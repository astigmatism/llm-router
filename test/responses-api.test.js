import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRouterServer } from '../src/server.js';
import {
  ResponsesApiError,
  translateOllamaResponse,
  translateResponsesRequest
} from '../src/responses-api.js';

const DAY_REASONING_CAPABILITIES = {
  supported_think_levels: ['low', 'medium', 'high', 'max'],
  reasoning_effort_map: {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'max',
    max: 'max'
  }
};

const NIGHT_REASONING_CAPABILITIES = {
  supported_think_levels: ['low', 'medium'],
  reasoning_effort_map: {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: true,
    xhigh: true,
    max: true
  }
};

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.trim() ? JSON.parse(raw) : null;
}

function sendJson(response, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length
  });
  response.end(payload);
}

function lastUserText(body) {
  return [...(body?.messages || [])].reverse().find((message) => message.role === 'user')?.content || '';
}

function createFakeOllama({ capabilities = ['completion'], enforceThinkValues = false, activeModel = 'active:model' } = {}) {
  const requests = [];
  let releaseDelayedHeaders;
  const delayedHeaders = new Promise((resolve) => { releaseDelayedHeaders = resolve; });
  const state = {
    upstreamClosed: false,
    residentModels: new Set([activeModel]),
    releaseDelayedHeaders
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://fake-ollama.local');
    const body = ['GET', 'HEAD'].includes(String(request.method).toUpperCase()) ? null : await readJsonBody(request);
    requests.push({ method: request.method, pathname: url.pathname, body });

    if (request.method === 'GET' && url.pathname === '/api/tags') {
      sendJson(response, 200, { models: [{ name: activeModel, model: activeModel }] });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/ps') {
      sendJson(response, 200, {
        models: [...state.residentModels].map((model) => ({ name: model, model, expires_at: '9999-12-31T23:59:59Z' }))
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/show') {
      sendJson(response, 200, { model: body?.model, capabilities });
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/api/chat') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    state.residentModels.add(body.model);
    if (Object.hasOwn(body || {}, 'tools') && !capabilities.includes('tools')) {
      sendJson(response, 400, { error: `${body.model} does not support tools` });
      return;
    }
    if (
      enforceThinkValues
      && Object.hasOwn(body || {}, 'think')
      && typeof body.think !== 'boolean'
      && !['low', 'medium', 'high', 'max'].includes(body.think)
    ) {
      sendJson(response, 400, {
        error: `invalid think value: ${JSON.stringify(body.think)} (must be "high", "medium", "low", "max", true, or false)`
      });
      return;
    }

    const prompt = lastUserText(body);
    if (prompt === 'delayed-headers') await delayedHeaders;
    if (!body.stream) {
      if (prompt === 'thinking-tool') {
        sendJson(response, 200, {
          model: body.model,
          message: {
            role: 'assistant',
            thinking: 'I should call the weather tool.',
            content: '',
            tool_calls: [{ id: 'call_weather_thinking', function: { name: 'get_weather', arguments: { city: 'Portland' } } }]
          },
          done: true, done_reason: 'stop',
          prompt_eval_count: 14,
          eval_count: 9
        });
        return;
      }
      if (prompt === 'thinking-only') {
        sendJson(response, 200, {
          model: body.model,
          message: {
            role: 'assistant',
            thinking: 'I reached no visible answer.',
            content: ''
          },
          done: true, done_reason: 'stop',
          prompt_eval_count: 17,
          eval_count: 6
        });
        return;
      }
      if (prompt === 'tool') {
        sendJson(response, 200, {
          model: body.model,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_weather_1', function: { name: 'get_weather', arguments: { city: 'Portland' } } }]
          },
          done: true, done_reason: 'stop',
          prompt_eval_count: 12,
          eval_count: 7,
          eval_duration: 1_000_000_000
        });
        return;
      }
      if (prompt === 'malformed-tool') {
        sendJson(response, 200, {
          model: body.model,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_bad', function: { name: 'bad', arguments: '{not-json' } }]
          },
          done: true, done_reason: 'stop'
        });
        return;
      }
      sendJson(response, 200, {
        model: body.model,
        message: {
          role: 'assistant',
          ...(body.think === true ? { thinking: 'reasoning from ollama' } : {}),
          content: 'hello from ollama'
        },
        done: true, done_reason: 'stop',
        prompt_eval_count: 3,
        eval_count: 4,
        total_duration: 2_000_000_000,
        eval_duration: 1_000_000_000
      });
      return;
    }

    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    if (prompt === 'malformed-stream') {
      response.end('{not-json}\n');
      return;
    }
    if (prompt === 'incomplete-stream') {
      response.end(`${JSON.stringify({ message: { role: 'assistant', content: 'partial' }, done: false })}\n`);
      return;
    }
    if (prompt === 'stream-tool') {
      response.write(`${JSON.stringify({
        model: body.model,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_stream_1', function: { name: 'read_value', arguments: { key: 'answer' } } }]
        },
        done: false
      })}\n`);
      response.end(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 2 })}\n`);
      return;
    }
    if (prompt === 'stream-thinking-tool') {
      response.write(`${JSON.stringify({
        model: body.model,
        message: { role: 'assistant', thinking: 'I should ', content: '' },
        done: false
      })}\n`);
      response.write(`${JSON.stringify({
        model: body.model,
        message: { role: 'assistant', thinking: 'read the value.', content: '' },
        done: false
      })}\n`);
      response.write(`${JSON.stringify({
        model: body.model,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_stream_thinking', function: { name: 'read_value', arguments: { key: 'answer' } } }]
        },
        done: false
      })}\n`);
      response.end(`${JSON.stringify({
        model: body.model,
        message: { role: 'assistant', content: '' },
        done: true, done_reason: 'stop',
        prompt_eval_count: 6,
        eval_count: 5
      })}\n`);
      return;
    }
    if (prompt === 'stream-thinking-only') {
      response.write(`${JSON.stringify({
        model: body.model,
        message: { role: 'assistant', thinking: 'I reached no visible answer.', content: '' },
        done: false
      })}\n`);
      response.end(`${JSON.stringify({
        model: body.model,
        message: { role: 'assistant', content: '' },
        done: true, done_reason: 'stop',
        prompt_eval_count: 18,
        eval_count: 5
      })}\n`);
      return;
    }
    if (prompt === 'slow') {
      response.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: false })}\n`);
      response.once('close', () => { state.upstreamClosed = true; });
      setTimeout(() => {
        if (!response.destroyed) response.end(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'late' }, done: true, done_reason: 'stop' })}\n`);
      }, 500);
      return;
    }
    if (body.think === true) {
      response.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', thinking: 'reasoning from ollama', content: '' }, done: false })}\n`);
    }
    response.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'hello ' }, done: false })}\n`);
    response.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'stream' }, done: false })}\n`);
    response.end(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 8, eval_count: 3 })}\n`);
  });
  return { server, requests, state };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections?.();
  await closed;
}

async function makeFixture({
  env = {},
  configOverrides = {},
  marker = true,
  capabilities = ['completion'],
  enforceThinkValues = false
} = {}) {
  const markerModel = typeof marker === 'object' && typeof marker.model === 'string'
    ? marker.model
    : 'active:model';
  const upstream = createFakeOllama({ capabilities, enforceThinkValues, activeModel: markerModel });
  const upstreamPort = await listen(upstream.server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'responses-api-test-'));
  const activeModelFile = path.join(dir, 'active-model.json');
  if (marker) {
    await fs.writeFile(activeModelFile, JSON.stringify({
      model: 'active:model',
      keep_alive: -1,
      ...DAY_REASONING_CAPABILITIES,
      ...(typeof marker === 'object' ? marker : {})
    }), 'utf8');
  }
  const config = {
    ...loadConfig({
      HOST: '127.0.0.1',
      ADMIN_ENABLED: 'false',
      OLLAMA_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
      OLLAMA_UPSTREAM_TIMEOUT_MS: '5000',
      ACTIVE_MODEL_FILE: activeModelFile,
      ACTIVE_MODEL: '',
      DATA_DIR: dir,
      ENABLE_NVIDIA_SMI: 'false',
      ...env
    }),
    ...configOverrides
  };
  const router = await createRouterServer(config);
  const apiPort = await listen(router.server);

  async function cleanup() {
    await close(router.server);
    await router.waitForIdle();
    await close(upstream.server);
    await fs.rm(dir, { recursive: true, force: true });
  }
  return { ...router, upstream, apiPort, activeModelFile, cleanup };
}

function postResponses(fixture, body, pathname = '/v1/responses', options = {}) {
  return fetch(`http://127.0.0.1:${fixture.apiPort}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(body),
    signal: options.signal
  });
}

