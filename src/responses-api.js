import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { selectModel } from './model-catalog.js';
import { parseJsonBuffer, readRequestBody, sendJson, summarizeBody } from './http-utils.js';
import { createModelCapabilityLookup, normalizeThinkForModel, upstreamFetch } from './upstream.js';
import { createToolCapabilityLookup, emptyToolPolicy, normalizeToolsForModel } from './native-tools.js';
import { BackendAdapterError, resolveBackendAdapter, fetchPrepared } from './backend-adapters.js';
import { RequestGateError } from './request-gate.js';
import { queueHeartbeat, endQueuedError } from './queue-response.js';
import {
  RESPONSES_REASONING_EFFORTS,
  thinkLevelToReasoningEffort,
  resolveDefaultThink
} from './reasoning.js';

const RESPONSES_PATHS = new Set(['/v1/responses', '/responses']);
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'developer']);

export class ResponsesApiError extends Error {
  constructor(statusCode, code, message, param = null, type = 'invalid_request_error', diagnostics = null) {
    super(message);
    this.name = 'ResponsesApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.param = param;
    this.type = type;
    this.diagnostics = diagnostics;
  }
}

function backendErrorToResponsesError(error) {
  return new ResponsesApiError(
    error.statusCode,
    error.code,
    error.message,
    error.param,
    error.statusCode >= 500 ? 'server_error' : 'invalid_request_error',
    error.diagnostics
  );
}

export function isResponsesPath(pathname) {
  return RESPONSES_PATHS.has(pathname);
}

export function responsesErrorPayload(error) {
  return {
    error: {
      message: error.message,
      type: error.type || 'invalid_request_error',
      param: error.param ?? null,
      code: error.code || 'RESPONSES_API_ERROR'
    }
  };
}

function invalid(code, message, param = null) {
  throw new ResponsesApiError(400, code, message, param);
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function withoutPromptCacheKey(body) {
  if (!Object.hasOwn(body, 'prompt_cache_key')) return body;
  const sanitized = { ...body };
  delete sanitized.prompt_cache_key;
  return sanitized;
}

function normalizeTextValue(value, param) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isPlainObject(value) || Array.isArray(value)) return JSON.stringify(value);
  invalid('INVALID_INPUT', `${param} must be text or a JSON value.`, param);
}

function parseDataImageUrl(value, param) {
  if (typeof value !== 'string') {
    invalid('UNSUPPORTED_IMAGE_INPUT', 'Only base64 data URLs are supported for input images.', param);
  }
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) {
    invalid('UNSUPPORTED_IMAGE_INPUT', 'Only base64 data URLs are supported for input images.', param);
  }
  return match[1].replace(/[\r\n]/g, '');
}

function translateMessageContent(content, role, param) {
  if (typeof content === 'string') return { content, images: [] };
  if (!Array.isArray(content)) {
    invalid('INVALID_INPUT', `${param} must be a string or an array of content parts.`, param);
  }

  const textParts = [];
  const images = [];
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    const partParam = `${param}[${index}]`;
    if (!isPlainObject(part) || typeof part.type !== 'string') {
      invalid('INVALID_INPUT', `${partParam} must be a typed content part.`, partParam);
    }
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text !== 'string') invalid('INVALID_INPUT', `${partParam}.text must be a string.`, `${partParam}.text`);
      textParts.push(part.text);
      continue;
    }
    if (part.type === 'input_image') {
      if (role !== 'user') invalid('INVALID_INPUT', 'input_image is only supported in user messages.', partParam);
      images.push(parseDataImageUrl(part.image_url, `${partParam}.image_url`));
      continue;
    }
    invalid('UNSUPPORTED_INPUT_CONTENT', `Unsupported content part type: ${part.type}.`, `${partParam}.type`);
  }
  return { content: textParts.join(''), images };
}

function translateFunctionCallOutput(output, param) {
  if (!Array.isArray(output)) {
    return { content: normalizeTextValue(output, param), images: [] };
  }
  return translateMessageContent(output, 'user', param);
}

function parseFunctionArguments(value, param) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      invalid('MALFORMED_TOOL_ARGUMENTS', `${param} must contain valid JSON.`, param);
    }
  }
  if (!isPlainObject(parsed)) {
    invalid('MALFORMED_TOOL_ARGUMENTS', `${param} must encode a JSON object.`, param);
  }
  return parsed;
}

function translateReasoningParts(parts, expectedType, param, separator) {
  if (parts === undefined) return { present: false, text: '' };
  if (!Array.isArray(parts)) invalid('INVALID_REASONING_ITEM', `${param} must be an array.`, param);

  const texts = parts.map((part, index) => {
    const partParam = `${param}[${index}]`;
    if (!isPlainObject(part) || part.type !== expectedType) {
      invalid('INVALID_REASONING_ITEM', `${partParam}.type must be ${expectedType}.`, `${partParam}.type`);
    }
    if (typeof part.text !== 'string') {
      invalid('INVALID_REASONING_ITEM', `${partParam}.text must be a string.`, `${partParam}.text`);
    }
    return part.text;
  });
  return { present: true, text: texts.join(separator) };
}

function translateReasoningItem(item, param) {
  const summary = translateReasoningParts(item.summary, 'summary_text', `${param}.summary`, '\n\n');
  let content = { present: false, text: '' };
  if (item.content !== undefined) {
    if (!Array.isArray(item.content)) {
      invalid('INVALID_REASONING_ITEM', `${param}.content must be an array.`, `${param}.content`);
    }
    const texts = item.content.map((part, index) => {
      const partParam = `${param}.content[${index}]`;
      if (!isPlainObject(part) || !['reasoning_text', 'text'].includes(part.type)) {
        invalid('INVALID_REASONING_ITEM', `${partParam}.type must be reasoning_text.`, `${partParam}.type`);
      }
      if (typeof part.text !== 'string') {
        invalid('INVALID_REASONING_ITEM', `${partParam}.text must be a string.`, `${partParam}.text`);
      }
      return part.text;
    });
    content = { present: true, text: texts.join('') };
  }

  const hasEncryptedContent = item.encrypted_content !== undefined && item.encrypted_content !== null;
  if (hasEncryptedContent && (typeof item.encrypted_content !== 'string' || !item.encrypted_content)) {
    invalid(
      'INVALID_REASONING_ITEM',
      `${param}.encrypted_content must be a non-empty string or null.`,
      `${param}.encrypted_content`
    );
  }
  if (!summary.present && !content.present && !hasEncryptedContent) {
    invalid(
      'INVALID_REASONING_ITEM',
      'reasoning items require summary, content, or encrypted_content.',
      param
    );
  }

  const thinking = content.text || summary.text;
  if (!thinking && !hasEncryptedContent) {
    invalid('INVALID_REASONING_ITEM', 'reasoning items must contain reasoning text.', param);
  }
  // Ollama cannot consume OpenAI-encrypted reasoning. Accept encrypted-only items
  // without rejecting otherwise valid stateless history; plaintext content or a
  // supplied summary is preserved in the prior assistant message when available.
  return thinking || null;
}

