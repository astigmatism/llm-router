import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRouterServer } from '../src/server.js';
import { RequestGate } from '../src/request-gate.js';
import { hostCatalogFile } from '../src/catalog-source.js';

const template = JSON.parse(await fs.readFile(new URL('../runtime/primary-model-catalog.json', import.meta.url)));
const CODING = template.models[0].model;
const NIGHT = template.models[1].model;
const NATIVE_CONTEXT = 262144;
const PARAMETERS = 27_300_000_000;
const SIZE_BYTES = 28_600_000_000;
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

// One fake backend per published model, answering the small set of routes a
// resident model needs: health, props, slots, template, tokenize, completions.
// `hits` records what the machine was actually asked, which is how these tests
// tell which machine a request landed on.
async function fakeBackend(model, t, hits, slots = 1) {
  const state = { healthy: true };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    hits.push({ model, url: req.url, body });
    if (req.url === '/health') return json(res, state.healthy ? 200 : 503, { status: state.healthy ? 'ok' : 'unavailable' });
    if (req.url === '/props') return json(res, 200, { default_generation_settings: { params: { n_predict: -1 } }, modalities: { vision: true }, build_info: 'b1-test' });
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: model, meta: { n_ctx_train: NATIVE_CONTEXT, n_params: PARAMETERS, size: SIZE_BYTES } }] });
    if (req.url === '/slots') return json(res, 200, Array.from({ length: slots }, () => ({ n_ctx: 262144, is_processing: false })));
    if (req.url === '/apply-template') return json(res, 200, { prompt: JSON.stringify(body) });
    if (req.url === '/tokenize') return json(res, 200, { tokens: new Array(20).fill(1) });
    if (req.url === '/v1/chat/completions') {
      if (body?.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      return json(res, 200, {
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 }
      });
    }
    json(res, 404, {});
  });
  const url = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url, state };
}

function catalogEntry(model, aliases) {
  const entry = structuredClone(template.models.find((candidate) => candidate.model === model));
  entry.aliases = aliases;
  entry.runtime_output_policy = {
    verification: 'docker-inspect-argv',
    n_predict: -1,
    reasoning_budget: -1,
    reasoning_effort: 'default',
    container_id: `fake-${model}`
  };
  return entry;
}

// One host's published catalog: the entries that machine runs, plus the root
// projection the marker contract has always required.
function hostCatalog(entries) {
  const catalog = { schema_version: 3, default_model: entries[0].model, models: entries };
  return Object.assign(catalog, { ...entries[0], models: entries });
}

async function fixture(t, { env = {}, local = [CODING], secondHost = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-multi-host-'));
  const hits = [];
  const backends = new Map();
  const marker = structuredClone(template);
  marker.models = await Promise.all(local.map(async (model) => {
    const entry = catalogEntry(model, model === CODING ? ['local-active', 'daytime'] : ['nighttime']);
    entry.backend_url = (await fakeBackend(model, t, hits, entry.max_active_requests)).url;
    backends.set(model, entry.backend_url);
    return entry;
  }));
  marker.configuration = { id: 'multi-host-test', exclusive: local.length === 1 && secondHost === null, runtime_revision: 'abcd123', published_at: '2026-10-20T02:13:27.000Z' };
  marker.offline_services = [];
  if (local.length === 1 && secondHost === null) {
    // A machine with one GPU stops the other service only while nothing else in
    // the deployment runs it; a host that is expected to publish it keeps the
    // name free.
    Object.assign(marker.models[0], { exclusive: true });
    marker.offline_services = [{ model: local[0] === CODING ? NIGHT : CODING, aliases: ['nighttime'], display_name: 'Nighttime', reason: 'exclusive_configuration' }];
  }
  Object.assign(marker, { ...marker.models[0], models: marker.models });
  const file = path.join(root, 'active-model.json');
  await fs.writeFile(file, JSON.stringify(marker));

  const config = loadConfig({
    DATA_DIR: path.join(root, 'data'),
    ACTIVE_MODEL_FILE: file,
    ROUTER_CONTROL_FILE: path.join(root, 'control.json'),
    ADMIN_TOKEN: 'test',
    ADMIN_ENABLED: 'false',
    GPU_TELEMETRY_ENABLED: 'false',
    REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true',
    UNSUPPORTED_TOOLS_POLICY: 'drop',
    ROUTER_MODEL_METADATA_TTL_MS: '0',
    ...(secondHost === null ? {} : { ROUTER_HOSTS: `local,${secondHost}`, ROUTER_DEFAULT_HOST: 'local', CATALOG_PUSH_TOKEN: 'push-secret' }),
    ...env
  });
  const router = await createRouterServer(config);
  const base = await listen(router.server);
  t.after(async () => {
    router.server.closeAllConnections();
    await new Promise((resolve) => router.server.close(resolve));
    await router.waitForIdle();
    await fs.rm(root, { recursive: true, force: true });
  });
  const publish = (host, payload, { token = 'push-secret', method = 'PUT' } = {}) => fetch(`${base}/admin/api/hosts/${host}/catalog`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
  const admin = (route, body = {}, headers = {}) => fetch(base + '/admin/api/' + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'test', ...headers },
    body: JSON.stringify(body)
  });
  const get = async (route) => (await fetch(base + route)).json();
  const chat = (model) => fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'none', max_tokens: 16, stream: false })
  });
  return { ...router, base, config, root, file, marker, hits, backends, publish, admin, get, chat };
}