function parseSse(text) {
  return text
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: ') && block !== 'data: [DONE]')
    .map((block) => JSON.parse(block.slice(6)));
}

async function beforeTimeout(promise, timeoutMs = 1000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('request translation preserves instructions, message roles, images, JSON format, reasoning, and limits', () => {
  const translated = translateResponsesRequest({
    model: 'active:model',
    instructions: 'top-level instruction',
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'developer instruction' }] },
      { role: 'user', content: [
        { type: 'input_text', text: 'describe' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }
      ] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'prior answer' }] }
    ],
    stream: false,
    temperature: 0.25,
    max_output_tokens: 123,
    reasoning: { effort: 'minimal' },
    text: { format: { type: 'json_schema', name: 'result', schema: { type: 'object' } } }
  }, 'active:model', -1);

  assert.equal(translated.upstreamBody.model, 'active:model');
  assert.equal(translated.upstreamBody.keep_alive, -1);
  assert.equal(Object.hasOwn(translated.upstreamBody, 'shift'), false);
  assert.deepEqual(translated.upstreamBody.options, { temperature: 0.25, num_predict: 123 });
  assert.deepEqual(translated.upstreamBody.format, { type: 'object' });
  assert.equal(translated.upstreamBody.think, 'minimal');
  assert.deepEqual(translated.upstreamBody.messages, [
    { role: 'system', content: 'top-level instruction\n\ndeveloper instruction' },
    { role: 'user', content: 'describe', images: ['aGVsbG8='] },
    { role: 'assistant', content: 'prior answer' }
  ]);

  const withContextShift = translateResponsesRequest(
    { input: 'shift enabled', stream: true },
    'active:model',
    -1,
    false,
    true
  );
  assert.equal(withContextShift.upstreamBody.shift, true);
});

test('Responses temperature validation retains the existing finite-number contract', () => {
  const omitted = translateResponsesRequest({ input: 'omitted' }, 'active:model', -1);
  const explicitNull = translateResponsesRequest({ input: 'null', temperature: null }, 'active:model', -1);
  assert.equal(Object.hasOwn(omitted.upstreamBody.options || {}, 'temperature'), false);
  assert.equal(Object.hasOwn(explicitNull.upstreamBody.options || {}, 'temperature'), false);

  for (const invalidTemperature of ['1', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => translateResponsesRequest({ input: 'invalid', temperature: invalidTemperature }, 'active:model', -1),
      (error) => error instanceof ResponsesApiError
        && error.statusCode === 400
        && error.code === 'INVALID_TEMPERATURE'
        && error.param === 'temperature'
    );
  }

  for (const finiteTemperature of [-0.1, 2.1]) {
    const translated = translateResponsesRequest(
      { input: 'finite pass-through', temperature: finiteTemperature },
      'active:model',
      -1
    );
    assert.equal(translated.upstreamBody.options.temperature, finiteTemperature);
  }
});

test('Responses prompt_cache_key accepts only strings and is removed before translation', () => {
  const base = {
    model: 'active:model',
    input: 'same input',
    stream: false,
    store: false,
    temperature: 0,
    max_output_tokens: 32
  };
  const omitted = translateResponsesRequest(base, 'active:model', -1);
  assert.equal(omitted.promptCacheKeyPresent, false);
  assert.equal(omitted.promptCacheKeyDisposition, null);
  assert.equal(Object.hasOwn(omitted.requestBody, 'prompt_cache_key'), false);

  for (const promptCacheKey of ['', 'codex-session-0123456789abcdef', 'scope/α β\tline']) {
    const accepted = translateResponsesRequest({ ...base, prompt_cache_key: promptCacheKey }, 'active:model', -1);
    assert.deepEqual(accepted.upstreamBody, omitted.upstreamBody);
    assert.equal(accepted.promptCacheKeyPresent, true);
    assert.equal(accepted.promptCacheKeyDisposition, 'accepted_ignored');
    assert.equal(Object.hasOwn(accepted.requestBody, 'prompt_cache_key'), false);
  }

  for (const promptCacheKey of [null, false, 0, [], {}]) {
    assert.throws(
      () => translateResponsesRequest({ ...base, prompt_cache_key: promptCacheKey }, 'active:model', -1),
      (error) => error instanceof ResponsesApiError
        && error.statusCode === 400
        && error.code === 'INVALID_PROMPT_CACHE_KEY'
        && error.param === 'prompt_cache_key'
        && !error.message.includes(JSON.stringify(promptCacheKey))
    );
  }
});

test('request translation merges multiple system and developer messages in their relative order', () => {
  const translated = translateResponsesRequest({
    input: [
      { role: 'system', content: 'system one' },
      { role: 'developer', content: [{ type: 'input_text', text: 'developer one' }] },
      { role: 'system', content: '' },
      { role: 'developer', content: 'developer two' },
      { role: 'user', content: 'hello' }
    ]
  }, 'active:model', -1);

  assert.deepEqual(translated.upstreamBody.messages, [
    { role: 'system', content: 'system one\n\ndeveloper one\n\ndeveloper two' },
    { role: 'user', content: 'hello' }
  ]);
});

test('request translation hoists interleaved system-equivalent messages without reordering history', () => {
  const translated = translateResponsesRequest({
    input: [
      { role: 'user', content: 'first user' },
      { role: 'system', content: 'late system' },
      { role: 'assistant', content: 'prior answer' },
      { role: 'developer', content: 'late developer' },
      { role: 'user', content: 'second user' }
    ]
  }, 'active:model', -1);

  assert.deepEqual(translated.upstreamBody.messages, [
    { role: 'system', content: 'late system\n\nlate developer' },
    { role: 'user', content: 'first user' },
    { role: 'assistant', content: 'prior answer' },
    { role: 'user', content: 'second user' }
  ]);
});

test('request translation handles system-equivalent input without instructions and omits empty system messages', () => {
  const withDeveloper = translateResponsesRequest({
    input: [
      { role: 'developer', content: 'developer only' },
      { role: 'user', content: 'hello' }
    ]
  }, 'active:model', -1);
  assert.deepEqual(withDeveloper.upstreamBody.messages, [
    { role: 'system', content: 'developer only' },
    { role: 'user', content: 'hello' }
  ]);

  const withoutSystem = translateResponsesRequest({
    instructions: '',
    input: [
      { role: 'system', content: '' },
      { role: 'developer', content: [] },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' }
    ]
  }, 'active:model', -1);
  assert.deepEqual(withoutSystem.upstreamBody.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' }
  ]);

  const stringInput = translateResponsesRequest({ input: 'hello' }, 'active:model', -1);
  assert.deepEqual(stringInput.upstreamBody.messages, [{ role: 'user', content: 'hello' }]);
});

test('hoisted system-equivalent messages preserve function-call grouping boundaries', () => {
  const translated = translateResponsesRequest({
    input: [
      { type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: '{"key":"a"}' },
      { role: 'developer', content: 'developer boundary' },
      { type: 'function_call', call_id: 'call_b', name: 'lookup', arguments: '{"key":"b"}' },
      { role: 'system', content: 'system boundary' },
      { type: 'function_call', call_id: 'call_c', name: 'lookup', arguments: '{"key":"c"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'first' },
      { type: 'function_call_output', call_id: 'call_b', output: 'second' },
      { type: 'function_call_output', call_id: 'call_c', output: 'third' }
    ]
  }, 'active:model', -1);

  assert.deepEqual(translated.upstreamBody.messages, [
    { role: 'system', content: 'developer boundary\n\nsystem boundary' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'lookup', arguments: { key: 'a' } } }]
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_b', type: 'function', function: { name: 'lookup', arguments: { key: 'b' } } }]
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_c', type: 'function', function: { name: 'lookup', arguments: { key: 'c' } } }]
    },
    { role: 'tool', tool_name: 'lookup', tool_call_id: 'call_a', content: 'first' },
    { role: 'tool', tool_name: 'lookup', tool_call_id: 'call_b', content: 'second' },
    { role: 'tool', tool_name: 'lookup', tool_call_id: 'call_c', content: 'third' }
  ]);
});

