import { createHash } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { upstreamFetch, upstreamJson } from './upstream.js';
import { managedCompletion, openGenerationJournal, rebaseContext } from './generation-session.js';

const encoder = new TextEncoder();
const LLAMA_CPP_KIND = 'llama_cpp';
const OLLAMA_KIND = 'ollama';
const SAFE_POLICY_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_TOOL_ARGUMENT_DIAGNOSTIC_DELTAS = 64;

export const OPENAI_CONTEXT_LENGTH_EXCEEDED_CODE = 'context_length_exceeded';
export const DEFAULT_CONTEXT_SAFETY_RESERVE = 1024;

export class BackendAdapterError extends Error {
  constructor(statusCode, code, message, param = null, diagnostics = null) {
    super(message);
    this.name = 'BackendAdapterError';
    this.statusCode = statusCode;
    this.code = code;
    this.param = param;
    this.diagnostics = diagnostics;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value, fallback = null) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback = null) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function llamaTemperature(body) {
  const request = isPlainObject(body) ? body : {};
  const options = isPlainObject(request.options) ? request.options : {};
  const topLevelPresent = Object.hasOwn(request, 'temperature');
  const optionPresent = Object.hasOwn(options, 'temperature');
  if (!topLevelPresent && !optionPresent) {
    return {
      controls: {},
      forwarding: 'omitted_for_backend_default'
    };
  }

  // Retain the existing top-level/nullish precedence and finite-number
  // normalization for explicitly supplied values. Presence is evaluated
  // separately so an absent value is not converted into an explicit zero.
  const parsed = Number(request.temperature ?? options.temperature ?? 0);
  const forwardedTemperature = Number.isFinite(parsed) ? parsed : 0;
  return {
    controls: { temperature: forwardedTemperature },
    forwarding: 'explicit',
    forwardedTemperature
  };
}

export function enforcedContextSafetyReserve(activeModel) {
  if ((activeModel?.backend_kind || OLLAMA_KIND) !== LLAMA_CPP_KIND) return null;
  return nonNegativeInteger(activeModel?.context_safety_reserve, DEFAULT_CONTEXT_SAFETY_RESERVE);
}

function clonedConfig(config, upstreamUrl) {
  return { ...config, upstreamUrl: String(upstreamUrl || config.upstreamUrl).replace(/\/+$/, '') };
}

function hasMultimodalContent(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => {
    if (Array.isArray(message?.images) && message.images.length) return true;
    if (!Array.isArray(message?.content)) return false;
    return message.content.some((part) => !['text', 'input_text', 'output_text'].includes(part?.type));
  });
}

const UNSUPPORTED_CONTROL_FIELDS = new Set([
  'reasoning',
  'reasoning_effort',
  'reasoning_budget_tokens',
  'reasoning_budget_message',
  'reasoning_control',
  'reasoning_format',
  'think',
  'thinking',
  'thinking_budget_tokens',
  'chat_template_kwargs',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'functions',
  'function_call',
  'max_tool_calls',
  'images',
  'audio',
  'video',
  'mmproj',
  'draft_model',
  'speculative',
  'id_slot',
  'cache_prompt',
  // Responses strips prompt_cache_key only after strict string validation.
  // Keep the backend guard so it cannot leak through another public protocol.
  'prompt_cache_key',
  'prompt_cache_options',
  'prompt_cache_retention',
  'cache_id',
  'cache_ram',
  'cache_idle_slots',
  'cache_reuse',
  'n_cache_reuse',
  'cache_path',
  'cache_dir',
  'cache_file',
  'slot_action',
  'slot_save_path',
  'slot_restore_path',
  'slot_erase',
  'n_keep',
  'n_discard',
  'slot_id',
  'backend',
  'backend_url',
  'upstream_url'
]);

const LLAMA_TOOL_CONTROL_FIELDS = new Set([
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'functions',
  'function_call'
]);

const STRICT_REASONING_CONTROL_FIELDS = new Set([
  'reasoning_budget_tokens',
  'reasoning_budget_message',
  'reasoning_control',
  'reasoning_format',
  'thinking',
  'thinking_budget_tokens',
  'chat_template_kwargs'
]);

function rejectUnsupportedFields(body, { allowTools = false, allowVision = false } = {}) {
  for (const field of STRICT_REASONING_CONTROL_FIELDS) {
    if (Object.hasOwn(body || {}, field)) {
      throw new BackendAdapterError(
        400,
        'UNTRUSTED_REASONING_CONTROL',
        `Caller-supplied ${field} is not accepted by the active model profile.`,
        field
      );
    }
  }
  for (const field of UNSUPPORTED_CONTROL_FIELDS) {
    if (allowTools && LLAMA_TOOL_CONTROL_FIELDS.has(field)) continue;
    if (Object.hasOwn(body || {}, field) && body[field] !== null && body[field] !== false) {
      throw new BackendAdapterError(
        400,
        'UNSUPPORTED_PROFILE_CAPABILITY',
        `Field ${field} is not supported by the active model profile.`,
        field
      );
    }
  }
  if (!allowVision && hasMultimodalContent(body?.messages)) {
    throw new BackendAdapterError(
      400,
      'UNSUPPORTED_PROFILE_CAPABILITY',
      'Multimodal message content is not supported by the active model profile.',
      'messages'
    );
  }
  const options = isPlainObject(body?.options) ? body.options : {};
  for (const field of [
    'num_ctx',
    'num_gpu',
    'main_gpu',
    'tensor_split',
    'split_mode',
    'numa',
    'num_thread',
    'cache_prompt',
    'cache_ram',
    'cache_idle_slots',
    'cache_reuse',
    'n_cache_reuse',
    'cache_path',
    'id_slot',
    'slot_id',
    'slot_action',
    'slot_save_path',
    'slot_restore_path'
  ]) {
    if (Object.hasOwn(options, field)) {
      throw new BackendAdapterError(
        400,
        'BACKEND_CONTROL_FORBIDDEN',
        `Backend control options.${field} cannot be supplied through the router.`,
        `options.${field}`
      );
    }
  }
}

function imageSource(value, param, { allowRawBase64 = false } = {}) {
  if (typeof value !== 'string' || !value) {
    throw new BackendAdapterError(400, 'INVALID_IMAGE_INPUT', `${param} must contain non-empty base64 image data.`, param);
  }
  const compact = value.replace(/[\r\n]/g, '');
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(compact)) return compact;
  if (allowRawBase64 && /^[A-Za-z0-9+/=]+$/.test(compact)) return compact;
  throw new BackendAdapterError(
    400,
    'UNSUPPORTED_IMAGE_INPUT',
    `${param} must use inline base64 image data; remote URLs and filesystem paths are not accepted.`,
    param
  );
}

function mappedMessageContent(message, index, allowVision) {
  const param = `messages[${index}]`;
  const role = message?.role;
  const content = message?.content;
  const parts = [];

  if (typeof content === 'string' || content === undefined || content === null) {
    if (typeof content === 'string' && content) parts.push({ type: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      const part = content[partIndex];
      const partParam = `${param}.content[${partIndex}]`;
      if (!isPlainObject(part) || typeof part.type !== 'string') {
        throw new BackendAdapterError(400, 'INVALID_MESSAGE_CONTENT', `${partParam} must be a typed content object.`, partParam);
      }
      if (['text', 'input_text', 'output_text'].includes(part.type)) {
        if (typeof part.text !== 'string') {
          throw new BackendAdapterError(400, 'INVALID_MESSAGE_CONTENT', `${partParam}.text must be a string.`, `${partParam}.text`);
        }
        if (part.text) parts.push({ type: 'text', text: part.text });
        continue;
      }
      if (!allowVision) {
        throw new BackendAdapterError(
          400,
          'UNSUPPORTED_PROFILE_CAPABILITY',
          'Multimodal message content is not supported by the active model profile.',
          partParam
        );
      }
      if (role !== 'user') {
        throw new BackendAdapterError(400, 'UNSUPPORTED_IMAGE_ROLE', 'Images are supported only in user messages.', partParam);
      }
      if (part.type === 'image_url') {
        const image = isPlainObject(part.image_url) ? part.image_url : null;
        if (!image) {
          throw new BackendAdapterError(400, 'INVALID_IMAGE_INPUT', `${partParam}.image_url must be an object.`, `${partParam}.image_url`);
        }
        const url = imageSource(image.url, `${partParam}.image_url.url`);
        const detail = image.detail;
        if (detail !== undefined && !['auto', 'low', 'high'].includes(detail)) {
          throw new BackendAdapterError(400, 'INVALID_IMAGE_INPUT', `${partParam}.image_url.detail must be auto, low, or high.`, `${partParam}.image_url.detail`);
        }
        parts.push({
          type: 'image_url',
          image_url: { url, ...(detail === undefined ? {} : { detail }) }
        });
        continue;
      }
      if (part.type === 'input_image') {
        const url = imageSource(part.image_url, `${partParam}.image_url`);
        parts.push({ type: 'image_url', image_url: { url } });
        continue;
      }
      throw new BackendAdapterError(
        400,
        'UNSUPPORTED_PROFILE_CAPABILITY',
        `Content part type ${part.type} is not supported by the active model profile.`,
        `${partParam}.type`
      );
    }
  } else {
    throw new BackendAdapterError(400, 'INVALID_MESSAGE_CONTENT', `${param}.content must be text or an array of content parts.`, `${param}.content`);
  }

  if (message?.images !== undefined && !Array.isArray(message.images)) {
    throw new BackendAdapterError(400, 'INVALID_IMAGE_INPUT', `${param}.images must be an array.`, `${param}.images`);
  }
  if (Array.isArray(message?.images) && message.images.length) {
    if (!allowVision) {
      throw new BackendAdapterError(
        400,
        'UNSUPPORTED_PROFILE_CAPABILITY',
        'Multimodal message content is not supported by the active model profile.',
        `${param}.images`
      );
    }
    if (role !== 'user') {
      throw new BackendAdapterError(400, 'UNSUPPORTED_IMAGE_ROLE', 'Images are supported only in user messages.', `${param}.images`);
    }
    message.images.forEach((value, imageIndex) => {
      parts.push({
        type: 'image_url',
        image_url: { url: imageSource(value, `${param}.images[${imageIndex}]`, { allowRawBase64: true }) }
      });
    });
  }

  const hasImage = parts.some((part) => part.type === 'image_url');
  return hasImage ? parts : parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
}

function parseToolArguments(value, param) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new BackendAdapterError(400, 'INVALID_TOOL_ARGUMENTS', `${param} must contain a JSON object.`, param);
    }
  }
  if (!isPlainObject(parsed)) {
    throw new BackendAdapterError(400, 'INVALID_TOOL_ARGUMENTS', `${param} must be a JSON object.`, param);
  }
  return parsed;
}