function translateInput(input, instructions, toolNames) {
  const messages = [];
  const systemParts = [];
  const knownCalls = new Map();
  const completedCalls = new Set();
  let pendingAssistant = null;

  const ensurePendingAssistant = () => {
    if (!pendingAssistant) {
      pendingAssistant = {
        message: { role: 'assistant', content: '' },
        hasMessageItem: false
      };
    }
    return pendingAssistant;
  };

  const flushAssistant = () => {
    if (!pendingAssistant) return;
    messages.push(pendingAssistant.message);
    pendingAssistant = null;
  };

  const finishMessages = () => {
    if (systemParts.length) messages.unshift({ role: 'system', content: systemParts.join('\n\n') });
    return messages;
  };

  if (instructions !== undefined && instructions !== null) {
    if (typeof instructions !== 'string') invalid('INVALID_INSTRUCTIONS', 'instructions must be a string.', 'instructions');
    if (instructions) systemParts.push(instructions);
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return finishMessages();
  }
  if (!Array.isArray(input)) invalid('INVALID_INPUT', 'input must be a string or an array of input items.', 'input');

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const param = `input[${index}]`;
    if (!isPlainObject(item)) invalid('INVALID_INPUT', `${param} must be an object.`, param);

    const itemType = item.type || (typeof item.role === 'string' ? 'message' : null);
    if (itemType === 'message') {
      if (!MESSAGE_ROLES.has(item.role)) invalid('INVALID_INPUT_ROLE', `Unsupported message role: ${String(item.role)}.`, `${param}.role`);
      const translated = translateMessageContent(item.content, item.role, `${param}.content`);
      if (item.role === 'system' || item.role === 'developer') {
        flushAssistant();
        if (translated.content) systemParts.push(translated.content);
        continue;
      }
      if (item.role === 'assistant') {
        if (pendingAssistant?.hasMessageItem || pendingAssistant?.message.tool_calls?.length) flushAssistant();
        const pending = ensurePendingAssistant();
        pending.message.content = translated.content;
        if (translated.images.length) pending.message.images = translated.images;
        pending.hasMessageItem = true;
        continue;
      }
      flushAssistant();
      messages.push({
        role: item.role,
        content: translated.content,
        ...(translated.images.length ? { images: translated.images } : {})
      });
      continue;
    }

    if (itemType === 'reasoning') {
      flushAssistant();
      const thinking = translateReasoningItem(item, param);
      if (thinking) ensurePendingAssistant().message.thinking = thinking;
      continue;
    }

    if (itemType === 'function_call') {
      const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : null;
      if (!callId) invalid('INVALID_TOOL_CALL', 'function_call items require a non-empty call_id.', `${param}.call_id`);
      if (knownCalls.has(callId)) invalid('DUPLICATE_TOOL_CALL_ID', `Duplicate function call_id: ${callId}.`, `${param}.call_id`);
      if (typeof item.name !== 'string' || !item.name) invalid('INVALID_TOOL_CALL', 'function_call items require a function name.', `${param}.name`);
      if (item.namespace !== undefined && (typeof item.namespace !== 'string' || !item.namespace)) {
        invalid('INVALID_TOOL_CALL', 'function_call namespace must be a non-empty string when provided.', `${param}.namespace`);
      }
      const qualifiedName = item.namespace ? `${item.namespace}\u0000${item.name}` : item.name;
      const upstreamName = item.namespace ? toolNames.byQualifiedName.get(qualifiedName) : item.name;
      if (item.namespace && !upstreamName) {
        invalid('UNKNOWN_TOOL_NAME', `Unknown namespaced function: ${item.namespace}.${item.name}.`, `${param}.name`);
      }
      const args = parseFunctionArguments(item.arguments, `${param}.arguments`);
      knownCalls.set(callId, upstreamName);
      const pending = ensurePendingAssistant();
      if (!pending.message.tool_calls) pending.message.tool_calls = [];
      pending.message.tool_calls.push({
        id: callId,
        type: 'function',
        function: { name: upstreamName, arguments: args }
      });
      continue;
    }

    if (itemType === 'function_call_output') {
      flushAssistant();
      const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : null;
      if (!callId || !knownCalls.has(callId)) {
        invalid('UNKNOWN_TOOL_CALL_ID', `Unknown function call_id: ${String(callId)}.`, `${param}.call_id`);
      }
      if (completedCalls.has(callId)) invalid('DUPLICATE_TOOL_OUTPUT', `Duplicate output for function call_id: ${callId}.`, `${param}.call_id`);
      completedCalls.add(callId);
      const output = translateFunctionCallOutput(item.output, `${param}.output`);
      const toolName = knownCalls.get(callId);
      messages.push({
        role: 'tool',
        tool_name: toolName,
        tool_call_id: callId,
        content: output.content || (output.images.length ? '(see attached image)' : '')
      });
      if (output.images.length) {
        messages.push({
          role: 'user',
          content: `Image output from tool ${toolName} (call ${callId}).`,
          images: output.images
        });
      }
      continue;
    }

    invalid('UNSUPPORTED_INPUT_ITEM', `Unsupported input item type: ${String(itemType)}.`, `${param}.type`);
  }

  flushAssistant();
  return finishMessages();
}

function translateTools(tools, toolChoice) {
  if (tools === undefined || tools === null) tools = [];
  if (!Array.isArray(tools)) invalid('INVALID_TOOLS', 'tools must be an array.', 'tools');

  const choice = toolChoice ?? 'auto';
  if (choice !== 'auto' && choice !== 'none') {
    invalid('UNSUPPORTED_TOOL_CHOICE', 'Only tool_choice "auto" and "none" are supported by this adapter.', 'tool_choice');
  }

  const names = new Set();
  const byUpstreamName = new Map();
  const byQualifiedName = new Map();
  const translated = [];

  const addFunction = (tool, param, namespace = null, namespaceDescription = '') => {
    if (!isPlainObject(tool) || tool.type !== 'function') {
      invalid('UNSUPPORTED_TOOL_TYPE', `Unsupported nested tool type: ${String(tool?.type)}.`, `${param}.type`);
    }
    if (typeof tool.name !== 'string' || !tool.name) invalid('INVALID_TOOL', 'Function tools require a non-empty name.', `${param}.name`);
    if (tool.parameters !== undefined && !isPlainObject(tool.parameters)) {
      invalid('INVALID_TOOL', 'Function tool parameters must be a JSON Schema object.', `${param}.parameters`);
    }
    const upstreamName = namespace ? `${namespace}__${tool.name}` : tool.name;
    if (names.has(upstreamName)) invalid('DUPLICATE_TOOL_NAME', `Duplicate translated function tool name: ${upstreamName}.`, `${param}.name`);
    names.add(upstreamName);
    const metadata = { name: tool.name, namespace };
    byUpstreamName.set(upstreamName, metadata);
    if (namespace) byQualifiedName.set(`${namespace}\u0000${tool.name}`, upstreamName);
    const descriptionParts = [namespace ? `Namespace: ${namespace}.` : '', namespaceDescription, tool.description]
      .filter((part) => typeof part === 'string' && part.trim())
      .map((part) => part.trim());
    translated.push({
      type: 'function',
      function: {
        name: upstreamName,
        ...(descriptionParts.length ? { description: descriptionParts.join(' ') } : {}),
        parameters: tool.parameters || { type: 'object', properties: {} }
      }
    });
  };

  tools.forEach((tool, index) => {
    const param = `tools[${index}]`;
    if (isPlainObject(tool) && tool.type === 'namespace') {
      if (typeof tool.name !== 'string' || !tool.name) invalid('INVALID_TOOL', 'Namespace tools require a non-empty name.', `${param}.name`);
      if (!Array.isArray(tool.tools) || !tool.tools.length) invalid('INVALID_TOOL', 'Namespace tools require a non-empty tools array.', `${param}.tools`);
      tool.tools.forEach((nested, nestedIndex) => addFunction(
        nested,
        `${param}.tools[${nestedIndex}]`,
        tool.name,
        typeof tool.description === 'string' ? tool.description : ''
      ));
      return;
    }
    if (!isPlainObject(tool) || tool.type !== 'function') {
      invalid(
        'UNSUPPORTED_TOOL_TYPE',
        `Unsupported tool type: ${String(tool?.type)}. Only function tools are supported; disable provider-executed tools such as web_search.`,
        `${param}.type`
      );
    }
    addFunction(tool, param);
  });
  return {
    tools: choice === 'none' ? [] : translated,
    toolChoice: choice,
    toolNames: { byUpstreamName, byQualifiedName }
  };
}