test('request translation composes nested and top-level reasoning efforts with configurable defaults', () => {
  const cases = [
    [{ reasoning: { effort: 'none' } }, false],
    [{ reasoning: { effort: 'minimal' } }, 'minimal'],
    [{ reasoning: { effort: 'medium' } }, 'medium'],
    [{ reasoning: { effort: 'xhigh' } }, 'xhigh'],
    [{ reasoning: { effort: 'max' } }, 'max'],
    [{ reasoning_effort: 'low' }, 'low']
  ];
  for (const [reasoning, expected] of cases) {
    const translated = translateResponsesRequest({ input: 'hello', ...reasoning }, 'active:model', -1);
    assert.equal(translated.upstreamBody.think, expected);
  }

  const configured = translateResponsesRequest({ input: 'hello' }, 'active:model', -1, true);
  assert.equal(configured.upstreamBody.think, true);
  const modelDefault = translateResponsesRequest({ input: 'hello' }, 'active:model', -1, undefined);
  assert.equal(Object.hasOwn(modelDefault.upstreamBody, 'think'), false);

  assert.throws(
    () => translateResponsesRequest({
      input: 'hello',
      reasoning: { effort: 'low' },
      reasoning_effort: 'high'
    }, 'active:model', -1),
    (error) => error.code === 'CONFLICTING_REASONING_EFFORT'
  );
});

test('request translation preserves Codex reasoning summary-only, content-only, and combined items', () => {
  const cases = [
    [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary thought' }] },
      'summary thought'
    ],
    [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'raw thought' }] },
      'raw thought'
    ],
    [
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'summary must not replace raw thinking' }],
        content: [{ type: 'reasoning_text', text: 'preserved raw thought' }],
        encrypted_content: null
      },
      'preserved raw thought'
    ]
  ];

  for (const [reasoningItem, expectedThinking] of cases) {
    const translated = translateResponsesRequest({
      input: [
        { role: 'user', content: 'use a tool' },
        reasoningItem,
        { type: 'function_call', call_id: 'call_reasoning', name: 'lookup', arguments: '{"key":"x"}' },
        { type: 'function_call_output', call_id: 'call_reasoning', output: 'result' }
      ]
    }, 'active:model', -1);

    assert.deepEqual(translated.upstreamBody.messages, [
      { role: 'user', content: 'use a tool' },
      {
        role: 'assistant',
        content: '',
        thinking: expectedThinking,
        tool_calls: [{
          id: 'call_reasoning',
          type: 'function',
          function: { name: 'lookup', arguments: { key: 'x' } }
        }]
      },
      { role: 'tool', tool_name: 'lookup', tool_call_id: 'call_reasoning', content: 'result' }
    ]);
  }
});

test('request translation merges reasoning with prior assistant text and accepts encrypted-only history', () => {
  const withText = translateResponsesRequest({
    input: [
      { type: 'reasoning', content: [{ type: 'text', text: 'legacy raw thought' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'visible answer' }] },
      { role: 'user', content: 'continue' }
    ]
  }, 'active:model', -1);
  assert.deepEqual(withText.upstreamBody.messages, [
    { role: 'assistant', content: 'visible answer', thinking: 'legacy raw thought' },
    { role: 'user', content: 'continue' }
  ]);

  const encryptedOnly = translateResponsesRequest({
    input: [
      { type: 'reasoning', summary: [], content: [], encrypted_content: 'opaque-ciphertext' },
      { type: 'function_call', call_id: 'call_encrypted', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_encrypted', output: 'ok' }
    ]
  }, 'active:model', -1);
  assert.equal(Object.hasOwn(encryptedOnly.upstreamBody.messages[0], 'thinking'), false);
  assert.equal(encryptedOnly.upstreamBody.messages[0].tool_calls[0].id, 'call_encrypted');
});

test('malformed reasoning items return INVALID_REASONING_ITEM', () => {
  const malformedItems = [
    { type: 'reasoning' },
    { type: 'reasoning', summary: 'not-an-array' },
    { type: 'reasoning', summary: [{ type: 'text', text: 'wrong type' }] },
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 42 }] },
    { type: 'reasoning', summary: [], content: [], encrypted_content: null },
    { type: 'reasoning', encrypted_content: '' }
  ];
  for (const reasoningItem of malformedItems) {
    assert.throws(
      () => translateResponsesRequest({ input: [reasoningItem] }, 'active:model', -1),
      (error) => error instanceof ResponsesApiError && error.code === 'INVALID_REASONING_ITEM'
    );
  }
});

test('request translation reconstructs multiple function calls and ordered outputs by call_id', () => {
  const translated = translateResponsesRequest({
    input: [
      { role: 'user', content: 'look things up' },
      { type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: '{"key":"a"}' },
      { type: 'function_call', call_id: 'call_b', name: 'lookup', arguments: '{"key":"b"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'first' },
      { type: 'function_call_output', call_id: 'call_b', output: { value: 2 } }
    ],
    tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
    tool_choice: 'auto'
  }, 'active:model', -1);

  assert.deepEqual(translated.upstreamBody.messages.slice(1), [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: { key: 'a' } } },
        { id: 'call_b', type: 'function', function: { name: 'lookup', arguments: { key: 'b' } } }
      ]
    },
    { role: 'tool', tool_name: 'lookup', tool_call_id: 'call_a', content: 'first' },
    { role: 'tool', tool_name: 'lookup', tool_call_id: 'call_b', content: '{"value":2}' }
  ]);
  assert.equal(translated.upstreamBody.tools[0].function.name, 'lookup');
});

test('request translation preserves image-bearing function output as associated tool text plus a user image turn', () => {
  const translated = translateResponsesRequest({
    input: [
      { role: 'user', content: 'capture the browser' },
      { type: 'function_call', call_id: 'call_screen', name: 'browser_screenshot', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call_screen',
        output: [
          { type: 'input_text', text: 'Screenshot captured.' },
          { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }
        ]
      }
    ],
    tools: [{ type: 'function', name: 'browser_screenshot', parameters: { type: 'object' } }]
  }, 'active:model', -1);

  assert.deepEqual(translated.upstreamBody.messages, [
    { role: 'user', content: 'capture the browser' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_screen',
        type: 'function',
        function: { name: 'browser_screenshot', arguments: {} }
      }]
    },
    {
      role: 'tool',
      tool_name: 'browser_screenshot',
      tool_call_id: 'call_screen',
      content: 'Screenshot captured.'
    },
    {
      role: 'user',
      content: 'Image output from tool browser_screenshot (call call_screen).',
      images: ['aGVsbG8=']
    }
  ]);
});

test('request translation rejects unknown/duplicate call IDs and malformed arguments', () => {
  const cases = [
    {
      body: { input: [{ type: 'function_call_output', call_id: 'missing', output: 'x' }] },
      code: 'UNKNOWN_TOOL_CALL_ID'
    },
    {
      body: { input: [
        { type: 'function_call', call_id: 'same', name: 'a', arguments: '{}' },
        { type: 'function_call', call_id: 'same', name: 'a', arguments: '{}' }
      ] },
      code: 'DUPLICATE_TOOL_CALL_ID'
    },
    {
      body: { input: [{ type: 'function_call', call_id: 'bad', name: 'a', arguments: '{bad' }] },
      code: 'MALFORMED_TOOL_ARGUMENTS'
    }
  ];
  for (const item of cases) {
    assert.throws(
      () => translateResponsesRequest(item.body, 'active:model', -1),
      (error) => error instanceof ResponsesApiError && error.code === item.code
    );
  }
});

test('request translation implements auto/none and rejects required, named, and provider-executed tools', () => {
  const tool = { type: 'function', name: 'ok', parameters: { type: 'object' } };
  const none = translateResponsesRequest({ input: 'hello', tools: [tool], tool_choice: 'none' }, 'active:model', -1);
  assert.equal(none.upstreamBody.tools, undefined);

  for (const toolChoice of ['required', { type: 'function', name: 'ok' }]) {
    assert.throws(
      () => translateResponsesRequest({ input: 'hello', tools: [tool], tool_choice: toolChoice }, 'active:model', -1),
      (error) => error.code === 'UNSUPPORTED_TOOL_CHOICE'
    );
  }
  assert.throws(
    () => translateResponsesRequest({ input: 'hello', tools: [{ type: 'web_search' }] }, 'active:model', -1),
    (error) => error.code === 'UNSUPPORTED_TOOL_TYPE'
  );
  assert.throws(
    () => translateResponsesRequest({ input: 'hello', tools: [{ type: 'web_search' }], tool_choice: 'none' }, 'active:model', -1),
    (error) => error.code === 'UNSUPPORTED_TOOL_TYPE'
  );
});

