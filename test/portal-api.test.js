import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRouterServer } from '../src/server.js';
import { randomUUID } from 'node:crypto';
import { normalizeRecord } from '../src/portal-records.js';
import { ensureJournals } from '../src/portal-routes.js';

// The portal reads one contract (docs/PORTAL_API.md) from two listeners with
// two different auth postures. These tests drive a real router against a fake
// backend and assert what the dashboard would receive, because every one of
// these shapes is a promise the browser cannot defend itself against.

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createFakeOllama() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://fake-ollama.local');
    const json = (body) => {
      const payload = Buffer.from(`${JSON.stringify(body)}\n`);
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length });
      response.end(payload);
    };
    if (url.pathname === '/api/version') return json({ version: 'portal-test' });
    if (url.pathname === '/api/tags') return json({ models: [{ name: 'active:model', model: 'active:model' }] });
    if (url.pathname === '/api/ps') return json({ models: [{ name: 'active:model', model: 'active:model', until: 'Forever', context: 8192 }] });
    if (url.pathname === '/api/chat') {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (!body.stream) {
          return json({ model: 'active:model', created_at: '2026-01-01T00:00:00Z', done: true, done_reason: 'stop',
            message: { role: 'assistant', content: 'hello back' },
            prompt_eval_count: 11, eval_count: 7, prompt_eval_duration: 4e6, eval_duration: 3e6, total_duration: 9e6 });
        }
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const chunks = [
          { model: 'active:model', created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'hello' }, done: false },
          { model: 'active:model', created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: ' back' }, done: false },
          { model: 'active:model', created_at: '2026-01-01T00:00:00Z', done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 5, total_duration: 12e6, eval_duration: 4e6 }
        ];
        for (const chunk of chunks) response.write(`${JSON.stringify(chunk)}\n`);
        return response.end();
      });
      return undefined;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
    return undefined;
  });
  return { server };
}