function normalizedToolDefinition(tool, param) {
  if (!isPlainObject(tool) || tool.type !== 'function' || !isPlainObject(tool.function)) {
    throw new BackendAdapterError(400, 'INVALID_TOOL', `${param} must be a function tool.`, param);
  }
  const fn = tool.function;
  if (typeof fn.name !== 'string' || !fn.name.trim()) {
    throw new BackendAdapterError(400, 'INVALID_TOOL', `${param}.function.name must be a non-empty string.`, `${param}.function.name`);
  }
  if (fn.description !== undefined && typeof fn.description !== 'string') {
    throw new BackendAdapterError(400, 'INVALID_TOOL', `${param}.function.description must be a string.`, `${param}.function.description`);
  }
  if (fn.parameters !== undefined && !isPlainObject(fn.parameters)) {
    throw new BackendAdapterError(400, 'INVALID_TOOL', `${param}.function.parameters must be a JSON Schema object.`, `${param}.function.parameters`);
  }
  return {
    type: 'function',
    function: {
      name: fn.name,
      ...(fn.description === undefined ? {} : { description: fn.description }),
      parameters: fn.parameters || { type: 'object', properties: {} }
    }
  };
}

function normalizedToolChoice(value, param) {
  if (['auto', 'none', 'required'].includes(value)) return value;
  if (isPlainObject(value)) {
    const fn = value.function;
    if (value.type === 'function' && isPlainObject(fn) && typeof fn.name === 'string' && fn.name) {
      return { type: 'function', function: { name: fn.name } };
    }
    if (param === 'function_call' && typeof value.name === 'string' && value.name) {
      return { type: 'function', function: { name: value.name } };
    }
  }
  throw new BackendAdapterError(400, 'INVALID_TOOL_CHOICE', `${param} must be auto, none, required, or a named function.`, param);
}

export function normalizeLlamaToolRequest(body, activeModel, protocol) {
  const toolsSupported = activeModel?.capability_profile?.tools === true;
  const toolFieldsPresent = [...LLAMA_TOOL_CONTROL_FIELDS].some((field) => Object.hasOwn(body || {}, field));
  if (!toolFieldsPresent) return { tools: [], controls: {}, templateControls: {} };
  if (!toolsSupported || protocol === 'native-generate') {
    throw new BackendAdapterError(
      400,
      'UNSUPPORTED_PROFILE_CAPABILITY',
      'Tools are not supported by the active model profile on this route.',
      'tools'
    );
  }
  if (Object.hasOwn(body, 'tools') && Object.hasOwn(body, 'functions')) {
    throw new BackendAdapterError(400, 'CONFLICTING_TOOL_FIELDS', 'tools and functions cannot both be supplied.', 'tools');
  }
  if (Object.hasOwn(body, 'tool_choice') && Object.hasOwn(body, 'function_call')) {
    throw new BackendAdapterError(400, 'CONFLICTING_TOOL_FIELDS', 'tool_choice and function_call cannot both be supplied.', 'tool_choice');
  }

  let rawTools = body.tools;
  if (Object.hasOwn(body, 'functions')) {
    if (!Array.isArray(body.functions)) {
      throw new BackendAdapterError(400, 'INVALID_TOOLS', 'functions must be an array.', 'functions');
    }
    rawTools = body.functions.map((fn) => ({ type: 'function', function: fn }));
  }
  if (rawTools !== undefined && !Array.isArray(rawTools)) {
    throw new BackendAdapterError(400, 'INVALID_TOOLS', 'tools must be an array.', 'tools');
  }
  const tools = (rawTools || []).map((tool, index) => normalizedToolDefinition(tool, `tools[${index}]`));

  const rawChoice = body.tool_choice ?? body.function_call;
  const choiceParam = Object.hasOwn(body, 'tool_choice') ? 'tool_choice' : 'function_call';
  const toolChoice = rawChoice === undefined ? undefined : normalizedToolChoice(rawChoice, choiceParam);
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    throw new BackendAdapterError(400, 'INVALID_PARALLEL_TOOL_CALLS', 'parallel_tool_calls must be a boolean.', 'parallel_tool_calls');
  }

  const controls = {
    ...((Object.hasOwn(body, 'tools') || Object.hasOwn(body, 'functions')) ? { tools } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(body.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: body.parallel_tool_calls })
  };
  return {
    tools,
    controls,
    templateControls: tools.length ? { tools } : {}
  };
}

function messagesForLlama(messages, protocol, allowVision = false) {
  const knownCalls = new Map();
  const pendingCalls = [];
  const usedResults = new Set();

  const resolveToolCallId = (message, index) => {
    const suppliedId = message?.tool_call_id;
    const suppliedName = message?.tool_name ?? message?.name;
    if (suppliedId !== undefined && (typeof suppliedId !== 'string' || !suppliedId)) {
      throw new BackendAdapterError(400, 'INVALID_TOOL_HISTORY', `messages[${index}].tool_call_id must be a non-empty string.`, `messages[${index}].tool_call_id`);
    }
    if (suppliedId) {
      const known = knownCalls.get(suppliedId);
      if (!known || usedResults.has(suppliedId) || (suppliedName && suppliedName !== known.name)) {
        throw new BackendAdapterError(400, 'INVALID_TOOL_HISTORY', `messages[${index}] does not match a preceding function call.`, `messages[${index}].tool_call_id`);
      }
      usedResults.add(suppliedId);
      return { id: suppliedId, name: known.name };
    }
    const candidates = pendingCalls.filter((call) => !usedResults.has(call.id)
      && (!suppliedName || call.name === suppliedName));
    if (candidates.length !== 1) {
      throw new BackendAdapterError(400, 'INVALID_TOOL_HISTORY', `messages[${index}] must identify exactly one preceding function call.`, `messages[${index}].tool_call_id`);
    }
    usedResults.add(candidates[0].id);
    return candidates[0];
  };

  return messages.map((message, index) => {
    const role = message?.role;
    if (role === 'tool' || role === 'function') {
      const resolved = resolveToolCallId(message, index);
      if (message?.content !== undefined && typeof message.content !== 'string' && !Array.isArray(message.content)) {
        throw new BackendAdapterError(400, 'INVALID_TOOL_HISTORY', `messages[${index}].content must be text.`, `messages[${index}].content`);
      }
      const content = mappedMessageContent(message, index, allowVision);
      if (Array.isArray(content)) {
        throw new BackendAdapterError(400, 'UNSUPPORTED_IMAGE_ROLE', 'Images are supported only in user messages.', `messages[${index}].content`);
      }
      return {
        role: 'tool',
        content,
        tool_call_id: resolved.id,
        name: resolved.name
      };
    }

    const mapped = { role, content: mappedMessageContent(message, index, allowVision) };
    const reasoningValue = protocol === 'openai-chat' ? message?.reasoning_content : message?.thinking;
    const reasoningField = protocol === 'openai-chat' ? 'reasoning_content' : 'thinking';
    if (reasoningValue !== undefined) {
      if (role !== 'assistant' || typeof reasoningValue !== 'string') {
        throw new BackendAdapterError(400, 'INVALID_REASONING_HISTORY', `${reasoningField} is accepted only as string content on assistant history messages.`, `messages[${index}].${reasoningField}`);
      }
      if (reasoningValue) mapped.reasoning_content = reasoningValue;
    }
    const alternate = protocol === 'openai-chat' ? message?.thinking : message?.reasoning_content;
    if (alternate !== undefined) {
      const alternateField = protocol === 'openai-chat' ? 'thinking' : 'reasoning_content';
      throw new BackendAdapterError(400, 'INVALID_REASONING_HISTORY', `${alternateField} is not valid for this public route.`, `messages[${index}].${alternateField}`);
    }

    const rawToolCalls = message?.tool_calls;
    const legacyFunctionCall = message?.function_call;
    if (rawToolCalls !== undefined || legacyFunctionCall !== undefined) {
      if (role !== 'assistant') {
        throw new BackendAdapterError(400, 'INVALID_TOOL_HISTORY', `messages[${index}] tool calls are valid only on assistant messages.`, `messages[${index}].tool_calls`);
      }
      if (rawToolCalls !== undefined && legacyFunctionCall !== undefined) {
        throw new BackendAdapterError(400, 'CONFLICTING_TOOL_FIELDS', 'tool_calls and function_call cannot both be supplied on a history message.', `messages[${index}].tool_calls`);
      }
      const calls = rawToolCalls ?? [{ type: 'function', function: legacyFunctionCall }];
      if (!Array.isArray(calls) || calls.length === 0) {
        throw new BackendAdapterError(400, 'INVALID_TOOL_HISTORY', `messages[${index}].tool_calls must be a non-empty array.`, `messages[${index}].tool_calls`);
      }
      mapped.tool_calls = calls.map((call, callIndex) => {
        const param = `messages[${index}].tool_calls[${callIndex}]`;
        if (!isPlainObject(call) || (call.type !== undefined && call.type !== 'function') || !isPlainObject(call.function)) {
          throw new BackendAdapterError(400, 'INVALID_TOOL_HISTORY', `${param} must be a function call.`, param);
        }
        if (typeof call.function.name !== 'string' || !call.function.name) {
          throw new BackendAdapterError(400, 'INVALID_TOOL_HISTORY', `${param}.function.name must be a non-empty string.`, `${param}.function.name`);
        }
        const suppliedId = call.id ?? call.call_id;
        if (suppliedId !== undefined && (typeof suppliedId !== 'string' || !suppliedId)) {
          throw new BackendAdapterError(400, 'INVALID_TOOL_HISTORY', `${param}.id must be a non-empty string.`, `${param}.id`);
        }
        const id = suppliedId || `call_router_${index}_${callIndex}`;
        if (knownCalls.has(id)) {
          throw new BackendAdapterError(400, 'INVALID_TOOL_HISTORY', `Duplicate tool call ID ${id}.`, `${param}.id`);
        }
        const normalized = {
          id,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: JSON.stringify(parseToolArguments(call.function.arguments ?? {}, `${param}.function.arguments`))
          }
        };
        const known = { id, name: call.function.name };
        knownCalls.set(id, known);
        pendingCalls.push(known);
        return normalized;
      });
    }
    return mapped;
  });
}