function translateTextFormat(text) {
  if (text === undefined || text === null) return undefined;
  if (!isPlainObject(text)) invalid('INVALID_TEXT_CONFIG', 'text must be an object.', 'text');
  const format = text.format;
  if (format === undefined || format === null || format.type === 'text') return undefined;
  if (!isPlainObject(format) || typeof format.type !== 'string') {
    invalid('INVALID_TEXT_FORMAT', 'text.format must be a typed object.', 'text.format');
  }
  if (format.type === 'json_object') return 'json';
  if (format.type === 'json_schema') {
    if (!isPlainObject(format.schema)) invalid('INVALID_TEXT_FORMAT', 'json_schema format requires a schema object.', 'text.format.schema');
    return format.schema;
  }
  invalid('UNSUPPORTED_TEXT_FORMAT', `Unsupported text format: ${format.type}.`, 'text.format.type');
}

function validateDefaultThink(defaultThink) {
  if (defaultThink === undefined || typeof defaultThink === 'boolean' || RESPONSES_REASONING_EFFORTS.has(defaultThink)) return defaultThink;
  throw new ResponsesApiError(500, 'INVALID_REASONING_DEFAULT', 'The configured thinking default is invalid.', 'reasoning', 'server_error');
}

function translateReasoning(reasoning, reasoningEffort, defaultThink) {
  if (reasoning !== undefined && reasoning !== null && !isPlainObject(reasoning)) {
    invalid('INVALID_REASONING', 'reasoning must be an object or null.', 'reasoning');
  }

  const nestedEffort = reasoning?.effort;
  const hasNestedEffort = nestedEffort !== undefined && nestedEffort !== null;
  const hasTopLevelEffort = reasoningEffort !== undefined && reasoningEffort !== null;
  if (hasNestedEffort && hasTopLevelEffort && nestedEffort !== reasoningEffort) {
    invalid('CONFLICTING_REASONING_EFFORT', 'reasoning.effort and reasoning_effort must match when both are provided.', 'reasoning_effort');
  }

  const effort = nestedEffort ?? reasoningEffort;
  if (effort === undefined || effort === null) {
    const think = validateDefaultThink(defaultThink);
    return {
      think,
      incomingReasoningEffort: null,
      effectiveReasoningEffort: thinkLevelToReasoningEffort(think) ?? null
    };
  }
  if (!RESPONSES_REASONING_EFFORTS.has(effort)) {
    invalid(
      'UNSUPPORTED_REASONING_EFFORT',
      `Unsupported reasoning effort: ${String(effort)}.`,
      hasNestedEffort ? 'reasoning.effort' : 'reasoning_effort'
    );
  }
  return {
    think: effort === 'none' ? false : effort,
    incomingReasoningEffort: effort,
    effectiveReasoningEffort: effort
  };
}

export function translateResponsesRequest(
  body,
  activeModel,
  forcedKeepAlive,
  defaultThink,
  contextShift = false,
  rewriteRequestedModelToActive = false,
  routerModelAlias = null
) {
  if (arguments.length < 4) defaultThink = false;
  if (!isPlainObject(body)) invalid('INVALID_REQUEST_BODY', 'The request body must be a JSON object.');
  if (!activeModel) throw new ResponsesApiError(503, 'NO_ACTIVE_MODEL', 'No active model marker is available.', 'model', 'server_error');

  if (body.store === true) invalid('STATEFUL_REQUEST_UNSUPPORTED', 'store=true is unsupported; this adapter is stateless.', 'store');
  if (body.store !== undefined && body.store !== false) invalid('INVALID_STORE', 'store must be false or omitted.', 'store');
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    invalid('STATEFUL_REQUEST_UNSUPPORTED', 'previous_response_id is unsupported; resend the full input history.', 'previous_response_id');
  }
  const promptCacheKeyPresent = Object.hasOwn(body, 'prompt_cache_key');
  if (promptCacheKeyPresent && typeof body.prompt_cache_key !== 'string') {
    invalid('INVALID_PROMPT_CACHE_KEY', 'prompt_cache_key must be a string when provided.', 'prompt_cache_key');
  }
  // This is an OpenAI API compatibility hint, not a local cache namespace.
  // Remove it before any response construction or backend-policy processing so
  // its value cannot affect inference, llama.cpp slot selection, or telemetry.
  const compatibilityBody = withoutPromptCacheKey(body);
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
    invalid('INVALID_MODEL', 'model must be a non-empty string when provided.', 'model');
  }
  const publicAliasRequested = body.model === routerModelAlias;
  if (!rewriteRequestedModelToActive && !publicAliasRequested && body.model && body.model !== activeModel) {
    invalid('MODEL_NOT_ACTIVE', 'Requested model is not the active deployed model for this router profile.', 'model');
  }
  if (body.input === undefined || body.input === null) invalid('INPUT_REQUIRED', 'input is required.', 'input');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('INVALID_STREAM', 'stream must be a boolean.', 'stream');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    invalid('INVALID_PARALLEL_TOOL_CALLS', 'parallel_tool_calls must be a boolean.', 'parallel_tool_calls');
  }
  if (body.temperature !== undefined && body.temperature !== null && (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature))) {
    invalid('INVALID_TEMPERATURE', 'temperature must be a finite number.', 'temperature');
  }
  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null && (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1)) {
    invalid('INVALID_MAX_OUTPUT_TOKENS', 'max_output_tokens must be a positive integer.', 'max_output_tokens');
  }

  const translatedTools = translateTools(body.tools, body.tool_choice);
  const options = {};
  if (body.temperature !== undefined && body.temperature !== null) options.temperature = body.temperature;
  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) options.num_predict = body.max_output_tokens;
  const format = translateTextFormat(body.text);
  const reasoningTranslation = translateReasoning(body.reasoning, body.reasoning_effort, defaultThink);
  const think = reasoningTranslation.think;

  const upstreamBody = {
    model: activeModel,
    messages: translateInput(body.input, body.instructions, translatedTools.toolNames),
    stream: body.stream === true,
    ...(contextShift ? { shift: true } : {}),
    keep_alive: forcedKeepAlive,
    ...(translatedTools.tools.length ? { tools: translatedTools.tools } : {}),
    ...(Object.hasOwn(body, 'tool_choice') ? { tool_choice: body.tool_choice } : {}),
    ...(Object.hasOwn(body, 'parallel_tool_calls') ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(Object.hasOwn(body, 'max_tool_calls') ? { max_tool_calls: body.max_tool_calls } : {}),
    ...(Object.keys(options).length ? { options } : {}),
    ...(format === undefined ? {} : { format }),
    ...(think === undefined ? {} : { think })
  };

  const requestedModel = body.model ?? null;
  return {
    upstreamBody,
    incomingReasoningEffort: reasoningTranslation.incomingReasoningEffort,
    reasoningEffort: reasoningTranslation.effectiveReasoningEffort,
    requestedModel,
    forwardedModel: activeModel,
    modelRewritten: (rewriteRequestedModelToActive || publicAliasRequested) && requestedModel !== activeModel,
    stream: body.stream === true,
    toolChoice: translatedTools.toolChoice,
    parallelToolCalls: body.parallel_tool_calls ?? true,
    toolNames: translatedTools.toolNames,
    requestBody: compatibilityBody,
    promptCacheKeyPresent,
    promptCacheKeyDisposition: promptCacheKeyPresent ? 'accepted_ignored' : null
  };
}

