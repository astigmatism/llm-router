import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRouterServer } from '../src/server.js';

const PINNED = 'qwen3.8-flash-next-iq3-xxs';
const REASONING_POLICY = {
  schema_version: 1,
  kind: 'llama_cpp_template_budgeted',
  mapping_kind: 'native_low_medium_high_local_max',
  default_level: 'off',
  public_levels: ['off', 'none', 'low', 'medium', 'high', 'max'],
  aliases: { none: 'off', minimal: 'low', xhigh: 'max' },
  boolean_true_behavior: { mode: 'reject' },
  output_limit_policy: 'cap',
  reasoning_format: 'deepseek',
  answer_reserve: 1024,
  levels: {
    off: { enabled: false, default_output_tokens: 512, max_output_tokens: 4096 },
    low: { enabled: true, template_effort: 'low', reasoning_budget_tokens: 512, default_output_tokens: 1536, max_output_tokens: 1536 },
    medium: { enabled: true, template_effort: 'medium', reasoning_budget_tokens: 2048, default_output_tokens: 3072, max_output_tokens: 3072 },
    high: { enabled: true, template_effort: 'high', reasoning_budget_tokens: 8192, default_output_tokens: 9216, max_output_tokens: 9216 },
    max: { enabled: true, template_effort: 'high', reasoning_budget_tokens: -1, default_output_tokens: 16384, max_output_tokens: 16384 }
  }
};

const QWEN38_REASONING_POLICY = {
  schema_version: 1,
  kind: 'llama_cpp_template_budgeted',
  mapping_kind: 'qwen38_native_xhigh',
  default_level: 'medium',
  public_levels: ['off', 'low', 'medium', 'xhigh'],
  aliases: { none: 'off', minimal: 'low', high: 'xhigh', max: 'xhigh' },
  boolean_true_behavior: { mode: 'map', level: 'medium' },
  output_limit_policy: 'cap',
  reasoning_format: 'deepseek',
  answer_reserve: 1024,
  levels: {
    off: { enabled: false, default_output_tokens: 512, max_output_tokens: 4096 },
    low: { enabled: true, template_effort: 'low', reasoning_budget_tokens: 512, default_output_tokens: 1536, max_output_tokens: 1536 },
    medium: { enabled: true, template_effort: 'medium', reasoning_budget_tokens: 2048, default_output_tokens: 3072, max_output_tokens: 8192 },
    xhigh: { enabled: true, template_effort: 'xhigh', reasoning_budget_tokens: -1, default_output_tokens: 32768, max_output_tokens: 32768 }
  }
};

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim() ? JSON.parse(raw) : null;
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
  response.end(payload);
}

function createFakeLlama() {
  const requests = [];
  let releaseHolds;
  const hold = new Promise((resolve) => { releaseHolds = resolve; });
  let releaseValidation;
  const validationHold = new Promise((resolve) => { releaseValidation = resolve; });
  let releasePrewarm;
  const prewarmHold = new Promise((resolve) => { releasePrewarm = resolve; });
  const state = {
    releaseHolds,
    releaseValidation,
    releasePrewarm,
    cancelled: false,
    healthy: true,
    prewarmMode: 'success'
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://fake-llama.local');
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await readJsonBody(request);
    requests.push({ method: request.method, pathname: url.pathname, body });
    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, state.healthy ? 200 : 503, { status: state.healthy ? 'ok' : 'unavailable' });
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(response, 200, { object: 'list', data: [{ id: PINNED, object: 'model' }] });
    }
    if (request.method === 'GET' && url.pathname === '/slots') {
      return sendJson(response, 200, [
        { id: 0, n_ctx: 131072, is_processing: false },
        { id: 1, n_ctx: 131072, is_processing: false }
      ]);
    }
    if (request.method === 'POST' && url.pathname === '/apply-template') {
      const text = (body?.messages || []).map((message) => String(message.content || '')).join('\n');
      return sendJson(response, 200, { prompt: `templated:${text}` });
    }
    if (request.method === 'POST' && url.pathname === '/tokenize') {
      if (String(body?.content || '').includes('VALIDATION_DELAY')) await validationHold;
      const content = String(body?.content || '');
      const count = content.includes('OBSERVED_OVERFLOW')
        ? 101165
        : (content.includes('EXACT_BOUNDARY')
          ? 97280
          : (content.includes('OVERSIZE') ? 130000 : 8));
      return sendJson(response, 200, { tokens: Array.from({ length: count }, (_, index) => index) });
    }
    if (request.method === 'POST' && url.pathname === '/v1/completions') {
      if (state.prewarmMode === 'delayed-body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"id":"completion-prewarm-delayed"');
        await prewarmHold;
        if (!response.destroyed) response.end('}');
        return;
      }
      if (state.prewarmMode === 'oversized') {
        return sendJson(response, 200, {
          choices: [{ index: 0, text: 'x', finish_reason: 'length' }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
          padding: 'private-generated-output'.repeat(1024)
        });
      }
      if (state.prewarmMode === 'rejected') {
        return sendJson(response, 500, { error: { message: 'private-generated-output' } });
      }
      return sendJson(response, 200, {
        id: 'completion-prewarm-1',
        object: 'text_completion',
        model: body.model,
        choices: [{ index: 0, text: 'ready', finish_reason: 'length' }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }
      });
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const prompt = (body?.messages || []).map((message) => String(message.content || '')).join('\n');
      const reasoning = body?.chat_template_kwargs?.enable_thinking === true;
      const hasToolResult = (body?.messages || []).some((message) => message?.role === 'tool');
      const requestsToolCall = !hasToolResult && prompt.includes('CALL_TOOL');
      if (prompt.includes('BACKEND_ERROR')) return sendJson(response, 500, { error: { message: 'synthetic backend error' } });
      if (prompt.includes('HOLD')) await hold;
      if (body?.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (prompt.includes('MALFORMED_STREAM_TOOL')) {
          const invalidSyntax = prompt.includes('MALFORMED_STREAM_TOOL_SYNTAX');
          const firstArguments = invalidSyntax ? '{"questions":' : '{"questions":[';
          const secondArguments = invalidSyntax ? 'not-json}' : '{"id":"width"';
          response.write(`data: ${JSON.stringify({
            id: 'chunk-malformed-tool-1',
            model: body.model,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                reasoning_content: 'I should ask the user.',
                tool_calls: [{
                  index: 0,
                  id: 'call_question_1',
                  type: 'function',
                  function: { name: 'ask_user_question', arguments: firstArguments }
                }]
              },
              finish_reason: null
            }]
          })}\n\n`);
          response.end(`data: ${JSON.stringify({
            id: 'chunk-malformed-tool-2',
            model: body.model,
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: secondArguments } }] },
              finish_reason: invalidSyntax ? 'tool_calls' : 'length'
            }],
            usage: { prompt_tokens: 12, completion_tokens: invalidSyntax ? 17 : body.max_tokens }
          })}\n\ndata: [DONE]\n\n`);
          return;
        }
        if (requestsToolCall) {
          response.write(`data: ${JSON.stringify({
            id: 'chunk-tool-1',
            model: body.model,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{
                  index: 0,
                  id: 'call_bash_1',
                  type: 'function',
                  function: { name: 'bash', arguments: '{"command":"' }
                }]
              },
              finish_reason: null
            }]
          })}\n\n`);
          response.end(`data: ${JSON.stringify({
            id: 'chunk-tool-2',
            model: body.model,
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: 'pwd"}' } }] },
              finish_reason: 'tool_calls'
            }],
            usage: { prompt_tokens: 12, completion_tokens: 4 }
          })}\n\ndata: [DONE]\n\n`);
          return;
        }
        response.write(`data: ${JSON.stringify({
          id: 'chunk-1', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', ...(reasoning ? { reasoning_content: 'private reasoning' } : {}), content: 'stream ' }, finish_reason: null }]
        })}\n\n`);
        if (prompt.includes('CANCEL')) {
          request.once('close', () => { state.cancelled = true; });
          return;
        }
        response.write(`data: ${JSON.stringify({
          id: 'chunk-2', model: body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }]
        })}\n\n`);
        if (body?.stream_options?.include_usage === true) {
          response.write(`data: ${JSON.stringify({
            id: 'chunk-usage', model: body.model, choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
          })}\n\n`);
        }
        response.end('data: [DONE]\n\n');
        return;
      }
      if (requestsToolCall) {
        return sendJson(response, 200, {
          id: 'completion-tool-1',
          object: 'chat.completion',
          model: body.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_bash_1',
                type: 'function',
                function: { name: 'bash', arguments: '{"command":"pwd"}' }
              }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
        });
      }
      return sendJson(response, 200, {
        id: 'completion-1',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'llama adapter ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        ...(reasoning ? { choices: [{ index: 0, message: { role: 'assistant', reasoning_content: 'private reasoning', content: 'llama adapter ok' }, finish_reason: 'stop' }] } : {})
      });
    }
    return sendJson(response, 404, { error: 'not found' });
  });
  return { server, requests, state };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