test('a deployment with one host reports no hosts and no host stamps', async (t) => {
  const f = await fixture(t);
  const health = await f.get('/health');
  assert.equal(health.ok, true);
  assert.equal(health.hosts, undefined);
  assert.equal(health.degraded, undefined);
  const models = await f.get('/v1/models');
  assert.ok(models.data.some((model) => model.id === CODING));
  const capabilities = await f.get('/v1/router/capabilities');
  assert.equal(capabilities.hosts, undefined);
  assert.equal(capabilities.models[0].host, undefined);
  assert.equal((await f.chat(CODING)).status, 200);
});

test('runtime control describes the pushed default host without a local marker', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina', env: {
    ROUTER_HOSTS: 'rosalina', ROUTER_DEFAULT_HOST: 'rosalina'
  } });
  await fs.rm(f.file);
  const backend = await fakeBackend(CODING, t, f.hits, catalogEntry(CODING, []).max_active_requests);
  const catalog = hostCatalog([{ ...catalogEntry(CODING, ['local-active', 'daytime']), backend_url: backend.url }]);
  catalog.configuration = { id: 'remote-runtime-configuration', exclusive: true };
  assert.equal((await f.publish('rosalina', catalog)).status, 200);
  const response = await fetch(f.base + '/admin/api/runtime-state', { headers: { 'x-admin-token': 'test' } });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.active_model.model, CODING);
  assert.equal(state.active_model.profile, catalog.profile);
  assert.equal(state.runtime.model, CODING);
  assert.equal(state.backend.health.ok, true);
  assert.equal((await f.get('/admin/api/hosts')).hosts[0].configuration.id, catalog.configuration.id);
  const drained = await (await f.admin('runtime-drain', { enabled: true, host: 'rosalina', reason: 'test migration' })).json();
  assert.equal(drained.runtime.model, CODING);
  assert.deepEqual(drained.runtime.draining_hosts, ['rosalina']);
  assert.equal((await f.chat('daytime')).status, 503);
  await f.admin('runtime-drain', { enabled: false, host: 'rosalina' });
  assert.equal((await f.chat('daytime')).status, 200);
});

test('a published host joins the deployment and serves its own models', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina' });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  const published = await f.publish('rosalina', hostCatalog([catalogEntry(NIGHT, ['local-active', 'nighttime'])].map((entry) => ({ ...entry, backend_url: backend.url }))));
  assert.equal(published.status, 200);
  const receipt = await published.json();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.host, 'rosalina');
  assert.deepEqual(receipt.models.map((model) => model.model), [NIGHT]);
  assert.equal(receipt.warnings.length, 0);
  const roster = await f.get('/admin/api/hosts');
  assert.equal(roster.hosts.find((host) => host.id === 'rosalina').revision, receipt.revision,
    'the publication receipt hashes the same saved bytes that later readers observe');

  const models = await f.get('/v1/models');
  const ids = models.data.map((model) => model.id);
  // Both machines' canonical IDs are selectable; alias rows stay alias rows.
  assert.deepEqual(ids.filter((id) => id === CODING || id === NIGHT).sort(), [CODING, NIGHT].sort());
  assert.equal(new Set(ids).size, ids.length, 'no name is published twice');

  const response = await f.chat(NIGHT);
  assert.equal(response.status, 200);
  assert.ok(f.hits.some((hit) => hit.url === '/v1/chat/completions' && hit.model === NIGHT), 'the request reached the publishing machine');
  assert.ok(!f.hits.some((hit) => hit.url === '/v1/chat/completions' && hit.model === CODING), 'and not the local one');

  const capabilities = await f.get('/v1/router/capabilities');
  assert.equal(capabilities.schema_version, 2);
  const hosts = Object.fromEntries(capabilities.hosts.map((host) => [host.id, host]));
  assert.equal(hosts.local.default, true);
  assert.equal(hosts.rosalina.default, false);
  assert.equal(hosts.rosalina.available, true);
  assert.deepEqual(hosts.rosalina.model_ids, [NIGHT]);
  assert.equal(capabilities.models.find((model) => model.id === NIGHT).host, 'rosalina');
  assert.equal(capabilities.models.find((model) => model.id === CODING).host, 'local');

  const health = await f.get('/health');
  assert.equal(health.ok, true);
  assert.equal(health.hosts.length, 2);
  assert.equal(health.hosts.find((host) => host.id === 'rosalina').default, false);
});