function usageFromOllama(payload, reasoningProduced = false) {
  // Ollama reports an exact aggregate eval_count but not the split between
  // thinking and visible output. Preserve the exact input/output/total counts
  // Codex needs for context accounting. When thinking is present, attribute
  // the aggregate output count conservatively to reasoning rather than
  // suppressing the entire usage object and disabling automatic compaction.
  const inputTokens = Number.isFinite(payload?.prompt_eval_count) ? payload.prompt_eval_count : 0;
  const outputTokens = Number.isFinite(payload?.eval_count) ? payload.eval_count : 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningProduced ? outputTokens : 0 },
    total_tokens: inputTokens + outputTokens
  };
}

function rawUsageFromOllama(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const fields = ['total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_duration', 'eval_count', 'eval_duration'];
  const usage = {};
  for (const field of fields) {
    if (Number.isFinite(payload[field])) usage[field] = payload[field];
  }
  if (Number.isFinite(usage.eval_count) && Number.isFinite(usage.eval_duration) && usage.eval_duration > 0) {
    usage.eval_tokens_per_second = usage.eval_count / (usage.eval_duration / 1e9);
  }
  if (Number.isFinite(usage.prompt_eval_count) && Number.isFinite(usage.prompt_eval_duration) && usage.prompt_eval_duration > 0) {
    usage.prompt_tokens_per_second = usage.prompt_eval_count / (usage.prompt_eval_duration / 1e9);
  }
  return Object.keys(usage).length ? usage : null;
}

function responseShell(requestBody, activeModel, responseId, createdAt, status) {
  const responseText = isPlainObject(requestBody.text)
    ? {
      format: requestBody.text.format ?? { type: 'text' },
      ...(requestBody.text.verbosity === undefined ? {} : { verbosity: requestBody.text.verbosity })
    }
    : { format: { type: 'text' } };
  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: requestBody.instructions ?? null,
    max_output_tokens: requestBody.max_output_tokens ?? null,
    model: activeModel,
    output: [],
    parallel_tool_calls: requestBody.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: requestBody.reasoning ?? null,
    store: false,
    temperature: requestBody.temperature ?? null,
    text: responseText,
    tool_choice: requestBody.tool_choice ?? 'auto',
    tools: requestBody.tools ?? [],
    usage: null
  };
}

function normalizeUpstreamToolCall(toolCall, index, toolNames = { byUpstreamName: new Map() }) {
  if (!isPlainObject(toolCall) || !isPlainObject(toolCall.function)) {
    throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'Ollama returned a malformed function call.', null, 'server_error');
  }
  const name = toolCall.function.name;
  if (typeof name !== 'string' || !name) {
    throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'Ollama returned a function call without a name.', null, 'server_error');
  }
  let args = toolCall.function.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_TOOL_ARGUMENTS', 'Ollama returned malformed function arguments.', null, 'server_error');
    }
  }
  if (!isPlainObject(args)) {
    throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_TOOL_ARGUMENTS', 'Ollama function arguments must be a JSON object.', null, 'server_error');
  }
  const metadata = toolNames.byUpstreamName.get(name) || { name, namespace: null };
  return {
    id: newId('fc'),
    type: 'function_call',
    status: 'completed',
    arguments: JSON.stringify(args),
    call_id: typeof toolCall.id === 'string' && toolCall.id
      ? toolCall.id
      : (typeof toolCall.call_id === 'string' && toolCall.call_id ? toolCall.call_id : newId(`call${index}`)),
    name: metadata.name,
    ...(metadata.namespace ? { namespace: metadata.namespace } : {})
  };
}

function messageOutputItem(text) {
  return {
    id: newId('msg'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }]
  };
}

function reasoningOutputItem(thinking) {
  return {
    id: newId('rs'),
    type: 'reasoning',
    status: 'completed',
    summary: [],
    content: [{ type: 'reasoning_text', text: thinking }]
  };
}

export function translateOllamaResponse(
  payload,
  requestBody,
  activeModel,
  responseId = newId('resp'),
  createdAt = Math.floor(Date.now() / 1000),
  toolNames = { byUpstreamName: new Map() }
) {
  if (!isPlainObject(payload) || !isPlainObject(payload.message)) {
    throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_RESPONSE', 'Ollama returned a malformed chat response.', null, 'server_error');
  }
  const text = typeof payload.message.content === 'string' ? payload.message.content : '';
  const thinking = typeof payload.message.thinking === 'string' ? payload.message.thinking : '';
  const rawToolCalls = Array.isArray(payload.message.tool_calls) ? payload.message.tool_calls : [];
  const toolCalls = rawToolCalls.map((toolCall, index) => normalizeUpstreamToolCall(toolCall, index, toolNames));
  const callIds = new Set();
  for (const toolCall of toolCalls) {
    if (callIds.has(toolCall.call_id)) {
      throw new ResponsesApiError(502, 'DUPLICATE_UPSTREAM_TOOL_CALL_ID', 'Ollama returned duplicate function call IDs.', null, 'server_error');
    }
    callIds.add(toolCall.call_id);
  }
  const incompleteReason = payload.x_router?.stop_reason === 'context_length_exceeded' ? 'context_length_exceeded'
    : payload.done_reason === 'length' ? 'max_output_tokens'
    : !payload.done || !['stop', 'tool_calls', 'function_call'].includes(payload.done_reason) ? 'upstream_incomplete' : null;
  if (!incompleteReason && !text.trim() && !toolCalls.length) {
    throw new ResponsesApiError(
      502,
      'EMPTY_UPSTREAM_RESPONSE',
      'Ollama completed generation without a visible assistant message or function call.',
      null,
      'server_error'
    );
  }
  const output = [];
  if (thinking) output.push(reasoningOutputItem(thinking));
  if (text) output.push(messageOutputItem(text));
  output.push(...toolCalls);
  for (const call of payload.x_router?.partial_tool_calls ?? []) output.push({
    id: newId('fc'), type: 'function_call', status: 'incomplete', call_id: call.id, name: call.function.name, arguments: call.function.arguments
  });
  return {
    ...responseShell(requestBody, activeModel, responseId, createdAt, incompleteReason ? 'incomplete' : 'completed'),
    ...(incompleteReason ? { incomplete_details: { reason: incompleteReason } } : {}),
    ...(payload.x_router ? { x_router: payload.x_router } : {}),
    output: incompleteReason ? output.map((item) => ({ ...item, status: 'incomplete' })) : output,
    usage: usageFromOllama(payload, Boolean(thinking))
  };
}

class SseWriter {
  constructor(response, signal) {
    this.response = response;
    this.signal = signal;
    this.sequenceNumber = 0;
    this.bytes = 0;
  }

  async event(type, fields = {}) {
    const payload = `${JSON.stringify({ type, sequence_number: this.sequenceNumber, ...fields })}\n\n`;
    this.sequenceNumber += 1;
    const framed = `data: ${payload}`;
    this.bytes += Buffer.byteLength(framed);
    if (!this.response.write(framed)) await once(this.response, 'drain', { signal: this.signal });
  }

  end() {
    const final = 'data: [DONE]\n\n';
    this.bytes += Buffer.byteLength(final);
    this.response.end(final);
  }
}