export function validatedReasoningPolicy(activeModel) {
  const policy = activeModel?.reasoning_policy;
  if (!isPlainObject(policy)) return null;
  if (policy.schema_version !== undefined && ![1, 2].includes(policy.schema_version)) {
    throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', 'The active reasoning policy schema version is not supported.');
  }
  if (!isPlainObject(policy.levels) || Object.keys(policy.levels).length === 0) {
    throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', 'The active reasoning policy levels are missing.');
  }

  const levels = {};
  for (const [rawLevel, entry] of Object.entries(policy.levels)) {
    const level = rawLevel.trim().toLowerCase();
    if (rawLevel !== level || !SAFE_POLICY_NAME.test(level)) {
      throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', `The reasoning policy level ${rawLevel} is invalid.`);
    }
    if (!isPlainObject(entry)
      || typeof entry.enabled !== 'boolean'
      || (policy.schema_version === 2
        ? entry.default_output_tokens !== null || entry.max_output_tokens !== null
        : positiveInteger(entry.default_output_tokens) === null
          || positiveInteger(entry.max_output_tokens) === null
          || entry.default_output_tokens > entry.max_output_tokens)) {
      throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', `The active reasoning policy has an invalid ${level} level.`);
    }
    const normalizedEntry = {
      enabled: entry.enabled,
      default_output_tokens: entry.default_output_tokens,
      max_output_tokens: entry.max_output_tokens
    };
    if (entry.enabled) {
      if (typeof entry.template_effort !== 'string' || !SAFE_POLICY_NAME.test(entry.template_effort)) {
        throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', `The ${level} template effort is invalid.`);
      }
      normalizedEntry.template_effort = entry.template_effort;
      if (entry.reasoning_budget_tokens !== undefined
        && entry.reasoning_budget_tokens !== -1
        && positiveInteger(entry.reasoning_budget_tokens) === null) {
        throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', `The ${level} reasoning budget is invalid.`);
      }
      if (entry.reasoning_budget_tokens !== undefined) {
        normalizedEntry.reasoning_budget_tokens = entry.reasoning_budget_tokens;
      }
    } else if (Object.hasOwn(entry, 'template_effort') || Object.hasOwn(entry, 'reasoning_budget_tokens')) {
      throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', `The disabled ${level} level cannot define upstream reasoning controls.`);
    }
    levels[level] = normalizedEntry;
  }

  const aliases = {};
  if (policy.aliases !== undefined && !isPlainObject(policy.aliases)) {
    throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', 'The reasoning aliases must be an object.');
  }
  for (const [rawAlias, rawTarget] of Object.entries(policy.aliases || {})) {
    const alias = rawAlias.trim().toLowerCase();
    const target = typeof rawTarget === 'string' ? rawTarget.trim().toLowerCase() : '';
    if (rawAlias !== alias || !SAFE_POLICY_NAME.test(alias) || !Object.hasOwn(levels, target)) {
      throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', `The reasoning alias ${rawAlias} is invalid.`);
    }
    if (Object.hasOwn(levels, alias) && alias !== target) {
      throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', `The reasoning alias ${alias} conflicts with a configured level.`);
    }
    aliases[alias] = target;
  }

  const defaultName = typeof policy.default_level === 'string' ? policy.default_level.trim().toLowerCase() : '';
  const defaultLevel = aliases[defaultName] || defaultName;
  if (!Object.hasOwn(levels, defaultLevel)) {
    throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', 'The reasoning default level is invalid.');
  }

  const answerReserve = nonNegativeInteger(policy.answer_reserve, 0);
  if (answerReserve === null) {
    throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', 'The reasoning answer reserve is invalid.');
  }
  for (const [level, entry] of Object.entries(levels)) {
    if (entry.default_output_tokens !== null && positiveInteger(entry.reasoning_budget_tokens) !== null
      && entry.default_output_tokens < entry.reasoning_budget_tokens + answerReserve) {
      throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', `The ${level} default does not reserve enough visible-answer capacity.`);
    }
  }

  const outputLimitPolicy = policy.output_limit_policy ?? 'reject';
  if (!['cap', 'reject'].includes(outputLimitPolicy)) {
    throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', 'The reasoning output limit policy must be cap or reject.');
  }
  const booleanTrueBehavior = policy.boolean_true_behavior ?? { mode: 'reject' };
  if (!isPlainObject(booleanTrueBehavior) || !['reject', 'map', 'passthrough'].includes(booleanTrueBehavior.mode)) {
    throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', 'The boolean true behavior is invalid.');
  }
  let booleanLevel = null;
  if (booleanTrueBehavior.mode !== 'reject') {
    const rawBooleanLevel = typeof booleanTrueBehavior.level === 'string'
      ? booleanTrueBehavior.level.trim().toLowerCase()
      : '';
    booleanLevel = aliases[rawBooleanLevel] || rawBooleanLevel;
    if (!Object.hasOwn(levels, booleanLevel) || !levels[booleanLevel].enabled) {
      throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', 'The boolean true behavior must name an enabled level.');
    }
  }

  const reasoningFormat = policy.reasoning_format ?? null;
  if (reasoningFormat !== null
    && (typeof reasoningFormat !== 'string' || !SAFE_POLICY_NAME.test(reasoningFormat))) {
    throw new BackendAdapterError(503, 'INVALID_REASONING_POLICY', 'The reasoning format is invalid.');
  }

  return {
    schema_version: policy.schema_version ?? 1,
    default_level: defaultLevel,
    aliases,
    boolean_true_behavior: {
      mode: booleanTrueBehavior.mode,
      ...(booleanLevel ? { level: booleanLevel } : {})
    },
    output_limit_policy: outputLimitPolicy,
    answer_reserve: answerReserve,
    reasoning_format: reasoningFormat,
    levels
  };
}

function reasoningParam(protocol) {
  return protocol === 'native-chat' || protocol === 'native-generate' ? 'think' : 'reasoning_effort';
}