// Two machines may describe the model they run in the same words. That is only
// the router's business once a client has to pick one of them by name, which is
// exactly what a model picker does: it renders one option per service and finds
// the option again by its label.
test('a two-machine roster tells two rows of one title apart', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina' });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  const TITLE = 'Daytime (160K)';
  const catalog = Object.assign(
    hostCatalog([Object.assign(catalogEntry(NIGHT, ['local-active', 'nighttime']), { backend_url: backend.url, display_name: TITLE })]),
    { host: { id: 'rosalina', display_name: 'Rosalina' } });
  assert.equal((await f.publish('rosalina', catalog)).status, 200);

  const capabilities = await f.get('/v1/router/capabilities');
  assert.equal(capabilities.schema_version, 2);
  const rows = Object.fromEntries(capabilities.models.map((model) => [model.id, model]));
  assert.deepEqual([rows[CODING].display_name, rows[NIGHT].display_name], [TITLE, TITLE],
    'a published title is never rewritten, whatever else the deployment holds');
  // Each row is still selectable by one exact label: the machine it runs on,
  // named the way that machine published itself and by its ID when it did not.
  assert.equal(rows[CODING].display_name_qualified, `${TITLE} (local)`);
  assert.equal(rows[NIGHT].display_name_qualified, `${TITLE} (Rosalina)`);
  const qualified = capabilities.models.map((model) => model.display_name_qualified);
  assert.equal(new Set(qualified).size, qualified.length, JSON.stringify(qualified));
  assert.deepEqual(capabilities.hosts.map((host) => [host.id, host.display_name]), [['local', 'local'], ['rosalina', 'Rosalina']]);
});

test('the default host selects the model an unnamed request answers with', async (t) => {
  const f = await fixture(t, { secondHost: 'daisy' });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  await f.publish('daisy', hostCatalog([catalogEntry(NIGHT, ['local-active', 'nighttime'])].map((entry) => ({ ...entry, backend_url: backend.url }))));
  const unnamed = await fetch(f.base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'none', max_tokens: 16, stream: false })
  });
  assert.equal(unnamed.status, 200);
  assert.ok(f.hits.some((hit) => hit.model === CODING && hit.url === '/v1/chat/completions'));
  const health = await f.get('/health');
  assert.equal(health.activeModel.model, CODING);
});

test('runtime-state names the pushed default host as what an unnamed request answers with', async (t) => {
  // A runtime reopens the door it closed only after the router tells it, over the same connection,
  // which model is now answering unnamed requests. On a router with a marker file that has always been
  // answerable; on a router whose default host published over HTTP it is answerable only if
  // runtime-state reads the published host, which is what it does now. The configuration's own name is
  // on the roster, beside the revision it accepted; `profile` stays the publisher's name for the
  // resident, because that is what it has always named.
  const f = await fixture(t, { secondHost: 'rosalina', env: { ROUTER_DEFAULT_HOST: 'rosalina', ADMIN_ENABLED: 'true' } });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  const catalog = Object.assign(
    hostCatalog([catalogEntry(NIGHT, ['local-active', 'nighttime'])].map((entry) => ({ ...entry, backend_url: backend.url }))),
    { configuration: { id: 'recovery-cache', exclusive: false } });
  assert.equal((await f.publish('rosalina', catalog)).status, 200);
  const state = await (await fetch(f.base + '/admin/api/runtime-state', { headers: { 'x-admin-token': 'test' } })).json();
  assert.equal(state.active_model.model, NIGHT);
  assert.equal(state.active_model.profile, catalog.profile,
    'the publisher\'s name for its resident travels unchanged; the router renames nothing');
  assert.equal(state.active_model.context_length, catalog.context_length);
  const roster = await f.get('/admin/api/hosts');
  assert.equal(roster.hosts.find((host) => host.id === 'rosalina').configuration.id, 'recovery-cache',
    'the configuration this machine published is named where an owner can compare it');
  const health = await f.get('/health');
  assert.equal(health.activeModel.model, NIGHT, 'health and runtime-state must not disagree');
});