class StreamingResponseBuilder {
  constructor(writer, requestBody, activeModel, responseId, createdAt, toolNames) {
    this.writer = writer;
    this.requestBody = requestBody;
    this.activeModel = activeModel;
    this.responseId = responseId;
    this.createdAt = createdAt;
    this.toolNames = toolNames;
    this.output = [];
    this.reasoningItem = null;
    this.textItem = null;
    this.toolItems = [];
    this.toolKeys = new Map();
    this.donePayload = null;
  }

  shell(status) {
    return {
      ...responseShell(this.requestBody, this.activeModel, this.responseId, this.createdAt, status),
      output: this.output.map((item) => ({ ...item }))
    };
  }

  async start() {
    await this.writer.event('response.created', { response: this.shell('in_progress') });
    await this.writer.event('response.in_progress', { response: this.shell('in_progress') });
  }

  async ensureReasoningItem() {
    if (this.reasoningItem) return this.reasoningItem;
    const item = {
      id: newId('rs'),
      type: 'reasoning',
      status: 'in_progress',
      summary: [],
      content: [{ type: 'reasoning_text', text: '' }]
    };
    const outputIndex = this.output.length;
    this.output.push(item);
    this.reasoningItem = { item, outputIndex, done: false };
    await this.writer.event('response.output_item.added', {
      output_index: outputIndex,
      item: { ...item, content: [] }
    });
    return this.reasoningItem;
  }

  async addThinking(delta) {
    if (!delta) return;
    if (this.reasoningItem?.done) {
      throw new ResponsesApiError(
        502,
        'MALFORMED_UPSTREAM_REASONING_ORDER',
        'Ollama returned thinking after assistant output began.',
        null,
        'server_error'
      );
    }
    const { item, outputIndex } = await this.ensureReasoningItem();
    item.content[0].text += delta;
    await this.writer.event('response.reasoning_text.delta', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      delta
    });
  }

  async finishReasoning() {
    if (!this.reasoningItem || this.reasoningItem.done) return;
    const tracked = this.reasoningItem;
    tracked.done = true;
    tracked.item.status = 'completed';
    await this.writer.event('response.reasoning_text.done', {
      item_id: tracked.item.id,
      output_index: tracked.outputIndex,
      content_index: 0,
      text: tracked.item.content[0].text
    });
    await this.writer.event('response.output_item.done', {
      output_index: tracked.outputIndex,
      item: tracked.item
    });
  }

  async ensureTextItem() {
    if (this.textItem) return this.textItem;
    const item = {
      id: newId('msg'),
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [], logprobs: [] }]
    };
    const outputIndex = this.output.length;
    this.output.push(item);
    this.textItem = { item, outputIndex };
    await this.writer.event('response.output_item.added', { output_index: outputIndex, item: { ...item, content: [] } });
    await this.writer.event('response.content_part.added', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] }
    });
    return this.textItem;
  }

  async addText(delta) {
    if (!delta) return;
    await this.finishReasoning();
    const { item, outputIndex } = await this.ensureTextItem();
    item.content[0].text += delta;
    await this.writer.event('response.output_text.delta', {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      delta,
      logprobs: []
    });
  }

  async addToolCall(toolCall, index) {
    await this.finishReasoning();
    if (!isPlainObject(toolCall) || !isPlainObject(toolCall.function)) {
      throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'Ollama returned a malformed function call.', null, 'server_error');
    }
    const name = toolCall.function.name;
    if (typeof name !== 'string' || !name) {
      throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'Ollama returned a function call without a name.', null, 'server_error');
    }
    const upstreamId = typeof toolCall.id === 'string' && toolCall.id
      ? toolCall.id
      : (typeof toolCall.call_id === 'string' && toolCall.call_id ? toolCall.call_id : null);
    const key = upstreamId || `${index}:${name}`;
    let tracked = this.toolKeys.get(key);
    if (tracked && (tracked.name !== name || tracked.sourceIndex !== index)) {
      throw new ResponsesApiError(502, 'DUPLICATE_UPSTREAM_TOOL_CALL_ID', 'Ollama returned duplicate function call IDs.', null, 'server_error');
    }
    if (!tracked) {
      const metadata = this.toolNames.byUpstreamName.get(name) || { name, namespace: null };
      const item = {
        id: newId('fc'),
        type: 'function_call',
        status: 'in_progress',
        arguments: '',
        call_id: upstreamId || newId(`call${index}`),
        name: metadata.name,
        ...(metadata.namespace ? { namespace: metadata.namespace } : {})
      };
      const outputIndex = this.output.length;
      this.output.push(item);
      tracked = { item, outputIndex, objectArgumentsObserved: false, name, sourceIndex: index };
      this.toolKeys.set(key, tracked);
      this.toolItems.push(tracked);
      await this.writer.event('response.output_item.added', { output_index: outputIndex, item: { ...item } });
    }

    const args = toolCall.function.arguments;
    let delta = '';
    if (typeof args === 'string') {
      delta = args;
    } else if (isPlainObject(args)) {
      if (!tracked.objectArgumentsObserved) {
        delta = JSON.stringify(args);
        tracked.objectArgumentsObserved = true;
      }
    } else {
      throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_TOOL_ARGUMENTS', 'Ollama function arguments must be a JSON object or JSON text.', null, 'server_error');
    }
    if (delta) {
      tracked.item.arguments += delta;
      await this.writer.event('response.function_call_arguments.delta', {
        item_id: tracked.item.id,
        output_index: tracked.outputIndex,
        delta
      });
    }
  }

  observeDone(payload) {
    this.donePayload = payload;
  }

  async complete() {
    const stop = this.donePayload?.done_reason;
    if (stop && !['stop', 'tool_calls', 'function_call'].includes(stop)) {
      return this.incomplete(this.donePayload?.x_router?.stop_reason === 'context_length_exceeded' ? 'context_length_exceeded' : stop === 'length' ? 'max_output_tokens' : 'upstream_incomplete');
    }
    await this.finishReasoning();
    const visibleText = this.textItem?.item.content[0].text || '';
    if (!visibleText.trim() && !this.toolItems.length) {
      throw new ResponsesApiError(
        502,
        'EMPTY_UPSTREAM_RESPONSE',
        'Ollama completed generation without a visible assistant message or function call.',
        null,
        'server_error'
      );
    }
    if (this.textItem) {
      const { item, outputIndex } = this.textItem;
      item.status = 'completed';
      const part = item.content[0];
      await this.writer.event('response.output_text.done', {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text: part.text,
        logprobs: []
      });
      await this.writer.event('response.content_part.done', {
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part
      });
      await this.writer.event('response.output_item.done', { output_index: outputIndex, item });
    }
    for (const tracked of this.toolItems) {
      try {
        const parsed = JSON.parse(tracked.item.arguments);
        if (!isPlainObject(parsed)) throw new Error('not an object');
      } catch {
        throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_TOOL_ARGUMENTS', 'Ollama returned malformed function arguments.', null, 'server_error');
      }
      tracked.item.status = 'completed';
      await this.writer.event('response.function_call_arguments.done', {
        item_id: tracked.item.id,
        output_index: tracked.outputIndex,
        arguments: tracked.item.arguments
      });
      await this.writer.event('response.output_item.done', { output_index: tracked.outputIndex, item: tracked.item });
    }

    const completed = this.shell('completed');
    completed.usage = usageFromOllama(this.donePayload, Boolean(this.reasoningItem));
    await this.writer.event('response.completed', { response: completed });
    return completed;
  }

  async incomplete(reason) {
    await this.finishReasoning();
    const incomplete = this.shell('incomplete');
    incomplete.incomplete_details = { reason };
    incomplete.output = incomplete.output.map((item) => ({ ...item, status: 'incomplete' }));
    for (const call of this.donePayload?.x_router?.partial_tool_calls ?? []) incomplete.output.push({
      id: newId('fc'), type: 'function_call', status: 'incomplete', call_id: call.id, name: call.function.name, arguments: call.function.arguments
    });
    if (this.donePayload?.x_router) incomplete.x_router = this.donePayload.x_router;
    incomplete.usage = usageFromOllama(this.donePayload, Boolean(this.reasoningItem));
    await this.writer.event('response.incomplete', { response: incomplete });
    return incomplete;
  }
}

