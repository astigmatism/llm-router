import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRouterServer } from '../src/server.js';

const REASONING_CAPABILITIES = {
  supported_think_levels: ['low', 'medium', 'high'],
  reasoning_effort_map: {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
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

function createFakeOllama() {
  const requests = [];
  const state = {
    psStatus: 200,
    showStatus: 200,
    loadedModels: [],
    showByModel: new Map(),
    installedModels: ['model-a:test', 'model-b:test', 'model-c:test']
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://fake-ollama.local');
    const body = ['GET', 'HEAD'].includes(request.method) ? null : await readJsonBody(request);
    requests.push({ method: request.method, pathname: url.pathname, body });

    if (request.method === 'GET' && url.pathname === '/api/ps') {
      sendJson(response, state.psStatus, state.psStatus === 200
        ? { models: state.loadedModels }
        : { error: 'ps unavailable' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/show') {
      const show = state.showByModel.get(body?.model);
      sendJson(response, state.showStatus, state.showStatus === 200 && show
        ? show
        : { error: 'show unavailable' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/tags') {
      sendJson(response, 200, {
        models: state.installedModels.map((model) => ({ name: model, model }))
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      sendJson(response, 200, {
        model: body?.model,
        message: { role: 'assistant', content: 'ok' },
        done: true
      });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
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

function marker(model, overrides = {}) {
  return {
    model,
    profile: 'test-profile',
    context_length: 16384,
    max_output_tokens: 2048,
    default_think: 'medium',
    ...REASONING_CAPABILITIES,
    input_modalities: ['text'],
    updated_at: '2026-08-31T12:00:00.000Z',
    ...overrides
  };
}

function showPayload(architecture, contextLength, capabilities) {
  return {
    details: { family: architecture, families: [architecture] },
    model_info: {
      'general.architecture': architecture,
      [`${architecture}.context_length`]: contextLength
    },
    capabilities
  };
}

async function makeFixture({ markerValue = marker('model-a:test'), env = {} } = {}) {
  const upstream = createFakeOllama();
  upstream.state.loadedModels = [{
    name: 'model-a:test',
    model: 'model-a:test',
    context_length: 8192
  }];
  upstream.state.showByModel.set(
    'model-a:test',
    showPayload('testarch-a', 131072, ['completion', 'tools', 'thinking'])
  );
  upstream.state.showByModel.set(
    'model-b:test',
    showPayload('testarch-b', 65536, ['completion', 'vision'])
  );
  upstream.state.showByModel.set(
    'model-c:test',
    showPayload('testarch-c', 32768, ['embedding'])
  );
  const upstreamPort = await listen(upstream.server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-discovery-test-'));
  const activeModelFile = path.join(dir, 'active-model.json');
  if (markerValue) await fs.writeFile(activeModelFile, JSON.stringify(markerValue), 'utf8');

  const config = loadConfig({
    HOST: '127.0.0.1',
    ADMIN_ENABLED: 'false',
    OLLAMA_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
    OLLAMA_UPSTREAM_TIMEOUT_MS: '1000',
    ACTIVE_MODEL_FILE: activeModelFile,
    ACTIVE_MODEL: '',
    DATA_DIR: dir,
    ROUTER_MODEL_METADATA_TTL_MS: '60000',
    REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'false',
    ...env
  });
  const router = await createRouterServer(config);
  const apiPort = await listen(router.server);

  async function writeMarker(value) {
    await fs.writeFile(activeModelFile, JSON.stringify(value), 'utf8');
  }

  async function cleanup() {
    await close(router.server);
    await router.waitForIdle();
    await close(upstream.server);
    await fs.rm(dir, { recursive: true, force: true });
  }

  return { ...router, apiPort, activeModelFile, upstream, writeMarker, cleanup };
}

test('model discovery lists one stable alias, supports detail lookup and ETags, and does not enumerate installed models', async () => {
  const fixture = await makeFixture({ env: { ROUTER_MODEL_ALIAS: 'active-slot' } });
  try {
    const listResponse = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`);
    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.headers.get('cache-control'), 'no-cache');
    const etag = listResponse.headers.get('etag');
    assert.ok(etag);
    const list = await listResponse.json();
    assert.equal(list.object, 'list');
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].id, 'active-slot');
    assert.equal(list.data[0].owned_by, 'llm-router');
    assert.equal(list.data[0].x_ollama_router.upstream_model, 'model-a:test');
    assert.equal(list.data[0].x_ollama_router.context_window, 8192);
    assert.equal(list.data[0].x_ollama_router.model_context_window, 131072);
    assert.equal(list.data[0].x_ollama_router.context_safety_reserve, null);
    assert.equal(list.data[0].x_ollama_router.max_output_tokens, 2048);
    assert.deepEqual(list.data[0].x_ollama_router.input_modalities, ['text']);
    assert.deepEqual(list.data[0].x_ollama_router.capabilities, ['completion', 'tools', 'thinking']);
    assert.equal(list.data[0].x_ollama_router.reasoning.supported, true);
    assert.equal(list.data[0].x_ollama_router.reasoning.efforts.off, 'none');
    assert.equal(list.data[0].x_ollama_router.reasoning.efforts.xhigh, 'xhigh');
    assert.equal(list.data[0].x_ollama_router.reasoning.default, 'medium');
    assert.equal(list.data[0].x_ollama_router.complete, true);

    const detailResponse = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models/active-slot`);
    assert.equal(detailResponse.status, 200);
    assert.equal(detailResponse.headers.get('etag'), etag);
    assert.deepEqual(await detailResponse.json(), list.data[0]);

    const notModified = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models/active-slot`, {
      headers: { 'if-none-match': `W/${etag}` }
    });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.headers.get('cache-control'), 'no-cache');
    assert.equal(await notModified.text(), '');

    const unknown = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models/model-b%3Atest`);
    assert.equal(unknown.status, 404);
    const unknownError = await unknown.json();
    assert.equal(unknownError.error.code, 'MODEL_NOT_FOUND');
    assert.equal(unknownError.error.type, 'invalid_request_error');

    const tags = await fetch(`http://127.0.0.1:${fixture.apiPort}/api/tags`);
    assert.equal((await tags.json()).models.length, 3);
    assert.equal(JSON.stringify(list).includes('model-b:test'), false);
    assert.equal(JSON.stringify(list).includes('model-c:test'), false);
    assert.equal(fixture.context.store.recentRequests().length, 1);
    assert.equal(fixture.context.store.recentRequests()[0].endpoint, '/api/tags');

    const discoveryCalls = fixture.upstream.requests.filter((item) => ['/api/ps', '/api/show'].includes(item.pathname));
    assert.equal(discoveryCalls.length, 2);

    await fixture.writeMarker(marker('model-a:test', {
      revision: 'second-revision',
      max_output_tokens: 4096,
      updated_at: '2026-08-31T12:01:00.000Z'
    }));
    const refreshedResponse = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models/active-slot`, {
      headers: { 'if-none-match': etag }
    });
    assert.equal(refreshedResponse.status, 200);
    assert.notEqual(refreshedResponse.headers.get('etag'), etag);
    assert.equal((await refreshedResponse.json()).x_ollama_router.max_output_tokens, 4096);
    assert.equal(
      fixture.upstream.requests.filter((item) => ['/api/ps', '/api/show'].includes(item.pathname)).length,
      4
    );
  } finally {
    await fixture.cleanup();
  }
});

test('model discovery returns NO_ACTIVE_MODEL without fabricating an entry', async () => {
  const fixture = await makeFixture({ markerValue: null });
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`);
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error.code, 'NO_ACTIVE_MODEL');
    assert.equal(payload.error.type, 'server_error');
    assert.equal(fixture.upstream.requests.length, 0);
    assert.equal(fixture.context.store.recentEvents().some((event) => event.code === 'NO_ACTIVE_MODEL'), true);
  } finally {
    await fixture.cleanup();
  }
});

test('marker changes invalidate enrichment immediately and context/modalities follow source precedence conservatively', async () => {
  const fixture = await makeFixture();
  try {
    const first = (await (await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`)).json()).data[0];
    assert.equal(first.x_ollama_router.context_window, 8192);
    assert.equal(first.x_ollama_router.model_context_window, 131072);
    assert.deepEqual(first.x_ollama_router.input_modalities, ['text']);

    fixture.upstream.state.loadedModels = [];
    await fixture.writeMarker(marker('model-b:test', {
      profile: 'second-profile',
      context_length: 24576,
      max_output_tokens: 1024,
      input_modalities: []
    }));
    const second = (await (await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`)).json()).data[0];
    assert.equal(second.id, first.id);
    assert.equal(second.x_ollama_router.upstream_model, 'model-b:test');
    assert.equal(second.x_ollama_router.profile, 'second-profile');
    assert.equal(second.x_ollama_router.context_window, 24576);
    assert.equal(second.x_ollama_router.model_context_window, 65536);
    assert.equal(second.x_ollama_router.max_output_tokens, 1024);
    assert.deepEqual(second.x_ollama_router.input_modalities, ['text', 'image']);
    assert.equal(JSON.stringify(second).includes('testarch-a'), false);
    assert.equal(JSON.stringify(second).includes('131072'), false);

    await fixture.writeMarker(marker('model-c:test', {
      context_length: null,
      max_output_tokens: null,
      input_modalities: []
    }));
    const third = (await (await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`)).json()).data[0];
    assert.equal(third.x_ollama_router.context_window, 32768);
    assert.equal(third.x_ollama_router.model_context_window, 32768);
    assert.equal(third.x_ollama_router.max_output_tokens, null);
    assert.deepEqual(third.x_ollama_router.input_modalities, []);
    assert.deepEqual(third.x_ollama_router.capabilities, ['embedding']);
    assert.equal(JSON.stringify(third).includes('vision'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('partial upstream metadata preserves marker limits and reasoning while reporting stable warnings', async () => {
  const fixture = await makeFixture({
    markerValue: marker('model-a:test', { input_modalities: ['text', 'image'] })
  });
  try {
    fixture.upstream.state.psStatus = 503;
    fixture.upstream.state.showStatus = 503;
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models/active-slot`);
    assert.equal(response.status, 404);

    const discoveredResponse = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models/local-active`);
    assert.equal(discoveredResponse.status, 200);
    const discovered = await discoveredResponse.json();
    const metadata = discovered.x_ollama_router;
    assert.equal(metadata.context_window, 16384);
    assert.equal(metadata.model_context_window, null);
    assert.equal(metadata.max_output_tokens, 2048);
    assert.deepEqual(metadata.input_modalities, ['text', 'image']);
    assert.equal(metadata.capabilities, null);
    assert.equal(metadata.reasoning.supported, true);
    assert.deepEqual(metadata.reasoning.upstream_levels, ['low', 'medium', 'high']);
    assert.equal(metadata.reasoning.effort_map.xhigh, true);
    assert.deepEqual(metadata.sources, {
      active_model_marker: true,
      ollama_ps: false,
      ollama_show: false
    });
    assert.equal(metadata.complete, false);
    assert.deepEqual(metadata.warnings, ['OLLAMA_PS_UNAVAILABLE', 'OLLAMA_SHOW_UNAVAILABLE']);
    assert.equal(fixture.context.store.recentEvents().some((event) => event.code === 'MODEL_METADATA_PARTIAL'), true);
  } finally {
    await fixture.cleanup();
  }
});

test('invalid marker reasoning metadata reuses router validation diagnostics without inventing a map', async () => {
  const fixture = await makeFixture({
    markerValue: marker('model-a:test', {
      supported_think_levels: ['low'],
      reasoning_effort_map: { minimal: 'low' }
    })
  });
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models/local-active`);
    assert.equal(response.status, 200);
    const metadata = (await response.json()).x_ollama_router;
    assert.equal(metadata.reasoning.supported, null);
    assert.deepEqual(metadata.reasoning.efforts, { off: 'none' });
    assert.equal(metadata.reasoning.upstream_levels, null);
    assert.equal(metadata.reasoning.effort_map, null);
    assert.equal(metadata.reasoning.default, null);
    assert.equal(metadata.complete, false);
    assert.equal(metadata.warnings.includes('INVALID_REASONING_CAPABILITIES'), true);
  } finally {
    await fixture.cleanup();
  }
});

test('the stable alias forwards to each current physical model in strict mode while other names stay rejected', async () => {
  const fixture = await makeFixture({ env: { ROUTER_MODEL_ALIAS: 'active-slot' } });
  try {
    const first = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'active-slot', input: 'first', stream: false })
    });
    assert.equal(first.status, 200);

    const rejected = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-the-alias:test', input: 'reject', stream: false })
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, 'MODEL_NOT_ACTIVE');

    await fixture.writeMarker(marker('model-b:test', { context_length: 24576 }));
    fixture.upstream.state.loadedModels = [{
      name: 'model-b:test',
      model: 'model-b:test',
      context_length: 12288
    }];
    const metadata = (await (await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/models`)).json()).data[0];
    assert.equal(metadata.id, 'active-slot');
    assert.equal(metadata.x_ollama_router.upstream_model, 'model-b:test');
    assert.equal(metadata.x_ollama_router.context_window, 12288);

    const second = await fetch(`http://127.0.0.1:${fixture.apiPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'active-slot', input: 'second', stream: false })
    });
    assert.equal(second.status, 200);

    const chats = fixture.upstream.requests.filter((item) => item.pathname === '/api/chat');
    assert.deepEqual(chats.map((item) => item.body.model), ['model-a:test', 'model-b:test']);
  } finally {
    await fixture.cleanup();
  }
});