test('a machine claiming a name another machine serves is refused', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina' });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  const clash = hostCatalog([catalogEntry(NIGHT, ['local-active', 'daytime'])].map((entry) => ({ ...entry, backend_url: backend.url })));
  const response = await f.publish('rosalina', clash);
  assert.equal(response.status, 409);
  const rejection = await response.json();
  assert.equal(rejection.error.code, 'CATALOG_ID_CONFLICT');
  assert.match(rejection.error.message, /daytime/);
  // Nothing half-published survives the refusal.
  assert.equal((await f.get('/admin/api/hosts')).hosts.find((host) => host.id === 'rosalina').published, false);
  assert.equal((await f.chat(NIGHT)).status, 404);
});

test('a publication is validated at the door and never half-stored', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina' });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  const good = hostCatalog([catalogEntry(NIGHT, ['local-active', 'nighttime'])].map((entry) => ({ ...entry, backend_url: backend.url })));
  const file = hostCatalogFile(f.config, 'rosalina');

  const broken = structuredClone(good);
  broken.models[0].total_context_length = 1;
  const rejected = await f.publish('rosalina', broken);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'INVALID_MODEL_CATALOG');
  await assert.rejects(() => fs.access(file), { code: 'ENOENT' });

  const notJson = await f.publish('rosalina', '{');
  assert.equal(notJson.status, 400);
  assert.equal((await notJson.json()).error.code, 'INVALID_CATALOG_BODY');

  const bare = await f.publish('rosalina', { schema_version: 3, model: NIGHT });
  assert.equal(bare.status, 400);
  assert.equal((await bare.json()).error.code, 'HOST_CATALOG_INCOMPATIBLE');

  assert.equal((await f.publish('rosalina', good)).status, 200);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).default_model, NIGHT);
});

test('publication needs the publisher token and a declared host', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina' });
  const catalog = hostCatalog([catalogEntry(NIGHT, ['local-active', 'nighttime'])]);
  assert.equal(((await f.publish('rosalina', catalog, { token: null })).status), 401);
  assert.equal((await f.publish('rosalina', catalog, { token: 'wrong' })).status, 401);
  assert.equal((await f.publish('nosuchhost', catalog)).status, 404);
  const localPush = await f.publish('local', catalog);
  assert.equal(localPush.status, 400);
  assert.equal((await localPush.json()).error.code, 'LOCAL_HOST_IS_FILE_BACKED');
  // The admin token also publishes, for a router configured with one credential.
  const withAdmin = await fetch(`${f.base}/admin/api/hosts/rosalina/catalog`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(catalog)
  });
  assert.equal(withAdmin.status, 200);
});

test('publication is refused outright when no credential exists', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina', env: { CATALOG_PUSH_TOKEN: '', ADMIN_TOKEN: '' } });
  const response = await f.publish('rosalina', hostCatalog([catalogEntry(NIGHT, ['nighttime'])]), { token: 'anything' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'CATALOG_PUSH_UNAVAILABLE');
});

test('a machine that stops publishing leaves the deployment and its models go away', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina' });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  await f.publish('rosalina', hostCatalog([catalogEntry(NIGHT, ['local-active', 'nighttime'])].map((entry) => ({ ...entry, backend_url: backend.url }))));
  assert.equal((await f.chat(NIGHT)).status, 200);
  const retired = await fetch(`${f.base}/admin/api/hosts/rosalina/catalog`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer push-secret' }
  });
  assert.equal(retired.status, 200);
  assert.equal((await retired.json()).removed, true);
  assert.equal((await f.chat(NIGHT)).status, 404);
  const hosts = await f.get('/admin/api/hosts');
  assert.equal(hosts.hosts.find((host) => host.id === 'rosalina').published, false);
  assert.equal(hosts.hosts.find((host) => host.id === 'local').published, true);
});