async function makeFixture({
  reasoning = false,
  reasoningPolicy = REASONING_POLICY,
  model = PINNED,
  tools = false,
  vision = false,
  unsupportedToolsPolicy = 'passthrough',
  maxOutputTokens = 4096,
  contextSafetyReserve = 1024,
  upstreamTimeoutMs = 5000
} = {}) {
  const backend = createFakeLlama();
  const backendPort = await listen(backend.server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-llama-test-'));
  const marker = {
    profile: 'llama-unit',
    backend_kind: 'llama_cpp',
    backend_url: `http://127.0.0.1:${backendPort}`,
    backend_revision: 'pinned-test-revision',
    model,
    keep_alive: -1,
    context_length: 131072,
    total_context_length: 262144,
    max_output_tokens: maxOutputTokens,
    default_output_tokens: 512,
    context_safety_reserve: contextSafetyReserve,
    max_active_requests: 2,
    input_modalities: vision ? ['text', 'image'] : ['text'],
    prompt_cache_mode: 'volatile_slot_lcp',
    capability_profile: {
      prompt_cache_volatile: true,
      prompt_cache_persistence: false,
      tools,
      reasoning,
      vision
    },
    ...(reasoning ? { reasoning_policy: reasoningPolicy } : {})
  };
  const markerPath = path.join(dir, 'active-model.json');
  await fs.writeFile(markerPath, JSON.stringify(marker));
  const config = {
    ...loadConfig({
      HOST: '127.0.0.1',
      ADMIN_ENABLED: 'true',
      ADMIN_BIND_HOST: '127.0.0.1',
      OLLAMA_UPSTREAM_URL: 'http://127.0.0.1:1',
      LLAMA_CPP_UPSTREAM_URL: 'http://127.0.0.1:1',
      OLLAMA_UPSTREAM_TIMEOUT_MS: '5000',
      ACTIVE_MODEL_FILE: markerPath,
      ROUTER_CONTROL_FILE: path.join(dir, 'router-control.json'),
      ROUTER_MODEL_ALIAS: 'local-active',
      REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true',
      UNSUPPORTED_TOOLS_POLICY: unsupportedToolsPolicy,
      ADMIN_TOKEN: 'secret-token',
      DATA_DIR: dir,
      ENABLE_NVIDIA_SMI: 'false'
    }),
    upstreamTimeoutMs
  };
  const router = await createRouterServer(config);
  const apiPort = await listen(router.server);
  const adminPort = await listen(router.adminServer);
  const cleanup = async () => {
    backend.state.releaseHolds();
    backend.state.releaseValidation();
    backend.state.releasePrewarm();
    await close(router.adminServer);
    await close(router.server);
    await router.waitForIdle();
    await close(backend.server);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  };
  return { ...router, backend, apiPort, adminPort, cleanup };
}

function post(port, pathname, body) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-name': 'llama-unit' },
    body: JSON.stringify(body)
  });
}

function parseSse(text) {
  return text
    .split(/\n\n/)
    .flatMap((frame) => frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()))
    .filter((data) => data && data !== '[DONE]')
    .map(JSON.parse);
}

// DeepSeek Harness classifies provider codes matching this structured
// context-length/window convention before normalizing to CONTEXT_WINDOW_EXCEEDED.
const HARNESS_STRUCTURED_CONTEXT_OVERFLOW = /(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])/i;

