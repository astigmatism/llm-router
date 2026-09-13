import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRouterServer } from '../src/server.js';
import { readModelCatalog, selectCatalogModel } from '../src/model-catalog.js';
import { writeActiveModelMarker } from '../src/active-model.js';

const template = JSON.parse(await fs.readFile(new URL('../runtime/primary-model-catalog.json', import.meta.url)));
const CODING = template.models[0].model;
const EVERYDAY = template.models[1].model;
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const until = async (predicate) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail('condition timed out'); };

async function fixture(t, env = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-catalog-'));
  const marker = structuredClone(template);
  const backends = [];
  for (const entry of marker.models) {
    entry.runtime_output_policy = { verification: 'docker-inspect-argv', n_predict: -1, reasoning_budget: -1, reasoning_effort: 'default', container_id: 'fake-' + entry.model };
    const state = { requests: [], healthy: true, active: 0, cancelled: 0, launchLimit: -1 };
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      state.requests.push({ path: req.url, body });
      if (req.url === '/props') return json(res, 200, { default_generation_settings: { params: { n_predict: state.launchLimit } } });
      if (req.url === '/health') return json(res, state.healthy ? 200 : 503, { status: state.healthy ? 'ok' : 'unavailable' });
      if (req.url === '/v1/models') return json(res, 200, { data: [{ id: entry.model }] });
      if (req.url === '/slots') return json(res, 200, [{ n_ctx: entry.context_length }]);
      if (req.url === '/apply-template') return json(res, 200, { prompt: JSON.stringify(body) });
      if (req.url === '/tokenize') {
        if (body.content.includes('HOLD_TOKENIZER')) return;
        return json(res, 200, { tokens: new Array(state.countInput?.(body.content) ?? Number(body.content.match(/INPUT=(\d+)/)?.[1] ?? 20)).fill(1) });
      }
      if (req.url === '/v1/chat/completions') {
        state.active++;
        res.once('close', () => { state.active--; if (!res.writableEnded) state.cancelled++; });
        if (state.generationHandler) return state.generationHandler(body, res);
        const message = { role: 'assistant', content: '323', ...(body.chat_template_kwargs.enable_thinking ? { reasoning_content: 'Calculated.' } : {}) };
        if (body.stream === false) return json(res, 200, { model: entry.model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ model: entry.model, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
        if (JSON.stringify(body.messages).includes('HOLD')) return;
        res.end(`data: ${JSON.stringify({ model: entry.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } })}\n\ndata: [DONE]\n\n`);
        return;
      }
      json(res, 404, {});
    });
    entry.backend_url = await listen(server);
    backends.push({ server, state });
  }
  Object.assign(marker, { ...marker.models[0], models: marker.models });
  const file = path.join(root, 'active-model.json');
  await fs.writeFile(file, JSON.stringify(marker));
  const config = loadConfig({ DATA_DIR: path.join(root, 'data'), ACTIVE_MODEL_FILE: file, ROUTER_CONTROL_FILE: path.join(root, 'control.json'), ADMIN_TOKEN: 'test', ADMIN_ENABLED: 'false', GPU_TELEMETRY_ENABLED: 'false', REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true', UNSUPPORTED_TOOLS_POLICY: 'drop', ROUTER_MODEL_METADATA_TTL_MS: '0', ...env });
  const router = await createRouterServer(config);
  const base = await listen(router.server);
  const adminBase = router.adminServer ? await listen(router.adminServer) : null;
  if (router.adminServer) t.after(async () => {
    router.adminServer.closeAllConnections();
    await new Promise((resolve) => router.adminServer.close(resolve));
  });
  t.after(async () => { router.server.closeAllConnections(); await new Promise((r) => router.server.close(r)); await router.waitForIdle(); for (const b of backends) { b.server.closeAllConnections(); await new Promise((r) => b.server.close(r)); } await fs.rm(root, { recursive: true, force: true }); });
  const post = (url, body, signal) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  return { ...router, base, adminBase, config, file, marker, post, backends };
}
const chat = (model, content = '17*19', extra = {}) => ({ ...(model ? { model } : {}), messages: [{ role: 'user', content }], reasoning_effort: 'none', max_tokens: 16, stream: false, ...extra });

test('qualified Daytime context extensions update aliases and actual admission boundaries', async (t) => {
  const f = await fixture(t);
  const night = structuredClone(f.marker.models[1]);
  for (const context of [147456, 163840]) {
    const day = f.marker.models[0];
    Object.assign(day, { context_length: context, total_context_length: context,
      display_name: `Daytime (${context / 1024}K)` });
    Object.assign(f.marker, day);
    await fs.writeFile(f.file, JSON.stringify(f.marker));
    assert.deepEqual(f.marker.models[1], night);
    const { data } = await (await fetch(f.base + '/v1/models')).json();
    for (const id of [CODING, 'daytime', 'local-active']) {
      const metadata = data.find(row => row.id === id).x_ollama_router;
      assert.equal(metadata.context_window, context);
      assert.equal(metadata.display_name, `Daytime (${context / 1024}K)`);
      assert.equal(metadata.max_output_tokens, null);
    }
    const boundary = context - 1024 - 16;
    assert.equal((await f.post('/v1/chat/completions', chat('daytime', `INPUT=${boundary}`))).status, 200);
    assert.equal((await f.post('/v1/chat/completions', chat('daytime', `INPUT=${boundary + 1}`))).status, 400);
  }
  Object.assign(f.marker.models[0], { context_length: 262144, total_context_length: 262144 });
  Object.assign(f.marker, f.marker.models[0]);
  await fs.writeFile(f.file, JSON.stringify(f.marker));
  await assert.rejects(readModelCatalog(f.config), { code: 'INVALID_MODEL_CATALOG' });
});

test('catalog lists canonical identities, resolves aliases deliberately, and protects metadata writers', async (t) => {
  const f = await fixture(t, { ADMIN_ENABLED: 'true' });
  const catalog = await readModelCatalog(f.config);
  assert.equal(selectCatalogModel(catalog, 'local-active').model, CODING);
  assert.equal(selectCatalogModel(catalog).model, CODING);
  assert.throws(() => selectCatalogModel(catalog, 'unknown'), { code: 'MODEL_NOT_FOUND' });
  await assert.rejects(writeActiveModelMarker(f.file, { model: CODING }), /complete catalog/);
  const list = await (await fetch(f.base + '/v1/models')).json();
  assert.deepEqual(list.data.map((x) => x.id), [CODING, EVERYDAY, 'local-active', 'daytime', 'nighttime']);
  assert.equal(list.data[1].x_ollama_router.context_window, 131072);
  assert.equal(list.data[0].x_ollama_router.display_name, 'Daytime (128K)');
  assert.equal(list.data[1].x_ollama_router.display_name, 'Nighttime (128K)');
  assert.equal(list.data[1].x_ollama_router.default_output_tokens, null);
  assert.equal(list.data[1].x_ollama_router.reasoning.per_effort.medium.reasoning_budget_tokens, -1);
  assert.deepEqual(list.data[1].x_ollama_router.capabilities, ['completion', 'thinking', 'tools', 'vision']);
  const alias = await (await fetch(f.base + '/v1/models/local-active')).json();
  assert.equal(alias.x_ollama_router.upstream_model, CODING);
  assert.equal(alias.x_ollama_router.alias, true);
  assert.deepEqual(list.data.find((entry) => entry.id === 'local-active'), alias);
  assert.deepEqual(alias, {
    ...list.data[0], id: 'local-active',
    x_ollama_router: { ...list.data[0].x_ollama_router, alias: true }
  });
  const tags = await (await fetch(f.base + '/api/tags')).json();
  assert.deepEqual(tags.models.map((x) => x.name), [CODING, EVERYDAY, 'local-active', 'daytime', 'nighttime']);
  for (const [id, target] of [['local-active', CODING], ['daytime', CODING], ['nighttime', EVERYDAY]]) {
    const canonical = list.data.find((entry) => entry.id === target);
    const alias = list.data.find((entry) => entry.id === id);
    assert.deepEqual(alias, { ...canonical, id, x_ollama_router: { ...canonical.x_ollama_router, alias: true } });
    assert.deepEqual(tags.models.find((entry) => entry.model === id).x_ollama_router, alias.x_ollama_router);
    const show = await f.post('/api/show', { model: id });
    assert.equal(show.status, 200);
    const metadata = await show.json();
    assert.equal(metadata.model_info.context_length, canonical.x_ollama_router.context_window);
    assert.deepEqual(metadata.capabilities, canonical.x_ollama_router.capabilities);
  }
  const ps = await (await fetch(f.base + '/api/ps')).json();
  assert.deepEqual(ps.models.map((entry) => [entry.name, entry.slots]), [[CODING, 1], [EVERYDAY, 1]]);
  const residents = await f.context.modelDiscovery.document(null, { includeAliases: false });
  assert.deepEqual(residents.entries.map((entry) => entry.id), [CODING, EVERYDAY]);
  for (const route of ['/admin/api/runtime-state', '/admin/api/summary']) {
    const response = await fetch(f.adminBase + route, { headers: { 'x-admin-token': 'test' } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).models.map((entry) => entry.id), [CODING, EVERYDAY]);
  }
  const show = await (await f.post('/api/show', { model: EVERYDAY })).json();
  assert.deepEqual(show.capabilities, ['completion', 'thinking', 'tools', 'vision']);
  assert.equal(show.model_info.context_length, 131072);
  f.marker.models[1].context_length = 262144;
  await fs.writeFile(f.file, JSON.stringify(f.marker));
  await assert.rejects(readModelCatalog(f.config), { code: 'INVALID_MODEL_CATALOG' });
});

test('stable native services preserve reasoning off/max and selected-backend failures', async (t) => {
  const f = await fixture(t);
  for (const [model, index] of [['daytime', 0], ['nighttime', 1]]) {
    for (const think of [false, 'max']) {
      const response = await f.post('/api/chat', { model, messages: chat(model).messages, think, stream: false });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).done_reason, 'stop');
      const sent = f.backends[index].state.requests.filter((r) => r.path === '/v1/chat/completions').at(-1).body;
      assert.equal(sent.model, f.marker.models[index].model);
      assert.equal(sent.chat_template_kwargs.enable_thinking, think !== false);
      assert.equal(sent.reasoning_effort, think === 'max' ? 'xhigh' : undefined);
      assert.equal(sent.n_predict, -1);
      assert.equal(sent.max_tokens, undefined);
    }
  }
  f.backends[1].state.healthy = false;
  const primaryCalls = f.backends[0].state.requests.length;
  for (const model of ['nighttime', EVERYDAY]) {
    const response = await f.post('/api/chat', { model, messages: chat(model).messages, think: false, stream: false });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'BACKEND_UNAVAILABLE');
  }
  assert.equal(f.backends[0].state.requests.length, primaryCalls);
});

