import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRouterServer } from '../src/server.js';

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

function createFakeOllama({ capabilities = ['completion'], capabilitiesByModel = {}, enforceThinkValues = false } = {}) {
  const requests = [];
  const capabilitiesFor = (model) => Object.hasOwn(capabilitiesByModel, model)
    ? capabilitiesByModel[model]
    : capabilities;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://fake-ollama.local');
    const body = ['GET', 'HEAD'].includes(String(request.method).toUpperCase()) ? null : await readJsonBody(request);
    requests.push({ method: request.method, pathname: url.pathname, body });

    if (request.method === 'GET' && url.pathname === '/api/version') {
      sendJson(response, 200, { version: 'fake-ollama-test' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/tags') {
      sendJson(response, 200, { models: [{ name: 'active:model', model: 'active:model' }] });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/ps') {
      sendJson(response, 200, {
        models: [{ name: 'active:model', model: 'active:model', until: 'Forever', context: 8192 }]
      });
      return;
    }
    if (
      enforceThinkValues
      && request.method === 'POST'
      && ['/api/chat', '/api/generate'].includes(url.pathname)
      && Object.hasOwn(body || {}, 'think')
      && typeof body.think !== 'boolean'
      && !['low', 'medium', 'high', 'max'].includes(body.think)
    ) {
      sendJson(response, 400, {
        error: `invalid think value: ${JSON.stringify(body.think)} (must be "high", "medium", "low", "max", true, or false)`
      });
      return;
    }
    if (
      request.method === 'POST'
      && ['/api/chat', '/v1/chat/completions'].includes(url.pathname)
      && (Object.hasOwn(body || {}, 'tools') || Object.hasOwn(body || {}, 'functions'))
      && !capabilitiesFor(body?.model).includes('tools')
    ) {
      sendJson(response, 400, { error: `${body?.model} does not support tools` });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      sendJson(response, 200, {
        model: body?.model,
        message: { role: 'assistant', content: 'ok' },
        done: true,
        eval_count: 1,
        eval_duration: 1000000000
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (body?.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        response.end(`data: ${JSON.stringify({
          id: 'chatcmpl_fake',
          object: 'chat.completion.chunk',
          model: body?.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
        })}\n\ndata: [DONE]\n\n`);
      } else {
        sendJson(response, 200, {
          id: 'chatcmpl_fake',
          object: 'chat.completion',
          model: body?.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
        });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/generate') {
      sendJson(response, 200, {
        model: body?.model,
        response: 'ok',
        done: true,
        eval_count: 1,
        eval_duration: 1000000000
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/show') {
      sendJson(response, 200, {
        model: body?.model,
        details: {},
        ...(body?.verbose ? {} : { capabilities: capabilitiesFor(body?.model) })
      });
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  });
  return { server, requests };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  if (!server || !server.listening) return;
  const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections?.();
  await closed;
}

async function makeFixture(overrides = {}, upstreamOptions = {}, markerOverrides = {}) {
  const upstream = createFakeOllama(upstreamOptions);
  const upstreamPort = await listen(upstream.server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-server-test-'));
  const activeModelFile = path.join(dir, 'active-model.json');
  await fs.writeFile(activeModelFile, JSON.stringify({
    profile: 'unit-test',
    model: 'active:model',
    keep_alive: -1,
    context: 8192,
    ...DAY_REASONING_CAPABILITIES,
    updated_at: '2026-06-29T00:00:00.000Z',
    source: 'server.test.js',
    ...markerOverrides
  }), 'utf8');

  const config = {
    ...loadConfig({
      HOST: '127.0.0.1',
      ADMIN_ENABLED: 'true',
      ADMIN_BIND_HOST: '127.0.0.1',
      OLLAMA_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
      OLLAMA_UPSTREAM_TIMEOUT_MS: '5000',
      ACTIVE_MODEL_FILE: activeModelFile,
      ACTIVE_MODEL: '',
      ADMIN_TOKEN: 'secret-token',
      DATA_DIR: dir,
      REQUEST_HISTORY_LIMIT: '100',
      EVENT_HISTORY_LIMIT: '100',
      ENABLE_NVIDIA_SMI: 'false',
      ...overrides
    })
  };

  const router = await createRouterServer(config);
  const apiPort = await listen(router.server);
  const adminPort = await listen(router.adminServer);
  config.port = apiPort;
  config.adminPort = adminPort;

  async function cleanup() {
    await close(router.adminServer);
    await close(router.server);
    await close(upstream.server);
    await fs.rm(dir, { recursive: true, force: true });
  }

  return { ...router, config, upstream, apiPort, adminPort, cleanup };
}

test('admin listener serves dashboard and summary without auth while API port stays Ollama-compatible', async () => {
  const fixture = await makeFixture();
  try {
    const adminRoot = await fetch(`http://127.0.0.1:${fixture.adminPort}/`);
    assert.equal(adminRoot.status, 200);
    assert.match(adminRoot.headers.get('content-type') || '', /text\/html/);
    assert.match(await adminRoot.text(), /No login or token is required/);

    const adminAlias = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin`);
    assert.equal(adminAlias.status, 200);
    assert.match(await adminAlias.text(), /LLM Router Admin/);

    const summaryResponse = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/summary`);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.equal(summary.config.adminPortalAuthRequired, false);
    assert.equal(summary.config.adminPort, fixture.adminPort);
    assert.equal(summary.activeModel.model, 'active:model');
    assert.equal(summary.activeLoadedState.loaded, true);

    const legacyUnauthed = await fetch(`http://127.0.0.1:${fixture.apiPort}/admin/api/summary`);
    assert.equal(legacyUnauthed.status, 401);

    const legacyAuthed = await fetch(`http://127.0.0.1:${fixture.apiPort}/admin/api/summary`, {
      headers: { 'x-admin-token': 'secret-token' }
    });
    assert.equal(legacyAuthed.status, 200);

    const apiRoot = await fetch(`http://127.0.0.1:${fixture.apiPort}/`);
    assert.equal(apiRoot.status, 200);
    assert.equal(await apiRoot.text(), 'Ollama is running\n');

    const version = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/version`);
    assert.equal(version.status, 200);
    assert.equal((await version.json()).version, 'fake-ollama-test');

    const wrongPort = await fetch(`http://127.0.0.1:${fixture.adminPort}/api/version`);
    assert.equal(wrongPort.status, 404);
    assert.equal((await wrongPort.json()).error.code, 'API_NOT_ON_ADMIN_PORT');

    const redirect = await fetch(`http://127.0.0.1:${fixture.apiPort}/admin`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get('location') || '', new RegExp(`:${fixture.adminPort}/admin$`));
  } finally {
    await fixture.cleanup();
  }
});

test('API chat preserves non-model parameters and forces keep_alive to -1', async () => {
  const fixture = await makeFixture();
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-name': 'server-test'
      },
      body: JSON.stringify({
        model: 'active:model',
        stream: false,
        keep_alive: '5m',
        think: false,
        messages: [{ role: 'user', content: 'hello' }],
        options: { temperature: 0.2, num_ctx: 4096 }
      })
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, 'active:model');

    const chatRequest = fixture.upstream.requests.find((request) => request.method === 'POST' && request.pathname === '/api/chat');
    assert.ok(chatRequest);
    assert.equal(chatRequest.body.model, 'active:model');
    assert.equal(chatRequest.body.keep_alive, -1);
    assert.equal(chatRequest.body.think, false);
    assert.deepEqual(chatRequest.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.deepEqual(chatRequest.body.options, { temperature: 0.2, num_ctx: 4096 });

    const requestsResponse = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/requests?limit=1`);
    assert.equal(requestsResponse.status, 200);
    const history = await requestsResponse.json();
    assert.equal(history.requests[0].incomingKeepAlive, '5m');
    assert.equal(history.requests[0].forwardedKeepAlive, -1);
    assert.equal(history.requests[0].keepAliveNormalized, true);
  } finally {
    await fixture.cleanup();
  }
});

test('API chat drops enabled think for unsupported models and preserves it for supported models', async () => {
  const unsupported = await makeFixture();
  try {
    const response = await fetch(`http://127.0.0.1:${unsupported.apiPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'active:model',
        stream: false,
        think: true,
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    assert.equal(response.status, 200);

    const showRequest = unsupported.upstream.requests.find((item) => item.pathname === '/api/show');
    assert.deepEqual(showRequest.body, { model: 'active:model' });
    const chatRequest = unsupported.upstream.requests.find((item) => item.pathname === '/api/chat');
    assert.equal(Object.hasOwn(chatRequest.body, 'think'), false);

    const record = unsupported.context.store.recentRequests(1)[0];
    assert.equal(record.incomingThink, true);
    assert.equal(record.thinkNormalized, true);
    assert.equal(record.thinkingSupported, false);
    assert.equal(record.reasoningEffort, 'high');
  } finally {
    await unsupported.cleanup();
  }

  const supported = await makeFixture({}, { capabilities: ['completion', 'thinking'] });
  try {
    const response = await fetch(`http://127.0.0.1:${supported.apiPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'active:model',
        stream: false,
        think: true,
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    assert.equal(response.status, 200);

    const chatRequest = supported.upstream.requests.find((item) => item.pathname === '/api/chat');
    assert.equal(chatRequest.body.think, true);
    const record = supported.context.store.recentRequests(1)[0];
    assert.equal(record.thinkNormalized, false);
    assert.equal(record.thinkingSupported, true);
    assert.equal(record.forwardedThink, true);
    assert.equal(record.reasoningEffort, 'high');
  } finally {
    await supported.cleanup();
  }
});

test('API chat applies a configured default think only when the request omits it', async () => {
  const fixture = await makeFixture({ DEFAULT_THINK: 'medium' }, { capabilities: ['completion', 'thinking'] });
  try {
    for (const body of [
      { model: 'active:model', stream: false, messages: [{ role: 'user', content: 'default' }] },
      { model: 'active:model', stream: false, think: false, messages: [{ role: 'user', content: 'explicit' }] }
    ]) {
      const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 200);
    }

    const chats = fixture.upstream.requests.filter((item) => item.pathname === '/api/chat');
    assert.equal(chats[0].body.think, 'medium');
    assert.equal(chats[1].body.think, false);
  } finally {
    await fixture.cleanup();
  }
});

test('API chat preserves model-default behavior when no router default is configured', async () => {
  const fixture = await makeFixture({}, { capabilities: ['completion', 'thinking'] });
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'active:model',
        stream: false,
        messages: [{ role: 'user', content: 'model default' }]
      })
    });
    assert.equal(response.status, 200);
    const chat = fixture.upstream.requests.find((item) => item.pathname === '/api/chat');
    assert.equal(Object.hasOwn(chat.body, 'think'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('native chat and generate negotiate string levels through day and night profiles', async () => {
  const cases = [
    {
      profile: DAY_REASONING_CAPABILITIES,
      requests: [
        ['/api/chat', 'xhigh', false, 'max'],
        ['/api/generate', 'max', true, 'max'],
        ['/api/chat', 'low', false, 'low'],
        ['/api/generate', 'medium', true, 'medium']
      ]
    },
    {
      profile: NIGHT_REASONING_CAPABILITIES,
      requests: [
        ['/api/chat', 'high', false, true],
        ['/api/generate', 'max', true, true],
        ['/api/chat', 'xhigh', true, true],
        ['/api/generate', 'low', false, 'low'],
        ['/api/chat', 'medium', false, 'medium']
      ]
    }
  ];

  for (const item of cases) {
    const fixture = await makeFixture(
      {},
      { capabilities: ['completion', 'thinking'], enforceThinkValues: true },
      item.profile
    );
    try {
      for (const [endpoint, effort, stream] of item.requests) {
        const body = endpoint === '/api/chat'
          ? { model: 'active:model', think: effort, stream, messages: [{ role: 'user', content: effort }] }
          : { model: 'active:model', think: effort, stream, prompt: effort };
        const response = await fetch(`http://127.0.0.1:${fixture.apiPort}${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
        assert.equal(response.status, 200);
        await response.text();
      }

      const generated = fixture.upstream.requests.filter((request) => ['/api/chat', '/api/generate'].includes(request.pathname));
      assert.deepEqual(generated.map((request) => request.body.think), item.requests.map((request) => request[3]));
      assert.deepEqual(generated.map((request) => request.body.keep_alive), item.requests.map(() => -1));
      const records = fixture.context.store.recentRequests(item.requests.length).reverse();
      assert.deepEqual(records.map((record) => record.incomingReasoningEffort), item.requests.map((request) => request[1]));
      assert.deepEqual(records.map((record) => record.forwardedThink), item.requests.map((request) => request[3]));
      if (item.profile === NIGHT_REASONING_CAPABILITIES) {
        assert.deepEqual(records.slice(0, 3).map((record) => record.thinkMapped), [true, true, true]);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test('native chat and generate map an omitted nighttime default through the profile', async () => {
  const fixture = await makeFixture(
    {},
    { capabilities: ['completion', 'thinking'], enforceThinkValues: true },
    { ...NIGHT_REASONING_CAPABILITIES, default_think: 'max' }
  );
  try {
    for (const [endpoint, content] of [['/api/chat', 'default chat'], ['/api/generate', 'default generate']]) {
      const body = endpoint === '/api/chat'
        ? { model: 'active:model', stream: false, messages: [{ role: 'user', content }] }
        : { model: 'active:model', stream: false, prompt: content };
      const response = await fetch(`http://127.0.0.1:${fixture.apiPort}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 200);
    }

    const generated = fixture.upstream.requests.filter((request) => ['/api/chat', '/api/generate'].includes(request.pathname));
    assert.deepEqual(generated.map((request) => request.body.think), [true, true]);
    assert.deepEqual(generated.map((request) => request.body.keep_alive), [-1, -1]);
    const records = fixture.context.store.recentRequests(2).reverse();
    assert.deepEqual(records.map((record) => record.forwardedThink), [true, true]);
    assert.deepEqual(records.map((record) => record.thinkMapped), [true, true]);
  } finally {
    await fixture.cleanup();
  }
});

test('native generation rejects incomplete profiles and invalid think strings before Ollama generation', async () => {
  const cases = [
    {
      marker: { reasoning_effort_map: undefined },
      think: 'max',
      status: 503,
      code: 'INVALID_REASONING_CAPABILITIES'
    },
    {
      marker: DAY_REASONING_CAPABILITIES,
      think: 'turbo',
      status: 400,
      code: 'INVALID_THINK_VALUE'
    },
    {
      marker: { ...NIGHT_REASONING_CAPABILITIES, supported_think_levels: 'low,medium' },
      think: 'max',
      status: 503,
      code: 'INVALID_REASONING_CAPABILITIES'
    },
    {
      marker: {
        ...NIGHT_REASONING_CAPABILITIES,
        reasoning_effort_map: { ...NIGHT_REASONING_CAPABILITIES.reasoning_effort_map, max: false }
      },
      think: 'max',
      status: 503,
      code: 'INVALID_REASONING_CAPABILITIES'
    }
  ];

  for (const item of cases) {
    const fixture = await makeFixture({}, { capabilities: ['completion', 'thinking'] }, item.marker);
    try {
      const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'active:model', prompt: 'hello', stream: false, think: item.think })
      });
      assert.equal(response.status, item.status);
      assert.equal((await response.json()).error.code, item.code);
      assert.equal(fixture.upstream.requests.some((request) => request.pathname === '/api/generate'), false);
      assert.equal(fixture.upstream.requests.some((request) => request.pathname === '/api/show'), false);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('native think values gracefully use binary model capabilities without string-level metadata', async () => {
  const fixture = await makeFixture(
    {},
    { capabilities: ['completion', 'thinking'], enforceThinkValues: true },
    { supported_think_levels: undefined, reasoning_effort_map: undefined }
  );
  try {
    for (const think of [true, false, 'none', 'low', 'max']) {
      const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'active:model',
          stream: false,
          think,
          messages: [{ role: 'user', content: String(think) }]
        })
      });
      assert.equal(response.status, 200);
    }
    const chats = fixture.upstream.requests.filter((request) => request.pathname === '/api/chat');
    assert.deepEqual(chats.map((request) => request.body.think), [true, false, false, true, true]);
    const records = fixture.context.store.recentRequests(5).reverse();
    assert.deepEqual(records.map((record) => record.incomingThink), [true, false, 'none', 'low', 'max']);
    assert.deepEqual(records.map((record) => record.thinkMapped), [false, false, true, true, true]);
  } finally {
    await fixture.cleanup();
  }
});

test('native string reasoning is dropped for a non-thinking model without profile metadata', async () => {
  const fixture = await makeFixture(
    {},
    { capabilities: ['completion'] },
    { supported_think_levels: undefined, reasoning_effort_map: undefined }
  );
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'active:model', prompt: 'hello', stream: false, think: 'max' })
    });
    assert.equal(response.status, 200);

    const generated = fixture.upstream.requests.find((request) => request.pathname === '/api/generate');
    assert.equal(Object.hasOwn(generated.body, 'think'), false);
    const record = fixture.context.store.recentRequests(1)[0];
    assert.equal(record.incomingThink, 'max');
    assert.equal(record.thinkMapped, true);
    assert.equal(record.thinkDropped, true);
    assert.equal(record.thinkingSupported, false);
  } finally {
    await fixture.cleanup();
  }
});

test('native chat drop policy uses the rewritten active model and emits privacy-safe metadata', async () => {
  const fixture = await makeFixture(
    {
      REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true',
      UNSUPPORTED_TOOLS_POLICY: 'drop',
      PROMPT_LOGGING: 'full'
    },
    {
      capabilitiesByModel: {
        'stable-client:model': ['completion', 'tools'],
        'active:model': ['completion']
      }
    }
  );
  const messages = [{ role: 'user', content: 'ordinary chat' }];
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'stable-client:model',
        messages,
        stream: false,
        think: false,
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        options: { temperature: 0.2 }
      })
    });

    assert.equal(response.status, 200);
    const showRequests = fixture.upstream.requests.filter((item) => item.pathname === '/api/show');
    assert.deepEqual(showRequests.map((item) => item.body), [{ model: 'active:model' }]);
    const chat = fixture.upstream.requests.find((item) => item.pathname === '/api/chat');
    assert.equal(chat.body.model, 'active:model');
    assert.deepEqual(chat.body.messages, messages);
    assert.deepEqual(chat.body.options, { temperature: 0.2 });
    for (const field of ['tools', 'tool_choice', 'parallel_tool_calls']) {
      assert.equal(Object.hasOwn(chat.body, field), false);
    }

    const record = fixture.context.store.recentRequests(1)[0];
    assert.equal(record.toolsPresent, true);
    assert.equal(record.toolCount, 1);
    assert.equal(record.toolChoicePresent, true);
    assert.equal(record.toolsSupported, false);
    assert.equal(record.toolsDropped, true);
    assert.equal(record.unsupportedToolsPolicy, 'drop');
    assert.deepEqual(record.bodySummary, {
      messageCount: 1,
      messageRoles: ['user'],
      messageContentChars: 13,
      stream: false,
      optionKeys: ['temperature']
    });
    const event = fixture.context.store.recentEvents(20).find((item) => item.type === 'unsupported_tools_dropped');
    assert.ok(event);
    assert.equal(event.toolCount, 1);
    assert.equal(Object.hasOwn(event, 'tools'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('tool-capable native chat preserves tool fields exactly and shares capability lookup with thinking', async () => {
  const fixture = await makeFixture(
    { UNSUPPORTED_TOOLS_POLICY: 'drop' },
    { capabilities: ['completion', 'thinking', 'tools'] }
  );
  const toolFields = {
    tools: [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
    parallel_tool_calls: false
  };
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'active:model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        think: true,
        ...toolFields
      })
    });
    assert.equal(response.status, 200);
    await response.text();

    const chat = fixture.upstream.requests.find((item) => item.pathname === '/api/chat');
    for (const [field, value] of Object.entries(toolFields)) assert.deepEqual(chat.body[field], value);
    assert.equal(fixture.upstream.requests.filter((item) => item.pathname === '/api/show').length, 1);
    const record = fixture.context.store.recentRequests(1)[0];
    assert.equal(record.toolsSupported, true);
    assert.equal(record.toolsDropped, false);
    assert.equal(record.streaming, true);
  } finally {
    await fixture.cleanup();
  }
});

test('tool-free chat avoids capability lookup and default passthrough still forwards unsupported tools', async () => {
  const toolFree = await makeFixture({ UNSUPPORTED_TOOLS_POLICY: 'drop' });
  try {
    const response = await fetch(`http://127.0.0.1:${toolFree.apiPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'active:model',
        messages: [{ role: 'user', content: 'no tools' }],
        stream: false,
        think: false,
        options: { temperature: 0.7 }
      })
    });
    assert.equal(response.status, 200);
    assert.equal(toolFree.upstream.requests.some((item) => item.pathname === '/api/show'), false);
    const record = toolFree.context.store.recentRequests(1)[0];
    assert.equal(record.toolsPresent, false);
    assert.equal(record.toolsSupported, null);
    assert.equal(record.toolsDropped, false);
  } finally {
    await toolFree.cleanup();
  }

  const passthrough = await makeFixture();
  try {
    const tools = [{ type: 'function', function: { name: 'lookup' } }];
    const response = await fetch(`http://127.0.0.1:${passthrough.apiPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'active:model', messages: [], stream: false, tools })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /does not support tools/);
    const chat = passthrough.upstream.requests.find((item) => item.pathname === '/api/chat');
    assert.deepEqual(chat.body.tools, tools);
    const record = passthrough.context.store.recentRequests(1)[0];
    assert.equal(record.unsupportedToolsPolicy, 'passthrough');
    assert.equal(record.toolsSupported, false);
    assert.equal(record.toolsDropped, false);
  } finally {
    await passthrough.cleanup();
  }
});

test('unsupported prior tool history receives an explicit router error without generation', async () => {
  const fixture = await makeFixture({ UNSUPPORTED_TOOLS_POLICY: 'drop' });
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'active:model',
        stream: false,
        messages: [
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: {} } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'result' }
        ]
      })
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, 'UNSUPPORTED_TOOL_HISTORY');
    assert.match(payload.error.message, /will not drop or rewrite tool history/);
    assert.equal(fixture.upstream.requests.some((item) => item.pathname === '/api/chat'), false);
    assert.deepEqual(
      fixture.upstream.requests.filter((item) => item.pathname === '/api/show').map((item) => item.body),
      [{ model: 'active:model' }]
    );
  } finally {
    await fixture.cleanup();
  }
});

test('reject policy returns an actionable router-generated unsupported-tools error', async () => {
  const fixture = await makeFixture({ UNSUPPORTED_TOOLS_POLICY: 'reject' });
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'active:model',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        tools: [{ type: 'function', function: { name: 'lookup' } }]
      })
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, 'UNSUPPORTED_TOOLS');
    assert.match(payload.error.message, /model qualified for tools/);
    assert.equal(fixture.upstream.requests.some((item) => item.pathname === '/api/chat'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('OpenAI chat completions applies tool policy for streaming and non-streaming requests', async () => {
  const fixture = await makeFixture({
    REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true',
    UNSUPPORTED_TOOLS_POLICY: 'drop'
  });
  try {
    for (const stream of [false, true]) {
      const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'stable-openai-name',
          messages: [{ role: 'user', content: `stream=${stream}` }],
          stream,
          temperature: 0.35,
          tools: [{ type: 'function', function: { name: 'lookup' } }],
          tool_choice: 'auto',
          parallel_tool_calls: true
        })
      });
      assert.equal(response.status, 200);
      if (stream) {
        assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
        assert.match(await response.text(), /data: \[DONE\]/);
      } else {
        assert.equal((await response.json()).model, 'active:model');
      }
    }

    const completions = fixture.upstream.requests.filter((item) => item.pathname === '/v1/chat/completions');
    assert.equal(completions.length, 2);
    for (const request of completions) {
      assert.equal(request.body.model, 'active:model');
      assert.equal(request.body.temperature, 0.35);
      assert.equal(Object.hasOwn(request.body, 'keep_alive'), false);
      for (const field of ['tools', 'tool_choice', 'parallel_tool_calls']) {
        assert.equal(Object.hasOwn(request.body, field), false);
      }
    }
    assert.deepEqual(
      fixture.upstream.requests.filter((item) => item.pathname === '/api/show').map((item) => item.body),
      [{ model: 'active:model' }, { model: 'active:model' }]
    );
  } finally {
    await fixture.cleanup();
  }

  const supported = await makeFixture(
    { REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true', UNSUPPORTED_TOOLS_POLICY: 'drop' },
    { capabilities: ['completion', 'tools'] }
  );
  const toolFields = {
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
    parallel_tool_calls: false
  };
  try {
    const response = await fetch(`http://127.0.0.1:${supported.apiPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stable-openai-name', messages: [], stream: false, ...toolFields })
    });
    assert.equal(response.status, 200);
    const completion = supported.upstream.requests.find((item) => item.pathname === '/v1/chat/completions');
    for (const [field, value] of Object.entries(toolFields)) assert.deepEqual(completion.body[field], value);
  } finally {
    await supported.cleanup();
  }
});

test('Responses compatibility preserves native routes while public discovery exposes only the stable alias', async () => {
  const fixture = await makeFixture();
  try {
    const version = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/version`);
    assert.equal(version.status, 200);
    assert.deepEqual(await version.json(), { version: 'fake-ollama-test' });

    const tags = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/tags`);
    assert.equal(tags.status, 200);
    assert.deepEqual(await tags.json(), {
      models: [{ name: 'active:model', model: 'active:model' }]
    });

    const running = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/ps`);
    assert.equal(running.status, 200);
    assert.deepEqual(await running.json(), {
      models: [{ name: 'active:model', model: 'active:model', until: 'Forever', context: 8192 }]
    });

    const showBody = { model: 'catalog:model', verbose: true };
    const show = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(showBody)
    });
    assert.equal(show.status, 200);
    assert.deepEqual(await show.json(), { model: 'catalog:model', details: {} });
    const forwardedShow = fixture.upstream.requests.find((item) => item.pathname === '/api/show');
    assert.deepEqual(forwardedShow.body, showBody);

    const generate = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'active:model',
        prompt: 'unchanged generation route',
        stream: false,
        keep_alive: '5m',
        options: { temperature: 0.1 }
      })
    });
    assert.equal(generate.status, 200);
    const forwardedGenerate = fixture.upstream.requests.find((item) => item.pathname === '/api/generate');
    assert.deepEqual(forwardedGenerate.body, {
      model: 'active:model',
      prompt: 'unchanged generation route',
      stream: false,
      keep_alive: -1,
      options: { temperature: 0.1 }
    });

    const pull = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'other:model' })
    });
    assert.equal(pull.status, 403);
    assert.equal((await pull.json()).error.code, 'MODEL_MANAGEMENT_DISABLED');
    assert.equal(fixture.upstream.requests.some((item) => item.pathname === '/api/pull'), false);

    const codexCatalog = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`);
    assert.equal(codexCatalog.status, 200);
    const catalog = await codexCatalog.json();
    assert.deepEqual(catalog.data.map((model) => model.id), ['local-active']);
    assert.equal(JSON.stringify(catalog).includes('catalog:model'), false);

    const adminResponses = await fetch(`http://127.0.0.1:${fixture.adminPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'must not run here' })
    });
    assert.equal(adminResponses.status, 404);
    assert.equal((await adminResponses.json()).error.code, 'NOT_FOUND');

    assert.deepEqual(
      fixture.upstream.requests.map((item) => `${item.method} ${item.pathname}`),
      [
        'GET /api/version',
        'GET /api/tags',
        'GET /api/ps',
        'POST /api/show',
        'POST /api/generate',
        'GET /api/ps',
        'POST /api/show'
      ]
    );
  } finally {
    await fixture.cleanup();
  }
});