async function runtimeState(fixture) {
  const response = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/runtime-state`, {
    headers: { 'x-admin-token': 'secret-token' }
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function waitForActive(fixture, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await runtimeState(fixture);
    if (state.runtime.active_count === count) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`active count did not become ${count}`);
}

async function waitForEvent(fixture, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = fixture.context.store.recentEvents(100).find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('expected router event was not persisted');
}

test('llama.cpp adapter forces model identity and translates native/OpenAI/Responses shapes', async () => {
  const fixture = await makeFixture();
  try {
    const openai = await post(fixture.apiPort, '/v1/chat/completions', {
      model: 'malicious:alternate', messages: [{ role: 'user', content: 'OPENAI' }], stream: false, max_tokens: 32
    });
    assert.equal(openai.status, 200);
    assert.equal((await openai.json()).model, PINNED);

    const native = await post(fixture.apiPort, '/api/chat', {
      model: 'another:installed', messages: [{ role: 'user', content: 'NATIVE' }], stream: false, options: { num_predict: 32 }
    });
    assert.equal(native.status, 200);
    const nativeBody = await native.json();
    assert.equal(nativeBody.model, PINNED);
    assert.equal(nativeBody.message.content, 'llama adapter ok');

    const generate = await post(fixture.apiPort, '/api/generate', {
      model: 'wrong', prompt: 'GENERATE', stream: false, options: { num_predict: 32 }
    });
    assert.equal(generate.status, 200);
    assert.equal((await generate.json()).response, 'llama adapter ok');

    const responses = await post(fixture.apiPort, '/v1/responses', {
      model: 'wrong', input: 'RESPONSES', stream: false, store: false, max_output_tokens: 32
    });
    assert.equal(responses.status, 200);
    const responseBody = await responses.json();
    assert.equal(responseBody.model, PINNED);
    assert.equal(responseBody.output[0].content[0].text, 'llama adapter ok');

    const completions = fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions');
    assert.equal(completions.length, 4);
    assert.ok(completions.every((request) => request.body.model === PINNED));
    assert.ok(completions.every((request) => !Object.hasOwn(request.body, 'cache_prompt')));
    assert.ok(completions.every((request) => !Object.hasOwn(request.body, 'id_slot')));
    assert.ok(fixture.backend.requests.filter((request) => request.pathname === '/tokenize').length >= 4);
  } finally {
    await fixture.cleanup();
  }
});

test('Responses preserves omitted and explicit temperatures in llama.cpp requests and structured metadata', async () => {
  const fixture = await makeFixture();
  try {
    const cases = [
      { label: 'omitted', forwarding: 'omitted_for_backend_default' },
      { label: 'zero', temperature: 0, forwarding: 'explicit' },
      { label: 'one', temperature: 1.0, forwarding: 'explicit' }
    ];
    for (const item of cases) {
      const response = await post(fixture.apiPort, '/v1/responses', {
        model: 'local-active',
        input: `RESPONSES_TEMPERATURE_${item.label}`,
        stream: false,
        store: false,
        max_output_tokens: 32,
        ...(Object.hasOwn(item, 'temperature') ? { temperature: item.temperature } : {})
      });
      assert.equal(response.status, 200, await response.text());
    }

    const generation = fixture.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions');
    assert.equal(generation.length, 3);
    assert.equal(Object.hasOwn(generation[0].body, 'temperature'), false);
    assert.equal(generation[1].body.temperature, 0);
    assert.equal(generation[2].body.temperature, 1);

    const records = fixture.context.store.recentRequests(3).reverse();
    assert.deepEqual(records.map((record) => record.temperatureForwarding), cases.map((item) => item.forwarding));
    assert.equal(Object.hasOwn(records[0], 'forwardedTemperature'), false);
    assert.deepEqual(records.slice(1).map((record) => record.forwardedTemperature), [0, 1]);

    const generationCount = generation.length;
    const invalid = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: 'RESPONSES_INVALID_TEMPERATURE',
      stream: false,
      store: false,
      max_output_tokens: 32,
      temperature: '1'
    });
    const invalidPayload = await invalid.json();
    assert.equal(invalid.status, 400, JSON.stringify(invalidPayload));
    assert.equal(invalidPayload.error.code, 'INVALID_TEMPERATURE');
    assert.equal(invalidPayload.error.param, 'temperature');
    assert.equal(
      fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length,
      generationCount
    );
  } finally {
    await fixture.cleanup();
  }
});

test('Responses accepts prompt_cache_key as a privacy-safe ignored hint without local response caching', async () => {
  const fixture = await makeFixture();
  const codexStyleKey = 'codex-session-0123456789abcdef';
  const unusualKey = 'scope/α β\tline';
  const invalidMarker = 'invalid-cache-key-must-not-escape';
  try {
    const base = {
      model: 'local-active',
      input: 'PROMPT_CACHE_EQUIVALENCE',
      stream: false,
      store: false,
      max_output_tokens: 32
    };
    const responseTexts = [];
    for (const body of [
      base,
      { ...base, prompt_cache_key: codexStyleKey },
      { ...base, prompt_cache_key: unusualKey }
    ]) {
      const response = await post(fixture.apiPort, '/v1/responses', body);
      const responseText = await response.text();
      assert.equal(response.status, 200, responseText);
      responseTexts.push(responseText);
    }

    const streaming = await post(fixture.apiPort, '/v1/responses', {
      ...base,
      input: 'PROMPT_CACHE_STREAM',
      stream: true,
      prompt_cache_key: ''
    });
    const streamingText = await streaming.text();
    assert.equal(streaming.status, 200, streamingText);
    assert.match(streamingText, /response\.completed/);

    const generation = fixture.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions');
    assert.equal(generation.length, 4, 'each request must perform a separate backend generation');
    assert.deepEqual(generation[1].body, generation[0].body);
    assert.deepEqual(generation[2].body, generation[0].body);
    assert.ok(generation.every((request) => !Object.hasOwn(request.body, 'prompt_cache_key')));
    assert.doesNotMatch(JSON.stringify(fixture.backend.requests), /codex-session|scope\/α/);
    assert.doesNotMatch(responseTexts.join('\n'), /codex-session|scope\/α/);
    assert.doesNotMatch(streamingText, /codex-session|scope\/α/);

    for (let attempt = 0; attempt < 100 && fixture.context.store.recentRequests(10).length < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const records = fixture.context.store.recentRequests(4).reverse();
    assert.deepEqual(records.map((record) => record.promptCacheKeyPresent), [false, true, true, true]);
    assert.deepEqual(records.map((record) => record.promptCacheKeyDisposition), [null, 'accepted_ignored', 'accepted_ignored', 'accepted_ignored']);
    assert.doesNotMatch(JSON.stringify(records), /codex-session|scope\/α/);

    const invalid = await post(fixture.apiPort, '/v1/responses', {
      ...base,
      prompt_cache_key: { private: invalidMarker }
    });
    const invalidText = await invalid.text();
    assert.equal(invalid.status, 400, invalidText);
    const invalidPayload = JSON.parse(invalidText);
    assert.deepEqual(invalidPayload.error, {
      message: 'prompt_cache_key must be a string when provided.',
      type: 'invalid_request_error',
      param: 'prompt_cache_key',
      code: 'INVALID_PROMPT_CACHE_KEY'
    });
    assert.doesNotMatch(invalidText, new RegExp(invalidMarker));
    const rejectedEvent = await waitForEvent(
      fixture,
      (event) => event.type === 'responses_request_rejected' && event.code === 'INVALID_PROMPT_CACHE_KEY'
    );
    assert.doesNotMatch(JSON.stringify(rejectedEvent), new RegExp(invalidMarker));

    const generationCount = generation.length;
    for (const [field, value] of [
      ['prompt_cache_options', { mode: 'explicit', ttl: '30m' }],
      ['prompt_cache_retention', '24h']
    ]) {
      const response = await post(fixture.apiPort, '/v1/responses', { ...base, [field]: value });
      const payload = await response.json();
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.equal(payload.error.code, 'UNSUPPORTED_PROFILE_CAPABILITY');
      assert.equal(payload.error.param, field);
    }
    assert.equal(
      fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length,
      generationCount
    );

    const stored = JSON.stringify({
      requests: fixture.context.store.recentRequests(20),
      events: fixture.context.store.recentEvents(20)
    });
    assert.doesNotMatch(stored, /codex-session|scope\/α|invalid-cache-key-must-not-escape/);
    const paths = fixture.context.store.paths();
    const persisted = `${await fs.readFile(paths.requestLogPath, 'utf8')}\n${await fs.readFile(paths.eventLogPath, 'utf8')}`;
    assert.doesNotMatch(persisted, /codex-session|scope\/α|invalid-cache-key-must-not-escape/);
  } finally {
    await fixture.cleanup();
  }
});

test('Chat Completions preserves omitted and explicit temperatures in llama.cpp requests and structured metadata', async () => {
  const fixture = await makeFixture();
  try {
    const cases = [
      { label: 'omitted', forwarding: 'omitted_for_backend_default' },
      { label: 'zero', temperature: 0, forwarding: 'explicit' },
      { label: 'one', temperature: 1.0, forwarding: 'explicit' }
    ];
    for (const item of cases) {
      const response = await post(fixture.apiPort, '/v1/chat/completions', {
        model: 'local-active',
        messages: [{ role: 'user', content: `CHAT_TEMPERATURE_${item.label}` }],
        stream: false,
        max_tokens: 32,
        ...(Object.hasOwn(item, 'temperature') ? { temperature: item.temperature } : {})
      });
      assert.equal(response.status, 200, await response.text());
    }

    const generation = fixture.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions');
    assert.equal(generation.length, 3);
    assert.equal(Object.hasOwn(generation[0].body, 'temperature'), false);
    assert.equal(generation[1].body.temperature, 0);
    assert.equal(generation[2].body.temperature, 1);

    const records = fixture.context.store.recentRequests(3).reverse();
    assert.deepEqual(records.map((record) => record.temperatureForwarding), cases.map((item) => item.forwarding));
    assert.equal(Object.hasOwn(records[0], 'forwardedTemperature'), false);
    assert.deepEqual(records.slice(1).map((record) => record.forwardedTemperature), [0, 1]);
  } finally {
    await fixture.cleanup();
  }
});

test('temperature fix leaves max-to-xhigh, output caps, tools, and discovery unchanged', async () => {
  const fixture = await makeFixture({
    reasoning: true,
    reasoningPolicy: QWEN38_REASONING_POLICY,
    tools: true,
    unsupportedToolsPolicy: 'reject',
    maxOutputTokens: 32768
  });
  try {
    const discoveryBefore = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`);
    assert.equal(discoveryBefore.status, 200);
    const beforePayload = await discoveryBefore.json();

    const tool = {
      type: 'function',
      name: 'lookup',
      description: 'Look up a value.',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
    };
    const response = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: 'QWEN38_REGRESSION_CONTRACT',
      stream: false,
      store: false,
      reasoning: { effort: 'max' },
      max_output_tokens: 50000,
      tools: [tool]
    });
    assert.equal(response.status, 200, await response.text());
    assert.equal(response.headers.get('x-router-effective-max-output-tokens'), '32768');

    const upstream = fixture.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions')
      .at(-1).body;
    assert.equal(Object.hasOwn(upstream, 'temperature'), false);
    assert.equal(upstream.reasoning_effort, 'xhigh');
    assert.equal(upstream.max_tokens, 32768);
    assert.deepEqual(upstream.tools, [{
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }]);

    const discoveryAfter = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`);
    assert.equal(discoveryAfter.status, 200);
    assert.deepEqual(await discoveryAfter.json(), beforePayload);
    assert.equal(beforePayload.data[0].x_ollama_router.reasoning.aliases.max, 'xhigh');
  } finally {
    await fixture.cleanup();
  }
});

test('llama.cpp adapter translates streaming native and Responses output with terminal frames', async () => {
  const fixture = await makeFixture();
  try {
    const native = await post(fixture.apiPort, '/api/chat', {
      model: 'local-active', messages: [{ role: 'user', content: 'STREAM_NATIVE' }], stream: true, options: { num_predict: 32 }
    });
    assert.equal(native.status, 200);
    const ndjson = (await native.text()).trim().split('\n').map(JSON.parse);
    assert.equal(ndjson.filter((entry) => entry.done).length, 1);
    assert.equal(ndjson.filter((entry) => !entry.done).map((entry) => entry.message.content).join(''), 'stream ok');
    assert.equal(ndjson.at(-1).prompt_eval_count, 8);
    assert.equal(ndjson.at(-1).eval_count, 2);

    const responses = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active', input: 'STREAM_RESPONSES', stream: true, store: false, max_output_tokens: 32
    });
    assert.equal(responses.status, 200);
    const sse = await responses.text();
    assert.match(sse, /response\.completed/);
    assert.match(sse, /stream ok/);
    const completed = parseSse(sse).find((event) => event.type === 'response.completed');
    assert.deepEqual(completed.response.usage, {
      input_tokens: 8,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 10
    });
    const streamedRequests = fixture.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions' && request.body.stream);
    assert.equal(streamedRequests.length, 2);
    assert.ok(streamedRequests.every((request) => request.body.stream_options?.include_usage === true));
    assert.equal((await runtimeState(fixture)).runtime.active_count, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('streamed llama.cpp tool arguments truncated at the output limit produce an incomplete response', async () => {
  const fixture = await makeFixture({ tools: true });
  try {
    const response = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: 'MALFORMED_STREAM_TOOL',
      stream: true,
      store: false,
      max_output_tokens: 128,
      tools: [{
        type: 'function',
        name: 'ask_user_question',
        parameters: { type: 'object', properties: { questions: { type: 'array' } } }
      }]
    });
    assert.equal(response.status, 200);
    const events = parseSse(await response.text());
    assert.equal(events.at(-1).type, 'response.incomplete');
    assert.equal(events.at(-1).response.status, 'incomplete');
    assert.equal(events.at(-1).response.error, null);
    assert.deepEqual(events.at(-1).response.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(events.at(-1).response.output.some((item) => item.type === 'function_call'), false);

    const event = await waitForEvent(
      fixture,
      (entry) => entry.type === 'responses_incomplete'
        && entry.reason === 'max_output_tokens'
    );
    const malformedArguments = '{"questions":[{"id":"width"';
    assert.deepEqual(event.diagnostics, {
      toolIndex: 0,
      toolName: 'ask_user_question',
      toolCallIdPresent: true,
      argumentDeltaCount: 2,
      argumentDeltaTypes: ['string', 'string'],
      argumentDeltaTypesTruncated: false,
      argumentBytes: Buffer.byteLength(malformedArguments),
      argumentSha256: createHash('sha256').update(malformedArguments).digest('hex'),
      jsonErrorCategory: 'unexpected_end',
      jsonErrorOffset: malformedArguments.length,
      finishReason: 'length',
      completionTokens: 128,
      requestedOutputTokens: 128,
      outputLimitReached: true
    });
    assert.doesNotMatch(JSON.stringify(event), /questions|width/);

    const record = fixture.context.store.recentRequests(20)
      .find((entry) => entry.endpoint === '/v1/responses' && entry.incomplete);
    assert.equal(record.upstreamError, false);
    assert.equal(record.incompleteReason, 'max_output_tokens');
    assert.deepEqual(record.incompleteDiagnostics, event.diagnostics);
  } finally {
    await fixture.cleanup();
  }
});

test('malformed tool diagnostics distinguish invalid syntax from output-limit truncation', async () => {
  const fixture = await makeFixture({ tools: true });
  try {
    const response = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: 'MALFORMED_STREAM_TOOL_SYNTAX',
      stream: true,
      store: false,
      max_output_tokens: 128,
      tools: [{
        type: 'function',
        name: 'ask_user_question',
        parameters: { type: 'object', properties: { questions: { type: 'array' } } }
      }]
    });
    const events = parseSse(await response.text());
    assert.equal(events.at(-1).response.error.code, 'MALFORMED_UPSTREAM_TOOL_ARGUMENTS');

    const event = await waitForEvent(
      fixture,
      (entry) => entry.type === 'responses_upstream_failed'
        && entry.code === 'MALFORMED_UPSTREAM_TOOL_ARGUMENTS'
    );
    assert.equal(event.diagnostics.jsonErrorCategory, 'invalid_syntax');
    assert.equal(event.diagnostics.jsonErrorOffset, 14);
    assert.equal(event.diagnostics.finishReason, 'tool_calls');
    assert.equal(event.diagnostics.completionTokens, 17);
    assert.equal(event.diagnostics.outputLimitReached, false);
    assert.doesNotMatch(JSON.stringify(event), /not-json/);
  } finally {
    await fixture.cleanup();
  }
});

test('llama.cpp capability and context policies reject before generation', async () => {
  const fixture = await makeFixture();
  try {
    const cases = [
      { body: { model: 'local-active', messages: [{ role: 'user', content: 'x' }], stream: false, tools: [{ type: 'function' }] }, code: 'UNSUPPORTED_PROFILE_CAPABILITY' },
      { body: { model: 'local-active', messages: [{ role: 'user', content: 'x' }], stream: false, reasoning_effort: 'high' }, code: 'UNSUPPORTED_PROFILE_CAPABILITY' },
      { body: { model: 'local-active', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }], stream: false }, code: 'UNSUPPORTED_PROFILE_CAPABILITY' },
      { body: { model: 'local-active', messages: [{ role: 'user', content: 'x' }], stream: false, options: { num_ctx: 1 } }, code: 'BACKEND_CONTROL_FORBIDDEN' },
      { body: { model: 'local-active', messages: [{ role: 'user', content: 'x' }], stream: false, cache_prompt: true }, code: 'UNSUPPORTED_PROFILE_CAPABILITY' },
      { body: { model: 'local-active', messages: [{ role: 'user', content: 'x' }], stream: false, id_slot: 0 }, code: 'UNSUPPORTED_PROFILE_CAPABILITY' },
      { body: { model: 'local-active', messages: [{ role: 'user', content: 'x' }], stream: false, slot_action: 'save', slot_save_path: '/tmp/forbidden' }, code: 'UNSUPPORTED_PROFILE_CAPABILITY' },
      { body: { model: 'local-active', messages: [{ role: 'user', content: 'x' }], stream: false, cache_idle_slots: true, cache_ram: 8192 }, code: 'UNSUPPORTED_PROFILE_CAPABILITY' },
      { body: { model: 'local-active', messages: [{ role: 'user', content: 'x' }], stream: false, options: { cache_prompt: true } }, code: 'BACKEND_CONTROL_FORBIDDEN' },
      { body: { model: 'local-active', messages: [{ role: 'user', content: 'OVERSIZE' }], stream: false, max_tokens: 128 }, code: 'context_length_exceeded' }
    ];
    for (const item of cases) {
      const response = await post(fixture.apiPort, '/v1/chat/completions', item.body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, item.code);
    }
    assert.equal(fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('context overflow is OpenAI-structured, Harness-recognizable, and never forwarded to generation', async () => {
  const fixture = await makeFixture({ maxOutputTokens: 32768 });
  const message = 'Formatted input (101165) plus requested output (32768) and safety reserve (1024) exceeds the 131072-token slot.';
  try {
    const cases = [
      {
        pathname: '/v1/responses',
        body: { model: 'local-active', input: 'OBSERVED_OVERFLOW', stream: false, store: false, max_output_tokens: 32768 }
      },
      {
        pathname: '/v1/responses',
        body: { model: 'local-active', input: 'OBSERVED_OVERFLOW', stream: true, store: false, max_output_tokens: 32768 }
      },
      {
        pathname: '/responses',
        body: { model: 'local-active', input: 'OBSERVED_OVERFLOW', stream: false, store: false, max_output_tokens: 32768 }
      },
      {
        pathname: '/v1/chat/completions',
        body: { model: 'local-active', messages: [{ role: 'user', content: 'OBSERVED_OVERFLOW' }], stream: false, max_tokens: 32768 }
      },
      {
        pathname: '/v1/chat/completions',
        body: { model: 'local-active', messages: [{ role: 'user', content: 'OBSERVED_OVERFLOW' }], stream: true, max_tokens: 32768 }
      }
    ];

    for (const item of cases) {
      const generatedBefore = fixture.backend.requests
        .filter((request) => request.pathname === '/v1/chat/completions').length;
      const response = await post(fixture.apiPort, item.pathname, item.body);
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type'), /^application\/json/);
      const payload = await response.json();
      assert.deepEqual(payload.error, {
        message,
        type: 'invalid_request_error',
        param: 'messages',
        code: 'context_length_exceeded'
      });
      assert.equal(HARNESS_STRUCTURED_CONTEXT_OVERFLOW.test(payload.error.code), true);
      assert.equal(payload.error.message.includes('101165'), true);
      assert.equal(payload.error.message.includes('32768'), true);
      assert.equal(payload.error.message.includes('1024'), true);
      assert.equal(payload.error.message.includes('131072'), true);
      assert.equal(
        fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length,
        generatedBefore
      );
    }

    const boundaryCases = [
      {
        pathname: '/v1/responses',
        body: { model: 'local-active', input: 'EXACT_BOUNDARY', stream: false, store: false, max_output_tokens: 32768 }
      },
      {
        pathname: '/v1/responses',
        body: { model: 'local-active', input: 'EXACT_BOUNDARY', stream: true, store: false, max_output_tokens: 32768 }
      },
      {
        pathname: '/v1/chat/completions',
        body: { model: 'local-active', messages: [{ role: 'user', content: 'EXACT_BOUNDARY' }], stream: false, max_tokens: 32768 }
      },
      {
        pathname: '/v1/chat/completions',
        body: { model: 'local-active', messages: [{ role: 'user', content: 'EXACT_BOUNDARY' }], stream: true, max_tokens: 32768 }
      }
    ];
    for (const item of boundaryCases) {
      const boundary = await post(fixture.apiPort, item.pathname, item.body);
      assert.equal(boundary.status, 200);
      await boundary.text();
    }
    assert.equal(
      fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length,
      boundaryCases.length
    );
  } finally {
    await fixture.cleanup();
  }
});

test('a text-only llama.cpp marker rejects image-bearing Responses tool history before inference', async () => {
  const fixture = await makeFixture({ tools: true, vision: false });
  try {
    const response = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: [
        { role: 'user', content: 'Capture the browser.' },
        {
          type: 'function_call',
          call_id: 'call_screenshot_1',
          name: 'browser_screenshot',
          arguments: '{}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_screenshot_1',
          output: [{
            type: 'input_image',
            image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
          }]
        }
      ],
      tools: [{
        type: 'function',
        name: 'browser_screenshot',
        parameters: { type: 'object', properties: {} }
      }],
      stream: false,
      store: false,
      max_output_tokens: 32
    });
    const payload = await response.json();
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(payload.error.code, 'UNSUPPORTED_PROFILE_CAPABILITY');
    assert.equal(fixture.backend.requests.filter((request) => request.pathname === '/apply-template').length, 0);
    assert.equal(fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('llama.cpp vision is marker-driven across native chat, Chat Completions, Responses, and tool-result history', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const dataUrl = `data:image/png;base64,${png}`;
  const fixture = await makeFixture({
    model: 'orion-vision-synthetic',
    tools: true,
    vision: true,
    unsupportedToolsPolicy: 'reject'
  });
  try {
    const openAi = await post(fixture.apiPort, '/v1/chat/completions', {
      model: 'local-active',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }
        ]
      }],
      stream: false,
      max_tokens: 32
    });
    assert.equal(openAi.status, 200, await openAi.text());

    const native = await post(fixture.apiPort, '/api/chat', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'Describe this screenshot.', images: [png] }],
      stream: false,
      options: { num_predict: 32 }
    });
    assert.equal(native.status, 200, await native.text());

    const responses = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this attachment.' },
          { type: 'input_image', image_url: dataUrl }
        ]
      }],
      stream: false,
      store: false,
      max_output_tokens: 32
    });
    assert.equal(responses.status, 200, await responses.text());

    const responseWithToolImage = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: [
        { role: 'user', content: 'Capture and inspect the browser.' },
        {
          type: 'function_call',
          call_id: 'call_screenshot_1',
          name: 'browser_screenshot',
          arguments: '{}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_screenshot_1',
          output: [
            { type: 'input_text', text: 'Screenshot captured.' },
            { type: 'input_image', image_url: dataUrl, detail: 'auto' }
          ]
        }
      ],
      tools: [{
        type: 'function',
        name: 'browser_screenshot',
        parameters: { type: 'object', properties: {} }
      }],
      stream: false,
      store: false,
      max_output_tokens: 32
    });
    assert.equal(responseWithToolImage.status, 200, await responseWithToolImage.text());

    const generation = fixture.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions');
    assert.equal(generation.length, 4);
    assert.deepEqual(generation[0].body.messages[0].content, [
      { type: 'text', text: 'Describe this image.' },
      { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } }
    ]);
    assert.deepEqual(generation[1].body.messages[0].content, [
      { type: 'text', text: 'Describe this screenshot.' },
      { type: 'image_url', image_url: { url: png } }
    ]);
    assert.deepEqual(generation[2].body.messages[0].content, [
      { type: 'text', text: 'Describe this attachment.' },
      { type: 'image_url', image_url: { url: png } }
    ]);
    assert.equal(generation[3].body.messages[2].role, 'tool');
    assert.equal(generation[3].body.messages[2].content, 'Screenshot captured.');
    assert.deepEqual(generation[3].body.messages[3], {
      role: 'user',
      content: [
        { type: 'text', text: 'Image output from tool browser_screenshot (call call_screenshot_1).' },
        { type: 'image_url', image_url: { url: png } }
      ]
    });

    const loggedToolImageRequest = fixture.context.store.recentRequests(20)
      .find((request) => request.endpoint === '/v1/responses'
        && request.bodySummary?.inputCount === 3
        && request.bodySummary?.inputImageCount === 1);
    assert.ok(loggedToolImageRequest);

    const discovery = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`);
    const entry = (await discovery.json()).data[0].x_ollama_router;
    assert.ok(entry.capabilities.includes('vision'));
    assert.deepEqual(entry.input_modalities, ['text', 'image']);
  } finally {
    await fixture.cleanup();
  }
});