test('service identifiers survive replacing either canonical model without client reconfiguration', async (t) => {
  const f = await fixture(t);
  for (const [service, index] of [['daytime', 0], ['nighttime', 1]]) {
    const clientRequest = { model: service, messages: chat(service).messages, think: false, stream: false };
    assert.equal((await (await f.post('/api/chat', clientRequest)).json()).model, f.marker.models[index].model);
    const oldModel = f.marker.models[index].model;
    const replacement = `replacement-${service}-v2`;
    f.marker.models[index].model = replacement;
    f.marker.default_model = f.marker.models[0].model;
    Object.assign(f.marker, { ...f.marker.models[0], models: f.marker.models });
    await fs.writeFile(f.file, JSON.stringify(f.marker));
    const response = await f.post('/api/chat', clientRequest);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, replacement);
    const { models } = await (await fetch(f.base + '/api/tags')).json();
    assert.equal(models.find((entry) => entry.model === service).x_ollama_router.upstream_model, replacement);
    assert.equal(models.some((entry) => entry.model === oldModel), false);
    const alias = await (await fetch(f.base + '/v1/models/' + service)).json();
    assert.equal(alias.x_ollama_router.upstream_model, replacement);
  }
  assert.equal((await (await fetch(f.base + '/v1/models/local-active')).json()).x_ollama_router.upstream_model, 'replacement-daytime-v2');
});