test('Codex namespace function groups flatten for Ollama and restore namespace on output', () => {
  const request = {
    input: 'run a command',
    tools: [{
      type: 'namespace',
      name: 'functions',
      description: 'Local client-executed tools.',
      tools: [{
        type: 'function',
        name: 'exec_command',
        description: 'Run a command.',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
      }]
    }]
  };
  const translated = translateResponsesRequest(request, 'active:model', -1);
  assert.equal(translated.upstreamBody.tools[0].function.name, 'functions__exec_command');
  assert.match(translated.upstreamBody.tools[0].function.description, /Namespace: functions/);

  const response = translateOllamaResponse({ done: true, done_reason: 'stop',
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_exec', function: { name: 'functions__exec_command', arguments: { cmd: 'true' } } }]
    }
  }, request, 'active:model', 'resp_namespace', 42, translated.toolNames);
  assert.equal(response.output[0].name, 'exec_command');
  assert.equal(response.output[0].namespace, 'functions');

  const followUp = translateResponsesRequest({
    ...request,
    input: [
      { type: 'function_call', call_id: 'call_exec', namespace: 'functions', name: 'exec_command', arguments: '{"cmd":"true"}' },
      { type: 'function_call_output', call_id: 'call_exec', output: 'ok' }
    ]
  }, 'active:model', -1);
  assert.equal(followUp.upstreamBody.messages[0].tool_calls[0].function.name, 'functions__exec_command');
  assert.equal(followUp.upstreamBody.messages[1].tool_name, 'functions__exec_command');
});

test('non-stream response translation emits text, function calls, stable IDs, and usage', () => {
  const translated = translateOllamaResponse({
    done: true, done_reason: 'stop',
    message: {
      role: 'assistant',
      content: 'preface',
      tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: { q: 'x' } } }]
    },
    prompt_eval_count: 11,
    eval_count: 4
  }, { input: 'x' }, 'active:model', 'resp_fixed', 42);
  assert.equal(translated.id, 'resp_fixed');
  assert.equal(translated.created_at, 42);
  assert.equal(translated.output[0].content[0].text, 'preface');
  assert.deepEqual(translated.output[1], {
    id: translated.output[1].id,
    type: 'function_call',
    status: 'completed',
    arguments: '{"q":"x"}',
    call_id: 'call_1',
    name: 'lookup'
  });
  assert.deepEqual(translated.usage, {
    input_tokens: 11,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 15
  });
});

test('non-stream response emits raw thinking before assistant text and tool calls with aggregate usage', () => {
  const translated = translateOllamaResponse({
    done: true, done_reason: 'stop',
    message: {
      role: 'assistant',
      thinking: 'careful raw reasoning',
      content: 'tool preface',
      tool_calls: [{ id: 'call_thinking', function: { name: 'lookup', arguments: { q: 'x' } } }]
    },
    prompt_eval_count: 13,
    eval_count: 8
  }, { input: 'x' }, 'active:model', 'resp_thinking', 42);

  assert.deepEqual(translated.output.map((item) => item.type), ['reasoning', 'message', 'function_call']);
  assert.match(translated.output[0].id, /^rs_[a-f0-9]{32}$/);
  assert.deepEqual(translated.output[0], {
    id: translated.output[0].id,
    type: 'reasoning',
    status: 'completed',
    summary: [],
    content: [{ type: 'reasoning_text', text: 'careful raw reasoning' }]
  });
  assert.equal(translated.output[1].content[0].text, 'tool preface');
  assert.equal(translated.output[2].call_id, 'call_thinking');
  assert.deepEqual(translated.usage, {
    input_tokens: 13,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 8,
    output_tokens_details: { reasoning_tokens: 8 },
    total_tokens: 21
  });
});