function normalizeNamedReasoningLevel(value, protocol, policy, param = reasoningParam(protocol)) {
  if (typeof value !== 'string') {
    throw new BackendAdapterError(400, 'INVALID_REASONING_LEVEL', 'Reasoning must be a named level.', param);
  }
  const normalized = value.trim().toLowerCase();
  const level = policy?.aliases?.[normalized] || (normalized === 'none' ? 'off' : normalized);
  if (!policy && level !== 'off') {
    throw new BackendAdapterError(400, 'UNSUPPORTED_PROFILE_CAPABILITY', 'Reasoning is not enabled for the active model profile.', param);
  }
  if (policy && !Object.hasOwn(policy.levels, level)) {
    const supported = [...Object.keys(policy.levels), ...Object.keys(policy.aliases)].join(', ');
    throw new BackendAdapterError(400, 'INVALID_REASONING_LEVEL', `Unsupported reasoning level ${String(value)}; supported values are ${supported}.`, param);
  }
  return level;
}

function resolveReasoningInputs(inputs, protocol, policy) {
  const present = inputs.filter(({ value }) => value !== undefined && value !== null);
  const named = present
    .filter(({ value }) => typeof value === 'string')
    .map(({ value, param }) => ({ level: normalizeNamedReasoningLevel(value, protocol, policy, param), param }));
  if (present.some(({ value }) => typeof value !== 'string' && typeof value !== 'boolean')) {
    const invalid = present.find(({ value }) => typeof value !== 'string' && typeof value !== 'boolean');
    throw new BackendAdapterError(400, 'INVALID_REASONING_LEVEL', 'Reasoning must be a boolean or named level.', invalid.param);
  }
  if (new Set(named.map(({ level }) => level)).size > 1) {
    throw new BackendAdapterError(400, 'CONFLICTING_REASONING_EFFORT', 'Supplied reasoning levels resolve to different efforts.', named.at(-1)?.param || reasoningParam(protocol));
  }
  const namedLevel = named[0]?.level;
  if (present.some(({ value }) => value === false) && namedLevel && !policy?.levels?.[namedLevel]?.enabled) {
    return namedLevel;
  }
  if (present.some(({ value }) => value === false) && namedLevel) {
    throw new BackendAdapterError(400, 'CONFLICTING_REASONING_EFFORT', 'Reasoning cannot be explicitly disabled while a named enabled effort is requested.', named.at(-1)?.param || reasoningParam(protocol));
  }
  if (namedLevel) return namedLevel;
  if (present.some(({ value }) => value === false)) {
    const disabled = Object.entries(policy?.levels || {}).find(([, entry]) => !entry.enabled)?.[0];
    return disabled || 'off';
  }
  if (present.some(({ value }) => value === true)) {
    if (policy && policy.boolean_true_behavior.mode !== 'reject') return policy.boolean_true_behavior.level;
    throw new BackendAdapterError(400, 'INVALID_REASONING_LEVEL', 'A named reasoning level is required; boolean true is not accepted.', present.find(({ value }) => value === true)?.param || reasoningParam(protocol));
  }
  return policy?.default_level || 'off';
}

function requestedReasoning(body, protocol, policy) {
  if (protocol === 'openai-chat') {
    return resolveReasoningInputs([{ value: body?.reasoning_effort, param: 'reasoning_effort' }], protocol, policy);
  }
  if (protocol === 'native-chat' || protocol === 'native-generate') {
    return resolveReasoningInputs([
      { value: body?.think, param: 'think' },
      { value: body?.options?.reasoning_effort, param: 'options.reasoning_effort' }
    ], protocol, policy);
  }
  if (protocol === 'responses') {
    if (body?.reasoning !== undefined && body?.reasoning !== null && !isPlainObject(body.reasoning)) {
      throw new BackendAdapterError(400, 'INVALID_REASONING_LEVEL', 'reasoning must be an object containing only effort.', 'reasoning');
    }
    const nestedKeys = isPlainObject(body?.reasoning) ? Object.keys(body.reasoning) : [];
    if (nestedKeys.some((key) => !['effort', 'summary'].includes(key))) {
      throw new BackendAdapterError(400, 'UNTRUSTED_REASONING_CONTROL', 'Only reasoning.effort and reasoning.summary are accepted by the active model profile.', 'reasoning');
    }
    if (body?.reasoning?.summary !== undefined
      && !['auto', 'concise', 'detailed'].includes(body.reasoning.summary)) {
      throw new BackendAdapterError(400, 'UNSUPPORTED_REASONING_SUMMARY', 'reasoning.summary must be auto, concise, or detailed.', 'reasoning.summary');
    }
    return resolveReasoningInputs([
      { value: body?.reasoning?.effort, param: 'reasoning.effort' },
      { value: body?.reasoning_effort, param: 'reasoning_effort' }
    ], protocol, policy);
  }
  return policy?.default_level || 'off';
}

function requestedOutputLimit(body, protocol) {
  if (protocol === 'openai-chat') {
    const maxTokens = body?.max_tokens;
    const maxCompletionTokens = body?.max_completion_tokens;
    if (maxTokens !== undefined && maxCompletionTokens !== undefined && Number(maxTokens) !== Number(maxCompletionTokens)) {
      throw new BackendAdapterError(400, 'CONFLICTING_OUTPUT_LIMITS', 'max_tokens and max_completion_tokens must match.', 'max_tokens');
    }
    return maxCompletionTokens ?? maxTokens;
  }
  if (protocol === 'responses') return body?.max_output_tokens;
  return body?.options?.num_predict ?? body?.num_predict ?? body?.n_predict;
}

export function normalizeLlamaReasoningRequest(body, activeModel, protocol) {
  const policy = validatedReasoningPolicy(activeModel);
  const level = requestedReasoning(body, protocol, policy);
  const enabled = policy?.levels?.[level]?.enabled === true;
  if (protocol === 'native-generate' && enabled) {
    throw new BackendAdapterError(400, 'REASONING_ROUTE_UNSUPPORTED', 'Enabled reasoning is supported on chat routes, not /api/generate.', 'think');
  }

  const entry = policy?.levels?.[level] || {
    enabled: false,
    default_output_tokens: positiveInteger(activeModel?.default_output_tokens, 512),
    max_output_tokens: positiveInteger(activeModel?.max_output_tokens, 4096)
  };
  const rawLimit = requestedOutputLimit(body, protocol);
  const unlimited = policy?.schema_version === 2;
  const nativeUnlimited = protocol.startsWith('native') && rawLimit === -1;
  const requestedOutputTokens = rawLimit === undefined || rawLimit === null || nativeUnlimited
    ? null
    : positiveInteger(rawLimit);
  let outputTokens = requestedOutputTokens === null && rawLimit !== undefined && rawLimit !== null && !nativeUnlimited
    ? null
    : (requestedOutputTokens ?? entry.default_output_tokens);
  const outputParam = protocol === 'responses' ? 'max_output_tokens' : (protocol.startsWith('native') ? 'options.num_predict' : 'max_tokens');
  if (outputTokens === null && !(unlimited && (rawLimit == null || nativeUnlimited))) {
    throw new BackendAdapterError(400, 'INVALID_OUTPUT_LIMIT', 'The requested output limit must be a positive integer.', outputParam);
  }
  const outputLimitCapped = !unlimited && outputTokens > entry.max_output_tokens && policy?.output_limit_policy === 'cap';
  if (outputLimitCapped) outputTokens = entry.max_output_tokens;
  if (!unlimited && outputTokens > entry.max_output_tokens) {
    throw new BackendAdapterError(400, 'OUTPUT_LIMIT_EXCEEDED', `Reasoning level ${level} permits at most ${entry.max_output_tokens} total output tokens.`, outputParam);
  }
  if (outputTokens !== null && entry.enabled && entry.reasoning_budget_tokens !== -1) {
    const required = entry.reasoning_budget_tokens + policy.answer_reserve;
    if (outputTokens < required) {
      throw new BackendAdapterError(400, 'REASONING_OUTPUT_BUDGET_TOO_SMALL', `Reasoning level ${level} requires at least ${required} total output tokens (${entry.reasoning_budget_tokens} reasoning plus ${policy.answer_reserve} answer reserve).`, outputParam);
    }
  }

  const cleanBody = { ...(body || {}) };
  const requestedThinkingBudget = body?.reasoning_budget_tokens ?? body?.options?.reasoning_budget_tokens;
  if (requestedThinkingBudget !== undefined && (!Number.isSafeInteger(requestedThinkingBudget) || requestedThinkingBudget < -1)) {
    throw new BackendAdapterError(400, 'INVALID_REASONING_BUDGET', 'reasoning_budget_tokens must be -1 (unrestricted) or a nonnegative integer.', 'reasoning_budget_tokens');
  }
  if (unlimited) delete cleanBody.reasoning_budget_tokens;
  delete cleanBody.reasoning_effort;
  delete cleanBody.reasoning;
  delete cleanBody.think;
  if (isPlainObject(cleanBody.options) && Object.hasOwn(cleanBody.options, 'reasoning_effort')) {
    cleanBody.options = { ...cleanBody.options };
    delete cleanBody.options.reasoning_effort;
  }
  rejectUnsupportedFields(cleanBody, {
    allowTools: activeModel?.capability_profile?.tools === true && protocol !== 'native-generate',
    allowVision: activeModel?.capability_profile?.vision === true && protocol !== 'native-generate'
  });

  const controls = entry.enabled
    ? {
      chat_template_kwargs: { enable_thinking: true },
      ...(entry.template_effort === 'default' ? {} : { reasoning_effort: entry.template_effort }),
      ...(policy?.reasoning_format ? { reasoning_format: policy.reasoning_format } : {}),
      ...((entry.reasoning_budget_tokens === undefined || (entry.reasoning_budget_tokens === -1 && !unlimited)) ? {} : { reasoning_budget_tokens: entry.reasoning_budget_tokens })
    }
    : { chat_template_kwargs: { enable_thinking: false } };
  if (unlimited && requestedThinkingBudget !== undefined) controls.reasoning_budget_tokens = requestedThinkingBudget;

  return {
    level,
    enabled: entry.enabled,
    outputTokens,
    requestedOutputTokens,
    maxOutputTokens: entry.max_output_tokens,
    outputLimitPolicy: policy?.output_limit_policy ?? 'reject',
    outputLimitCapped,
    answerReserve: policy?.answer_reserve ?? 0,
    reasoningBudgetTokens: entry.reasoning_budget_tokens ?? null,
    controls,
    cleanBody
  };
}