async function endFailedStream(builder, writer, apiError) {
  const failed = builder.shell('failed');
  failed.error = { code: apiError.code, message: apiError.message };
  await writer.event('response.failed', { response: failed });
  writer.end();
}

async function endIncompleteStream(builder, writer, reason) {
  const incomplete = await builder.incomplete(reason);
  writer.end();
  return incomplete;
}

function isOutputLimitToolArgumentTruncation(error) {
  return error instanceof BackendAdapterError
    && error.code === 'MALFORMED_UPSTREAM_TOOL_ARGUMENTS'
    && error.diagnostics?.jsonErrorCategory === 'unexpected_end'
    && error.diagnostics?.finishReason === 'length'
    && error.diagnostics?.outputLimitReached === true;
}

async function readUpstreamError(upstreamResponse) {
  const text = await upstreamResponse.text();
  if (!text.trim()) return `Ollama returned HTTP ${upstreamResponse.status}.`;
  try {
    const parsed = JSON.parse(text);
    return parsed.error || parsed.message || text;
  } catch {
    return text;
  }
}

async function processNdjsonStream(upstreamResponse, builder) {
  const reader = upstreamResponse.body.getReader();
  let pending = '';
  const decoder = new TextDecoder();
  let sawDone = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) { pending += decoder.decode(); break; }
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_STREAM', 'Ollama returned malformed NDJSON.', null, 'server_error');
      }
      if (payload.error) throw new ResponsesApiError(502, 'UPSTREAM_GENERATION_FAILED', String(payload.error), null, 'server_error');
      if (typeof payload.message?.thinking === 'string') await builder.addThinking(payload.message.thinking);
      if (typeof payload.message?.content === 'string') await builder.addText(payload.message.content);
      if (Array.isArray(payload.message?.tool_calls)) {
        for (let index = 0; index < payload.message.tool_calls.length; index += 1) {
          await builder.addToolCall(payload.message.tool_calls[index], index);
        }
      }
      if (payload.done === true) {
        sawDone = true;
        builder.observeDone(payload);
      }
    }
  }
  if (pending.trim()) {
    let payload;
    try {
      payload = JSON.parse(pending);
    } catch {
      throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_STREAM', 'Ollama returned malformed NDJSON.', null, 'server_error');
    }
    if (payload.error) throw new ResponsesApiError(502, 'UPSTREAM_GENERATION_FAILED', String(payload.error), null, 'server_error');
    if (typeof payload.message?.thinking === 'string') await builder.addThinking(payload.message.thinking);
    if (typeof payload.message?.content === 'string') await builder.addText(payload.message.content);
    if (Array.isArray(payload.message?.tool_calls)) {
      for (let index = 0; index < payload.message.tool_calls.length; index += 1) {
        await builder.addToolCall(payload.message.tool_calls[index], index);
      }
    }
    if (payload.done === true) {
      sawDone = true;
      builder.observeDone(payload);
    }
  }
  if (!sawDone) {
    throw new ResponsesApiError(502, 'INCOMPLETE_UPSTREAM_STREAM', 'Ollama ended the stream before a done response.', null, 'server_error');
  }
}

function attachAbort(request, response, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let clientAborted = false;
  // Generation has no total deadline. Transport detects connection failure and stalls.
  const onAborted = () => {
    clientAborted = true;
    controller.abort(new DOMException('Client disconnected.', 'AbortError'));
  };
  const onClose = () => {
    if (!response.writableEnded) onAborted();
  };
  request.once('aborted', onAborted);
  response.once('close', onClose);
  if (request.aborted || response.destroyed) onAborted();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clientAborted: () => clientAborted,
    cleanup() {
      request.off('aborted', onAborted);
      response.off('close', onClose);
    }
  };
}

function outcomeBase(started, pathname, body, activeModel, translated, toolPolicy = null) {
  const tools = toolPolicy || translated || emptyToolPolicy(body, null);
  return {
    endpoint: pathname,
    activeModel,
    requestedModel: translated?.requestedModel ?? body?.model ?? null,
    forwardedModel: translated?.forwardedModel ?? null,
    modelRewritten: translated?.modelRewritten ?? false,
    incomingKeepAlive: null,
    forwardedKeepAlive: translated ? translated.upstreamBody.keep_alive : null,
    keepAliveNormalized: Boolean(translated),
    incomingThink: translated?.incomingThink,
    forwardedThink: translated?.forwardedThink,
    incomingReasoningEffort: translated?.incomingReasoningEffort ?? null,
    thinkMapped: translated?.thinkMapped ?? false,
    thinkDropped: translated?.thinkDropped ?? false,
    thinkNormalized: translated?.thinkNormalized ?? false,
    thinkingSupported: translated?.thinkingSupported ?? null,
    reasoningEffort: translated?.reasoningEffort ?? null,
    requestedOutputTokens: translated?.requestedOutputTokens ?? null,
    effectiveOutputTokens: translated?.effectiveOutputTokens ?? null,
    outputLimitCapped: translated?.outputLimitCapped ?? false,
    outputLimitPolicy: translated?.outputLimitPolicy ?? null,
    temperatureForwarding: translated?.temperatureForwarding ?? null,
    ...(translated && Object.hasOwn(translated, 'forwardedTemperature')
      ? { forwardedTemperature: translated.forwardedTemperature }
      : {}),
    promptCacheKeyPresent: translated?.promptCacheKeyPresent
      ?? (isPlainObject(body) && Object.hasOwn(body, 'prompt_cache_key')),
    promptCacheKeyDisposition: translated?.promptCacheKeyDisposition ?? null,
    toolsPresent: tools.toolsPresent,
    toolCount: tools.toolCount,
    toolChoicePresent: tools.toolChoicePresent,
    toolHistoryPresent: tools.toolHistoryPresent,
    toolsSupported: tools.toolsSupported,
    toolsDropped: tools.toolsDropped,
    unsupportedToolsPolicy: tools.unsupportedToolsPolicy,
    streaming: translated?.stream ?? body?.stream === true,
    bodySummary: summarizeBody(body, 'metadata'),
    latencyMs: Date.now() - started
  };
}