async function makeFixture(overrides = {}) {
  const upstream = createFakeOllama();
  const upstreamPort = await listen(upstream.server);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-portal-test-'));
  const activeModelFile = path.join(dir, 'active-model.json');
  await fs.writeFile(activeModelFile, JSON.stringify({
    profile: 'portal-test',
    model: 'active:model',
    keep_alive: -1,
    context: 8192,
    supported_think_levels: ['low', 'medium', 'high', 'max'],
    reasoning_effort_map: {
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'max',
      max: 'max'
    },
    updated_at: '2026-06-29T00:00:00.000Z',
    source: 'portal-api.test.js'
  }), 'utf8');

  const config = loadConfig({
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
  });
  const router = await createRouterServer(config);
  const apiPort = await listen(router.server);
  const adminPort = await listen(router.adminServer);
  return {
    config,
    apiPort,
    adminPort,
    dir,
    async chat(body = {}, options = {}) {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-name': options.client ?? 'portal-test' },
        body: JSON.stringify({ model: 'active:model', ...body })
      });
      const text = await response.text();
      return { status: response.status, text };
    },
    async get(pathname, { port = adminPort, token } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        headers: token ? { 'x-admin-token': token } : {}
      });
      return { status: response.status, body: response.status === 200 || response.status === 404 || response.status === 401
        ? await response.json() : null, headers: response.headers };
    },
    async post(pathname, body, { port = adminPort, token = 'secret-token' } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    async cleanup() {
      await close(router.adminServer);
      await close(router.server);
      await router.waitForIdle();
      await close(upstream.server);
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

async function untilRequests(fixture, count) {
  // The log is written after the response finishes, so the dashboard races it.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { body } = await fixture.get('/admin/api/requests?limit=500&offset=0');
    if ((body?.page?.total ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`the request log never reached ${count} records`);
}

test('portal/state reports admission, fleet and per-model window activity', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.chat({ messages: [{ role: 'user', content: 'hello router' }] });
    await fixture.chat({ messages: [{ role: 'user', content: 'stream please' }], stream: true });
    await untilRequests(fixture, 2);

    const { status, body } = await fixture.get('/admin/api/portal/state?window=1h');
    assert.equal(status, 200);
    assert.equal(body.schema, 2);
    assert.equal(body.window.resolved, '1h');
    assert.equal(body.state.admission, 'accepting');
    assert.equal(body.state.listeners.admin.port, fixture.config.adminPort);
    assert.equal(body.state.listeners.admin.authRequired, false);
    assert.equal(body.state.retention.requestHistoryLimit, 100);
    assert.ok(body.state.inFlight.active <= 2);
    assert.ok(Array.isArray(body.models) && body.models.length >= 1);
    // The selectable id is the alias the router publishes; the request log names
    // the backend's own model. The window statistics have to follow the request
    // to the entry a client actually selects, or a busy model reads as idle.
    const model = body.models.find((entry) => entry.id === 'local-active' || entry.id === 'active:model');
    assert.equal(model.window.requests, 2, 'the window count for the served model');
    assert.ok(model.window.tokensOut >= 5);
    assert.equal(model.window.successRate, 100);
    assert.ok(model.context_window >= 8192);
    // Retention advisories are how the dashboard explains an em dash.
    assert.ok(body.warnings.some((warning) => warning.code === 'PROMPT_LOGGING_METADATA'));
    assert.ok(body.stats.series.buckets.length > 0);
    assert.equal(body.stats.totals.requests, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('requests page, filter and normalize; the raw view keeps the stored shape', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.chat({ messages: [{ role: 'user', content: 'one' }] });
    await fixture.chat({ messages: [{ role: 'user', content: 'two' }], stream: true }, { client: 'other-client' });
    await untilRequests(fixture, 2);

    const paged = await fixture.get('/admin/api/requests?limit=1&offset=0');
    assert.equal(paged.status, 200);
    assert.equal(paged.body.requests.length, 1);
    assert.equal(paged.body.page.total, 2);
    assert.equal(paged.body.page.hasMore, true);
    const record = paged.body.requests[0];
    assert.equal(record.schema, 2);
    assert.equal(record.protocol, 'ollama-chat');
    assert.equal(record.kind, 'prompt');
    assert.equal(record.outcome, 'success');
    assert.equal(record.client.name, 'other-client');
    assert.ok(record.tsEpochMs > 0);
    assert.equal(typeof record.tokens.output, 'number');
    assert.equal(Object.hasOwn(record, 'upstreamUrl'), true);
    // A record is never silently missing a decision the router made.
    assert.equal(Object.hasOwn(record.sampling, 'keepAlive'), true);
    assert.equal(Object.hasOwn(record.journal, 'state'), true);

    const byClient = await fixture.get('/admin/api/requests?client=other-client');
    assert.equal(byClient.body.page.total, 1);
    const byOutcome = await fixture.get('/admin/api/requests?outcome=cancelled');
    assert.equal(byOutcome.body.page.total, 0);
    const byModel = await fixture.get('/admin/api/requests?model=active:model');
    assert.equal(byModel.body.page.total, 2);

    const legacy = await fixture.get('/admin/api/requests?limit=1');
    assert.equal(legacy.body.requests.length, 1);
    const raw = await fixture.get('/admin/api/requests?limit=1&raw=1');
    assert.equal(Object.hasOwn(raw.body.requests[0], 'startedEpochMs'), true,
      'raw=1 is the escape hatch for consumers that read stored records');
    assert.equal(Object.hasOwn(raw.body.requests[0], 'schema'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('a rejected request is attributed as rejected and never claims a payload', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.post('/admin/api/maintenance', { enabled: true });
    const refused = await fixture.chat({ messages: [{ role: 'user', content: 'during maintenance' }] });
    assert.equal(refused.status, 503);
    await fixture.post('/admin/api/maintenance', { enabled: false });
    await untilRequests(fixture, 1);

    const { body } = await fixture.get('/admin/api/requests?limit=5');
    const record = body.requests.find((entry) => entry.outcome === 'rejected');
    assert.ok(record, 'the maintenance refusal is attributable');
    assert.equal(record.errorCode, 'MAINTENANCE_MODE');
    assert.equal(record.journal.state, 'pre_admission');
    assert.equal(record.journal.available, false);
    assert.equal(typeof record.errorBodyExcerpt, 'string');

    const missing = await fixture.get('/admin/api/requests/00000000-0000-4000-8000-000000000000');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'REQUEST_NOT_FOUND');
  } finally {
    await fixture.cleanup();
  }
});

test('an accepted request says whether its payload was archived, in words', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.chat({ messages: [{ role: 'user', content: 'no catalog, no archive' }] });
    await untilRequests(fixture, 1);
    const { body } = await fixture.get('/admin/api/requests?limit=1');
    const record = body.requests[0];
    assert.equal(record.outcome, 'success');
    // A backend serving an active-model marker never opens an archive; the
    // catalog-backed runtime in production does. The dashboard has to say which
    // of the two it is looking at rather than showing an empty payload view.
    assert.equal(record.journal.state, 'not_archived');
    assert.equal(record.journal.id, null);
    // A record written by this build says so: the absence of an archive is a
    // statement the router is entitled to make, unlike a record that predates
    // the linkage and cannot know.
    assert.equal(record.journal.note, undefined);
    const legacy = normalizeRecord({ id: 'x', ts: new Date().toISOString(), endpoint: '/api/chat', method: 'POST',
      responseStatus: 200, allowed: true, durationMs: 10 }, {});
    assert.equal(legacy.journal.state, 'not_archived');
    assert.match(legacy.journal.note, /did not record which archive/);
    // Measured on the bytes the client was given, not reported by the backend.
    assert.equal(typeof record.ttftMs, 'number');
    assert.ok(record.requestBytes > 0);
    assert.equal(record.host, 'local');
    assert.equal(record.hostSource, 'default');

    const missing = await fixture.get(`/admin/api/requests/${record.id}/journal`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'JOURNAL_NEVER_OPENED');
  } finally {
    await fixture.cleanup();
  }
});

test('stats bucket a window, keep idle minutes on the axis, and list every declared host', async () => {
  const fixture = await makeFixture();
  try {
    await fixture.chat({ messages: [{ role: 'user', content: 'count me' }] });
    await untilRequests(fixture, 1);
    const { body } = await fixture.get('/admin/api/stats?window=1h&bucket=1m');
    assert.equal(body.window.resolved, '1h');
    assert.equal(body.window.seconds, 3600);
    assert.equal(body.series.bucketSeconds, 60);
    assert.equal(body.series.kept, body.series.buckets.length);
    assert.ok(body.series.buckets.filter((bucket) => bucket.requests === 0).length > 50,
      'idle minutes are emitted so the chart axis is continuous');
    const active = body.series.buckets.filter((bucket) => bucket.requests > 0);
    assert.equal(active.length, 1);
    assert.equal(active[0].ok, 1);
    assert.equal(body.totals.requests, 1);
    assert.equal(body.totals.byStatus['200'], 1);
    assert.equal(body.byHost[0].key, 'local');
    assert.equal(body.byHost[0].requests, 1);
    assert.equal(body.byModel[0].key, 'active:model');
    assert.ok(body.byModel[0].tokensOut >= 5);
    assert.ok(body.sinceStart.requests >= 1);
    assert.ok(body.generatedAt);

    const widened = await fixture.get('/admin/api/stats?window=24h&bucket=10s');
    assert.ok(widened.body.series.bucketSeconds > 10, 'a 24 h window at 10 s intervals widens instead of returning 8640 points');
    assert.ok(widened.body.series.kept <= 600);
    const fallback = await fixture.get('/admin/api/stats?window=nonsense');
    assert.equal(fallback.body.window.resolved, '1h');
    assert.equal(fallback.body.window.requested, 'nonsense');
  } finally {
    await fixture.cleanup();
  }
});

test('the portal port serves the dashboard without a token and the API port does not', async () => {
  const fixture = await makeFixture();
  try {
    for (const pathname of ['/admin/api/portal/state', '/admin/api/requests?limit=1', '/admin/api/stats', '/admin/api/capabilities']) {
      const anonymous = await fixture.get(pathname);
      assert.equal(anonymous.status, 200, `${pathname} is readable from the portal port`);
    }
    const tokened = await fixture.get('/admin/api/requests?limit=1', { port: fixture.apiPort, token: 'secret-token' });
    assert.equal(tokened.status, 200);
    const anonymousApi = await fixture.get('/admin/api/requests?limit=1', { port: fixture.apiPort });
    assert.equal(anonymousApi.status, 401);
    const runtime = await fixture.get('/admin/api/runtime-state', { port: fixture.apiPort });
    assert.equal(runtime.status, 401, 'the API port keeps demanding the token for runtime control');
    const portalRuntime = await fixture.get('/admin/api/runtime-state');
    assert.equal(portalRuntime.status, 200, 'the portal can read runtime state, which is how its drain buttons work');
    const capabilities = await fixture.get('/admin/api/capabilities');
    assert.ok(capabilities.body.revision, 'the same capability document as the API port, same-origin');
    const events = await fixture.get('/admin/api/events?limit=1&type=maintenance_mode_changed');
    assert.ok(events.body.events.every((event) => event.type === 'maintenance_mode_changed'));
  } finally {
    await fixture.cleanup();
  }
});

test('the portal stream announces itself, then carries persisted requests', async () => {
  const fixture = await makeFixture();
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.adminPort}/admin/api/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readFrame = async () => {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
      const frame = buffer.slice(0, buffer.indexOf('\n\n'));
      buffer = buffer.slice(buffer.indexOf('\n\n') + 2);
      return frame;
    };

    // Frames that carry no event name (the `retry:` directive) are skipped the
    // same way EventSource skips them.
    let hello = await readFrame();
    while (hello !== null && !hello.includes('event:')) hello = await readFrame();
    assert.match(hello, /event: hello/);
    assert.match(hello, /"schema":2/);

    await fixture.chat({ messages: [{ role: 'user', content: 'stream me to the dashboard' }], stream: true });
    for (let frame = await readFrame(); frame !== null; frame = await readFrame()) {
      if (frame.includes('event: request')) {
        const payload = JSON.parse(frame.slice(frame.indexOf('data: ') + 6));
        assert.equal(payload.protocol, 'ollama-chat');
        assert.equal(payload.outcome, 'success');
        break;
      }
    }
    assert.ok(true);
  } finally {
    controller.abort();
    await fixture.cleanup();
  }
});

test('a payload written a moment ago is not labelled from a stale listing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-ensure-'));
  await fs.mkdir(path.join(dir, 'generations'));
  const present = randomUUID();
  await fs.writeFile(path.join(dir, 'generations', `${present}.jsonl`), '{}\n', 'utf8');
  // A listing taken before the file existed, still being served from cache.
  const context = { journals: new Set(), journalsAt: Number.MAX_SAFE_INTEGER, config: { dataDir: dir } };
  const gone = randomUUID();
  const set = await ensureJournals(context, [present, gone, present, null]);
  assert.equal(set.has(present), true, 'the file is there; the listing was just behind it');
  assert.equal(set.has(gone), false, 'and one that is genuinely gone still reads as gone');
  await fs.rm(dir, { recursive: true, force: true });
});