test('legacy exact-ID discovery preserves truthful unrestricted limits and per-model capabilities', async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/v1/models');
  const { data } = await response.json();
  const legacy = data.find((entry) => entry.id === 'local-active');
  assert.ok(legacy, 'legacy clients must find the stable alias without interpreting metadata');
  assert.deepEqual(data.filter((entry) => !entry.x_ollama_router.alias).map((entry) => entry.id), [CODING, EVERYDAY]);
  for (const [id, context, capabilities, modalities] of [
    [CODING, 131072, ['completion', 'thinking', 'tools', 'vision'], ['text', 'image']],
    ['local-active', 131072, ['completion', 'thinking', 'tools', 'vision'], ['text', 'image']],
    [EVERYDAY, 131072, ['completion', 'thinking', 'tools', 'vision'], ['text', 'image']]
  ]) {
    const entry = data.find((entry) => entry.id === id);
    const metadata = entry.x_ollama_router;
    assert.equal(metadata.schema_version, 2);
    assert.equal(metadata.complete, true);
    assert.deepEqual(metadata.warnings, []);
    assert.equal(metadata.context_window, context);
    assert.equal(metadata.active_request_limit, 1);
    assert.deepEqual(metadata.capabilities, capabilities);
    assert.deepEqual(metadata.input_modalities, modalities);
    assert.equal(metadata.output_policy, 'unrestricted');
    assert.equal(metadata.max_output_tokens, null);
    assert.equal(metadata.default_output_tokens, null);
    assert.equal(metadata.reasoning.default, 'default');
    assert.equal(metadata.reasoning.absolute_max_output_tokens, null);
    for (const effort of Object.values(metadata.reasoning.per_effort)) {
      assert.equal(effort.max_output_tokens, null);
      assert.equal(effort.default_output_tokens, null);
    }
    const detail = await fetch(f.base + '/v1/models/' + id);
    assert.deepEqual(await detail.json(), entry);
  }
  const cached = await fetch(f.base + '/v1/models', { headers: { 'if-none-match': response.headers.get('etag') } });
  assert.equal(cached.status, 304);

  // Alias health follows its selected backend; a healthy secondary is never a fallback.
  f.backends[0].state.healthy = false;
  const changed = await fetch(f.base + '/v1/models', { headers: { 'if-none-match': response.headers.get('etag') } });
  assert.equal(changed.status, 200);
  const unavailable = (await changed.json()).data;
  for (const id of [CODING, 'local-active']) {
    const metadata = unavailable.find((entry) => entry.id === id).x_ollama_router;
    assert.equal(metadata.health.available, false);
    assert.deepEqual(metadata.capabilities, legacy.x_ollama_router.capabilities);
    assert.equal((await f.post('/v1/chat/completions', chat(id))).status, 503);
  }
  assert.equal(unavailable.find((entry) => entry.id === EVERYDAY).x_ollama_router.health.available, true);
  assert.equal((await f.post('/v1/chat/completions', chat(EVERYDAY))).status, 200);
});

test('configured stable alias is discoverable and routes to its target with broad rewriting disabled', async (t) => {
  const f = await fixture(t, { ROUTER_MODEL_ALIAS: 'stable-primary', REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'false' });
  f.marker.models[0].aliases = ['stable-primary', 'extra-primary'];
  Object.assign(f.marker, { ...f.marker.models[0], models: f.marker.models });
  await fs.writeFile(f.file, JSON.stringify(f.marker));
  const { data } = await (await fetch(f.base + '/v1/models')).json();
  assert.deepEqual(data.map((entry) => entry.id), [CODING, EVERYDAY, 'stable-primary', 'extra-primary', 'nighttime']);
  for (const model of [CODING, EVERYDAY, 'stable-primary', 'extra-primary', undefined]) {
    const response = await f.post('/v1/responses', { model, input: '17*19', reasoning: { effort: 'none' }, stream: false });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, [EVERYDAY, 'nighttime'].includes(model) ? EVERYDAY : CODING);
  }
  assert.equal((await fetch(f.base + '/v1/models/local-active')).status, 404);
  assert.equal((await f.post('/v1/responses', { model: 'local-active', input: 'hi' })).status, 404);
});

test('alias and actual-ID inference enforce each discovered model capability profile', async (t) => {
  const f = await fixture(t);
  const { data } = await (await fetch(f.base + '/v1/models')).json();
  for (const model of ['local-active', 'daytime', CODING, 'nighttime', EVERYDAY]) {
    const metadata = data.find((entry) => entry.id === model).x_ollama_router;
    for (const [capability, extra] of [
      ['tools', { tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] }],
      ['vision', { messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' } }
      ] }] }]
    ]) {
      const backend = f.backends[[EVERYDAY, 'nighttime'].includes(model) ? 1 : 0];
      const before = backend.state.requests.filter((request) => request.path === '/v1/chat/completions').length;
      const response = await f.post('/v1/chat/completions', chat(model, 'hi', extra));
      assert.equal(response.status, metadata.capabilities.includes(capability) ? 200 : 400, await response.text());
      if (!metadata.capabilities.includes(capability)) {
        assert.equal(backend.state.requests.filter((request) => request.path === '/v1/chat/completions').length, before);
      }
    }
  }
});