export function normalizeOutputLimit(body, activeModel, protocol = 'openai') {
  const configuredDefault = positiveInteger(activeModel?.default_output_tokens, 512);
  const configuredMax = positiveInteger(activeModel?.max_output_tokens, 4096);
  let requested;
  if (protocol === 'openai') {
    const maxTokens = body?.max_tokens;
    const maxCompletionTokens = body?.max_completion_tokens;
    if (maxTokens !== undefined && maxCompletionTokens !== undefined && Number(maxTokens) !== Number(maxCompletionTokens)) {
      throw new BackendAdapterError(400, 'CONFLICTING_OUTPUT_LIMITS', 'max_tokens and max_completion_tokens must match.', 'max_tokens');
    }
    requested = maxCompletionTokens ?? maxTokens;
  } else {
    requested = body?.options?.num_predict ?? body?.num_predict;
  }
  const limit = requested === undefined || requested === null
    ? configuredDefault
    : positiveInteger(requested);
  if (limit === null) {
    throw new BackendAdapterError(400, 'INVALID_OUTPUT_LIMIT', 'The requested output limit must be a positive integer.', 'max_tokens');
  }
  if (limit > configuredMax) {
    throw new BackendAdapterError(
      400,
      'OUTPUT_LIMIT_EXCEEDED',
      `The active profile permits at most ${configuredMax} output tokens.`,
      'max_tokens'
    );
  }
  return limit;
}

function completionUsage(payload) {
  return {
    prompt_eval_count: positiveInteger(payload?.usage?.prompt_tokens, 0),
    eval_count: positiveInteger(payload?.usage?.completion_tokens, 0),
    total_duration: null,
    prompt_eval_duration: null,
    eval_duration: null
  };
}

function structuredOutputControls(body) {
  if (body?.response_format) return { response_format: body.response_format };
  if (body?.format === 'json') return { response_format: { type: 'json_object' } };
  if (isPlainObject(body?.format)) return { response_format: { type: 'json_schema', json_schema: { name: 'response', schema: body.format, strict: true } } };
  return {};
}

function invalidJsonLiteralOffset(value) {
  const literals = new Map([['t', 'true'], ['f', 'false'], ['n', 'null']]);
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    const literal = literals.get(character);
    if (literal) {
      for (let offset = 0; offset < literal.length; offset += 1) {
        if (value[index + offset] !== literal[offset]) return index + offset;
      }
      index += literal.length - 1;
      continue;
    }
    if (/[A-DF-Za-df-z_]/.test(character)) return index;
  }
  return null;
}

function jsonAppearsIncomplete(value) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' && stack.at(-1) === '{') stack.pop();
    else if (character === ']' && stack.at(-1) === '[') stack.pop();
  }
  if (inString || stack.length > 0) return true;
  const trimmed = value.trimEnd();
  return /[:,]$/.test(trimmed) || /(?:^|[\s:[,{])(?:tru|fals|nul|-?\d+(?:\.\d*)?(?:[eE][+-]?)?)$/.test(trimmed);
}

function normalizedJsonError(error, value) {
  const message = String(error?.message || '');
  const offsetMatch = /(?:at position|position)\s+(\d+)/i.exec(message);
  const literalOffset = invalidJsonLiteralOffset(value);
  const unexpectedEnd = literalOffset === null && jsonAppearsIncomplete(value);
  return {
    jsonErrorCategory: unexpectedEnd ? 'unexpected_end' : 'invalid_syntax',
    jsonErrorOffset: unexpectedEnd
      ? value.length
      : (offsetMatch ? Number(offsetMatch[1]) : literalOffset)
  };
}

function openAiToolCallsToOllama(rawToolCalls, diagnosticsByIndex = null) {
  if (rawToolCalls === undefined || rawToolCalls === null) return [];
  if (!Array.isArray(rawToolCalls)) {
    throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'llama.cpp returned malformed function calls.');
  }
  const ids = new Set();
  return rawToolCalls.map((call, index) => {
    if (!isPlainObject(call) || !isPlainObject(call.function)
      || typeof call.function.name !== 'string' || !call.function.name) {
      throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'llama.cpp returned a malformed function call.');
    }
    const id = typeof call.id === 'string' && call.id
      ? call.id
      : (typeof call.call_id === 'string' && call.call_id ? call.call_id : `call_llama_${index}`);
    if (ids.has(id)) {
      throw new BackendAdapterError(502, 'DUPLICATE_UPSTREAM_TOOL_CALL_ID', 'llama.cpp returned duplicate function call IDs.');
    }
    ids.add(id);
    let args = call.function.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch (error) {
        const toolIndex = Number.isInteger(call.function.index) ? call.function.index : index;
        const diagnostics = diagnosticsByIndex?.get(toolIndex);
        throw new BackendAdapterError(
          502,
          'MALFORMED_UPSTREAM_TOOL_ARGUMENTS',
          'llama.cpp returned malformed function arguments.',
          null,
          diagnostics ? { ...diagnostics, ...normalizedJsonError(error, call.function.arguments) } : null
        );
      }
    }
    if (!isPlainObject(args)) {
      throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_TOOL_ARGUMENTS', 'llama.cpp function arguments must be a JSON object.');
    }
    return {
      id,
      type: 'function',
      function: {
        ...(Number.isInteger(call.function.index) ? { index: call.function.index } : {}),
        name: call.function.name,
        arguments: args
      }
    };
  });
}

export function openAiCompletionToOllama(payload, { kind, model }) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content ?? choice?.text ?? '';
  const thinking = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : '';
  const incomplete = choice?.finish_reason && !['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason);
  const toolCalls = incomplete ? [] : openAiToolCallsToOllama(choice?.message?.tool_calls);
  const usage = completionUsage(payload);
  const common = {
    model,
    created_at: new Date().toISOString(),
    done: true,
    done_reason: choice?.finish_reason || 'incomplete',
    ...((payload?.x_router || (incomplete && choice?.message?.tool_calls)) ? { x_router: {
      ...payload.x_router, ...(incomplete && choice?.message?.tool_calls ? { partial_tool_calls: choice.message.tool_calls } : {})
    } } : {}),
    prompt_eval_count: usage.prompt_eval_count,
    eval_count: usage.eval_count,
    ...(payload?.timings ? { timings: payload.timings } : {})
  };
  if (kind === 'native-generate') return { ...common, response: content };
  return {
    ...common,
    message: {
      role: 'assistant',
      content,
      ...(thinking ? { thinking } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    }
  };
}

function sseFrames(buffer, flush = false) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  if (!flush) return { frames: frames.slice(0, -1), remainder: frames.at(-1) || '' };
  return { frames: frames.filter((frame) => frame.trim()), remainder: '' };
}