test('POST /v1/responses defaults to the active model and public discovery exposes its stable alias', async () => {
  const fixture = await makeFixture({ env: { MODEL_POLICY_MODE: 'permissive', REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true' } });
  try {
    const response = await postResponses(fixture, { input: 'hello', stream: false });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.model, 'active:model');
    assert.equal(payload.output[0].content[0].text, 'hello from ollama');
    assert.equal(payload.usage.total_tokens, 7);

    const upstreamChat = fixture.upstream.requests.find((item) => item.pathname === '/api/chat');
    assert.equal(upstreamChat.body.model, 'active:model');
    assert.equal(upstreamChat.body.keep_alive, -1);
    assert.equal(Object.hasOwn(upstreamChat.body, 'shift'), false);
    assert.equal(upstreamChat.body.think, false);
    assert.equal(fixture.upstream.requests.some((item) => item.pathname === '/api/show'), false);
    const record = fixture.context.store.recentRequests(1)[0];
    assert.equal(record.toolsPresent, false);
    assert.equal(record.toolsSupported, null);
    assert.equal(record.toolsDropped, false);

    const tags = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/tags`);
    assert.equal(tags.status, 200);
    assert.equal((await tags.json()).models[0].name, 'active:model');
    assert.equal(fixture.upstream.requests.filter((item) => item.pathname === '/api/tags').length, 1);

    const models = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`);
    assert.equal(models.status, 200);
    const catalog = await models.json();
    assert.deepEqual(catalog.data.map((model) => model.id), ['local-active']);
  } finally {
    await fixture.cleanup();
  }
});

test('Responses reasoning drops enabled think for unsupported models and preserves it for supported models', async () => {
  const unsupported = await makeFixture();
  try {
    const response = await postResponses(unsupported, {
      input: 'hello',
      reasoning: { effort: 'high' }
    });
    assert.equal(response.status, 200);

    const showRequest = unsupported.upstream.requests.find((item) => item.pathname === '/api/show');
    assert.deepEqual(showRequest.body, { model: 'active:model' });
    const chatRequest = unsupported.upstream.requests.find((item) => item.pathname === '/api/chat');
    assert.equal(Object.hasOwn(chatRequest.body, 'think'), false);

    const record = unsupported.context.store.recentRequests(1)[0];
    assert.equal(record.incomingThink, 'high');
    assert.equal(record.thinkNormalized, true);
    assert.equal(record.thinkingSupported, false);
    assert.equal(record.reasoningEffort, 'high');
  } finally {
    await unsupported.cleanup();
  }

  const supported = await makeFixture({ capabilities: ['completion', 'thinking'] });
  try {
    const response = await postResponses(supported, {
      input: 'hello',
      reasoning: { effort: 'low' }
    });
    assert.equal(response.status, 200);

    const chatRequest = supported.upstream.requests.find((item) => item.pathname === '/api/chat');
    assert.equal(chatRequest.body.think, 'low');
    const record = supported.context.store.recentRequests(1)[0];
    assert.equal(record.thinkNormalized, false);
    assert.equal(record.thinkingSupported, true);
    assert.equal(record.reasoningEffort, 'low');
  } finally {
    await supported.cleanup();
  }
});

test('Responses reasoning gracefully falls back to binary capabilities without profile metadata', async () => {
  for (const item of [
    { capabilities: ['completion', 'thinking'], expectedThink: true, thinkingSupported: true },
    { capabilities: ['completion'], expectedThink: undefined, thinkingSupported: false }
  ]) {
    const fixture = await makeFixture({
      marker: { supported_think_levels: undefined, reasoning_effort_map: undefined },
      capabilities: item.capabilities,
      enforceThinkValues: true
    });
    try {
      const response = await postResponses(fixture, {
        input: 'binary fallback',
        reasoning: { effort: 'max' }
      });
      assert.equal(response.status, 200);

      const chat = fixture.upstream.requests.find((request) => request.pathname === '/api/chat');
      assert.equal(chat.body.think, item.expectedThink);
      assert.equal(Object.hasOwn(chat.body, 'think'), item.expectedThink !== undefined);
      const record = fixture.context.store.recentRequests(1)[0];
      assert.equal(record.incomingThink, 'max');
      assert.equal(record.forwardedThink, item.expectedThink);
      assert.equal(record.thinkMapped, true);
      assert.equal(record.thinkDropped, item.expectedThink === undefined);
      assert.equal(record.thinkingSupported, item.thinkingSupported);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('Responses applies active-model thinking defaults with per-request precedence', async () => {
  const fixture = await makeFixture({
    env: { DEFAULT_THINK: 'high' },
    marker: { default_think: 'low' },
    capabilities: ['completion', 'thinking']
  });
  try {
    const defaulted = await postResponses(fixture, { input: 'default' });
    assert.equal(defaulted.status, 200);
    const explicit = await postResponses(fixture, { input: 'explicit', reasoning_effort: 'xhigh' });
    assert.equal(explicit.status, 200);

    const chats = fixture.upstream.requests.filter((item) => item.pathname === '/api/chat');
    assert.equal(chats[0].body.think, 'low');
    assert.equal(chats[1].body.think, 'max');
  } finally {
    await fixture.cleanup();
  }
});

test('Responses negotiates day and night efforts for streaming, non-streaming, and omitted defaults', async () => {
  const profiles = [
    {
      marker: { ...NIGHT_REASONING_CAPABILITIES, default_think: 'max' },
      requests: [
        [{ input: 'night max', reasoning: { effort: 'max' }, stream: false }, 'max', true],
        [{ input: 'night xhigh', reasoning_effort: 'xhigh', stream: true }, 'xhigh', true],
        [{ input: 'night high', reasoning: { effort: 'high' }, stream: false }, 'high', true],
        [{ input: 'night low', reasoning: { effort: 'low' }, stream: false }, 'low', 'low'],
        [{ input: 'night medium', reasoning: { effort: 'medium' }, stream: true }, 'medium', 'medium'],
        [{ input: 'night default', stream: false }, null, true]
      ]
    },
    {
      marker: DAY_REASONING_CAPABILITIES,
      requests: [
        [{ input: 'day xhigh', reasoning: { effort: 'xhigh' }, stream: false }, 'xhigh', 'max'],
        [{ input: 'day max', reasoning_effort: 'max', stream: true }, 'max', 'max']
      ]
    }
  ];

  for (const profile of profiles) {
    const fixture = await makeFixture({
      marker: profile.marker,
      capabilities: ['completion', 'thinking'],
      enforceThinkValues: true
    });
    try {
      for (const [body] of profile.requests) {
        const response = await postResponses(fixture, body);
        assert.equal(response.status, 200);
        await response.text();
      }

      const chats = fixture.upstream.requests.filter((request) => request.pathname === '/api/chat');
      assert.deepEqual(chats.map((request) => request.body.think), profile.requests.map((request) => request[2]));
      const records = fixture.context.store.recentRequests(profile.requests.length).reverse();
      assert.deepEqual(records.map((record) => record.incomingReasoningEffort), profile.requests.map((request) => request[1]));
      assert.deepEqual(records.map((record) => record.forwardedThink), profile.requests.map((request) => request[2]));
      assert.deepEqual(records.map((record) => record.streaming), profile.requests.map((request) => request[0].stream));
      if (profile.marker.default_think === 'max') {
        assert.deepEqual(records.map((record) => record.thinkMapped), [true, true, true, false, false, true]);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test('Responses nighttime max and xhigh pass strict Ollama think validation with visible reasoning and answers', async () => {
  const fixture = await makeFixture({
    marker: NIGHT_REASONING_CAPABILITIES,
    capabilities: ['completion', 'thinking'],
    enforceThinkValues: true
  });
  try {
    const nonStreaming = await postResponses(fixture, {
      input: 'strict non-stream',
      reasoning: { effort: 'max' },
      stream: false
    });
    assert.equal(nonStreaming.status, 200);
    const nonStreamingPayload = await nonStreaming.json();
    assert.deepEqual(nonStreamingPayload.output.map((item) => item.type), ['reasoning', 'message']);
    assert.equal(nonStreamingPayload.output[0].content[0].text, 'reasoning from ollama');
    assert.equal(nonStreamingPayload.output[1].content[0].text, 'hello from ollama');

    const streaming = await postResponses(fixture, {
      input: 'strict stream',
      reasoning_effort: 'xhigh',
      stream: true
    });
    assert.equal(streaming.status, 200);
    const streamEvents = parseSse(await streaming.text());
    assert.deepEqual(
      streamEvents.filter((event) => event.type === 'response.reasoning_text.delta').map((event) => event.delta),
      ['reasoning from ollama']
    );
    assert.deepEqual(
      streamEvents.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta),
      ['hello ', 'stream']
    );
    assert.equal(streamEvents.at(-1).type, 'response.completed');

    const chats = fixture.upstream.requests.filter((request) => request.pathname === '/api/chat');
    assert.deepEqual(chats.map((request) => request.body.think), [true, true]);
    assert.deepEqual(chats.map((request) => request.body.keep_alive), [-1, -1]);
    const records = fixture.context.store.recentRequests(2).reverse();
    assert.deepEqual(records.map((record) => record.incomingReasoningEffort), ['max', 'xhigh']);
    assert.deepEqual(records.map((record) => record.forwardedThink), [true, true]);
    assert.deepEqual(records.map((record) => record.thinkMapped), [true, true]);
    assert.deepEqual(records.map((record) => record.upstreamError), [false, false]);
  } finally {
    await fixture.cleanup();
  }
});

test('Responses rejects incomplete and inconsistent capability profiles before Ollama', async () => {
  const cases = [
    {
      marker: { reasoning_effort_map: undefined },
      request: { input: 'incomplete' },
      code: 'INVALID_REASONING_CAPABILITIES'
    },
    {
      marker: {
        reasoning_effort_map: { ...DAY_REASONING_CAPABILITIES.reasoning_effort_map, max: 'xhigh' }
      },
      request: { input: 'inconsistent', reasoning: { effort: 'max' } },
      code: 'INVALID_REASONING_CAPABILITIES'
    },
    {
      marker: { ...NIGHT_REASONING_CAPABILITIES, supported_think_levels: ['low', 1] },
      request: { input: 'malformed levels', reasoning: { effort: 'medium' } },
      code: 'INVALID_REASONING_CAPABILITIES'
    },
    {
      marker: {
        ...NIGHT_REASONING_CAPABILITIES,
        reasoning_effort_map: { ...NIGHT_REASONING_CAPABILITIES.reasoning_effort_map, high: false }
      },
      request: { input: 'invalid false target', reasoning: { effort: 'high' } },
      code: 'INVALID_REASONING_CAPABILITIES'
    }
  ];

  for (const item of cases) {
    const fixture = await makeFixture({ marker: item.marker, capabilities: ['completion', 'thinking'] });
    try {
      const response = await postResponses(fixture, item.request);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, item.code);
      assert.equal(fixture.upstream.requests.some((request) => request.pathname === '/api/chat'), false);
      assert.equal(fixture.upstream.requests.some((request) => request.pathname === '/api/show'), false);
      assert.equal(fixture.context.store.recentRequests(1)[0].upstreamError, false);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('invalid active-model thinking defaults fail closed before generation', async () => {
  const fixture = await makeFixture({ marker: { default_think: 'turbo' } });
  try {
    const response = await postResponses(fixture, { input: 'hello' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'INVALID_ACTIVE_MODEL_THINK_DEFAULT');
    assert.equal(fixture.upstream.requests.some((item) => item.pathname === '/api/chat'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('Responses rewrite mode treats requested models as advisory and preserves active-model residency', async () => {
  const activeModel = 'model-a:test';
  const fixture = await makeFixture({
    env: { REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true' },
    marker: { model: activeModel, ...NIGHT_REASONING_CAPABILITIES },
    capabilities: ['completion', 'thinking']
  });
  try {
    const markerBefore = await fs.readFile(fixture.activeModelFile, 'utf8');
    const cases = [
      { model: 'legacy-client:test', stream: false, input: 'legacy profile identifier' },
      { model: activeModel, stream: true, input: 'exact active identifier' },
      { model: 'client-slot:test', stream: true, input: 'stable client identifier', reasoning: { effort: 'xhigh' } },
      { model: 'local-active', stream: false, input: 'documented stable identifier' },
      { stream: false, input: 'omitted identifier' }
    ];

    for (const body of cases) {
      const response = await postResponses(fixture, body);
      assert.equal(response.status, 200);
      if (body.stream) {
        const events = parseSse(await response.text());
        assert.equal(events.at(-1).type, 'response.completed');
        assert.equal(events.at(-1).response.model, activeModel);
      } else {
        assert.equal((await response.json()).model, activeModel);
      }
    }

    const chats = fixture.upstream.requests.filter((item) => item.pathname === '/api/chat');
    assert.equal(chats.length, cases.length);
    assert.deepEqual(chats.map((item) => item.body.model), cases.map(() => activeModel));
    assert.deepEqual(chats.map((item) => item.body.keep_alive), cases.map(() => -1));
    assert.equal(chats.every((item) => !Object.hasOwn(item.body, 'shift')), true);
    assert.equal(chats[2].body.think, true);

    const psResponse = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/ps`);
    assert.equal(psResponse.status, 200);
    const ps = await psResponse.json();
    assert.deepEqual(ps.models.map((model) => model.name), [activeModel]);

    for (const [method, pathname] of [
      ['POST', '/api/pull'],
      ['POST', '/api/create'],
      ['POST', '/api/copy'],
      ['POST', '/api/push'],
      ['DELETE', '/api/delete']
    ]) {
      const response = await fetch(`http://127.0.0.1:${fixture.apiPort}${pathname}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'attacker:model', name: 'attacker:model' })
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'MODEL_MANAGEMENT_DISABLED');
    }

    const managementPaths = new Set(['/api/pull', '/api/create', '/api/copy', '/api/push', '/api/delete']);
    assert.equal(fixture.upstream.requests.some((item) => managementPaths.has(item.pathname)), false);
    assert.equal(await fs.readFile(fixture.activeModelFile, 'utf8'), markerBefore);

    const records = fixture.context.store.recentRequests(cases.length + 6)
      .filter((record) => record.endpoint === '/v1/responses');
    assert.equal(records.length, cases.length);
    for (const record of records) {
      assert.equal(record.activeModel, activeModel);
      assert.equal(record.forwardedModel, activeModel);
      assert.equal(record.status, 200);
      assert.equal(record.responseStatus, 200);
      assert.equal(Object.hasOwn(record.bodySummary, 'input'), false);
    }
    const recordsByRequestedModel = new Map(records.map((record) => [record.requestedModel, record]));
    assert.equal(recordsByRequestedModel.get('legacy-client:test').modelRewritten, true);
    assert.equal(recordsByRequestedModel.get(activeModel).modelRewritten, false);
    assert.equal(recordsByRequestedModel.get('client-slot:test').modelRewritten, true);
    assert.equal(recordsByRequestedModel.get('client-slot:test').incomingReasoningEffort, 'xhigh');
    assert.equal(recordsByRequestedModel.get('client-slot:test').forwardedThink, true);
    assert.equal(recordsByRequestedModel.get('local-active').modelRewritten, true);
    assert.equal(recordsByRequestedModel.get(null).modelRewritten, true);

    const rewriteEvents = fixture.context.store.recentEvents(10)
      .filter((event) => event.type === 'model_rewritten_to_active');
    assert.equal(rewriteEvents.length, 4);
    assert.equal(rewriteEvents.every((event) => event.forwardedModel === activeModel), true);
  } finally {
    await fixture.cleanup();
  }
});

test('Responses strict mode accepts the public alias, exact, and omitted models but rejects other names', async () => {
  const fixture = await makeFixture({
    env: {
      REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'false',
      MODEL_POLICY_MODE: 'permissive',
      ALLOWED_MODELS: 'other-client:test'
    }
  });
  try {
    const exact = await postResponses(fixture, { model: 'active:model', input: 'exact' });
    assert.equal(exact.status, 200);

    const omitted = await postResponses(fixture, { input: 'omitted' });
    assert.equal(omitted.status, 200);

    const alias = await postResponses(fixture, { model: 'local-active', input: 'stable alias' });
    assert.equal(alias.status, 200);

    const rejected = await postResponses(fixture, { model: 'other-client:test', input: 'mismatch' });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, 'MODEL_NOT_ACTIVE');

    const chats = fixture.upstream.requests.filter((item) => item.pathname === '/api/chat');
    assert.equal(chats.length, 3);
    assert.deepEqual(chats.map((item) => item.body.model), ['active:model', 'active:model', 'active:model']);
    const rejectedRecord = fixture.context.store.recentRequests(1)[0];
    assert.equal(rejectedRecord.requestedModel, 'other-client:test');
    assert.equal(rejectedRecord.activeModel, 'active:model');
    assert.equal(rejectedRecord.forwardedModel, null);
    assert.equal(rejectedRecord.modelRewritten, false);
    assert.equal(rejectedRecord.status, 400);
  } finally {
    await fixture.cleanup();
  }
});

test('Responses rewrite mode rejects empty model identifiers before Ollama', async () => {
  const fixture = await makeFixture({ env: { REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true' } });
  try {
    for (const model of ['', '   ']) {
      const response = await postResponses(fixture, { model, input: 'invalid identifier' });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'INVALID_MODEL');
    }
    assert.equal(fixture.upstream.requests.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('stateless contract rejects store=true and previous_response_id before Ollama', async () => {
  const fixture = await makeFixture();
  try {
    for (const body of [
      { input: 'hello', store: true },
      { input: 'hello', previous_response_id: 'resp_old' }
    ]) {
      const response = await postResponses(fixture, body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'STATEFUL_REQUEST_UNSUPPORTED');
    }
    assert.equal(fixture.upstream.requests.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('malformed reasoning history returns a Responses validation error before Ollama', async () => {
  const fixture = await makeFixture();
  try {
    const response = await postResponses(fixture, {
      input: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 42 }] }]
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.type, 'invalid_request_error');
    assert.equal(payload.error.code, 'INVALID_REASONING_ITEM');
    assert.equal(payload.error.param, 'input[0].content[0].text');
    assert.equal(fixture.upstream.requests.some((item) => item.pathname === '/api/chat'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('missing active marker fails closed and maintenance mode rejects Responses generation', async () => {
  const missing = await makeFixture({ marker: false });
  try {
    const response = await postResponses(missing, { input: 'hello' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'NO_ACTIVE_MODEL');
    assert.equal(missing.upstream.requests.length, 0);
  } finally {
    await missing.cleanup();
  }

  const maintenance = await makeFixture();
  try {
    maintenance.context.state.maintenanceMode = true;
    const response = await postResponses(maintenance, { input: 'hello' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'MAINTENANCE_MODE');
    assert.equal(maintenance.upstream.requests.length, 0);
  } finally {
    await maintenance.cleanup();
  }
});

test('Responses drop policy removes unsupported tools before validation for streaming and non-streaming chat', async () => {
  const fixture = await makeFixture({
    env: {
      REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true',
      UNSUPPORTED_TOOLS_POLICY: 'drop'
    }
  });
  try {
    const nonStreaming = await postResponses(fixture, {
      model: 'stable-responses-name',
      input: 'hello',
      stream: false,
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_tool_calls: 2
    }, '/responses');
    assert.equal(nonStreaming.status, 200);
    const nonStreamingPayload = await nonStreaming.json();
    assert.deepEqual(nonStreamingPayload.tools, []);
    assert.equal(nonStreamingPayload.tool_choice, 'auto');

    const streaming = await postResponses(fixture, {
      model: 'stable-responses-name',
      input: 'hello',
      stream: true,
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      tool_choice: 'auto',
      parallel_tool_calls: true
    });
    assert.equal(streaming.status, 200);
    assert.equal(parseSse(await streaming.text()).at(-1).type, 'response.completed');
    await fixture.waitForIdle();

    const chats = fixture.upstream.requests.filter((item) => item.pathname === '/api/chat');
    assert.equal(chats.length, 2);
    for (const chat of chats) {
      for (const field of ['tools', 'tool_choice', 'parallel_tool_calls', 'max_tool_calls']) {
        assert.equal(Object.hasOwn(chat.body, field), false);
      }
    }
    assert.deepEqual(
      fixture.upstream.requests.filter((item) => item.pathname === '/api/show').map((item) => item.body),
      [{ model: 'active:model' }, { model: 'active:model' }]
    );

    const records = fixture.context.store.recentRequests(2);
    assert.deepEqual(records.map((record) => record.toolsDropped), [true, true]);
    assert.deepEqual(records.map((record) => record.toolsSupported), [false, false]);
    assert.deepEqual(records.map((record) => record.unsupportedToolsPolicy), ['drop', 'drop']);
    const events = fixture.context.store.recentEvents(20).filter((event) => event.type === 'unsupported_tools_dropped');
    assert.equal(events.length, 2);
    assert.equal(events.every((event) => !Object.hasOwn(event, 'tools')), true);
  } finally {
    await fixture.cleanup();
  }
});

test('Responses preserves supported tool controls and rejects unsupported prior tool history safely', async () => {
  const supported = await makeFixture({
    env: { UNSUPPORTED_TOOLS_POLICY: 'drop' },
    capabilities: ['completion', 'tools']
  });
  const tools = [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }];
  try {
    const response = await postResponses(supported, {
      input: 'hello',
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_tool_calls: 4
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.tools, tools);
    assert.equal(payload.tool_choice, 'auto');
    assert.equal(payload.parallel_tool_calls, false);

    const chat = supported.upstream.requests.find((item) => item.pathname === '/api/chat');
    assert.deepEqual(chat.body.tools, [{
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Lookup',
        parameters: { type: 'object' }
      }
    }]);
    assert.equal(chat.body.tool_choice, 'auto');
    assert.equal(chat.body.parallel_tool_calls, false);
    assert.equal(chat.body.max_tool_calls, 4);
    const record = supported.context.store.recentRequests(1)[0];
    assert.equal(record.toolsSupported, true);
    assert.equal(record.toolsDropped, false);
  } finally {
    await supported.cleanup();
  }

  const unsupported = await makeFixture({ env: { UNSUPPORTED_TOOLS_POLICY: 'drop' } });
  try {
    const response = await postResponses(unsupported, {
      input: [
        { role: 'user', content: 'lookup' },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'result' }
      ]
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, 'UNSUPPORTED_TOOL_HISTORY');
    assert.equal(payload.error.param, 'input');
    assert.equal(unsupported.upstream.requests.some((item) => item.pathname === '/api/chat'), false);
    assert.deepEqual(
      unsupported.upstream.requests.filter((item) => item.pathname === '/api/show').map((item) => item.body),
      [{ model: 'active:model' }]
    );
  } finally {
    await unsupported.cleanup();
  }
});

test('function tool request and tool output follow-up preserve definitions and call_id', async () => {
  const fixture = await makeFixture({ capabilities: ['completion', 'tools'] });
  const tool = { type: 'function', name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } };
  try {
    const first = await postResponses(fixture, { input: 'tool', tools: [tool], tool_choice: 'auto' });
    assert.equal(first.status, 200);
    const firstPayload = await first.json();
    const call = firstPayload.output.find((item) => item.type === 'function_call');
    assert.equal(call.call_id, 'call_weather_1');
    assert.equal(call.arguments, '{"city":"Portland"}');

    const second = await postResponses(fixture, {
      input: [
        { role: 'user', content: 'tool' },
        call,
        { type: 'function_call_output', call_id: call.call_id, output: 'rain' }
      ],
      tools: [tool]
    });
    assert.equal(second.status, 200);

    const secondUpstream = fixture.upstream.requests.filter((item) => item.pathname === '/api/chat')[1].body;
    assert.equal(secondUpstream.tools[0].function.name, 'get_weather');
    assert.equal(secondUpstream.messages[1].tool_calls[0].id, 'call_weather_1');
    assert.deepEqual(secondUpstream.messages[2], {
      role: 'tool',
      tool_name: 'get_weather',
      tool_call_id: 'call_weather_1',
      content: 'rain'
    });
  } finally {
    await fixture.cleanup();
  }
});

test('reasoning plus a tool call is returned and preserved with the tool result on the next request', async () => {
  const fixture = await makeFixture({ capabilities: ['completion', 'thinking', 'tools'] });
  const tool = { type: 'function', name: 'get_weather', parameters: { type: 'object' } };
  try {
    const first = await postResponses(fixture, {
      input: 'thinking-tool',
      reasoning: { effort: 'high' },
      tools: [tool]
    });
    assert.equal(first.status, 200);
    const firstPayload = await first.json();
    assert.deepEqual(firstPayload.output.map((item) => item.type), ['reasoning', 'function_call']);
    const reasoning = firstPayload.output[0];
    const call = firstPayload.output[1];
    assert.equal(reasoning.content[0].text, 'I should call the weather tool.');
    assert.equal(reasoning.summary.length, 0);
    assert.match(reasoning.id, /^rs_[a-f0-9]{32}$/);
    assert.equal(call.call_id, 'call_weather_thinking');
    assert.deepEqual(firstPayload.usage, {
      input_tokens: 14,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 9,
      output_tokens_details: { reasoning_tokens: 9 },
      total_tokens: 23
    });

    const second = await postResponses(fixture, {
      input: [
        { role: 'user', content: 'thinking-tool' },
        reasoning,
        call,
        { type: 'function_call_output', call_id: call.call_id, output: 'rain' }
      ],
      tools: [tool]
    });
    assert.equal(second.status, 200);

    const secondUpstream = fixture.upstream.requests.filter((item) => item.pathname === '/api/chat')[1].body;
    assert.deepEqual(secondUpstream.messages, [
      { role: 'user', content: 'thinking-tool' },
      {
        role: 'assistant',
        content: '',
        thinking: 'I should call the weather tool.',
        tool_calls: [{
          id: 'call_weather_thinking',
          type: 'function',
          function: { name: 'get_weather', arguments: { city: 'Portland' } }
        }]
      },
      {
        role: 'tool',
        tool_name: 'get_weather',
        tool_call_id: 'call_weather_thinking',
        content: 'rain'
      }
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test('streaming text emits a coherent monotonic SSE lifecycle and completed usage', async () => {
  const fixture = await makeFixture();
  try {
    const response = await postResponses(fixture, { input: 'stream', stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const raw = await response.text();
    assert.match(raw, /data: \[DONE\]/);
    const events = parseSse(raw);
    assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
    assert.equal(events[0].type, 'response.created');
    assert.equal(events[1].type, 'response.in_progress');
    assert.deepEqual(
      events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta),
      ['hello ', 'stream']
    );
    assert.equal(events.at(-1).type, 'response.completed');
    assert.equal(events.at(-1).response.output[0].content[0].text, 'hello stream');
    assert.equal(events.at(-1).response.usage.total_tokens, 11);
  } finally {
    await fixture.cleanup();
  }
});

test('streaming response headers and lifecycle begin before Ollama response headers arrive', async () => {
  const fixture = await makeFixture();
  try {
    const pendingResponse = postResponses(fixture, { input: 'delayed-headers', stream: true });
    const earlyResult = await beforeTimeout(pendingResponse.then((response) => ({ response })));
    assert.equal(earlyResult.timedOut, undefined, 'router waited for Ollama before starting SSE');
    assert.equal(earlyResult.response.status, 200);
    assert.match(earlyResult.response.headers.get('content-type') || '', /text\/event-stream/);

    const reader = earlyResult.response.body.getReader();
    let raw = '';
    const firstEventResult = await beforeTimeout(
      (async () => {
        while (!parseSse(raw).length) {
          const { done, value } = await reader.read();
          assert.equal(done, false, 'SSE ended before response.created');
          raw += Buffer.from(value).toString('utf8');
        }
        return { event: parseSse(raw)[0] };
      })()
    );
    assert.equal(firstEventResult.timedOut, undefined, 'router did not emit SSE before Ollama responded');
    assert.equal(firstEventResult.event.type, 'response.created');

    fixture.upstream.state.releaseDelayedHeaders();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += Buffer.from(value).toString('utf8');
    }
    assert.match(raw, /data: \[DONE\]/);
    const events = parseSse(raw);
    assert.equal(events.at(-1).type, 'response.completed');
  } finally {
    fixture.upstream.state.releaseDelayedHeaders();
    await fixture.cleanup();
  }
});

test('streaming function calls emit argument delta/done and matching output item IDs', async () => {
  const fixture = await makeFixture({ capabilities: ['completion', 'tools'] });
  try {
    const response = await postResponses(fixture, {
      input: 'stream-tool',
      stream: true,
      tools: [{ type: 'function', name: 'read_value', parameters: { type: 'object' } }]
    });
    const events = parseSse(await response.text());
    const added = events.find((event) => event.type === 'response.output_item.added');
    const delta = events.find((event) => event.type === 'response.function_call_arguments.delta');
    const done = events.find((event) => event.type === 'response.function_call_arguments.done');
    const itemDone = events.find((event) => event.type === 'response.output_item.done');
    assert.equal(added.item.call_id, 'call_stream_1');
    assert.equal(delta.item_id, added.item.id);
    assert.equal(done.item_id, added.item.id);
    assert.equal(itemDone.item.id, added.item.id);
    assert.equal(done.arguments, '{"key":"answer"}');
    assert.equal(events.at(-1).response.output[0].call_id, 'call_stream_1');
  } finally {
    await fixture.cleanup();
  }
});

test('streaming thinking emits a complete reasoning item before the following tool call', async () => {
  const fixture = await makeFixture({ capabilities: ['completion', 'thinking', 'tools'] });
  try {
    const response = await postResponses(fixture, {
      input: 'stream-thinking-tool',
      stream: true,
      reasoning: { effort: 'medium' },
      tools: [{ type: 'function', name: 'read_value', parameters: { type: 'object' } }]
    });
    assert.equal(response.status, 200);
    const events = parseSse(await response.text());
    const reasoningAddedIndex = events.findIndex(
      (event) => event.type === 'response.output_item.added' && event.item.type === 'reasoning'
    );
    const reasoningDoneIndex = events.findIndex((event) => event.type === 'response.reasoning_text.done');
    const reasoningItemDoneIndex = events.findIndex(
      (event) => event.type === 'response.output_item.done' && event.item.type === 'reasoning'
    );
    const toolAddedIndex = events.findIndex(
      (event) => event.type === 'response.output_item.added' && event.item.type === 'function_call'
    );
    assert.ok(reasoningAddedIndex >= 0);
    assert.ok(reasoningDoneIndex > reasoningAddedIndex);
    assert.ok(reasoningItemDoneIndex > reasoningDoneIndex);
    assert.ok(toolAddedIndex > reasoningItemDoneIndex);

    const reasoningAdded = events[reasoningAddedIndex];
    assert.match(reasoningAdded.item.id, /^rs_[a-f0-9]{32}$/);
    assert.deepEqual(
      events.filter((event) => event.type === 'response.reasoning_text.delta').map((event) => event.delta),
      ['I should ', 'read the value.']
    );
    assert.equal(events[reasoningDoneIndex].item_id, reasoningAdded.item.id);
    assert.equal(events[reasoningDoneIndex].text, 'I should read the value.');
    assert.equal(events[reasoningItemDoneIndex].item.id, reasoningAdded.item.id);

    const completed = events.at(-1);
    assert.equal(completed.type, 'response.completed');
    assert.deepEqual(completed.response.output.map((item) => item.type), ['reasoning', 'function_call']);
    assert.equal(completed.response.output[0].content[0].text, 'I should read the value.');
    assert.equal(completed.response.output[1].call_id, 'call_stream_thinking');
    assert.deepEqual(completed.response.usage, {
      input_tokens: 6,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 11
    });
  } finally {
    await fixture.cleanup();
  }
});

test('thinking-only Responses completions fail without fabricating assistant messages', async () => {
  const fixture = await makeFixture({ capabilities: ['completion', 'thinking'] });
  try {
    const nonStreaming = await postResponses(fixture, {
      input: 'thinking-only',
      reasoning: { effort: 'medium' }
    });
    assert.equal(nonStreaming.status, 502);
    const nonStreamingPayload = await nonStreaming.json();
    assert.equal(nonStreamingPayload.error.type, 'server_error');
    assert.equal(nonStreamingPayload.error.code, 'EMPTY_UPSTREAM_RESPONSE');

    const streaming = await postResponses(fixture, {
      input: 'stream-thinking-only',
      stream: true,
      reasoning: { effort: 'medium' }
    });
    assert.equal(streaming.status, 200);
    const events = parseSse(await streaming.text());
    assert.equal(events.at(-1).type, 'response.failed');
    assert.equal(events.at(-1).response.error.code, 'EMPTY_UPSTREAM_RESPONSE');
    assert.equal(events.some((event) => event.type === 'response.completed'), false);
    assert.equal(events.some(
      (event) => event.type === 'response.output_item.added' && event.item.type === 'message'
    ), false);

    assert.throws(
      () => translateOllamaResponse({ done: true, done_reason: 'stop', message: { role: 'assistant', content: '   ' } }, { input: 'x' }, 'active:model'),
      (error) => error instanceof ResponsesApiError && error.code === 'EMPTY_UPSTREAM_RESPONSE'
    );
  } finally {
    await fixture.cleanup();
  }
});

test('malformed and incomplete Ollama streams terminate with response.failed', async () => {
  const fixture = await makeFixture();
  try {
    for (const input of ['malformed-stream', 'incomplete-stream']) {
      const response = await postResponses(fixture, { input, stream: true });
      assert.equal(response.status, 200);
      const events = parseSse(await response.text());
      assert.equal(events.at(-1).type, 'response.failed');
      assert.match(events.at(-1).response.error.code, /MALFORMED|INCOMPLETE/);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('malformed non-stream tool arguments return a standard Responses error', async () => {
  const fixture = await makeFixture();
  try {
    const response = await postResponses(fixture, { input: 'malformed-tool' });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.type, 'server_error');
    assert.equal(payload.error.code, 'MALFORMED_UPSTREAM_TOOL_ARGUMENTS');
  } finally {
    await fixture.cleanup();
  }
});

test('the /responses alias works and request history records fixed-model forwarding', async () => {
  const fixture = await makeFixture();
  try {
    const response = await postResponses(fixture, { input: 'hello' }, '/responses');
    assert.equal(response.status, 200);
    const history = fixture.context.store.recentRequests(1)[0];
    assert.equal(history.endpoint, '/responses');
    assert.equal(history.requestedModel, null);
    assert.equal(history.forwardedModel, 'active:model');
    assert.equal(history.forwardedKeepAlive, -1);
  } finally {
    await fixture.cleanup();
  }
});

test('a streamed upstream timeout fails coherently and client cancellation closes the Ollama request', async () => {
  const timeoutFixture = await makeFixture({ configOverrides: { generationStallTimeoutMs: 30 } });
  try {
    const timeoutResponse = await postResponses(timeoutFixture, { input: 'slow', stream: true });
    assert.equal(timeoutResponse.status, 200);
    const events = parseSse(await timeoutResponse.text());
    assert.equal(events.at(-1).type, 'response.failed');
    assert.equal(events.at(-1).response.error.code, 'UPSTREAM_TIMEOUT');
  } finally {
    await timeoutFixture.cleanup();
  }

  const cancelFixture = await makeFixture();
  try {
    const controller = new AbortController();
    const response = await postResponses(cancelFixture, { input: 'slow', stream: true }, '/v1/responses', { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await assert.rejects(() => reader.read(), /abort/i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cancelFixture.upstream.state.upstreamClosed, true);
  } finally {
    await cancelFixture.cleanup();
  }
});

test('the record behind a Responses request carries what only the pipeline knows', async () => {
  const fixture = await makeFixture();
  try {
    const streamed = await postResponses(fixture, { model: 'active:model', input: 'first', stream: true });
    assert.equal(streamed.status, 200);
    await streamed.text();
    const plain = await postResponses(fixture, { model: 'active:model', input: 'second', stream: false });
    assert.equal(plain.status, 200);
    await plain.text();

    const [streamedRecord, plainRecord] = fixture.context.store.recentRequests(2).reverse();
    // Bytes on the wire: not recoverable from the translated body, and the
    // difference between the two is the router's own overhead.
    assert.ok(streamedRecord.requestBytes > 20, 'the request size the client sent');
    assert.ok(plainRecord.requestBytes > 20);
    // First content frame, and nothing earlier: the lifecycle frames go out
    // before the backend has a worker, so a ttft measured from them is a lie.
    assert.equal(typeof streamedRecord.ttftMs, 'number');
    // A non-streamed response has no first token to measure; null says the
    // router did not measure it, which 0 would contradict.
    assert.equal(plainRecord.ttftMs, null);
    // Admission bookkeeping is written on every admitted request, queued or not.
    for (const record of [streamedRecord, plainRecord]) {
      assert.equal(typeof record.admissionWaitMs, 'number');
      assert.ok(record.queueWaitMs === null || typeof record.queueWaitMs === 'number');
      // Named while the archive is certainly this request's, so the payload view
      // can be reached from the row even when the generation never terminates.
      assert.equal('generationRecordId' in record, true);
      assert.ok(record.generationRecordId === null || /^[0-9a-f-]{36}$/.test(record.generationRecordId));
    }
  } finally {
    await fixture.cleanup();
  }
});