test('alias and canonical requests preserve omitted unrestricted output and deliberate finite allowances', async (t) => {
  const f = await fixture(t);
  for (const model of ['local-active', 'daytime', CODING, 'nighttime', EVERYDAY]) {
    for (const limit of [undefined, 64]) {
      for (const [url, body] of [
        ['/v1/responses', { model, input: 'hi', stream: false, max_output_tokens: limit }],
        ['/v1/chat/completions', { model, messages: chat(model).messages, stream: false, max_tokens: limit }],
        ['/api/chat', { model, messages: chat(model).messages, stream: false, options: { num_predict: limit } }],
        ['/api/generate', { model, prompt: 'hi', think: false, stream: false, options: { num_predict: limit } }]
      ]) {
        const response = await f.post(url, body);
        assert.equal(response.status, 200, await response.text());
        const backend = f.backends[[EVERYDAY, 'nighttime'].includes(model) ? 1 : 0];
        const sent = backend.state.requests.filter((request) => request.path === '/v1/chat/completions').at(-1).body;
        assert.equal(sent.model, [EVERYDAY, 'nighttime'].includes(model) ? EVERYDAY : CODING);
        assert.equal(sent.max_tokens, limit);
        if (limit === undefined) assert.equal(sent.n_predict, -1);
      }
    }
  }
});

test('all supported generation protocols select coding, everyday, alias and default without rewriting unknown IDs', async (t) => {
  const f = await fixture(t);
  for (const model of [CODING, EVERYDAY, 'local-active', 'daytime', 'nighttime', undefined]) {
    const expected = [EVERYDAY, 'nighttime'].includes(model) ? EVERYDAY : CODING;
    for (const [url, body] of [
      ['/v1/chat/completions', chat(model)],
      ['/v1/responses', { model, input: '17*19', reasoning: { effort: 'none' }, max_output_tokens: 16 }],
      ['/responses', { model, input: '17*19', reasoning: { effort: 'none' }, max_output_tokens: 16 }],
      ['/api/chat', { model, messages: chat(model).messages, think: false, stream: false, options: { num_predict: 16 } }],
      ['/api/generate', { model, prompt: '17*19', think: false, stream: false, options: { num_predict: 16 } }]
    ]) {
      const response = await f.post(url, body); const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.model, expected);
      const unknown = await f.post(url, { ...body, model: 'unknown' });
      assert.equal(unknown.status, 404); assert.equal((await unknown.json()).error.code, 'MODEL_NOT_FOUND');
    }
  }
  const stream = await f.post('/v1/chat/completions', { ...chat(EVERYDAY), stream: undefined });
  assert.match(stream.headers.get('content-type'), /event-stream/);
  assert.match(await stream.text(), new RegExp(EVERYDAY));
  await f.waitForIdle();
  assert.ok(f.context.metrics.snapshot().byModel[EVERYDAY] > 0);
  assert.equal(f.context.metrics.snapshot().byModel['local-active'], undefined);
});

test('independent gates allow overlap, share aliases, drain both, and release only the cancelled backend', async (t) => {
  const f = await fixture(t);
  const c = new AbortController(); const e = new AbortController();
  const coding = await f.post('/v1/chat/completions', chat('daytime', 'HOLD', { stream: true }), c.signal);
  const everyday = await f.post('/v1/chat/completions', chat(EVERYDAY, 'HOLD', { stream: true }), e.signal);
  await until(() => f.context.requestGate.active.size === 2);
  const waitingCoding = f.post('/api/chat', { model: CODING, messages: chat(CODING).messages, think: false, stream: false });
  await until(() => f.context.requestGate.snapshot().queued_count === 1);
  const waitingAlias = await f.post('/v1/responses', { model: 'local-active', input: '17*19', stream: true });
  const cancelQueued = new AbortController();
  const waitingNight = await f.post('/v1/chat/completions', chat('nighttime', 'SHOULD_NOT_RUN', { stream: true }), cancelQueued.signal);
  await until(() => f.context.requestGate.snapshot().queued_count === 3);
  cancelQueued.abort(); await waitingNight.body.cancel().catch(() => {});
  await until(() => f.context.requestGate.snapshot().queued_count === 2);
  await f.context.requestGate.setDraining(true);
  assert.equal(await f.context.requestGate.waitForIdle(10), false);
  assert.equal((await f.post('/v1/chat/completions', chat(CODING))).status, 503);
  c.abort(); await coding.body.cancel().catch(() => {});
  assert.equal((await waitingCoding).status, 200);
  assert.equal(waitingAlias.status, 200);
  assert.match(await waitingAlias.text(), /response.completed/);
  await until(() => f.context.requestGate.active.size === 1);
  assert.equal(f.context.requestGate.snapshot().active_by_model[EVERYDAY], 1);
  await f.context.requestGate.setDraining(false);
  assert.equal((await f.post('/v1/chat/completions', chat(CODING))).status, 200);
  assert.equal(f.context.requestGate.snapshot().queued_count, 0);
  assert.equal(f.backends[1].state.requests.some((r) => JSON.stringify(r.body).includes('SHOULD_NOT_RUN')), false);
  e.abort(); await everyday.body.cancel().catch(() => {});
  await until(() => f.context.requestGate.active.size === 0);
  assert.ok(f.backends[0].state.cancelled > 0 && f.backends[1].state.cancelled > 0);
});