function dataLines(frame) {
  return frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

export function openAiSseToOllamaStream(readable, {
  kind,
  model,
  usageState = {},
  requestedOutputTokens = null
}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let doneSent = false;
  let lastTimings = null;
  let routerMetadata = null;
  let toolsSent = false;
  const pendingToolCalls = new Map();
  const termination = {
    finishReason: null,
    completionTokens: null,
    requestedOutputTokens: positiveInteger(requestedOutputTokens)
  };

  const toolDiagnostics = (pending) => {
    const argumentsText = pending.arguments || '{}';
    return {
      toolIndex: pending.index,
      toolName: pending.name,
      toolCallIdPresent: Boolean(pending.id),
      argumentDeltaCount: pending.argumentDeltaCount,
      argumentDeltaTypes: pending.argumentDeltaTypes,
      argumentDeltaTypesTruncated: pending.argumentDeltaTypesTruncated,
      argumentBytes: encoder.encode(argumentsText).byteLength,
      argumentSha256: createHash('sha256').update(argumentsText).digest('hex'),
      finishReason: termination.finishReason,
      completionTokens: termination.completionTokens,
      requestedOutputTokens: termination.requestedOutputTokens,
      outputLimitReached: termination.completionTokens !== null && termination.requestedOutputTokens !== null
        ? termination.completionTokens >= termination.requestedOutputTokens
        : null
    };
  };

  const recordToolDeltas = (rawToolCalls) => {
    if (rawToolCalls === undefined) return;
    if (!Array.isArray(rawToolCalls)) {
      throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'llama.cpp returned malformed streaming function calls.');
    }
    rawToolCalls.forEach((call, position) => {
      if (!isPlainObject(call)) {
        throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'llama.cpp returned a malformed streaming function call.');
      }
      const index = Number.isInteger(call.index) ? call.index : position;
      let pending = pendingToolCalls.get(index);
      if (!pending) {
        pending = {
          index,
          id: null,
          type: 'function',
          name: null,
          arguments: '',
          argumentDeltaCount: 0,
          argumentDeltaTypes: [],
          argumentDeltaTypesTruncated: false
        };
        pendingToolCalls.set(index, pending);
      }
      if (call.id !== undefined) {
        if (typeof call.id !== 'string' || !call.id || (pending.id && pending.id !== call.id)) {
          throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'llama.cpp returned an inconsistent streaming function call ID.');
        }
        pending.id = call.id;
      }
      if (call.type !== undefined && call.type !== 'function') {
        throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'llama.cpp returned an unsupported streaming tool type.');
      }
      if (call.function !== undefined) {
        if (!isPlainObject(call.function)) {
          throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'llama.cpp returned a malformed streaming function call.');
        }
        if (call.function.name !== undefined) {
          if (typeof call.function.name !== 'string' || !call.function.name
            || (pending.name && pending.name !== call.function.name)) {
            throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_TOOL_CALL', 'llama.cpp returned an inconsistent streaming function name.');
          }
          pending.name = call.function.name;
        }
        if (call.function.arguments !== undefined) {
          pending.argumentDeltaCount += 1;
          if (pending.argumentDeltaTypes.length < MAX_TOOL_ARGUMENT_DIAGNOSTIC_DELTAS) {
            pending.argumentDeltaTypes.push(Array.isArray(call.function.arguments) ? 'array' : typeof call.function.arguments);
          } else {
            pending.argumentDeltaTypesTruncated = true;
          }
          if (typeof call.function.arguments === 'string') {
            pending.arguments += call.function.arguments;
          } else if (isPlainObject(call.function.arguments) && !pending.arguments) {
            pending.arguments = JSON.stringify(call.function.arguments);
          } else {
            throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_TOOL_ARGUMENTS', 'llama.cpp returned malformed streaming function arguments.');
          }
        }
      }
    });
  };

  const emitPendingTools = (controller) => {
    if (toolsSent || pendingToolCalls.size === 0) return;
    const calls = [...pendingToolCalls.values()]
      .sort((left, right) => left.index - right.index)
      .map((call) => ({
        id: call.id || `call_llama_${call.index}`,
        type: 'function',
        function: { index: call.index, name: call.name, arguments: call.arguments || '{}' }
      }));
    const diagnosticsByIndex = new Map(
      [...pendingToolCalls.values()].map((pending) => [pending.index, toolDiagnostics(pending)])
    );
    if (routerMetadata && !['stop', 'tool_calls', 'function_call'].includes(termination.finishReason)) {
      routerMetadata = { ...routerMetadata, partial_tool_calls: calls };
      toolsSent = true;
      return;
    }
    const toolCalls = openAiToolCallsToOllama(calls, diagnosticsByIndex);
    controller.enqueue(encoder.encode(`${JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '', tool_calls: toolCalls },
      done: false
    })}\n`));
    toolsSent = true;
  };

  const emitFinal = (controller) => {
    if (doneSent) return;
    // With include_usage, llama.cpp reports counts in a choices:[] trailer
    // after the finish_reason chunk, so [DONE] is the safe finalization point.
    if (!termination.finishReason) throw new BackendAdapterError(502, 'INCOMPLETE_UPSTREAM_STREAM', 'The backend terminal event has no finish reason.');
    emitPendingTools(controller);
    const usage = usageState.usage;
    const finalPayload = {
      model,
      created_at: new Date().toISOString(),
      ...(kind === 'native-generate' ? { response: '' } : { message: { role: 'assistant', content: '' } }),
      done: true,
      done_reason: termination.finishReason,
      ...(routerMetadata ? { x_router: routerMetadata } : {}),
      prompt_eval_count: positiveInteger(usage?.prompt_tokens, 0),
      eval_count: positiveInteger(usage?.completion_tokens, 0),
      ...(lastTimings ? { timings: lastTimings } : {})
    };
    controller.enqueue(encoder.encode(`${JSON.stringify(finalPayload)}\n`));
    doneSent = true;
  };

  const convertFrame = (frame, controller) => {
    const data = dataLines(frame);
    if (!data) return;
    if (data === '[DONE]') {
      emitFinal(controller);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_STREAM', 'llama.cpp returned malformed SSE JSON.');
    }
    if (payload.x_router) routerMetadata = payload.x_router;
    if (payload.usage) usageState.usage = payload.usage;
    if (payload.timings) lastTimings = payload.timings;
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (choice?.finish_reason) termination.finishReason = choice.finish_reason;
    const completionTokens = nonNegativeInteger(payload?.usage?.completion_tokens);
    if (completionTokens !== null) termination.completionTokens = completionTokens;
    const content = choice?.delta?.content ?? choice?.text ?? '';
    const thinking = typeof choice?.delta?.reasoning_content === 'string' ? choice.delta.reasoning_content : '';
    recordToolDeltas(choice?.delta?.tool_calls);
    if (thinking && kind !== 'native-generate') {
      controller.enqueue(encoder.encode(`${JSON.stringify({
        model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: '', thinking },
        done: false
      })}\n`));
    }
    if (content) {
      const chunk = {
        model,
        created_at: new Date().toISOString(),
        ...(kind === 'native-generate' ? { response: content } : { message: { role: 'assistant', content } }),
        done: false
      };
      controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
    }
  };

  return readable.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const parsed = sseFrames(buffer);
      buffer = parsed.remainder;
      for (const frame of parsed.frames) convertFrame(frame, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      const parsed = sseFrames(buffer, true);
      for (const frame of parsed.frames) convertFrame(frame, controller);
      if (!doneSent) {
        throw new BackendAdapterError(502, 'INCOMPLETE_UPSTREAM_STREAM', 'llama.cpp ended its stream without a terminal event.');
      }
    }
  }));
}

export function normalizeOpenAiSseModel(readable, model, onPayload = null) {
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  let finishReason = null;
  const emit = (frame, controller) => {
    const data = dataLines(frame);
    if (!data || data === '[DONE]') {
      if (data === '[DONE]') {
        if (!finishReason) throw new BackendAdapterError(502, 'INCOMPLETE_UPSTREAM_STREAM', 'Terminal event has no finish reason.');
        terminal = true;
      }
      controller.enqueue(encoder.encode(`${frame}\n\n`));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new BackendAdapterError(502, 'MALFORMED_UPSTREAM_STREAM', 'llama.cpp returned malformed SSE JSON.');
    }
    if (payload.choices?.[0]?.finish_reason) finishReason = payload.choices[0].finish_reason;
    payload.model = model;
    onPayload?.(payload);
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };
  return readable.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const parsed = sseFrames(buffer);
      buffer = parsed.remainder;
      for (const frame of parsed.frames) emit(frame, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      const parsed = sseFrames(buffer, true);
      for (const frame of parsed.frames) emit(frame, controller);
      if (!terminal) throw new BackendAdapterError(502, 'INCOMPLETE_UPSTREAM_STREAM', 'Backend ended without a terminal event.');
    }
  }));
}

class BackendAdapter {
  constructor(config, activeModel) {
    this.config = config;
    this.activeModel = activeModel;
  }

  get kind() {
    return OLLAMA_KIND;
  }

  get upstreamConfig() {
    return this.config;
  }

  get maxActiveRequests() {
    return null;
  }

  get admissionKey() {
    return `${this.kind}:${this.upstreamConfig.upstreamUrl}`;
  }

  async ensureAvailable(signal) {
    signal?.throwIfAborted();
    if (!this.activeModel.catalog_mode) return;
    let health;
    try {
      health = await upstreamJson(this.upstreamConfig, '/health', { timeoutMs: 3000, signal, maxResponseBytes: 16384 });
    } catch {
      signal?.throwIfAborted();
    }
    if (!health?.ok || health.body?.status !== 'ok') {
      throw new BackendAdapterError(503, 'BACKEND_UNAVAILABLE', `The backend for ${this.activeModel.model} is unavailable. Retry when this service is healthy.`, 'model');
    }
    if (this.activeModel.output_policy === 'unrestricted') {
      const launch = this.activeModel.raw?.runtime_output_policy;
      if (launch?.verification !== 'docker-inspect-argv' || launch.n_predict !== -1
        || launch.reasoning_budget !== -1 || launch.reasoning_effort !== 'default' || !launch.container_id) {
        throw new BackendAdapterError(503, 'BACKEND_LAUNCH_NOT_VERIFIED', 'Publish the catalog after verifying actual running --n-predict -1 --reasoning-budget -1 --reasoning-effort default arguments. This pinned engine reports -1 in /props even under a capped launch.', 'model');
      }
      const props = await upstreamJson(this.upstreamConfig, '/props', { timeoutMs: 5000, signal });
      if (props.body?.default_generation_settings?.params?.n_predict !== -1) {
        throw new BackendAdapterError(503, 'BACKEND_OUTPUT_POLICY_MISMATCH', 'The running backend must launch with --n-predict -1. In this pinned engine request -1 inherits the launch default.', 'model');
      }
    }
  }