test('one machine with an unusable catalog leaves the others serving', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina' });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  await f.publish('rosalina', hostCatalog([catalogEntry(NIGHT, ['local-active', 'nighttime'])].map((entry) => ({ ...entry, backend_url: backend.url }))));
  await fs.writeFile(hostCatalogFile(f.config, 'rosalina'), '{ this is not json');

  assert.equal((await f.chat(CODING)).status, 200, 'the healthy machine keeps serving');
  assert.equal((await f.chat(NIGHT)).status, 404);
  const hosts = await f.get('/admin/api/hosts');
  const broken = hosts.hosts.find((host) => host.id === 'rosalina');
  assert.equal(broken.published, false);
  assert.equal(broken.error.code, 'HOST_CATALOG_INVALID');
  const health = await f.get('/health');
  assert.equal(health.ok, true, 'the container stays healthy for the machines that work');
  assert.equal(health.degraded, true);
  assert.equal(health.hosts.find((host) => host.id === 'rosalina').published, false);
});

test('maintenance on one machine stops its traffic and leaves the rest serving', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina' });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  await f.publish('rosalina', hostCatalog([catalogEntry(NIGHT, ['local-active', 'nighttime'])].map((entry) => ({ ...entry, backend_url: backend.url }))));

  const drained = await f.admin('runtime-drain', { enabled: true, host: 'rosalina', reason: 'gpu maintenance' });
  assert.equal(drained.status, 200);
  assert.equal((await drained.json()).drain.draining, true);

  const blocked = await f.chat(NIGHT);
  assert.equal(blocked.status, 503);
  const rejection = await blocked.json();
  assert.equal(rejection.error.code, 'BACKEND_DRAINING');
  assert.match(rejection.error.message, /rosalina/);
  assert.match(rejection.error.message, /gpu maintenance/);
  assert.equal((await f.chat(CODING)).status, 200);

  const capabilities = await f.get('/v1/router/capabilities');
  const hosts = Object.fromEntries(capabilities.hosts.map((host) => [host.id, host]));
  assert.equal(hosts.rosalina.draining, true);
  assert.equal(hosts.rosalina.available, false);
  assert.equal(capabilities.models.find((model) => model.id === NIGHT).available, false);
  assert.equal(capabilities.models.find((model) => model.id === CODING).available, true);
  assert.equal(capabilities.router.accepting_requests, true, 'the router itself still accepts work');

  const health = await f.get('/health');
  assert.equal(health.ok, true);
  assert.equal(health.degraded, true);
  assert.equal(health.hosts.find((host) => host.id === 'rosalina').draining, true);

  // The whole-router switch keeps its old meaning: everything stops.
  await f.admin('runtime-drain', { enabled: true, reason: 'router release' });
  assert.equal((await f.chat(CODING)).status, 503);
  // Releasing the router does not release a machine somebody else drained; both
  // are then lifted and the deployment serves again.
  await f.admin('runtime-drain', { enabled: false });
  assert.equal((await f.chat(CODING)).status, 200);
  assert.equal((await f.chat(NIGHT)).status, 503, 'rosalina is still in its own maintenance window');
  await f.admin('runtime-drain', { enabled: false, host: 'rosalina' });
  assert.equal((await f.chat(NIGHT)).status, 200);
  assert.equal((await f.chat(CODING)).status, 200);

  // A host an operator never declared cannot be drained.
  assert.equal((await f.admin('runtime-drain', { enabled: true, host: 'daisy' })).status, 400);
});