test('selected template admission, independent reasoning budgets, longer output and unavailable health', async (t) => {
  const f = await fixture(t);
  for (const [model, context] of [[CODING, 131072], [EVERYDAY, 131072]]) {
    const boundary = context - 1024 - 16;
    assert.equal((await f.post('/v1/chat/completions', chat(model, `INPUT=${boundary}`))).status, 200);
    const rejected = await f.post('/v1/chat/completions', chat(model, `INPUT=${boundary + 1}`));
    assert.equal(rejected.status, 400); assert.equal((await rejected.json()).error.code, 'context_length_exceeded');
  }
  for (const allowance of [undefined, 2048, 4096]) {
    const response = await f.post('/v1/chat/completions', chat(EVERYDAY, '17*19', { reasoning_effort: 'medium', max_tokens: allowance }));
    assert.equal(response.status, 200);
    const sent = f.backends[1].state.requests.filter((r) => r.path === '/v1/chat/completions').at(-1).body;
    assert.equal(sent.max_tokens, allowance);
    if (allowance === undefined) assert.equal(sent.n_predict, -1);
    assert.equal(sent.chat_template_kwargs.enable_thinking, true);
    assert.notEqual(sent.reasoning_budget_tokens, 2048);
  }
  assert.equal((await f.post('/v1/responses', { model: EVERYDAY, input: 'hi', previous_response_id: 'old' })).status, 400);
  assert.equal((await f.post('/v1/responses', { model: EVERYDAY, input: 'hi', store: true })).status, 400);
  const tools = await f.post('/v1/chat/completions', chat(EVERYDAY, 'hi', { tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] }));
  assert.equal(tools.status, 200);
  assert.equal(f.backends[1].state.requests.filter((r) => r.path === '/v1/chat/completions').at(-1).body.tools[0].function.name, 'f');
  f.backends[1].state.healthy = false;
  const unavailable = await f.post('/v1/chat/completions', chat(EVERYDAY));
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error.code, 'BACKEND_UNAVAILABLE');
  assert.equal((await f.post('/v1/chat/completions', chat(CODING))).status, 200);
  let discovery = await (await fetch(f.base + '/v1/models')).json();
  assert.equal(discovery.data[1].x_ollama_router.health.available, false);
  f.backends[1].state.healthy = true;
  discovery = await (await fetch(f.base + '/v1/models')).json();
  assert.equal(discovery.data[1].x_ollama_router.health.available, true);
});

test('queued native, chat SSE, Responses and JSON requests complete with intact protocols', async (t) => {
  const f = await fixture(t);
  for (const stream of [true, false]) {
    for (const [url, body, terminal] of [
      ['/api/chat', { model: EVERYDAY, messages: chat(EVERYDAY).messages, think: false, stream }, 'done'],
      ['/api/generate', { model: EVERYDAY, prompt: '17*19', think: false, stream }, 'done'],
      ['/v1/chat/completions', chat(EVERYDAY, '17*19', { stream }), 'finish_reason'],
      ['/v1/responses', { model: EVERYDAY, input: '17*19', stream }, 'completed']
    ]) {
      const controller = new AbortController();
      const held = await f.post('/v1/chat/completions', chat(EVERYDAY, 'HOLD', { stream: true }), controller.signal);
      let settled = false;
      const pending = f.post(url, body).then((r) => { settled = true; return r; });
      await until(() => f.context.requestGate.snapshot().queued_count === 1);
      let reader;
      let prefix = '';
      if (stream) {
        const response = await pending;
        assert.equal(response.status, 200);
        reader = response.body.getReader();
        prefix = new TextDecoder().decode((await reader.read()).value);
        if (url.startsWith('/api/')) {
          const heartbeat = JSON.parse(prefix);
          assert.equal(heartbeat.model, EVERYDAY);
          assert.equal(heartbeat.done, false);
          assert.equal(heartbeat.message.content, '');
          assert.equal(heartbeat.response, '');
        } else assert.equal(prefix, ': waiting for inference slot\n\n');
      } else assert.equal(settled, false, 'JSON must retain final HTTP status while queued');
      assert.equal(f.backends[1].state.requests.filter((r) => r.path === '/v1/chat/completions').length % 2, 1);
      controller.abort(); await held.body.cancel().catch(() => {});
      if (stream) {
        let text = prefix;
        for (;;) { const { done, value } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
        assert.match(text, new RegExp(terminal));
        assert.doesNotMatch(text, /BACKEND_CONCURRENCY_LIMIT|"error":(?!null)/);
      } else {
        const response = await pending;
        assert.equal(response.status, 200);
        assert.match(JSON.stringify(await response.json()), new RegExp(terminal));
      }
      await until(() => f.context.requestGate.active.size === 0);
    }
  }
});

test('queued validation failures terminate SSE/NDJSON honestly and retain JSON HTTP errors', async (t) => {
  const f = await fixture(t);
  for (const stream of [true, false]) {
    for (const [url, body] of [
      ['/api/chat', { model: EVERYDAY, messages: chat(EVERYDAY, 'INPUT=131072').messages, think: false, options: { num_predict: 16 }, stream }],
      ['/v1/chat/completions', chat(EVERYDAY, 'INPUT=131072', { stream })],
      ['/v1/responses', { model: EVERYDAY, input: 'INPUT=131072', max_output_tokens: 16, stream }]
    ]) {
      const controller = new AbortController();
      const held = await f.post('/v1/chat/completions', chat(EVERYDAY, 'HOLD', { stream: true }), controller.signal);
      const pending = f.post(url, body);
      await until(() => f.context.requestGate.snapshot().queued_count === 1);
      controller.abort(); await held.body.cancel().catch(() => {});
      const response = await pending;
      assert.equal(response.status, stream ? 200 : 400);
      const text = await response.text();
      assert.match(text, /context_length_exceeded/);
      if (stream) assert.match(text, /incomplete/);
      await until(() => f.context.requestGate.active.size === 0);
      assert.equal(f.context.requestGate.snapshot().queued_count, 0);
    }
  }
});

test('cancelling queued JSON and Responses requests never reaches the backend', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const held = await f.post('/v1/chat/completions', chat(EVERYDAY, 'HOLD', { stream: true }), controller.signal);
  for (const url of ['/api/chat', '/v1/responses']) {
    const cancelled = new AbortController();
    const pending = f.post(url, url === '/api/chat'
      ? { model: EVERYDAY, messages: chat(EVERYDAY, 'NEVER_RUN').messages, think: false, stream: false }
      : { model: EVERYDAY, input: 'NEVER_RUN', stream: false }, cancelled.signal).catch(() => null);
    await until(() => f.context.requestGate.snapshot().queued_count === 1);
    cancelled.abort(); await pending;
    await until(() => f.context.requestGate.snapshot().queued_count === 0);
    assert.equal(f.context.requestGate.active.size, 1);
  }
  controller.abort(); await held.body.cancel().catch(() => {});
  await until(() => f.context.requestGate.active.size === 0);
  assert.equal(f.backends[1].state.requests.some((r) => JSON.stringify(r.body).includes('NEVER_RUN')), false);
});