  async health() {
    const started = Date.now();
    try {
      const version = await upstreamJson(this.upstreamConfig, '/api/version', { timeoutMs: 5000 });
      return {
        ok: version.ok,
        status: version.status,
        latencyMs: Date.now() - started,
        backendKind: this.kind,
        version: version.body,
        error: version.ok ? null : version.text
      };
    } catch (error) {
      return { ok: false, status: null, latencyMs: Date.now() - started, backendKind: this.kind, version: null, error: error.message };
    }
  }

  async ps() {
    try {
      return (await upstreamJson(this.upstreamConfig, '/api/ps', { timeoutMs: 10000 })).body;
    } catch (error) {
      return { error: error.message, models: [] };
    }
  }

  async show(model) {
    return await upstreamJson(this.upstreamConfig, '/api/show', {
      method: 'POST',
      body: { model },
      timeoutMs: Math.min(this.config.upstreamTimeoutMs, 10000)
    });
  }

  async prepareProxy({ method, pathname, body, query }) {
    return {
      upstreamPath: `${pathname}${query || ''}`,
      upstreamBody: body,
      responseKind: 'passthrough',
      streaming: body?.stream !== false,
      method
    };
  }

  prepareResponses(translated) {
    return { path: '/api/chat', body: translated.upstreamBody, responseKind: 'ollama' };
  }

  async adaptResponsesResponse(response) {
    return response;
  }
}

export class OllamaBackendAdapter extends BackendAdapter {
  get kind() {
    return OLLAMA_KIND;
  }
}

export class LlamaCppBackendAdapter extends BackendAdapter {
  get kind() {
    return LLAMA_CPP_KIND;
  }

  get upstreamConfig() {
    return clonedConfig(this.config, this.activeModel.backend_url || this.config.llamaCppUpstreamUrl);
  }

  get maxActiveRequests() {
    return positiveInteger(this.activeModel.max_active_requests, 2);
  }

  async health() {
    const started = Date.now();
    try {
      const health = await upstreamJson(this.upstreamConfig, '/health', { timeoutMs: 5000 });
      return {
        ok: health.ok && health.body?.status === 'ok',
        status: health.status,
        latencyMs: Date.now() - started,
        backendKind: this.kind,
        version: { revision: this.activeModel.backend_revision || null },
        error: health.ok ? null : health.text
      };
    } catch (error) {
      return { ok: false, status: null, latencyMs: Date.now() - started, backendKind: this.kind, version: null, error: error.message };
    }
  }

  async ps() {
    try {
      const [models, slots] = await Promise.all([
        upstreamJson(this.upstreamConfig, '/v1/models', { timeoutMs: 10000 }),
        upstreamJson(this.upstreamConfig, '/slots', { timeoutMs: 10000 })
      ]);
      const model = models.body?.data?.find((entry) => entry?.id === this.activeModel.model) || models.body?.data?.[0];
      return {
        models: model ? [{
          name: this.activeModel.model,
          model: this.activeModel.model,
          context_length: this.activeModel.context_length,
          total_context_length: this.activeModel.total_context_length,
          slots: Array.isArray(slots.body) ? slots.body.length : null,
          expires_at: '9999-12-31T23:59:59Z'
        }] : []
      };
    } catch (error) {
      return { error: error.message, models: [] };
    }
  }

  async show() {
    return {
      ok: true,
      status: 200,
      body: {
        model: this.activeModel.model,
        capabilities: [
          'completion',
          ...(this.activeModel.reasoning_policy ? ['thinking'] : []),
          ...(this.activeModel.capability_profile?.tools === true ? ['tools'] : []),
          ...(this.activeModel.capability_profile?.vision === true ? ['vision'] : [])
        ],
        details: { backend: 'llama_cpp', format: 'gguf', family: 'qwen3', parameter_size: '27B', quantization_level: this.activeModel.raw?.quantization },
        model_info: { context_length: this.activeModel.context_length },
        ...(this.activeModel.catalog_mode ? { x_ollama_router: {
          display_name: this.activeModel.raw?.display_name ?? this.activeModel.model,
          upstream_model: this.activeModel.model, aliases: this.activeModel.aliases,
          context_window: this.activeModel.context_length, context_safety_reserve: enforcedContextSafetyReserve(this.activeModel),
          active_request_limit: this.maxActiveRequests, max_output_tokens: this.activeModel.max_output_tokens,
          default_output_tokens: this.activeModel.default_output_tokens,
          input_modalities: this.activeModel.input_modalities, artifact: this.activeModel.raw.artifact
        } } : {})
      },
      text: ''
    };
  }