test('authenticated draining, two-active limit, backend error, and cancellation clean up accounting', async () => {
  const fixture = await makeFixture();
  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/runtime-state`);
    assert.equal(unauthenticated.status, 401);
    const initialState = await runtimeState(fixture);
    assert.equal(initialState.active_model.prompt_cache_mode, 'volatile_slot_lcp');
    assert.equal(initialState.active_model.prompt_cache_volatile, true);
    assert.equal(initialState.active_model.prompt_cache_persistence, false);
    let drain = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/runtime-drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'secret-token' },
      body: JSON.stringify({ enabled: true, reason: 'unit' })
    });
    assert.equal(drain.status, 200);
    fixture.backend.state.healthy = false;
    const blocked = await post(fixture.apiPort, '/api/chat', {
      model: 'local-active', messages: [{ role: 'user', content: 'blocked' }], stream: false
    });
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error.code, 'BACKEND_DRAINING');
    const health = await fetch(`http://127.0.0.1:${fixture.apiPort}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.backend_ready, false);
    drain = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/runtime-drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'secret-token' },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(drain.status, 200);
    fixture.backend.state.healthy = true;

    const one = post(fixture.apiPort, '/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'HOLD one' }], stream: false });
    const two = post(fixture.apiPort, '/v1/chat/completions', { model: 'y', messages: [{ role: 'user', content: 'HOLD two' }], stream: false });
    await waitForActive(fixture, 2);
    const third = post(fixture.apiPort, '/v1/chat/completions', { model: 'z', messages: [{ role: 'user', content: 'third' }], stream: false });
    for (let i = 0; i < 100 && !(await runtimeState(fixture)).runtime.queued_count; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await runtimeState(fixture)).runtime.queued_count, 1);
    fixture.backend.state.releaseHolds();
    assert.equal((await one).status, 200);
    assert.equal((await two).status, 200);
    assert.equal((await third).status, 200);
    await waitForActive(fixture, 0);

    const backendError = await post(fixture.apiPort, '/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'BACKEND_ERROR' }], stream: false });
    assert.equal(backendError.status, 502);
    assert.equal((await runtimeState(fixture)).runtime.active_count, 0);

    const controller = new AbortController();
    const cancelResponse = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'CANCEL' }], stream: true })
    });
    assert.equal(cancelResponse.status, 200);
    await cancelResponse.body.getReader().read();
    controller.abort();
    await waitForActive(fixture, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('authenticated llama.cpp prewarm checks readiness then performs one bounded deterministic raw completion without returning content', async () => {
  const fixture = await makeFixture();
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/prewarm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'secret-token' }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result, {
      ok: true,
      model: PINNED,
      backend: 'llama_cpp',
      status: 200,
      latencyMs: result.latencyMs,
      generatedTokens: 1
    });
    assert.equal(Number.isSafeInteger(result.latencyMs), true);
    const prewarmRequests = fixture.backend.requests.filter((request) => request.pathname === '/v1/completions');
    assert.equal(prewarmRequests.length, 1);
    const readinessIndex = fixture.backend.requests.findIndex((request) => request.pathname === '/health');
    const prewarmIndex = fixture.backend.requests.findIndex((request) => request.pathname === '/v1/completions');
    assert.ok(readinessIndex >= 0);
    assert.ok(prewarmIndex > readinessIndex);
    assert.deepEqual(prewarmRequests[0].body, {
      model: PINNED,
      prompt: 'Operational pre-warm.',
      stream: false,
      max_tokens: 1,
      temperature: 0,
      top_p: 1,
      n: 1,
      seed: 0
    });
    assert.equal(Object.hasOwn(prewarmRequests[0].body, 'tools'), false);
    assert.equal(Object.hasOwn(prewarmRequests[0].body, 'reasoning_effort'), false);
    assert.equal(Object.hasOwn(prewarmRequests[0].body, 'chat_template_kwargs'), false);
    const event = await waitForEvent(fixture, (entry) => entry.type === 'prewarm_triggered');
    assert.equal(event.ok, true);
    assert.equal(event.stage, 'inference');
    assert.equal(event.generatedTokens, 1);
    assert.equal(JSON.stringify(event).includes('ready'), false);
    assert.equal(Object.hasOwn(result, 'upstream'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('llama.cpp prewarm fails closed before inference when readiness fails', async () => {
  const fixture = await makeFixture();
  try {
    fixture.backend.state.healthy = false;
    const response = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/prewarm`, {
      method: 'POST',
      headers: { 'x-admin-token': 'secret-token' }
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'BACKEND_NOT_READY');
    assert.equal(fixture.backend.requests.some((request) => request.pathname === '/v1/completions'), false);
    const event = await waitForEvent(fixture, (entry) => entry.type === 'prewarm_failed');
    assert.equal(event.stage, 'readiness');
    assert.equal(event.code, 'BACKEND_NOT_READY');
  } finally {
    await fixture.cleanup();
  }
});

test('llama.cpp prewarm rejects an oversized active model identifier before readiness or inference', async () => {
  const fixture = await makeFixture({ model: 'm'.repeat(513) });
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/prewarm`, {
      method: 'POST',
      headers: { 'x-admin-token': 'secret-token' }
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'INVALID_ACTIVE_MODEL');
    assert.equal(fixture.backend.requests.length, 0);
    const event = await waitForEvent(fixture, (entry) => entry.type === 'prewarm_failed');
    assert.equal(event.stage, 'input');
    assert.equal(event.model, null);
  } finally {
    await fixture.cleanup();
  }
});

test('llama.cpp prewarm bounds the response and never records raw generated output', async () => {
  const fixture = await makeFixture();
  try {
    fixture.backend.state.prewarmMode = 'oversized';
    const response = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/prewarm`, {
      method: 'POST',
      headers: { 'x-admin-token': 'secret-token' }
    });
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.error.code, 'PREWARM_RESPONSE_TOO_LARGE');
    assert.equal(JSON.stringify(result).includes('private-generated-output'), false);
    const event = await waitForEvent(fixture, (entry) => entry.type === 'prewarm_failed');
    assert.equal(event.code, 'PREWARM_RESPONSE_TOO_LARGE');
    assert.equal(JSON.stringify(event).includes('private-generated-output'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('llama.cpp prewarm timeout covers a stalled response body and records only a stable error code', async () => {
  const fixture = await makeFixture({ upstreamTimeoutMs: 30 });
  try {
    fixture.backend.state.prewarmMode = 'delayed-body';
    const response = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/prewarm`, {
      method: 'POST',
      headers: { 'x-admin-token': 'secret-token' }
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'PREWARM_TIMEOUT');
    const event = await waitForEvent(fixture, (entry) => entry.type === 'prewarm_failed');
    assert.equal(event.code, 'PREWARM_TIMEOUT');
    assert.equal(Object.hasOwn(event, 'error'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('llama.cpp prewarm rejects an upstream failure without exposing its response', async () => {
  const fixture = await makeFixture();
  try {
    fixture.backend.state.prewarmMode = 'rejected';
    const response = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/prewarm`, {
      method: 'POST',
      headers: { 'x-admin-token': 'secret-token' }
    });
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.error.code, 'PREWARM_UPSTREAM_REJECTED');
    assert.equal(JSON.stringify(result).includes('private-generated-output'), false);
    const event = await waitForEvent(fixture, (entry) => entry.type === 'prewarm_failed');
    assert.equal(event.code, 'PREWARM_UPSTREAM_REJECTED');
    assert.equal(JSON.stringify(event).includes('private-generated-output'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('an admitted request remains counted while llama.cpp validates its formatted context', async () => {
  const fixture = await makeFixture();
  try {
    const pending = post(fixture.apiPort, '/v1/chat/completions', {
      model: 'local-active', messages: [{ role: 'user', content: 'VALIDATION_DELAY' }], stream: false
    });
    const active = await waitForActive(fixture, 1);
    assert.equal(active.runtime.active_count, 1);

    const drain = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/runtime-drain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'secret-token' },
      body: JSON.stringify({ enabled: true, reason: 'validation-race-test' })
    });
    assert.equal(drain.status, 200);
    assert.equal((await runtimeState(fixture)).runtime.active_count, 1);

    fixture.backend.state.releaseValidation();
    assert.equal((await pending).status, 200);
    await waitForActive(fixture, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('Flash reasoning policy defaults off and injects only profile-owned level controls', async () => {
  const fixture = await makeFixture({ reasoning: true });
  try {
    const cases = [
      { level: 'low', limit: 1536, template: 'low', budget: 512 },
      { level: 'medium', limit: 3072, template: 'medium', budget: 2048 },
      { level: 'high', limit: 9216, template: 'high', budget: 8192 },
      { level: 'max', limit: 16384, template: 'high', budget: undefined }
    ];

    const omitted = await post(fixture.apiPort, '/v1/chat/completions', {
      model: 'wrong', messages: [{ role: 'user', content: 'DEFAULT_OFF' }], stream: false, max_tokens: 32
    });
    assert.equal(omitted.status, 200);

    for (const item of cases) {
      const response = await post(fixture.apiPort, '/v1/chat/completions', {
        model: 'wrong', messages: [{ role: 'user', content: `LEVEL_${item.level}` }], stream: false,
        reasoning_effort: item.level, max_tokens: item.limit
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.model, PINNED);
      assert.equal(payload.choices[0].message.reasoning_content, 'private reasoning');
    }

    const generated = fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions');
    assert.equal(generated[0].body.chat_template_kwargs.enable_thinking, false);
    assert.equal(Object.hasOwn(generated[0].body, 'reasoning_budget_tokens'), false);
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index];
      const upstream = generated[index + 1].body;
      assert.equal(upstream.model, PINNED);
      assert.equal(upstream.chat_template_kwargs.enable_thinking, true);
      assert.equal(upstream.reasoning_effort, item.template);
      assert.equal(upstream.reasoning_format, 'deepseek');
      assert.equal(upstream.reasoning_budget_tokens, item.budget);
      assert.equal(upstream.max_tokens, item.limit);
    }
    assert.equal((await runtimeState(fixture)).runtime.active_count, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('native reasoning compatibility caps downward, emits an audit event, and reports the effective limit', async () => {
  const fixture = await makeFixture({ reasoning: true });
  try {
    const capped = await post(fixture.apiPort, '/api/chat', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'CAPPED' }],
      stream: false,
      think: true,
      options: { reasoning_effort: 'xhigh', num_predict: 32768 }
    });
    assert.equal(capped.status, 200);
    assert.equal(capped.headers.get('x-router-effective-max-output-tokens'), '16384');

    const cappedUpstream = fixture.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions')
      .at(-1).body;
    assert.equal(cappedUpstream.max_tokens, 16384);
    assert.equal(cappedUpstream.reasoning_effort, 'high');
    assert.equal(Object.hasOwn(cappedUpstream, 'think'), false);
    assert.equal(Object.hasOwn(cappedUpstream.options || {}, 'reasoning_effort'), false);

    const event = fixture.context.store.recentEvents(20)
      .find((item) => item.type === 'output_limit_capped');
    assert.ok(event);
    assert.equal(event.reasoningEffort, 'max');
    assert.equal(event.requestedOutputTokens, 32768);
    assert.equal(event.effectiveOutputTokens, 16384);

    const record = fixture.context.store.recentRequests(20)
      .find((item) => item.endpoint === '/api/chat' && item.responseStatus === 200);
    assert.ok(record);
    assert.equal(record.outputLimitCapped, true);
    assert.equal(record.requestedOutputTokens, 32768);
    assert.equal(record.effectiveOutputTokens, 16384);

    const below = await post(fixture.apiPort, '/api/chat', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'BELOW_CAP' }],
      stream: false,
      think: 'max',
      options: { num_predict: 12000 }
    });
    assert.equal(below.status, 200);
    assert.equal(below.headers.get('x-router-effective-max-output-tokens'), null);
    const belowUpstream = fixture.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions')
      .at(-1).body;
    assert.equal(belowUpstream.max_tokens, 12000);
  } finally {
    await fixture.cleanup();
  }
});

test('llama.cpp applies marker-driven unsupported-tools policy before backend validation', async () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'lookup_weather',
      description: 'Look up the weather.',
      parameters: { type: 'object', properties: { city: { type: 'string' } } }
    }
  }];
  const dropping = await makeFixture({
    reasoning: true,
    unsupportedToolsPolicy: 'drop'
  });
  try {
    const response = await post(dropping.apiPort, '/api/chat', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'Do not call tools; answer directly.' }],
      stream: false,
      think: true,
      tools,
      options: { reasoning_effort: 'xhigh', num_predict: 256 }
    });
    const responsePayload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(responsePayload));

    const upstream = dropping.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions')
      .at(-1).body;
    assert.equal(Object.hasOwn(upstream, 'tools'), false);
    assert.equal(upstream.max_tokens, 256);

    const event = await waitForEvent(dropping, (item) => item.type === 'unsupported_tools_dropped');
    assert.equal(event.toolsPresent, true);
    assert.equal(event.toolCount, 1);
    assert.equal(event.toolsSupported, false);
    assert.equal(event.unsupportedToolsPolicy, 'drop');

    const openAiResponse = await post(dropping.apiPort, '/v1/chat/completions', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'Answer without tools.' }],
      stream: false,
      tools,
      max_tokens: 128
    });
    assert.equal(openAiResponse.status, 200);

    const responsesResponse = await post(dropping.apiPort, '/v1/responses', {
      model: 'local-active',
      input: 'Answer without tools.',
      stream: false,
      store: false,
      tools: [{
        type: 'function',
        name: 'lookup_weather',
        description: 'Look up the weather.',
        parameters: { type: 'object', properties: { city: { type: 'string' } } }
      }],
      max_output_tokens: 128
    });
    assert.equal(responsesResponse.status, 200);

    const generationRequests = dropping.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions');
    assert.equal(generationRequests.length, 3);
    assert.ok(generationRequests.every((request) => !Object.hasOwn(request.body, 'tools')));
    await waitForEvent(dropping, (item) => item.type === 'unsupported_tools_dropped'
      && item.endpoint === '/v1/chat/completions');
    await waitForEvent(dropping, (item) => item.type === 'unsupported_tools_dropped'
      && item.endpoint === '/v1/responses');
  } finally {
    await dropping.cleanup();
  }

  const rejecting = await makeFixture({ unsupportedToolsPolicy: 'reject' });
  try {
    const response = await post(rejecting.apiPort, '/api/chat', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'TOOLS_REJECTED' }],
      stream: false,
      tools
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'UNSUPPORTED_TOOLS');
    assert.equal(rejecting.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length, 0);
  } finally {
    await rejecting.cleanup();
  }
});

test('llama.cpp marker-enabled tools round-trip through native, Chat Completions, and Responses APIs', async () => {
  const tools = [{
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      }
    }
  }];
  const fixture = await makeFixture({
    model: 'orion-tools-synthetic',
    tools: true,
    unsupportedToolsPolicy: 'reject'
  });
  try {
    const native = await post(fixture.apiPort, '/api/chat', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'CALL_TOOL using bash.' }],
      tools,
      stream: false,
      options: { num_predict: 128 }
    });
    const nativeBody = await native.json();
    assert.equal(native.status, 200, JSON.stringify(nativeBody));
    assert.equal(nativeBody.done_reason, 'tool_calls');
    assert.deepEqual(nativeBody.message.tool_calls, [{
      id: 'call_bash_1',
      type: 'function',
      function: { name: 'bash', arguments: { command: 'pwd' } }
    }]);

    const nativeFollowUp = await post(fixture.apiPort, '/api/chat', {
      model: 'local-active',
      messages: [
        { role: 'user', content: 'CALL_TOOL using bash.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'bash', arguments: { command: 'pwd' } } }]
        },
        { role: 'tool', tool_name: 'bash', content: '/workspace' }
      ],
      tools,
      stream: false,
      options: { num_predict: 128 }
    });
    assert.equal(nativeFollowUp.status, 200);
    assert.equal((await nativeFollowUp.json()).message.content, 'llama adapter ok');

    const openAi = await post(fixture.apiPort, '/v1/chat/completions', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'CALL_TOOL using bash.' }],
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      stream: false,
      max_tokens: 128
    });
    const openAiBody = await openAi.json();
    assert.equal(openAi.status, 200, JSON.stringify(openAiBody));
    assert.equal(openAiBody.choices[0].finish_reason, 'tool_calls');
    assert.equal(openAiBody.choices[0].message.tool_calls[0].function.name, 'bash');

    const nativeStreaming = await post(fixture.apiPort, '/api/chat', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'STREAM CALL_TOOL using bash.' }],
      tools,
      stream: true,
      options: { num_predict: 128 }
    });
    assert.equal(nativeStreaming.status, 200);
    const nativeStreamLines = (await nativeStreaming.text()).trim().split('\n').map(JSON.parse);
    const nativeToolChunk = nativeStreamLines.find((item) => item.message?.tool_calls?.length);
    assert.deepEqual(nativeToolChunk.message.tool_calls[0], {
      id: 'call_bash_1',
      type: 'function',
      function: { index: 0, name: 'bash', arguments: { command: 'pwd' } }
    });
    assert.equal(nativeStreamLines.at(-1).done_reason, 'tool_calls');

    const responsesTools = [{
      type: 'function',
      name: 'bash',
      description: 'Run a shell command.',
      parameters: tools[0].function.parameters
    }];
    const responses = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: 'CALL_TOOL using bash.',
      prompt_cache_key: 'codex-tool-turn-1',
      tools: responsesTools,
      stream: false,
      store: false,
      max_output_tokens: 128
    });
    const responsesBody = await responses.json();
    assert.equal(responses.status, 200, JSON.stringify(responsesBody));
    const functionCall = responsesBody.output.find((item) => item.type === 'function_call');
    assert.ok(functionCall);
    assert.equal(functionCall.name, 'bash');
    assert.equal(functionCall.call_id, 'call_bash_1');
    assert.equal(functionCall.arguments, '{"command":"pwd"}');

    const responsesFollowUp = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: [
        { role: 'user', content: 'CALL_TOOL using bash.' },
        functionCall,
        { type: 'function_call_output', call_id: functionCall.call_id, output: '/workspace' }
      ],
      prompt_cache_key: 'codex-tool-turn-2',
      tools: responsesTools,
      stream: false,
      store: false,
      max_output_tokens: 128
    });
    const responsesFollowUpBody = await responsesFollowUp.json();
    assert.equal(responsesFollowUp.status, 200, JSON.stringify(responsesFollowUpBody));
    assert.equal(responsesFollowUpBody.output[0].content[0].text, 'llama adapter ok');

    const streaming = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: 'STREAM CALL_TOOL using bash.',
      prompt_cache_key: 'codex-tool-stream',
      tools: responsesTools,
      stream: true,
      store: false,
      max_output_tokens: 128
    });
    assert.equal(streaming.status, 200);
    const streamingText = await streaming.text();
    assert.match(streamingText, /response\.function_call_arguments\.done/);
    assert.match(streamingText, /\\"command\\":\\"pwd\\"/);
    assert.match(streamingText, /response\.completed/);

    const discovery = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`);
    assert.equal(discovery.status, 200);
    const discoveryEntry = (await discovery.json()).data[0];
    assert.equal(discoveryEntry.x_ollama_router.upstream_model, 'orion-tools-synthetic');
    assert.ok(discoveryEntry.x_ollama_router.capabilities.includes('tools'));

    const generationRequests = fixture.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions');
    assert.equal(generationRequests.length, 7);
    assert.ok(generationRequests.every((request) => request.body.tools?.[0]?.function?.name === 'bash'));
    assert.equal(generationRequests[1].body.messages[1].tool_calls[0].id, 'call_router_1_0');
    assert.equal(generationRequests[1].body.messages[1].tool_calls[0].function.arguments, '{"command":"pwd"}');
    assert.equal(generationRequests[1].body.messages[2].tool_call_id, 'call_router_1_0');
    assert.equal(generationRequests[2].body.tool_choice, 'auto');
    assert.equal(generationRequests[2].body.parallel_tool_calls, false);
    assert.ok(generationRequests.every((request) => !Object.hasOwn(request.body, 'prompt_cache_key')));

    const templateRequests = fixture.backend.requests.filter((request) => request.pathname === '/apply-template');
    assert.equal(templateRequests.length, 7);
    assert.ok(templateRequests.every((request) => request.body.tools?.[0]?.function?.name === 'bash'));
  } finally {
    await fixture.cleanup();
  }
});

test('llama.cpp tool validation fails closed before template application or inference', async () => {
  const fixture = await makeFixture({ tools: true });
  try {
    const cases = [
      {
        body: {
          model: 'local-active',
          messages: [{ role: 'user', content: 'invalid tool' }],
          tools: [{ type: 'function' }],
          stream: false
        },
        code: 'INVALID_TOOL'
      },
      {
        body: {
          model: 'local-active',
          messages: [
            { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: '{bad' } }] }
          ],
          tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
          stream: false
        },
        code: 'INVALID_TOOL_ARGUMENTS'
      },
      {
        body: {
          model: 'local-active',
          messages: [{ role: 'tool', tool_name: 'bash', content: 'orphan result' }],
          tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
          stream: false
        },
        code: 'INVALID_TOOL_HISTORY'
      },
      {
        body: {
          model: 'local-active',
          messages: [{ role: 'user', content: 'unsupported control' }],
          tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
          max_tool_calls: 1,
          stream: false
        },
        code: 'UNSUPPORTED_PROFILE_CAPABILITY'
      }
    ];

    for (const item of cases) {
      const response = await post(fixture.apiPort, '/v1/chat/completions', item.body);
      const payload = await response.json();
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.equal(payload.error.code, item.code);
    }
    assert.equal(fixture.backend.requests.filter((request) => request.pathname === '/apply-template').length, 0);
    assert.equal(fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('Responses uses the same marker-driven output cap, header, and audit contract', async () => {
  const fixture = await makeFixture({ reasoning: true });
  try {
    const response = await post(fixture.apiPort, '/v1/responses', {
      model: 'local-active',
      input: 'CAPPED_RESPONSES',
      stream: false,
      store: false,
      reasoning: { effort: 'xhigh', summary: 'auto' },
      max_output_tokens: 32768
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-router-effective-max-output-tokens'), '16384');

    const upstream = fixture.backend.requests
      .filter((request) => request.pathname === '/v1/chat/completions')
      .at(-1).body;
    assert.equal(upstream.max_tokens, 16384);
    assert.equal(upstream.reasoning_effort, 'high');

    const record = fixture.context.store.recentRequests(20)
      .find((item) => item.endpoint === '/v1/responses' && item.responseStatus === 200);
    assert.ok(record);
    assert.equal(record.reasoningEffort, 'max');
    assert.equal(record.outputLimitCapped, true);
    assert.equal(record.requestedOutputTokens, 32768);
    assert.equal(record.effectiveOutputTokens, 16384);

    const event = await waitForEvent(fixture, (item) => item.type === 'output_limit_capped'
      && item.endpoint === '/v1/responses');
    assert.equal(event.requestedOutputTokens, 32768);
    assert.equal(event.effectiveOutputTokens, 16384);
    assert.equal(
      fixture.context.store.recentEvents(20)
        .some((item) => item.type === 'unsupported_thinking_dropped' && item.endpoint === '/v1/responses'),
      false
    );
  } finally {
    await fixture.cleanup();
  }
});

test('native reasoning rejects explicit false conflicts and marker-configured strict output overflow', async () => {
  const strictPolicy = JSON.parse(JSON.stringify(REASONING_POLICY));
  strictPolicy.output_limit_policy = 'reject';
  const fixture = await makeFixture({ reasoning: true, reasoningPolicy: strictPolicy });
  try {
    const conflict = await post(fixture.apiPort, '/api/chat', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'CONFLICT' }],
      stream: false,
      think: false,
      options: { reasoning_effort: 'high', num_predict: 9216 }
    });
    assert.equal(conflict.status, 400);
    assert.equal((await conflict.json()).error.code, 'CONFLICTING_REASONING_EFFORT');

    const overflow = await post(fixture.apiPort, '/api/chat', {
      model: 'local-active',
      messages: [{ role: 'user', content: 'STRICT' }],
      stream: false,
      think: 'max',
      options: { num_predict: 32768 }
    });
    assert.equal(overflow.status, 400);
    assert.equal((await overflow.json()).error.code, 'OUTPUT_LIMIT_EXCEEDED');
    assert.equal(fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('legacy alias discovery and inference retain bounded cap and reject output policies', async () => {
  for (const outputLimitPolicy of ['cap', 'reject']) {
    const fixture = await makeFixture({
      reasoning: true,
      maxOutputTokens: 16384,
      reasoningPolicy: { ...REASONING_POLICY, output_limit_policy: outputLimitPolicy }
    });
    fixture.context.config.rewriteRequestedModelToActive = false;
    try {
      const base = `http://127.0.0.1:${fixture.apiPort}`;
      const { data } = await (await fetch(base + '/v1/models')).json();
      const entry = data.find((model) => model.id === 'local-active');
      assert.equal(data.length, 1, 'singleton discovery retains its existing shape');
      assert.deepEqual(await (await fetch(base + '/v1/models/local-active')).json(), entry);
      const metadata = entry.x_ollama_router;
      assert.equal(metadata.context_window, 131072);
      assert.equal(metadata.active_request_limit, 2);
      assert.equal(metadata.max_output_tokens, 16384);
      assert.equal(metadata.default_output_tokens, 512);
      assert.equal(metadata.reasoning.default, 'off');
      assert.equal(metadata.reasoning.absolute_max_output_tokens, 16384);
      assert.equal(metadata.reasoning.output_limit_policy, outputLimitPolicy);
      assert.deepEqual(metadata.capabilities, ['completion', 'thinking']);
      assert.deepEqual(metadata.input_modalities, ['text']);
      for (const model of ['local-active', PINNED]) {
        for (const limit of [undefined, 1024, 6000]) {
          const response = await post(fixture.apiPort, '/v1/responses', {
            model, input: 'hello', stream: false, reasoning: { effort: 'none' }, max_output_tokens: limit
          });
          if (limit === 6000 && outputLimitPolicy === 'reject') {
            assert.equal(response.status, 400);
            assert.equal((await response.json()).error.code, 'OUTPUT_LIMIT_EXCEEDED');
          } else {
            assert.equal(response.status, 200, await response.text());
            const sent = fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').at(-1).body;
            assert.equal(sent.model, PINNED);
            assert.equal(sent.max_tokens, limit === undefined ? 512 : Math.min(limit, 4096));
          }
        }
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test('discovery publishes the complete marker-owned reasoning contract without upstream controls', async () => {
  const fixture = await makeFixture({ reasoning: true });
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`);
    assert.equal(response.status, 200);
    const entry = (await response.json()).data[0];
    const metadata = entry.x_ollama_router;
    assert.equal(metadata.schema_version, 2);
    assert.equal(metadata.complete, true);
    assert.equal(metadata.context_safety_reserve, 1024);
    assert.deepEqual(metadata.reasoning, {
      supported: true,
      efforts: { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'max' },
      aliases: { none: 'off', minimal: 'low', xhigh: 'max' },
      default: 'off',
      boolean_true_behavior: { mode: 'reject' },
      output_limit_policy: 'cap',
      absolute_max_output_tokens: 16384,
      per_effort: {
        off: { enabled: false, default_output_tokens: 512, max_output_tokens: 4096 },
        low: { enabled: true, default_output_tokens: 1536, max_output_tokens: 1536 },
        medium: { enabled: true, default_output_tokens: 3072, max_output_tokens: 3072 },
        high: { enabled: true, default_output_tokens: 9216, max_output_tokens: 9216 },
        max: { enabled: true, default_output_tokens: 16384, max_output_tokens: 16384 }
      }
    });
    assert.equal(Object.hasOwn(metadata.reasoning, 'upstream_levels'), false);
    assert.equal(Object.hasOwn(metadata.reasoning, 'effort_map'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('Flash reasoning rejects invalid levels, raw controls, hidden history, and unsafe output budgets before inference', async () => {
  const fixture = await makeFixture({ reasoning: true });
  try {
    const cases = [
      { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'ultra', max_tokens: 1536 }, code: 'INVALID_REASONING_LEVEL' },
      { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'low', max_tokens: 1535 }, code: 'REASONING_OUTPUT_BUDGET_TOO_SMALL' },
      { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'x' }], reasoning_budget_tokens: 1 }, code: 'UNTRUSTED_REASONING_CONTROL' },
      { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'x' }], chat_template_kwargs: { enable_thinking: true } }, code: 'UNTRUSTED_REASONING_CONTROL' },
      { path: '/v1/chat/completions', body: { messages: [{ role: 'user', content: 'x', reasoning_content: 'invalid-role' }] }, code: 'INVALID_REASONING_HISTORY' },
      { path: '/api/generate', body: { prompt: 'x', think: 'low', options: { num_predict: 1536 } }, code: 'REASONING_ROUTE_UNSUPPORTED' }
    ];
    for (const item of cases) {
      const before = fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length;
      const response = await post(fixture.apiPort, item.path, { model: 'wrong', stream: false, ...item.body });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, item.code);
      assert.equal(fixture.backend.requests.filter((request) => request.pathname === '/v1/chat/completions').length, before);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('Flash reasoning history is accepted only through each route public assistant schema', async () => {
  const fixture = await makeFixture({ reasoning: true });
  try {
    const openai = await post(fixture.apiPort, '/v1/chat/completions', {
      model: 'wrong', stream: false, reasoning_effort: 'low', max_tokens: 1536,
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', reasoning_content: 'earlier private reasoning', content: 'earlier answer' },
        { role: 'user', content: 'follow-up' }
      ]
    });
    assert.equal(openai.status, 200);
    const request = fixture.backend.requests.filter((entry) => entry.pathname === '/v1/chat/completions').at(-1);
    assert.equal(request.body.messages[1].reasoning_content, 'earlier private reasoning');

    const native = await post(fixture.apiPort, '/api/chat', {
      model: 'wrong', stream: false, think: 'low', options: { num_predict: 1536 },
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', thinking: 'native private reasoning', content: 'earlier answer' },
        { role: 'user', content: 'follow-up' }
      ]
    });
    assert.equal(native.status, 200);
    const nativeRequest = fixture.backend.requests.filter((entry) => entry.pathname === '/v1/chat/completions').at(-1);
    assert.equal(nativeRequest.body.messages[1].reasoning_content, 'native private reasoning');
  } finally {
    await fixture.cleanup();
  }
});

test('Flash reasoning remains separate on Ollama chat and Responses streaming/non-streaming contracts', async () => {
  const fixture = await makeFixture({ reasoning: true });
  try {
    const native = await post(fixture.apiPort, '/api/chat', {
      model: 'wrong', messages: [{ role: 'user', content: 'NATIVE_REASONING' }], stream: false,
      think: 'low', options: { num_predict: 1536 }
    });
    assert.equal(native.status, 200);
    const nativeBody = await native.json();
    assert.equal(nativeBody.message.thinking, 'private reasoning');
    assert.equal(nativeBody.message.content, 'llama adapter ok');

    const nativeStream = await post(fixture.apiPort, '/api/chat', {
      model: 'wrong', messages: [{ role: 'user', content: 'NATIVE_STREAM_REASONING' }], stream: true,
      think: 'low', options: { num_predict: 1536 }
    });
    assert.equal(nativeStream.status, 200);
    const ndjson = (await nativeStream.text()).trim().split('\n').map(JSON.parse);
    assert.equal(ndjson.filter((entry) => entry.done).length, 1);
    assert.equal(ndjson.map((entry) => entry.message?.thinking || '').join(''), 'private reasoning');
    assert.equal(ndjson.map((entry) => entry.message?.content || '').join(''), 'stream ok');

    const responses = await post(fixture.apiPort, '/v1/responses', {
      model: 'wrong', input: 'RESPONSES_REASONING', stream: false, store: false,
      reasoning: { effort: 'medium' }, max_output_tokens: 3072
    });
    assert.equal(responses.status, 200);
    const responsesBody = await responses.json();
    assert.equal(responsesBody.output.find((item) => item.type === 'reasoning').content[0].text, 'private reasoning');
    assert.equal(responsesBody.output.find((item) => item.type === 'message').content[0].text, 'llama adapter ok');

    const responsesStream = await post(fixture.apiPort, '/v1/responses', {
      model: 'wrong', input: 'RESPONSES_STREAM_REASONING', stream: true, store: false,
      reasoning_effort: 'medium', max_output_tokens: 3072
    });
    assert.equal(responsesStream.status, 200);
    const sse = await responsesStream.text();
    assert.match(sse, /response\.reasoning_text\.delta/);
    assert.match(sse, /private reasoning/);
    assert.match(sse, /response\.output_text\.delta/);
    assert.equal((await runtimeState(fixture)).runtime.active_count, 0);
  } finally {
    await fixture.cleanup();
  }
});