test('a drain for one machine survives a restart and waits for that machine only', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina' });
  await f.admin('runtime-drain', { enabled: true, host: 'rosalina', reason: 'maintenance' });
  const stored = JSON.parse(await fs.readFile(path.join(f.root, 'control.json'), 'utf8'));
  assert.equal(stored.schema_version, 2);
  assert.equal(stored.draining, false);
  assert.equal(stored.hosts.rosalina.draining, true);
  assert.equal(stored.hosts.rosalina.reason, 'maintenance');

  const reopened = new RequestGate(path.join(f.root, 'control.json'));
  await reopened.init();
  assert.equal(reopened.isDraining('rosalina'), true);
  assert.equal(reopened.isDraining('local'), false);
  assert.equal(reopened.draining, false);
  assert.equal(await reopened.waitForIdle(50, 'rosalina'), true, 'nothing was running there');

  const lease = await reopened.acquire({ endpoint: '/v1/chat/completions', host: 'local' });
  assert.equal(await reopened.waitForIdle(50, 'rosalina'), true, 'another machine does not hold a maintenance window open');
  let stillBusy = false;
  const waiting = reopened.waitForIdle(60, 'local').then((value) => { stillBusy = value; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await lease.release();
  await waiting;
  assert.equal(stillBusy, true);
});

test('a stale publication is reported without being withheld', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina', env: { CATALOG_MAX_AGE_MS: '60000' } });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  await f.publish('rosalina', hostCatalog([catalogEntry(NIGHT, ['local-active', 'nighttime'])].map((entry) => ({ ...entry, backend_url: backend.url }))));
  const file = hostCatalogFile(f.config, 'rosalina');
  const old = new Date(Date.now() - 3600_000);
  await fs.utimes(file, old, old);
  const capabilities = await f.get('/v1/router/capabilities');
  assert.ok(capabilities.warnings.includes('CATALOG_STALE:rosalina'), capabilities.warnings.join(', '));
  assert.equal((await f.chat(NIGHT)).status, 200, 'a stale catalog still serves until something newer arrives');
});

test('a loopback backend from another machine is reported as unroutable', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina', env: { ROUTER_EXPECT_ROUTABLE_BACKEND_URLS: 'true' } });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  const entry = { ...catalogEntry(NIGHT, ['local-active', 'nighttime']), backend_url: 'http://127.0.0.1:18080' };
  const response = await f.publish('rosalina', hostCatalog([entry]));
  assert.equal(response.status, 200, 'the publisher owns the claim about where its service is reachable from');
  assert.deepEqual((await response.json()).warnings, ['BACKEND_URL_NOT_ROUTABLE:rosalina:127.0.0.1']);
  void backend;
});

test('a model on another machine is served by that machine and never by the default', async (t) => {
  const f = await fixture(t, { local: [CODING, NIGHT] });
  assert.equal((await f.chat(NIGHT)).status, 200);
  assert.ok(f.hits.some((hit) => hit.model === NIGHT && hit.url === '/v1/chat/completions'));
  const health = await f.get('/health');
  assert.equal(health.activeModel.model, CODING, 'the default host still answers the unnamed request');
});

test('an accepted publication is announced to consumers and to the operator log', async (t) => {
  const f = await fixture(t, { secondHost: 'rosalina' });
  const backend = await fakeBackend(NIGHT, t, f.hits, catalogEntry(NIGHT, []).max_active_requests);
  const catalog = hostCatalog([catalogEntry(NIGHT, ['nighttime'])].map((entry) => ({ ...entry, backend_url: backend.url })));

  const capabilities = async () => {
    const response = await fetch(`${f.base}/v1/router/capabilities`);
    return { revision: response.headers.get('etag'), document: await response.json() };
  };
  const settle = async (predicate) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = await capabilities();
      if (predicate(current.document)) return current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('the capabilities document never reflected the change');
  };

  const before = (await capabilities()).document;
  assert.equal(before.hosts.find((host) => host.id === 'rosalina').published, false);
  const revisionBefore = (await capabilities()).revision;

  // A consumer that only ever reads the document sees the new state, and so does
  // one subscribed to the event stream: both follow the same revision.
  assert.equal((await f.publish('rosalina', catalog)).status, 200);
  const after = await settle((document) => document.hosts.find((host) => host.id === 'rosalina').published);
  assert.notEqual(after.revision, revisionBefore);
  assert.equal(after.document.models.find((entry) => entry.id === NIGHT).host, 'rosalina');
  assert.equal(after.document.hosts.find((host) => host.id === 'rosalina').available, true);

  // The operator sees which machine handed over what.
  const events = await (await fetch(`${f.base}/admin/api/events?limit=10`, { headers: { 'x-admin-token': 'test' } })).json();
  const event = events.events.find((entry) => entry.type === 'model_catalog_published');
  assert.ok(event, 'the publication is recorded');
  assert.equal(event.host, 'rosalina');
  assert.deepEqual(event.models, [NIGHT]);

  // Retirement announces itself the same way.
  assert.equal((await f.publish('rosalina', null, { method: 'DELETE' })).status, 200);
  const retired = await settle((document) => !document.models.some((entry) => entry.id === NIGHT));
  assert.notEqual(retired.revision, after.revision);
});