  async validateContext(messages, outputTokens, templateControls = {}, signal) {
    const slotContext = positiveInteger(this.activeModel.context_length, 131072);
    const reserve = enforcedContextSafetyReserve(this.activeModel);
    let applied;
    try {
      applied = await upstreamJson(this.upstreamConfig, '/apply-template', {
        signal,
        method: 'POST',
        body: {
          messages,
          ...(templateControls.chat_template_kwargs ? { chat_template_kwargs: templateControls.chat_template_kwargs } : {}),
          ...(templateControls.reasoning_effort ? { reasoning_effort: templateControls.reasoning_effort } : {}),
          ...(templateControls.tools ? { tools: templateControls.tools } : {})
        },
        timeoutMs: Math.min(this.config.upstreamTimeoutMs, 120000)
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new BackendAdapterError(503, 'TOKENIZER_UNAVAILABLE', `The backend for ${this.activeModel.model} could not apply its chat template: ${error.message}`);
    }
    const prompt = applied.body?.prompt;
    if (!applied.ok || typeof prompt !== 'string') {
      throw new BackendAdapterError(503, 'TOKENIZER_UNAVAILABLE', 'The active backend did not return a valid formatted prompt.');
    }
    let tokenized;
    try {
      tokenized = await upstreamJson(this.upstreamConfig, '/tokenize', {
        signal,
        method: 'POST',
        body: { content: prompt, add_special: false },
        timeoutMs: Math.min(this.config.upstreamTimeoutMs, 300000)
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new BackendAdapterError(503, 'TOKENIZER_UNAVAILABLE', `The backend for ${this.activeModel.model} could not tokenize the formatted prompt: ${error.message}`);
    }
    let inputTokens = Array.isArray(tokenized.body?.tokens) ? tokenized.body.tokens.length : null;
    if (!tokenized.ok || inputTokens === null) {
      throw new BackendAdapterError(503, 'TOKENIZER_UNAVAILABLE', 'The active backend did not return a valid token array.');
    }
    if (hasMultimodalContent(messages) && this.activeModel.catalog_mode) {
      // Text tokenization omits projector patch tokens. A zero-generation prefill
      // uses the actual selected template/projector under this request's lease.
      const counted = await upstreamFetch(this.upstreamConfig, '/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        generation: true, progressPath: '/slots',
        body: JSON.stringify({ model: this.activeModel.model, messages, ...templateControls, n_predict: 0, stream: false })
      });
      const payload = await counted.json();
      if (!counted.ok || !Number.isSafeInteger(payload?.usage?.prompt_tokens)) {
        throw new BackendAdapterError(counted.status === 400 ? 400 : 503,
          counted.status === 400 ? OPENAI_CONTEXT_LENGTH_EXCEEDED_CODE : 'TOKENIZER_UNAVAILABLE',
          payload.error?.message || 'The backend could not count the actual multimodal prompt.', 'messages');
      }
      inputTokens = payload.usage.prompt_tokens;
    }
    if (inputTokens + (outputTokens ?? 1) + reserve > slotContext) {
      throw new BackendAdapterError(
        400,
        OPENAI_CONTEXT_LENGTH_EXCEEDED_CODE,
        `Formatted input (${inputTokens}) plus ${outputTokens === null ? 'minimum generation space (1; unrestricted output)' : `requested output (${outputTokens})`} and safety reserve (${reserve}) exceeds the ${slotContext}-token slot${this.activeModel.catalog_mode ? ` for ${this.activeModel.model}` : ''}.`,
        'messages'
      );
    }
    return { inputTokens, outputTokens, outputPolicy: outputTokens === null ? 'unrestricted' : 'explicit', availableTokens: slotContext - inputTokens - reserve, reserve, slotContext };
  }

  async prepareWorkingContext(messages, outputTokens, controls, original, signal) {
    if (!this.activeModel.catalog_mode) return { messages, context: await this.validateContext(messages, outputTokens, controls, signal) };
    const journal = await openGenerationJournal(this.config, original);
    try {
      try {
        const context = await this.validateContext(messages, outputTokens, controls, signal);
        await journal.append({ type: 'admission', ...context });
        return { messages, journal, context };
      } catch (error) {
        if (error.code !== OPENAI_CONTEXT_LENGTH_EXCEEDED_CODE || outputTokens !== null) throw error;
        try {
          const transition = await rebaseContext(this, messages, controls, signal);
          return { ...transition, journal, transition };
        } catch (recoveryError) {
          if (recoveryError.code !== 'CONTEXT_RECOVERY_UNAVAILABLE') throw recoveryError;
          // Recovery being unsupported does not turn a measured input overflow
          // into a backend outage. Preserve the actionable context error and
          // token arithmetic so clients can page tool results or compact history.
          error.message += ` Automatic context recovery is unavailable: ${recoveryError.message} Use smaller or paged tool results, or shorten the conversation history.`;
          throw error;
        }
      }
    } catch (error) {
      await journal.append({ type: 'terminal', status: 'incomplete', error: { code: error.code, message: error.message } });
      await journal.close();
      throw error;
    }
  }

  async prepareProxy({ method, pathname, body, signal }) {
    if (['/api/embed', '/api/embeddings'].includes(pathname)) {
      throw new BackendAdapterError(400, 'UNSUPPORTED_PROFILE_CAPABILITY', 'Embeddings are not enabled for the active model profile.');
    }

    if (requestIsStatus(method, pathname)) {
      return { localResponse: await this.statusResponse(method, pathname, body) };
    }

    let messages;
    let responseKind;
    let protocol;
    if (pathname === '/v1/chat/completions') {
      messages = body?.messages;
      responseKind = 'openai-chat';
      protocol = 'openai-chat';
    } else if (pathname === '/api/chat') {
      messages = body?.messages;
      responseKind = 'native-chat';
      protocol = 'native-chat';
    } else if (pathname === '/api/generate') {
      messages = [{ role: 'user', content: typeof body?.prompt === 'string' ? body.prompt : '' }];
      responseKind = 'native-generate';
      protocol = 'native-generate';
    } else {
      throw new BackendAdapterError(404, 'ROUTE_NOT_SUPPORTED_BY_BACKEND', 'The selected backend does not support this route.');
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new BackendAdapterError(400, 'INVALID_MESSAGES', 'At least one chat message is required.', 'messages');
    }
    const reasoning = normalizeLlamaReasoningRequest(body, this.activeModel, protocol);
    const toolRequest = normalizeLlamaToolRequest(reasoning.cleanBody, this.activeModel, protocol);
    const outputTokens = reasoning.outputTokens;
    const mappedMessages = messagesForLlama(
      messages,
      protocol,
      this.activeModel.capability_profile?.vision === true && protocol !== 'native-generate'
    );
    const templateControls = { ...reasoning.controls, ...toolRequest.templateControls };
    const working = await this.prepareWorkingContext(mappedMessages, outputTokens, templateControls, body, signal);
    const context = working.context;
    const temperature = llamaTemperature(body);
    const upstreamBody = {
      model: this.activeModel.model,
      messages: working.messages,
      stream: body?.stream !== false,
      ...(body?.stream === false ? {} : { stream_options: { include_usage: true } }),
      ...temperature.controls,
      ...(outputTokens === null ? { n_predict: -1 } : { max_tokens: outputTokens }),
      ...reasoning.controls,
      ...toolRequest.controls,
      ...structuredOutputControls(body),
      ...(body?.seed === undefined ? {} : { seed: body.seed }),
      ...(body?.stop === undefined ? {} : { stop: body.stop }),
      ...(body?.top_p === undefined && body?.options?.top_p === undefined ? {} : { top_p: body?.top_p ?? body?.options?.top_p })
    };
    return {
      upstreamPath: '/v1/chat/completions',
      upstreamBody,
      responseKind,
      streaming: upstreamBody.stream,
      method: 'POST',
      context,
      journal: working.journal,
      transition: working.transition,
      reasoning,
      templateControls,
      temperatureForwarding: temperature.forwarding,
      ...(Object.hasOwn(temperature, 'forwardedTemperature')
        ? { forwardedTemperature: temperature.forwardedTemperature }
        : {})
    };
  }

  async statusResponse(method, pathname) {
    if (method === 'GET' && pathname === '/api/version') {
      return { status: 200, body: { version: `llama.cpp-${this.activeModel.backend_revision || 'pinned'}` } };
    }
    if (method === 'GET' && pathname === '/api/tags') {
      return { status: 200, body: { models: [{ name: this.activeModel.model, model: this.activeModel.model }] } };
    }
    if (method === 'GET' && pathname === '/api/ps') {
      return { status: 200, body: await this.ps() };
    }
    if (method === 'POST' && pathname === '/api/show') {
      return { status: 200, body: (await this.show()).body };
    }
    throw new BackendAdapterError(404, 'ROUTE_NOT_SUPPORTED_BY_BACKEND', 'The selected backend does not support this status route.');
  }

  prepareResponses(translated) {
    const reasoning = normalizeLlamaReasoningRequest(translated.originalBody || {}, this.activeModel, 'responses');
    const toolRequest = normalizeLlamaToolRequest(translated.upstreamBody, this.activeModel, 'responses');
    const outputTokens = reasoning.outputTokens;
    const messages = messagesForLlama(
      translated.upstreamBody.messages,
      'responses',
      this.activeModel.capability_profile?.vision === true
    );
    const templateControls = { ...reasoning.controls, ...toolRequest.templateControls };
    const temperature = llamaTemperature({ options: translated.upstreamBody?.options });
    const body = {
      model: this.activeModel.model,
      messages,
      stream: translated.stream,
      ...(translated.stream ? { stream_options: { include_usage: true } } : {}),
      ...temperature.controls,
      ...(outputTokens === null ? { n_predict: -1 } : { max_tokens: outputTokens }),
      ...reasoning.controls,
      ...toolRequest.controls
      , ...structuredOutputControls(translated.upstreamBody)
    };
    return {
      path: '/v1/chat/completions',
      body,
      originalRequest: translated.originalBody,
      responseKind: 'openai',
      outputTokens,
      reasoning,
      templateControls,
      temperatureForwarding: temperature.forwarding,
      ...(Object.hasOwn(temperature, 'forwardedTemperature')
        ? { forwardedTemperature: temperature.forwardedTemperature }
        : {})
    };
  }

  async validateResponsesContext(prepared, signal) {
    const working = await this.prepareWorkingContext(prepared.body.messages, prepared.outputTokens, prepared.templateControls, prepared.originalRequest ?? prepared.body, signal);
    prepared.body.messages = working.messages;
    prepared.journal = working.journal;
    prepared.transition = working.transition;
    prepared.context = working.context;
    return working.context;
  }

  async adaptResponsesResponse(response, streaming, prepared = null) {
    if (!response.ok) return response;
    if (!streaming) {
      const payload = JSON.parse(await response.text());
      const ollama = openAiCompletionToOllama(payload, { kind: 'native-chat', model: this.activeModel.model });
      return new Response(JSON.stringify(ollama), {
        status: response.status,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(openAiSseToOllamaStream(response.body, {
      kind: 'native-chat',
      model: this.activeModel.model,
      requestedOutputTokens: prepared?.outputTokens
    }), {
      status: response.status,
      headers: { 'content-type': 'application/x-ndjson' }
    });
  }
}

function requestIsStatus(method, pathname) {
  return (method === 'GET' && ['/api/version', '/api/tags', '/api/ps'].includes(pathname))
    || (method === 'POST' && pathname === '/api/show');
}

export function resolveBackendAdapter(config, activeModel) {
  const kind = activeModel?.backend_kind || OLLAMA_KIND;
  if (kind === OLLAMA_KIND) return new OllamaBackendAdapter(config, activeModel);
  if (kind === LLAMA_CPP_KIND) return new LlamaCppBackendAdapter(config, activeModel);
  throw new BackendAdapterError(503, 'INVALID_BACKEND_KIND', `Unsupported active backend kind: ${kind}.`);
}

export function isGenerationPath(pathname) {
  return ['/api/chat', '/api/generate', '/v1/chat/completions', '/v1/responses', '/responses'].includes(pathname);
}

export function openAiNonstreamForPublic(payload, model) {
  return { ...payload, model };
}

export async function fetchPrepared(adapter, prepared, headers = {}, signal = undefined) {
  if (adapter.activeModel.catalog_mode && isGenerationPath(prepared.upstreamPath || prepared.path)) {
    return managedCompletion(adapter, prepared, headers, signal);
  }
  const method = prepared.method || 'POST';
  const payload = prepared.upstreamBody ?? prepared.body;
  return await upstreamFetch(adapter.upstreamConfig, prepared.upstreamPath || prepared.path, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(String(method).toUpperCase()) || payload === undefined || payload === null
      ? undefined
      : JSON.stringify(payload),
    signal,
    generation: isGenerationPath(prepared.upstreamPath || prepared.path),
    progressPath: adapter.kind === 'llama_cpp' ? '/slots' : undefined
  });
}