test('cancelling Responses during tokenization releases its lease before generation', async (t) => {
  const f = await fixture(t); const controller = new AbortController();
  const pending = f.post('/v1/responses', { model: EVERYDAY, input: 'HOLD_TOKENIZER', reasoning: { effort: 'none' }, max_output_tokens: 16 }, controller.signal).catch(() => null);
  await until(() => f.backends[1].state.requests.some((r) => r.path === '/tokenize'));
  controller.abort(); await pending;
  await until(() => f.context.requestGate.active.size === 0);
  assert.equal(f.backends[1].state.requests.some((r) => r.path === '/v1/chat/completions'), false);
});

test('unrestricted defaults survive every reasoning mode, protocol, and deliberate historical threshold', async (t) => {
  const f = await fixture(t);
  for (const model of [CODING, EVERYDAY]) {
    const backend = f.backends[model === CODING ? 0 : 1];
    for (const effort of [undefined, 'default', 'off', 'low', 'medium', 'xhigh', 'max', 'minimal', true, false]) {
      for (const stream of [false, true]) {
        const response = await f.post('/api/chat', { model, messages: [{ role: 'user', content: 'long ordinary answer' }], think: effort, stream });
        assert.equal(response.status, 200, await response.text());
        const wire = backend.state.requests.filter((r) => r.path === '/v1/chat/completions').at(-1).body;
        assert.equal(wire.n_predict, -1);
        assert.equal(wire.max_tokens, undefined);
        assert.equal(wire.max_completion_tokens, undefined);
        assert.equal(wire.ignore_eos, undefined);
        assert.equal(wire.t_max_predict_ms, undefined);
        assert.equal(wire.n_indent, undefined);
        if (effort === undefined || effort === true || effort === 'default') assert.equal(wire.reasoning_effort, undefined);
        if (wire.chat_template_kwargs.enable_thinking) assert.equal(wire.reasoning_budget_tokens, -1);
      }
    }
    for (const [route, body] of [
      ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }],
      ['/v1/responses', { input: 'hello' }],
      ['/api/generate', { prompt: 'hello', think: false }],
      ['/api/chat', { messages: [{ role: 'user', content: 'hello' }], options: { num_predict: -1 } }]
    ]) for (const stream of [false, true]) {
      const response = await f.post(route, { ...body, model, stream });
      assert.equal(response.status, 200, await response.text());
      const wire = backend.state.requests.filter((r) => r.path === '/v1/chat/completions').at(-1).body;
      assert.equal(wire.n_predict, -1); assert.equal(wire.max_tokens, undefined);
    }
  }
  for (const quota of [1024, 4096, 8192, 32768, 65536]) {
    const response = await f.post('/v1/chat/completions', chat(CODING, 'explicit allowance', { max_tokens: quota }));
    assert.equal(response.status, 200, await response.text());
    assert.equal(f.backends[0].state.requests.filter((r) => r.path === '/v1/chat/completions').at(-1).body.max_tokens, quota);
  }
  const invalid = await f.post('/v1/chat/completions', chat(CODING, 'x', { max_tokens: -1 }));
  assert.equal(invalid.status, 400);
  const explicitThinking = await f.post('/api/chat', { model: CODING, messages: [{ role: 'user', content: 'x' }], reasoning_budget_tokens: 123, stream: false });
  assert.equal(explicitThinking.status, 200, await explicitThinking.text());
  assert.equal(f.backends[0].state.requests.filter((r) => r.path === '/v1/chat/completions').at(-1).body.reasoning_budget_tokens, 123);
});

test('pinned engine request -1 cannot conceal a capped launch, and root policy cannot drift', async (t) => {
  const f = await fixture(t);
  f.backends[1].state.launchLimit = 1024;
  const response = await f.post('/api/chat', { model: EVERYDAY, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'BACKEND_OUTPUT_POLICY_MISMATCH');
  assert.equal(f.backends[1].state.requests.some((r) => r.path === '/v1/chat/completions'), false);
  f.marker.default_output_tokens = 1024;
  await fs.writeFile(f.file, JSON.stringify(f.marker));
  await assert.rejects(readModelCatalog(f.config), { code: 'INVALID_MODEL_CATALOG' });
});

function streamResult(res, { content = 'partial visible answer', reasoning = 'retained reasoning', finish = 'stop', broken = false, tools = null } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content, reasoning_content: reasoning, ...(tools ? { tool_calls: tools } : {}) }, finish_reason: null }] })}\n\n`);
  if (broken) return res.end();
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 1500 } })}\n\ndata: [DONE]\n\n`);
}