export async function handleResponsesRequest(request, response, pathname, context) {
  const started = Date.now();
  let body = null;
  let activeModelInfo = null;
  let translated = null;
  let toolPolicy = emptyToolPolicy(null, context.config.unsupportedToolsPolicy);
  let abortState = null;
  let writer = null;
  let builder = null;
  let backend = null;
  let lease = null;
  let backendRequest = null;
  let stopQueueHeartbeat = () => {};

  try {
    if (request.method !== 'POST') {
      throw new ResponsesApiError(405, 'METHOD_NOT_ALLOWED', 'The Responses endpoint only accepts POST requests.', null);
    }
    let rawBody;
    try {
      rawBody = await readRequestBody(request, context.config.maxBodyBytes);
      body = parseJsonBuffer(rawBody);
    } catch (error) {
      if (error instanceof SyntaxError) throw new ResponsesApiError(400, 'INVALID_JSON_BODY', 'Request body is not valid JSON.', null);
      throw new ResponsesApiError(error.statusCode || 400, 'INVALID_REQUEST_BODY', error.message, null);
    }
    toolPolicy = emptyToolPolicy(body, context.config.unsupportedToolsPolicy);

    abortState = attachAbort(request, response, context.config.upstreamTimeoutMs);
    activeModelInfo = await selectModel(context.config, body?.model);
    if (context.state.maintenanceMode || context.requestGate.draining) {
      throw new ResponsesApiError(
        503,
        context.requestGate.draining ? 'BACKEND_DRAINING' : 'MAINTENANCE_MODE',
        context.requestGate.draining
          ? 'The active inference backend is draining for a runtime transition. Retry shortly.'
          : 'Router maintenance mode is enabled.',
        null,
        'server_error'
      );
    }
    backend = resolveBackendAdapter(context.config, activeModelInfo);
    const capabilityLookup = createToolCapabilityLookup(
      activeModelInfo,
      createModelCapabilityLookup(backend.upstreamConfig, activeModelInfo.model)
    );
    try {
      toolPolicy = await normalizeToolsForModel(
        body,
        activeModelInfo.model,
        activeModelInfo.catalog_mode ? 'reject' : context.config.unsupportedToolsPolicy,
        capabilityLookup
      );
    } catch (error) {
      if (error.code === 'UNSUPPORTED_TOOLS' || error.code === 'UNSUPPORTED_TOOL_HISTORY') {
        toolPolicy = { ...toolPolicy, toolsSupported: false };
        throw new ResponsesApiError(error.statusCode, error.code, error.message, error.param);
      }
      throw error;
    }

    let defaultThink;
    try {
      defaultThink = resolveDefaultThink(activeModelInfo, context.config, false);
    } catch (error) {
      throw new ResponsesApiError(503, 'INVALID_ACTIVE_MODEL_THINK_DEFAULT', error.message, 'reasoning', 'server_error');
    }
    translated = translateResponsesRequest(
      toolPolicy.body,
      activeModelInfo.model,
      context.config.forcedKeepAlive,
      defaultThink,
      context.config.responsesContextShift,
      activeModelInfo.catalog_mode ? activeModelInfo.aliases.includes(body?.model) : context.config.rewriteRequestedModelToActive,
      context.config.routerModelAlias
    );
    let thinkPolicy;
    try {
      thinkPolicy = backend.kind === 'ollama'
        ? await normalizeThinkForModel(
          backend.upstreamConfig,
          activeModelInfo.model,
          translated.upstreamBody,
          activeModelInfo,
          capabilityLookup
        )
        : {
          body: translated.upstreamBody,
          incomingThink: translated.upstreamBody?.think,
          forwardedThink: undefined,
          thinkMapped: false,
          thinkDropped: false,
          thinkNormalized: false,
          thinkingSupported: null
        };
    } catch (error) {
      throw new ResponsesApiError(error.statusCode || 503, error.code || 'INVALID_REASONING_CAPABILITIES', error.message, 'reasoning', (error.statusCode || 503) >= 500 ? 'server_error' : 'invalid_request_error');
    }
    translated.upstreamBody = thinkPolicy.body;
    translated.incomingThink = thinkPolicy.incomingThink;
    translated.forwardedThink = thinkPolicy.forwardedThink;
    translated.thinkMapped = thinkPolicy.thinkMapped;
    translated.thinkDropped = thinkPolicy.thinkDropped;
    translated.thinkNormalized = thinkPolicy.thinkNormalized;
    translated.thinkingSupported = thinkPolicy.thinkingSupported;
    translated.toolsPresent = toolPolicy.toolsPresent;
    translated.toolCount = toolPolicy.toolCount;
    translated.toolChoicePresent = toolPolicy.toolChoicePresent;
    translated.toolHistoryPresent = toolPolicy.toolHistoryPresent;
    translated.toolsSupported = toolPolicy.toolsSupported;
    translated.toolsDropped = toolPolicy.toolsDropped;
    translated.unsupportedToolsPolicy = toolPolicy.unsupportedToolsPolicy;
    translated.originalBody = translated.requestBody;
    try {
      // Template application/tokenization is part of an accepted generation
      // request. Hold the lease across it so draining cannot interrupt a
      // request between admission and backend inference.
      lease = await context.requestGate.acquire({
        endpoint: pathname,
        clientIdentity: request.headers['x-client-name'] || request.socket.remoteAddress,
        limit: backend.maxActiveRequests,
        backendKey: backend.admissionKey,
        model: activeModelInfo.model,
        signal: abortState.signal,
        onQueued: () => { stopQueueHeartbeat = queueHeartbeat(response, translated.stream ? 'responses' : null); }
      });
      stopQueueHeartbeat();
      await backend.ensureAvailable(abortState.signal);
      backendRequest = backend.prepareResponses(translated);
      translated.temperatureForwarding = backendRequest.temperatureForwarding ?? null;
      if (Object.hasOwn(backendRequest, 'forwardedTemperature')) {
        translated.forwardedTemperature = backendRequest.forwardedTemperature;
      }
      if (backendRequest.reasoning) {
        Object.assign(translated, {
          reasoningEffort: backendRequest.reasoning.level,
          thinkingSupported: true,
          requestedOutputTokens: backendRequest.reasoning.requestedOutputTokens,
          effectiveOutputTokens: backendRequest.reasoning.outputTokens,
          outputLimitCapped: backendRequest.reasoning.outputLimitCapped,
          outputLimitPolicy: backendRequest.reasoning.outputLimitPolicy
        });
      }
      if (backend.validateResponsesContext) await backend.validateResponsesContext(backendRequest, abortState.signal);
    } catch (error) {
      if (error instanceof BackendAdapterError || error instanceof RequestGateError) {
        if (error instanceof BackendAdapterError) throw backendErrorToResponsesError(error);
        throw new ResponsesApiError(
          error.statusCode,
          error.code,
          error.message,
          error.param,
          error.statusCode >= 500 ? 'server_error' : 'invalid_request_error'
        );
      }
      throw error;
    }
    const responseId = newId('resp');
    const createdAt = Math.floor(Date.now() / 1000);
    if (translated.stream) {
      if (!response.headersSent) response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-ollama-router': 'llm-router',
        'x-accel-buffering': 'no',
        ...(backendRequest.reasoning?.outputLimitCapped
          ? { 'x-router-effective-max-output-tokens': String(backendRequest.reasoning.outputTokens) }
          : {})
      });
      writer = new SseWriter(response, abortState.signal);
      builder = new StreamingResponseBuilder(
        writer,
        translated.requestBody,
        activeModelInfo.model,
        responseId,
        createdAt,
        translated.toolNames
      );
      // Start the downstream SSE lifecycle before Ollama has a worker. This
      // keeps a queued generation from tripping the client's header timeout.
      await builder.start();
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetchPrepared(backend, backendRequest, {
        'content-type': 'application/json',
        accept: translated.stream ? 'text/event-stream' : 'application/json'
      }, abortState.signal);
    } catch (error) {
      if (abortState.clientAborted()) {
        return {
          ...outcomeBase(started, pathname, body, activeModelInfo.model, translated),
          allowed: true,
          rejected: false,
          status: 499,
          responseStatus: 499,
          upstreamError: false,
          errorCode: 'CLIENT_CLOSED_REQUEST',
          usage: null,
          responseBytes: writer?.bytes || 0
        };
      }
      const apiError = abortState.timedOut() || error?.name === 'TimeoutError'
        ? new ResponsesApiError(504, 'UPSTREAM_TIMEOUT', 'Timed out waiting for the active backend.', null, 'server_error')
        : new ResponsesApiError(502, 'UPSTREAM_REQUEST_FAILED', error.message || 'Could not reach the active backend.', null, 'server_error');
      if (builder && writer && !response.destroyed) {
        await endFailedStream(builder, writer, apiError);
        return {
          ...outcomeBase(started, pathname, body, activeModelInfo.model, translated),
          allowed: true,
          rejected: false,
          status: 200,
          responseStatus: 200,
          upstreamError: true,
          errorCode: apiError.code,
          errorSummary: apiError.message,
          usage: null,
          responseBytes: writer.bytes
        };
      }
      throw apiError;
    }

    upstreamResponse = await backend.adaptResponsesResponse(upstreamResponse, translated.stream, backendRequest);

    if (!upstreamResponse.ok) {
      const upstreamMessage = await readUpstreamError(upstreamResponse);
      const apiError = new ResponsesApiError(502, 'UPSTREAM_REQUEST_FAILED', upstreamMessage, null, 'server_error');
      if (builder && writer && !response.destroyed) {
        await endFailedStream(builder, writer, apiError);
        return {
          ...outcomeBase(started, pathname, body, activeModelInfo.model, translated),
          allowed: true,
          rejected: false,
          status: 200,
          responseStatus: 200,
          upstreamError: true,
          errorCode: apiError.code,
          errorSummary: apiError.message,
          usage: null,
          responseBytes: writer.bytes
        };
      }
      throw apiError;
    }

    if (!translated.stream) {
      let upstreamPayload;
      try {
        upstreamPayload = JSON.parse(await upstreamResponse.text());
      } catch {
        throw new ResponsesApiError(502, 'MALFORMED_UPSTREAM_RESPONSE', 'The active backend returned invalid JSON.', null, 'server_error');
      }
      const payload = translateOllamaResponse(
        upstreamPayload,
        translated.requestBody,
        activeModelInfo.model,
        responseId,
        createdAt,
        translated.toolNames
      );
      const responseBytes = Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`);
      sendJson(response, 200, payload, {
        'x-ollama-router': 'llm-router',
        ...(backendRequest.reasoning?.outputLimitCapped
          ? { 'x-router-effective-max-output-tokens': String(backendRequest.reasoning.outputTokens) }
          : {})
      });
      return {
        ...outcomeBase(started, pathname, body, activeModelInfo.model, translated),
        allowed: true,
        rejected: false,
        status: 200,
        responseStatus: 200,
        upstreamError: false,
        usage: rawUsageFromOllama(upstreamPayload),
        responseBytes
      };
    }

    try {
      await processNdjsonStream(upstreamResponse, builder);
      const completed = await builder.complete();
      writer.end();
      return {
        ...outcomeBase(started, pathname, body, activeModelInfo.model, translated),
        allowed: true,
        rejected: false,
        status: 200,
        responseStatus: 200,
        upstreamError: false,
        usage: rawUsageFromOllama(builder.donePayload),
        responseBytes: writer.bytes,
        incomplete: completed.status === 'incomplete',
        incompleteReason: completed.incomplete_details?.reason,
        outputItems: completed.output.length
      };
    } catch (error) {
      if (abortState.clientAborted() || response.destroyed) {
        return {
          ...outcomeBase(started, pathname, body, activeModelInfo.model, translated),
          allowed: true,
          rejected: false,
          status: 499,
          responseStatus: 499,
          upstreamError: false,
          errorCode: 'CLIENT_CLOSED_REQUEST',
          usage: null,
          responseBytes: writer.bytes
        };
      }
      if (isOutputLimitToolArgumentTruncation(error)) {
        const incomplete = await endIncompleteStream(builder, writer, 'max_output_tokens');
        return {
          ...outcomeBase(started, pathname, body, activeModelInfo.model, translated),
          allowed: true,
          rejected: false,
          status: 200,
          responseStatus: 200,
          upstreamError: false,
          incomplete: true,
          incompleteReason: 'max_output_tokens',
          incompleteDiagnostics: error.diagnostics,
          usage: null,
          responseBytes: writer.bytes,
          outputItems: incomplete.output.length
        };
      }
      const apiError = error instanceof ResponsesApiError
        ? error
        : (error instanceof BackendAdapterError
          ? backendErrorToResponsesError(error)
          : (abortState.timedOut() || error?.name === 'TimeoutError'
            ? new ResponsesApiError(504, 'UPSTREAM_TIMEOUT', 'Timed out waiting for the active backend.', null, 'server_error')
            : new ResponsesApiError(502, 'UPSTREAM_STREAM_FAILED', error.message, null, 'server_error')));
      await endFailedStream(builder, writer, apiError);
      return {
        ...outcomeBase(started, pathname, body, activeModelInfo.model, translated),
        allowed: true,
        rejected: false,
        status: 200,
        responseStatus: 200,
        upstreamError: true,
        errorCode: apiError.code,
        errorSummary: apiError.message,
        ...(apiError.diagnostics ? { errorDiagnostics: apiError.diagnostics } : {}),
        usage: null,
        responseBytes: writer.bytes
      };
    }
  } catch (error) {
    if (abortState?.clientAborted() || response.destroyed) return {
      ...outcomeBase(started, pathname, body, activeModelInfo?.model ?? null, translated, toolPolicy),
      allowed: true, rejected: false, status: 499, responseStatus: 499,
      upstreamError: false, errorCode: 'CLIENT_CLOSED_REQUEST', usage: null, responseBytes: writer?.bytes || 0
    };
    const apiError = error instanceof ResponsesApiError
      ? error
      : (error instanceof BackendAdapterError
        ? backendErrorToResponsesError(error)
        : (abortState?.timedOut() || error?.name === 'TimeoutError'
          ? new ResponsesApiError(504, 'UPSTREAM_TIMEOUT', 'Timed out waiting for Ollama.', null, 'server_error')
          : new ResponsesApiError(500, 'INTERNAL_ERROR', error.message || 'Unexpected Responses adapter error.', null, 'server_error')));
    if (!response.headersSent && !response.destroyed) sendJson(response, apiError.statusCode, { ...responsesErrorPayload(apiError),
      ...(backendRequest?.journal ? { x_router: { status: 'incomplete', record_id: backendRequest.journal.id }, partial_response: backendRequest.journal.partial } : {}) });
    else endQueuedError(response, 'responses', { code: apiError.code, message: apiError.message, param: apiError.param });
    return {
      ...outcomeBase(started, pathname, body, activeModelInfo?.model ?? null, translated, toolPolicy),
      allowed: false,
      rejected: true,
      status: apiError.statusCode,
      responseStatus: apiError.statusCode,
      upstreamError: apiError.statusCode >= 500 && ![
        'NO_ACTIVE_MODEL',
        'MAINTENANCE_MODE',
        'INVALID_ACTIVE_MODEL_THINK_DEFAULT',
        'INVALID_REASONING_DEFAULT',
        'MISSING_REASONING_CAPABILITIES',
        'INVALID_REASONING_CAPABILITIES'
      ].includes(apiError.code),
      errorCode: apiError.code,
      errorSummary: apiError.message,
      ...(apiError.diagnostics ? { errorDiagnostics: apiError.diagnostics } : {}),
      usage: null,
      responseBytes: 0
    };
  } finally {
    stopQueueHeartbeat();
    abortState?.cleanup();
    lease?.release();
    if (backendRequest?.journal && !backendRequest.journal.closed) {
      try { await backendRequest.journal.append({ type: 'terminal', status: 'incomplete', reason: 'delivery_interrupted' }); }
      catch (error) { console.error('generation archive finalization failed', error); }
      finally { await backendRequest.journal.close(); }
    }
  }
}
