import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { JsonlStore } from '../src/fs-store.js';

async function fixture(t, env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-history-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = loadConfig({ DATA_DIR: dir, ...env });
  const store = new JsonlStore(config);
  return { config, store, dir };
}

async function rows(file) {
  return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
}

test('default count limits bound both disk logs and memory across concurrent appends and restart', async (t) => {
  const { store, config } = await fixture(t);
  await store.init();
  await Promise.all(Array.from({ length: 700 }, (_, n) => Promise.all([
    store.appendRequest({ n }), store.appendEvent({ n, type: 'test' })
  ])));
  for (const file of [config.requestLogPath, config.eventLogPath]) {
    const records = await rows(file);
    assert.equal(records.length, 500);
    assert.deepEqual(records.map((r) => r.n), Array.from({ length: 500 }, (_, n) => n + 200));
    assert.ok((await fs.stat(file)).size <= 5242880);
  }
  const restarted = new JsonlStore(config);
  await restarted.init();
  assert.deepEqual(restarted.recentRequests(), store.recentRequests());
  assert.deepEqual(restarted.recentEvents(), store.recentEvents());
});

test('byte limits evict whole oldest records using UTF-8 byte sizes', async (t) => {
  const record = { id: 'x', ts: 'now', text: '🙂'.repeat(20) };
  const bytes = Buffer.byteLength(JSON.stringify(record) + '\n');
  const { config, store } = await fixture(t, {
    REQUEST_LOG_MAX_BYTES: String(bytes * 2), EVENT_LOG_MAX_BYTES: String(bytes * 2)
  });
  for (const file of [config.requestLogPath, config.eventLogPath]) {
    await fs.writeFile(file, ['x', 'y', 'z'].map((id) => JSON.stringify({ ...record, id }) + '\n').join(''));
  }
  await store.init();
  assert.deepEqual(store.requests.map((r) => r.id), ['y', 'z']);
  assert.deepEqual(store.events.map((r) => r.id), ['y', 'z']);
  for (const id of ['a', 'b', 'c']) {
    await store.appendRequest({ ...record, id });
    await store.appendEvent({ ...record, id });
  }
  for (const file of [config.requestLogPath, config.eventLogPath]) {
    assert.equal((await fs.stat(file)).size, bytes * 2);
    assert.deepEqual((await rows(file)).map((r) => r.id), ['b', 'c']);
  }
  const restarted = new JsonlStore(config);
  await restarted.init();
  assert.deepEqual(restarted.recentRequests().map((r) => r.id), ['c', 'b']);
});

test('startup compacts a 600 MB historical file without reading its entire contents', async (t) => {
  const { config, store } = await fixture(t);
  const handle = await fs.open(config.requestLogPath, 'w');
  const recent = Array.from({ length: 600 }, (_, id) => JSON.stringify({ id, text: 'recent' })).join('\n') + '\n';
  await handle.write(Buffer.from('\n' + recent), 0, Buffer.byteLength('\n' + recent), 600_000_000);
  await handle.close();
  let bytesRead = 0;
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (file === config.requestLogPath && args[0] === 'r') {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...args) => {
        const result = await read(...args);
        bytesRead += result.bytesRead;
        return result;
      });
    }
    return handle;
  });
  await store.init();
  assert.ok(bytesRead <= 65536, `read ${bytesRead} bytes`);
  assert.equal(store.requests.length, 500);
  assert.equal(store.requests[0].id, 100);
  assert.ok((await fs.stat(config.requestLogPath)).size < 65536);
});

test('startup skips corrupt, partial and oversized lines while preserving records across UTF-8 chunk boundaries', async (t) => {
  const { config, store } = await fixture(t, { REQUEST_LOG_MAX_BYTES: '180000' });
  const record = { id: 'large', text: '🙂é'.repeat(20000) };
  await fs.writeFile(config.requestLogPath,
    JSON.stringify({ id: 'old' }) + '\r\n' + 'bad json\n' +
    JSON.stringify({ text: 'x'.repeat(200000) }) + '\n' +
    JSON.stringify(record) + '\r\n' + '{"partial":');
  await store.init();
  assert.deepEqual(store.requests, [{ id: 'old' }, record]);
  assert.deepEqual(await rows(config.requestLogPath), store.requests);
});

test('valid final records without a newline and empty histories survive initialization', async (t) => {
  const { config, store } = await fixture(t);
  await fs.writeFile(config.requestLogPath, '{"id":1}\n{"id":2}');
  await store.init();
  assert.deepEqual(store.requests, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await rows(config.eventLogPath), []);
});

test('oversized metadata is omitted with a payload-free warning and does not evict healthy records', async (t) => {
  const { config, store } = await fixture(t, { REQUEST_LOG_MAX_BYTES: '40', EVENT_LOG_MAX_BYTES: '40' });
  const warn = t.mock.method(console, 'warn', () => {});
  await store.init();
  await store.appendRequest({ id: 1 });
  await store.appendRequest({ private: 'secret'.repeat(100) });
  await store.appendEvent({ private: 'secret'.repeat(100) });
  assert.deepEqual(await rows(config.requestLogPath), [{ id: 1 }]);
  assert.deepEqual(store.events, []);
  assert.equal(warn.mock.callCount(), 2);
  assert.ok(warn.mock.calls.every((call) => !call.arguments[0].includes('secret')));
});

test('failed replacement preserves the old valid file and subsequent appends recover', async (t) => {
  const { config, store, dir } = await fixture(t);
  await store.init();
  await store.appendRequest({ id: 1 });
  const rename = fs.rename.bind(fs);
  const mocked = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === config.requestLogPath) throw Object.assign(new Error('test disk failure'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(store.appendRequest({ id: 2 }), { code: 'EIO' });
  assert.deepEqual(await rows(config.requestLogPath), [{ id: 1 }]);
  assert.ok((await fs.readdir(dir)).every((name) => !name.endsWith('.tmp')));
  mocked.mock.restore();
  await store.appendRequest({ id: 3 });
  assert.deepEqual(await rows(config.requestLogPath), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('startup removes abandoned snapshot files without touching unrelated files or symlinks', async (t) => {
  const { config, store } = await fixture(t);
  const abandoned = `${config.requestLogPath}.${randomUUID()}.tmp`;
  const unrelated = `${config.requestLogPath}.manual.tmp`;
  const link = `${config.requestLogPath}.${randomUUID()}.tmp`;
  await fs.writeFile(abandoned, 'incomplete snapshot');
  await fs.writeFile(unrelated, 'keep');
  await fs.symlink(unrelated, link);
  await store.init();
  await assert.rejects(fs.stat(abandoned), { code: 'ENOENT' });
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('appends during a replacement are serialized and concurrent appends are batched', async (t) => {
  const { config, store } = await fixture(t, { REQUEST_HISTORY_LIMIT: '3' });
  await store.init();
  let entered, unblock;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const rename = fs.rename.bind(fs);
  let writes = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === config.requestLogPath && ++writes === 1) { entered(); await blocked; }
    return rename(from, to);
  });
  const first = store.appendRequest({ id: 1 });
  await waiting;
  const rest = [2, 3, 4].map((id) => store.appendRequest({ id }));
  assert.deepEqual(await rows(config.requestLogPath), []);
  unblock();
  await Promise.all([first, ...rest]);
  assert.equal(writes, 2);
  assert.deepEqual(await rows(config.requestLogPath), [{ id: 2 }, { id: 3 }, { id: 4 }]);
});