async function journals(f) {
  const dir = path.join(f.config.dataDir, 'generations');
  return Promise.all((await fs.readdir(dir)).map(async (name) => (await fs.readFile(path.join(dir, name), 'utf8')).trim().split('\n').map(JSON.parse)));
}

test('length-ended Responses remain incomplete in both modes, retaining thinking and partial tool JSON', async (t) => {
  const f = await fixture(t);
  for (const tools of [null, [{ index: 0, id: 'call_partial', type: 'function', function: { name: 'lookup', arguments: '{"query":' } }]]) {
    f.backends[0].state.generationHandler = (_, res) => streamResult(res, { finish: 'length', tools });
    for (const stream of [false, true]) {
      const response = await f.post('/v1/responses', { model: CODING, input: 'x', max_output_tokens: 1500, stream });
      assert.equal(response.status, 200);
      const payload = stream ? (await response.text()).split('\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(5))).at(-1).response : await response.json();
      assert.equal(payload.status, 'incomplete');
      assert.equal(payload.incomplete_details.reason, 'max_output_tokens');
      assert.ok(payload.output.every((item) => item.status === 'incomplete'));
      assert.ok(JSON.stringify(payload).includes('retained reasoning'));
      if (tools) assert.equal(payload.output.find((item) => item.type === 'function_call').arguments, '{"query":');
    }
  }
});

test('context-ended default generation continues with a disclosed working excerpt and durable complete output', async (t) => {
  const f = await fixture(t);
  f.backends[1].state.generationHandler = (body, res) => streamResult(res, JSON.stringify(body.messages).includes('preceding attempt')
    ? { content: 'continued answer ending NATURAL-END', finish: 'stop' }
    : { content: 'first part retained in full', finish: 'length' });
  const response = await f.post('/api/chat', { model: EVERYDAY, messages: [{ role: 'user', content: 'Explain the whole task' }], stream: false });
  const payload = await response.json();
  assert.equal(payload.done_reason, 'stop');
  assert.match(payload.message.content, /first part retained in full[\s\S]*Physical context boundary[\s\S]*NATURAL-END/);
  assert.equal(payload.x_router.context_transitions, 1);
  const records = (await journals(f))[0];
  assert.equal(records[0].request.messages[0].content, 'Explain the whole task');
  assert.equal(records.filter((row) => row.type === 'backend_request').length, 2);
  assert.ok(records.filter((row) => row.type === 'backend_request').every((row) => row.body.n_predict === -1 && row.body.max_tokens === undefined));
  assert.equal(records.find((row) => row.type === 'terminal').status, 'completed');
  assert.equal(f.context.requestGate.active.size, 0);
});

test('oversized tool history keeps the measured context error across APIs without starting generation', async (t) => {
  const f = await fixture(t);
  f.backends[1].state.countInput = (content) => content.includes('OVERSIZED_TOOL_RESULT') ? 160000 : 20;
  const tools = [{ type: 'function', function: { name: 'fetch_url', parameters: { type: 'object' } } }];
  const messages = [
    { role: 'user', content: 'Read the source' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_fetch', type: 'function', function: { name: 'fetch_url', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_fetch', content: 'OVERSIZED_TOOL_RESULT' }
  ];
  for (const stream of [false, true]) {
    for (const route of ['/api/chat', '/v1/chat/completions', '/v1/responses']) {
      const body = route.endsWith('responses') ? {
        input: [messages[0], { type: 'function_call', call_id: 'call_fetch', name: 'fetch_url', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_fetch', output: 'OVERSIZED_TOOL_RESULT' }],
        tools: [{ type: 'function', name: 'fetch_url', parameters: { type: 'object' } }]
      } : { messages, tools };
      const response = await f.post(route, { ...body, model: 'nighttime', stream });
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.error.code, 'context_length_exceeded');
      assert.match(payload.error.message, /Formatted input \(160000\).*131072-token slot/);
      assert.match(payload.error.message, /Tool history cannot be shortened safely/);
      assert.match(payload.error.message, /paged tool results/);
    }
  }
  assert.equal(f.backends[1].state.requests.filter((r) => r.path === '/v1/chat/completions').length, 0);
  for (const rows of await journals(f)) {
    assert.match(JSON.stringify(rows[0].request), /OVERSIZED_TOOL_RESULT/);
    assert.equal(rows.at(-1).error.code, 'context_length_exceeded');
  }
  assert.equal((await f.post('/api/chat', { model: 'nighttime', messages: [messages[0]], stream: false })).status, 200);
  assert.equal(f.context.requestGate.active.size, 0);
});

test('broken stream reports incomplete, retains Unicode and reasoning, and releases only its service', async (t) => {
  const f = await fixture(t);
  const completeText = '🌌 漢字 café '.repeat(3000);
  f.backends[1].state.generationHandler = (_, res) => streamResult(res, { content: completeText, broken: true });
  for (const route of ['/api/chat', '/v1/chat/completions', '/v1/responses']) {
    const body = route.endsWith('responses') ? { input: 'x' } : { messages: [{ role: 'user', content: 'x' }] };
    const response = await f.post(route, { ...body, model: EVERYDAY, stream: true });
    const received = await response.text();
    assert.ok(received.includes(completeText));
    assert.match(received, /incomplete|response.failed/);
    assert.doesNotMatch(received, /"finish_reason":"stop"|"done_reason":"stop"|response.completed/);
  }
  for (const rows of await journals(f)) {
    const text = rows.filter((row) => row.type === 'backend_event' && row.event).map((row) => row.event.choices?.[0]?.delta?.content ?? '').join('');
    assert.equal(text, completeText);
    assert.equal(rows.find((row) => row.type === 'terminal').status, 'incomplete');
  }
  await until(() => f.context.requestGate.active.size === 0);
});

test('journal storage failure preserves committed output, signals incomplete, and releases admission', async (t) => {
  const f = await fixture(t);
  const open = fs.open.bind(fs);
  let failed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes('/generations/')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (data, ...rest) => {
        if (!failed && String(data).includes('UNCOMMITTED-DELTA')) {
          failed = true;
          throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
        }
        return write(data, ...rest);
      };
    }
    return handle;
  });
  f.backends[0].state.generationHandler = (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const content of ['COMMITTED-雪', 'UNCOMMITTED-DELTA']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  };
  const response = await f.post('/api/chat', { model: CODING, messages: [{ role: 'user', content: 'storage test' }], stream: true });
  const received = await response.text();
  assert.match(received, /COMMITTED-雪/);
  assert.doesNotMatch(received, /UNCOMMITTED-DELTA|"done_reason":"stop"/);
  assert.match(received, /GENERATION_STORAGE_FAILED|Could not retain/);
  await until(() => f.context.requestGate.active.size === 0);
  const records = (await journals(f))[0];
  assert.equal(records.find((row) => row.type === 'terminal').status, 'incomplete');
  assert.ok(JSON.stringify(records).includes('COMMITTED-雪'));
});

