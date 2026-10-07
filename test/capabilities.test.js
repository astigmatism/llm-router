import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRouterServer } from '../src/server.js';
import { formatParameterSize } from '../src/backend-adapters.js';

const template = JSON.parse(await fs.readFile(new URL('../runtime/primary-model-catalog.json', import.meta.url)));
const CODING = template.models[0].model;
const EVERYDAY = template.models[1].model;
const NATIVE_CONTEXT = 262144;
const PARAMETERS = 27_300_000_000;
const SIZE_BYTES = 28_600_000_000;
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const until = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition timed out');
};

async function fixture(t, { env = {}, edit = () => {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-capabilities-'));
  const marker = structuredClone(template);
  const backends = [];
  for (const entry of marker.models) {
    entry.runtime_output_policy = { verification: 'docker-inspect-argv', n_predict: -1, reasoning_budget: -1, reasoning_effort: 'default', container_id: 'fake-' + entry.model };
    const state = { healthy: true, props: true, vision: true, slots: null };
    const server = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      if (req.url === '/props') {
        if (!state.props) return json(res, 500, {});
        return json(res, 200, { default_generation_settings: { params: { n_predict: -1 } }, modalities: { vision: state.vision }, build_info: 'b1-test' });
      }
      if (req.url === '/health') return json(res, state.healthy ? 200 : 503, { status: state.healthy ? 'ok' : 'unavailable' });
      if (req.url === '/v1/models') return json(res, 200, { data: [{ id: entry.model, meta: { n_ctx_train: NATIVE_CONTEXT, n_params: PARAMETERS, size: SIZE_BYTES } }] });
      if (req.url === '/slots') return json(res, 200, state.slots ?? Array.from({ length: entry.max_active_requests }, () => ({ n_ctx: entry.context_length, is_processing: false })));
      if (req.url === '/apply-template') return json(res, 200, { prompt: JSON.stringify(body) });
      if (req.url === '/tokenize') {
        if (body.content.includes('HOLD_TOKENIZER')) return;
        return json(res, 200, { tokens: new Array(20).fill(1) });
      }
      if (req.url === '/v1/chat/completions') {
        const message = { role: 'assistant', content: 'ok' };
        const usage = { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 };
        if (body.stream === false) return json(res, 200, { model: entry.model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ model: entry.model, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
        return res.end(`data: ${JSON.stringify({ model: entry.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
      }
      json(res, 404, {});
    });
    entry.backend_url = await listen(server);
    backends.push({ server, state });
  }
  edit(marker);
  Object.assign(marker, { ...marker.models[0], models: marker.models });
  const file = path.join(root, 'active-model.json');
  await fs.writeFile(file, JSON.stringify(marker));
  const config = loadConfig({ DATA_DIR: path.join(root, 'data'), ACTIVE_MODEL_FILE: file, ROUTER_CONTROL_FILE: path.join(root, 'control.json'), ADMIN_TOKEN: 'test', ADMIN_ENABLED: 'false', REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true', UNSUPPORTED_TOOLS_POLICY: 'drop', ROUTER_MODEL_METADATA_TTL_MS: '0', ...env });
  const router = await createRouterServer(config);
  const base = await listen(router.server);
  t.after(async () => {
    router.server.closeAllConnections();
    await new Promise((resolve) => router.server.close(resolve));
    await router.waitForIdle();
    for (const backend of backends) { backend.server.closeAllConnections(); await new Promise((resolve) => backend.server.close(resolve)); }
    await fs.rm(root, { recursive: true, force: true });
  });
  const post = (url, body, signal) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const admin = (route, body = {}) => fetch(base + '/admin/api/' + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'test' }, body: JSON.stringify(body) });
  const capabilities = async (query = '') => (await fetch(base + '/v1/router/capabilities' + query)).json();
  const rewrite = async (change) => {
    change(marker);
    Object.assign(marker, { ...marker.models[0], models: marker.models });
    await fs.writeFile(file, JSON.stringify(marker));
  };
  return { ...router, base, config, file, marker, post, admin, capabilities, rewrite, backends };
}

const chat = (model, content = 'hello') => ({ model, messages: [{ role: 'user', content }], reasoning_effort: 'none', max_tokens: 16, stream: false });

function placeOnGpus(marker) {
  Object.assign(marker.models[0], {
    gpu_names: ['RTX 3090', 'RTX 4080 SUPER'],
    text_gpu_uuids: marker.models[0].gpu_uuids,
    mmproj_offload: 'gpu', vision_gpu_name: 'RTX 3080', vision_gpu_shared: true,
    deployment_warnings: ['160K is the total prompt, history, reasoning, and output capacity.']
  });
  marker.configuration = { id: 'qwen27b-q6k-with-nighttime', exclusive: false, runtime_revision: 'cc83b68', published_at: '2026-10-07T02:13:27.000Z' };
  marker.offline_services = [];
}

function exclusive(marker) {
  const night = marker.models.pop();
  Object.assign(marker.models[0], { exclusive: true });
  marker.configuration = { id: 'flash-next-solo-128k', exclusive: true, runtime_revision: 'cc83b68', published_at: '2026-10-07T02:13:27.000Z' };
  marker.offline_services = [{ model: night.model, aliases: night.aliases, display_name: night.display_name, role: 'everyday', reason: 'exclusive_configuration' }];
}

// Reads text/event-stream frames from the router into an array.
async function openEvents(base, t) {
  const controller = new AbortController();
  const response = await fetch(base + '/v1/router/events', { signal: controller.signal });
  const events = [];
  const state = { ended: false };
  if (response.ok) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = { comments: [] };
            for (const line of buffer.slice(0, index).split('\n')) {
              if (line.startsWith(':')) frame.comments.push(line.slice(1).trim());
              else {
                const [field, ...rest] = line.split(':');
                const text = rest.join(':').replace(/^ /, '');
                frame[field] = field === 'data' ? JSON.parse(text) : text;
              }
            }
            events.push(frame);
            buffer = buffer.slice(index + 2);
          }
        }
      } catch { /* aborted */ }
      state.ended = true;
    })();
  }
  t.after(() => controller.abort());
  const latest = (type) => events.filter((event) => event.event === type).at(-1);
  return { response, events, state, latest, abort: () => controller.abort() };
}

test('parameter sizes are formatted from the running model', () => {
  assert.equal(formatParameterSize(PARAMETERS), '27.3B');
  assert.equal(formatParameterSize(80_000_000_000), '80B');
  assert.equal(formatParameterSize(750_000_000), '750M');
  assert.equal(formatParameterSize(null), null);
  assert.equal(formatParameterSize(-5), null);
});

test('capabilities document describes residents, configuration and live facts, and revalidates', async (t) => {
  const f = await fixture(t, { edit: placeOnGpus });
  const response = await fetch(f.base + '/v1/router/capabilities');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  const doc = await response.json();
  assert.equal(response.headers.get('etag'), `"${doc.revision}"`);
  assert.equal(doc.object, 'router.capabilities');
  assert.equal(doc.schema_version, 1);
  assert.equal(doc.complete, true, JSON.stringify(doc.warnings));
  assert.deepEqual(doc.warnings, []);
  assert.deepEqual(doc.router, { name: 'llm-router', version: f.config.version, accepting_requests: true, draining: false, drain_reason: null, maintenance: false });
  assert.deepEqual(doc.configuration, { id: 'qwen27b-q6k-with-nighttime', exclusive: false, runtime_revision: 'cc83b68', published_at: '2026-10-07T02:13:27.000Z' });
  assert.equal(doc.default_model, CODING);
  assert.deepEqual(doc.offline_services, []);
  assert.deepEqual(doc.models.map((model) => model.id), [CODING, EVERYDAY]);
  assert.deepEqual(doc.ids, { [CODING]: CODING, 'local-active': CODING, daytime: CODING, [EVERYDAY]: EVERYDAY, nighttime: EVERYDAY });
  assert.ok(!('load' in doc));

  const [day, night] = doc.models;
  assert.deepEqual({ ...day, metadata: undefined }, {
    id: CODING, display_name: 'Daytime (160K)', aliases: ['local-active', 'daytime'], available: true, slots: 1,
    context_window: 163840, input_modalities: ['text', 'image'], capabilities: ['completion', 'thinking', 'tools', 'vision'], metadata: undefined
  });
  // The summary embeds exactly the /v1/models metadata for the canonical row.
  const { data } = await (await fetch(f.base + '/v1/models')).json();
  assert.deepEqual(day.metadata, data.find((row) => row.id === CODING).x_ollama_router);
  assert.deepEqual(day.metadata.live, { slots: 1, slot_context_window: 163840, vision: true, model_context_window: NATIVE_CONTEXT, parameters: PARAMETERS, size_bytes: SIZE_BYTES, build: 'b1-test' });
  assert.equal(day.metadata.model_context_window, NATIVE_CONTEXT);
  assert.equal(day.metadata.context_window, 163840);
  assert.equal(day.metadata.parameter_size, '27.3B');
  assert.equal(day.metadata.family, null);
  assert.deepEqual(day.metadata.placement, { gpu_count: 2, gpus: ['RTX 3090', 'RTX 4080 SUPER'], vision_encoder: 'gpu', vision_gpu: 'RTX 3080', vision_gpu_shared: true, exclusive: false });
  assert.deepEqual(night.metadata.placement, { gpu_count: 2, gpus: null, vision_encoder: 'cpu', vision_gpu: null, vision_gpu_shared: null, exclusive: false });
  assert.deepEqual(day.metadata.capability_profile, { name: 'qwen38-27b-golden-vision-tools', text: true, streaming: true, vision: true, tools: true, reasoning: true, speculative: true });
  assert.equal(night.metadata.capability_profile.speculative, false);
  assert.deepEqual(day.metadata.qualification_notes, ['160K is the total prompt, history, reasoning, and output capacity.']);
  assert.equal(day.metadata.sources.backend_props, true);
  assert.ok(!JSON.stringify(doc).includes('GPU-'), 'GPU UUIDs stay private');
  assert.ok(!JSON.stringify(doc).includes('127.0.0.1'), 'backend URLs stay private');

  const notModified = await fetch(f.base + '/v1/router/capabilities', { headers: { 'if-none-match': response.headers.get('etag') } });
  assert.equal(notModified.status, 304);

  const tags = await (await fetch(f.base + '/api/tags')).json();
  const tag = tags.models.find((row) => row.name === 'daytime');
  assert.deepEqual(tag.details, { format: 'gguf', family: null, parameter_size: '27.3B', quantization_level: template.models[0].quantization });
  assert.equal(tag.size, SIZE_BYTES);
  const show = await (await f.post('/api/show', { model: 'nighttime' })).json();
  assert.equal(show.details.parameter_size, '27.3B');
  assert.equal(show.details.family, null);

  assert.equal((await fetch(f.base + '/v1/router/capabilities', { method: 'POST' })).status, 405);
});

test('include=load reports per-resident admission without changing the revision', async (t) => {
  const f = await fixture(t);
  const idle = await f.capabilities('?include=load');
  assert.deepEqual(idle.load, { [CODING]: { active: 0, queued: 0, free_slots: 1 }, [EVERYDAY]: { active: 0, queued: 0, free_slots: 1 } });
  const first = new AbortController();
  const second = new AbortController();
  void f.post('/v1/chat/completions', chat('daytime', 'HOLD_TOKENIZER'), first.signal).catch(() => {});
  await until(async () => (await f.capabilities('?include=load')).load[CODING].active === 1);
  void f.post('/v1/chat/completions', chat('local-active', 'HOLD_TOKENIZER'), second.signal).catch(() => {});
  let busy;
  await until(async () => (busy = await f.capabilities('?include=load')).load[CODING].queued === 1);
  assert.deepEqual(busy.load[CODING], { active: 1, queued: 1, free_slots: 0 });
  assert.deepEqual(busy.load[EVERYDAY], { active: 0, queued: 0, free_slots: 1 });
  assert.equal(busy.revision, idle.revision);
  const plain = await fetch(f.base + '/v1/router/capabilities');
  assert.equal(plain.headers.get('etag'), `"${idle.revision}"`);
  first.abort();
  second.abort();
  await until(async () => (await f.capabilities('?include=load')).load[CODING].active === 0);
});

test('an exclusive configuration lists its offline service and rejects it as temporarily offline', async (t) => {
  const f = await fixture(t, { edit: exclusive });
  const doc = await f.capabilities();
  assert.equal(doc.complete, true, JSON.stringify(doc.warnings));
  assert.deepEqual(doc.models.map((model) => model.id), [CODING]);
  assert.deepEqual(doc.offline_services, [{ model: EVERYDAY, aliases: ['nighttime'], display_name: 'Nighttime (128K)', role: 'everyday', reason: 'exclusive_configuration' }]);
  assert.deepEqual(doc.configuration.exclusive, true);
  assert.equal(doc.models[0].metadata.placement.exclusive, true);
  assert.ok(!('nighttime' in doc.ids));

  for (const model of ['nighttime', EVERYDAY]) {
    for (const [route, body] of [
      ['/v1/chat/completions', chat(model)],
      ['/api/chat', { model, messages: [{ role: 'user', content: 'hi' }], think: false, stream: false }],
      ['/v1/responses', { model, input: 'hi', reasoning: { effort: 'none' }, stream: false }]
    ]) {
      const response = await f.post(route, body);
      assert.equal(response.status, 503, `${route} ${model}`);
      const text = await response.text();
      assert.match(text, /SERVICE_OFFLINE/, `${route} ${model}`);
      assert.match(text, /flash-next-solo-128k/);
    }
  }
  const detail = await fetch(f.base + '/v1/models/nighttime');
  assert.equal(detail.status, 503);
  assert.equal((await detail.json()).error.code, 'SERVICE_OFFLINE');
  assert.equal((await fetch(f.base + '/v1/models/no-such-model')).status, 404);
  assert.equal((await f.post('/v1/chat/completions', chat('no-such-model'))).status, 404);
  const { data } = await (await fetch(f.base + '/v1/models')).json();
  assert.ok(!data.some((row) => row.id === 'nighttime' || row.id === EVERYDAY));
  assert.equal((await f.post('/v1/chat/completions', chat('daytime'))).status, 200);
});

test('invalid optional runtime metadata is reported without blocking inference', async (t) => {
  const f = await fixture(t, { edit: (marker) => {
    marker.configuration = 'qwen27b';
    marker.offline_services = [{ model: CODING, aliases: [] }, { aliases: ['x'] }];
  } });
  const doc = await f.capabilities();
  assert.equal(doc.complete, false);
  assert.deepEqual(doc.warnings.sort(), ['INVALID_OFFLINE_SERVICES', 'INVALID_RUNTIME_CONFIGURATION', 'OFFLINE_SERVICE_CONFLICT']);
  assert.equal(doc.configuration, null);
  assert.deepEqual(doc.offline_services, []);
  assert.equal(doc.models.length, 2);
  assert.equal((await f.post('/v1/chat/completions', chat('daytime'))).status, 200);
  assert.equal((await fetch(f.base + '/v1/models')).status, 200);
});

test('an unusable catalog still yields a truthful document', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({ ...f.marker, schema_version: 2 }));
  const response = await fetch(f.base + '/v1/router/capabilities');
  assert.equal(response.status, 200);
  const doc = await response.json();
  assert.equal(doc.complete, false);
  assert.deepEqual(doc.models, []);
  assert.deepEqual(doc.warnings, ['INVALID_MODEL_CATALOG']);
  assert.equal(doc.default_model, null);
});

test('backend facts that contradict the catalog mark only that model incomplete', async (t) => {
  const f = await fixture(t);
  f.backends[0].state.slots = [{ n_ctx: 4096 }, { n_ctx: 4096 }];
  f.backends[0].state.vision = false;
  f.backends[1].state.props = false;
  const doc = await f.capabilities();
  const [day, night] = doc.models;
  assert.deepEqual(day.metadata.warnings.sort(), ['BACKEND_SLOT_CONTEXT_MISMATCH', 'BACKEND_SLOT_COUNT_MISMATCH', 'BACKEND_VISION_MISMATCH']);
  assert.equal(day.metadata.complete, false);
  assert.equal(day.metadata.live.slots, 2);
  assert.equal(day.metadata.live.slot_context_window, 4096);
  // An unavailable /props is not a contradiction.
  assert.equal(night.metadata.complete, true);
  assert.equal(night.metadata.sources.backend_props, false);
  assert.equal(night.metadata.live.vision, null);
  assert.equal(night.metadata.live.build, null);
  assert.equal(doc.complete, false);
});

test('the event stream pushes complete snapshots on reload, drain and load changes', async (t) => {
  // A long poll interval proves that these changes are pushed, not polled.
  const f = await fixture(t, { env: { ROUTER_CAPABILITY_POLL_MS: '60000', ROUTER_EVENTS_HEARTBEAT_MS: '1000' } });
  const stream = await openEvents(f.base, t);
  assert.equal(stream.response.status, 200);
  assert.equal(stream.response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  await until(() => stream.latest('load'));
  assert.equal(stream.events[0].retry, '3000');
  const initial = stream.latest('capabilities');
  assert.equal(initial.id, initial.data.revision);
  assert.equal(initial.data.object, 'router.capabilities');
  assert.equal(initial.data.models.length, 2);
  assert.deepEqual(stream.latest('load').data, { revision: initial.data.revision, load: { [CODING]: { active: 0, queued: 0, free_slots: 1 }, [EVERYDAY]: { active: 0, queued: 0, free_slots: 1 } } });

  // A runtime publication notifies the router, which pushes immediately.
  await f.rewrite((marker) => { marker.models[1].display_name = 'Nighttime (96K)'; });
  const reloadedAt = Date.now();
  assert.equal((await f.admin('reload-config')).status, 200);
  await until(() => stream.latest('capabilities').data.models[1]?.display_name === 'Nighttime (96K)', 3000);
  assert.ok(Date.now() - reloadedAt < 3000);
  assert.notEqual(stream.latest('capabilities').id, initial.id);

  assert.equal((await f.admin('runtime-drain', { enabled: true, reason: 'local-ai-runtime:test' })).status, 200);
  await until(() => stream.latest('capabilities').data.router.draining === true, 3000);
  const draining = stream.latest('capabilities').data;
  assert.equal(draining.router.accepting_requests, false);
  assert.equal(draining.router.drain_reason, 'local-ai-runtime:test');
  assert.ok(draining.models.every((model) => model.available === false));
  assert.equal((await f.admin('runtime-drain', { enabled: false })).status, 200);
  await until(() => stream.latest('capabilities').data.router.accepting_requests === true, 3000);

  const hold = new AbortController();
  void f.post('/v1/chat/completions', chat('nighttime', 'HOLD_TOKENIZER'), hold.signal).catch(() => {});
  await until(() => stream.latest('load').data.load[EVERYDAY].active === 1, 3000);
  assert.equal(stream.latest('load').data.load[EVERYDAY].free_slots, 0);
  hold.abort();
  await until(() => stream.latest('load').data.load[EVERYDAY].active === 0, 3000);

  await until(() => stream.events.some((event) => event.comments.includes('keepalive')), 3000);
  // Revisions are content-addressed: a state that returns repeats its earlier
  // revision, but an unchanged state is never pushed twice in a row.
  const ids = stream.events.filter((event) => event.event === 'capabilities').map((event) => event.id);
  assert.equal(ids.length, 4);
  assert.ok(ids.every((id, index) => index === 0 || id !== ids[index - 1]));
});

test('the event stream reports backend health changes found by its poll', async (t) => {
  const f = await fixture(t, { env: { ROUTER_CAPABILITY_POLL_MS: '1000' } });
  const stream = await openEvents(f.base, t);
  await until(() => stream.latest('capabilities'));
  f.backends[1].state.healthy = false;
  await until(() => stream.latest('capabilities').data.models[1].available === false, 6000);
  assert.equal(stream.latest('capabilities').data.models[1].metadata.health.available, false);
  assert.equal(stream.latest('capabilities').data.models[0].available, true);
  f.backends[1].state.healthy = true;
  await until(() => stream.latest('capabilities').data.models[1].available === true, 6000);
});

test('the event stream enforces its subscriber limit and ends on shutdown', async (t) => {
  const f = await fixture(t, { env: { ROUTER_EVENTS_MAX_SUBSCRIBERS: '1' } });
  const first = await openEvents(f.base, t);
  assert.equal(first.response.status, 200);
  await until(() => first.latest('capabilities'));
  const rejected = await fetch(f.base + '/v1/router/events');
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error.code, 'TOO_MANY_SUBSCRIBERS');
  first.abort();
  await until(() => f.context.capabilities.subscribers.size === 0);
  const second = await openEvents(f.base, t);
  assert.equal(second.response.status, 200);
  await until(() => second.latest('capabilities'));
  assert.equal((await fetch(f.base + '/v1/router/events', { method: 'POST' })).status, 405);
  // Graceful shutdown ends streams instead of waiting on them.
  f.context.capabilities.close();
  await until(() => second.state.ended);
  assert.equal(f.context.capabilities.pollTimer, null);
});