test('a new router process can retrieve the complete authenticated durable record', async (t) => {
  const f = await fixture(t);
  const response = await f.post('/api/chat', { model: CODING, messages: [{ role: 'user', content: 'persist across restart' }], stream: false });
  const id = response.headers.get('x-router-generation-id');
  await response.json();
  const restarted = await createRouterServer(f.config);
  const base = await listen(restarted.server);
  t.after(async () => { restarted.server.closeAllConnections(); await new Promise((r) => restarted.server.close(r)); await restarted.waitForIdle(); });
  assert.equal((await fetch(base + '/admin/api/generation-record?id=' + id)).status, 401);
  const recovered = await fetch(base + '/admin/api/generation-record?id=' + id, { headers: { authorization: 'Bearer test' } });
  assert.equal(recovered.status, 200);
  const rows = (await recovered.text()).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].request.messages[0].content, 'persist across restart');
  assert.equal(rows.find((row) => row.type === 'terminal').status, 'completed');
});

test('a stalled generation retains its fragment and never becomes a completed response', async (t) => {
  const f = await fixture(t, { GENERATION_STALL_TIMEOUT_MS: '40' });
  f.backends[1].state.generationHandler = (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Retained before stall' } }] })}\n\n`);
  };
  const response = await f.post('/v1/responses', { model: EVERYDAY, input: 'stall fixture', stream: true });
  const data = await response.text();
  assert.match(data, /Retained before stall/);
  assert.match(data, /response.failed/);
  assert.doesNotMatch(data, /response.completed/);
  await until(() => f.context.requestGate.active.size === 0 && f.backends[1].state.active === 0);
  assert.equal((await journals(f))[0].find((row) => row.type === 'terminal').status, 'incomplete');
});

test('malformed structured output is retained as incomplete in streaming and aggregated modes', async (t) => {
  const f = await fixture(t);
  f.backends[0].state.generationHandler = (_, res) => streamResult(res, { content: '{"unfinished":', finish: 'stop' });
  for (const stream of [false, true]) {
    const response = await f.post('/v1/chat/completions', { model: CODING, messages: [{ role: 'user', content: 'Return JSON' }], response_format: { type: 'json_object' }, stream });
    const data = await response.text();
    assert.match(data, /unfinished/);
    assert.match(data, /MALFORMED_STRUCTURED_OUTPUT|invalid JSON/);
    assert.doesNotMatch(data, /"finish_reason":"stop"/);
  }
  assert.ok((await journals(f)).every((rows) => rows.find((row) => row.type === 'terminal').status === 'incomplete'));
});

test('reasoning-only context exhaustion recovers without imposing a thinking budget', async (t) => {
  const f = await fixture(t);
  f.backends[1].state.generationHandler = (body, res) => streamResult(res,
    JSON.stringify(body.messages).includes('preceding attempt')
      ? { content: 'Visible answer after recovery.', reasoning: 'continued reasoning', finish: 'stop' }
      : { content: '', reasoning: 'Complete original reasoning before the physical boundary.', finish: 'length' });
  const response = await f.post('/v1/responses', { model: EVERYDAY, input: 'Complete the task after reasoning.', stream: false });
  const payload = await response.json();
  assert.equal(payload.status, 'completed');
  assert.match(JSON.stringify(payload.output), /Complete original reasoning/);
  assert.match(JSON.stringify(payload.output), /Visible answer after recovery/);
  const records = (await journals(f))[0];
  const wires = records.filter(row => row.type === 'backend_request').map(row => row.body);
  assert.equal(wires.length, 2);
  assert.ok(wires.every(body => body.n_predict === -1 && body.reasoning_budget_tokens === -1 && body.reasoning_effort === undefined));
});

test('context recovery with no progress stops honestly and retains the original task', async (t) => {
  const f = await fixture(t);
  f.backends[1].state.generationHandler = (_, res) => streamResult(res, { content: '', reasoning: '', finish: 'length' });
  const response = await f.post('/api/chat', { model: EVERYDAY, messages: [{ role: 'user', content: 'Retained original task' }], stream: false });
  const payload = await response.json();
  assert.equal(response.status, 502);
  assert.equal(payload.x_router.status, 'incomplete');
  assert.match(payload.error.message, /no new output/);
  const records = (await journals(f))[0];
  assert.equal(records[0].request.messages[0].content, 'Retained original task');
  assert.equal(records.find(row => row.type === 'terminal').status, 'incomplete');
  assert.equal(f.context.requestGate.active.size, 0);
});
