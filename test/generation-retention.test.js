import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { generationRetention } from '../src/generation-retention.js';
import { openGenerationJournal } from '../src/generation-session.js';

const DAY = 86400000;

async function fixture(t, env = {}, start = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-retention-'));
  const config = loadConfig({ DATA_DIR: dir, ...env });
  const retention = generationRetention(config);
  const directory = path.join(dir, 'generations');
  await fs.mkdir(directory);
  const journals = [];
  t.after(async () => {
    for (const journal of journals) await journal.close();
    retention.stop();
    await retention.pending;
    await fs.rm(dir, { recursive: true, force: true });
  });
  if (start) await retention.start();
  const write = async (bytes, ageDays = 0, name = `${randomUUID()}.jsonl`) => {
    const file = path.join(directory, name);
    await fs.writeFile(file, 'x'.repeat(bytes));
    const time = new Date(Date.now() - ageDays * DAY);
    await fs.utimes(file, time, time);
    return file;
  };
  const open = async (request = { messages: [{ role: 'user', content: 'retained in full' }] }) => {
    const journal = await openGenerationJournal(config, request);
    journals.push(journal);
    return journal;
  };
  return { dir, directory, config, retention, write, open };
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

test('startup removes expired files including interrupted journals, retaining recent complete contents', async (t) => {
  const f = await fixture(t, {}, false);
  const expired = await f.write(100, 8);
  const interrupted = await f.write(50, 9);
  const recent = await f.write(200, 1);
  await f.retention.start();
  assert.equal(await exists(expired), false);
  assert.equal(await exists(interrupted), false);
  assert.equal(await fs.readFile(recent, 'utf8'), 'x'.repeat(200));
  assert.equal(f.retention.snapshot().closedBytes, 200);
  assert.equal(f.retention.snapshot().lastError, null);
});

test('size eviction removes oldest closed journals until within budget', async (t) => {
  const f = await fixture(t, { GENERATION_MAX_BYTES: '250' });
  const oldest = await f.write(100, 3);
  const middle = await f.write(100, 2);
  const newest = await f.write(200, 1);
  await f.retention.sweep();
  assert.equal(await exists(oldest), false);
  assert.equal(await exists(middle), false);
  assert.equal(await exists(newest), true);
  assert.equal(f.retention.snapshot().closedBytes, 200);
  assert.equal(f.retention.snapshot().closedFiles, 1);
});

test('age expiration still applies below budget and a single oversized closed journal is evicted', async (t) => {
  const f = await fixture(t, { GENERATION_MAX_BYTES: '250' });
  const expired = await f.write(1, 8);
  const oversized = await f.write(251);
  await f.retention.sweep();
  assert.equal(await exists(expired), false);
  assert.equal(await exists(oversized), false);
  assert.equal(f.retention.snapshot().closedBytes, 0);
});

test('active journals exceed age and byte budgets safely, and close triggers cleanup', async (t) => {
  const f = await fixture(t, { GENERATION_MAX_BYTES: '50' });
  const journal = await f.open();
  const file = path.join(f.directory, journal.id + '.jsonl');
  const old = new Date(Date.now() - 8 * DAY);
  await fs.utimes(file, old, old);
  await f.retention.sweep();
  assert.equal(await exists(file), true);
  assert.equal(f.retention.snapshot().activeFiles, 1);
  assert.equal(f.retention.snapshot().closedBytes, 0);
  await journal.append({ type: 'backend_event', content: 'complete untruncated output'.repeat(100) });
  assert.match(await fs.readFile(file, 'utf8'), /complete untruncated output/);
  await Promise.all([journal.close(), journal.close()]);
  assert.equal(await exists(file), false);
  assert.equal(f.retention.snapshot().activeFiles, 0);
});

test('journal is registered before creation even when a concurrent sweep runs during open', async (t) => {
  const f = await fixture(t, { GENERATION_MAX_BYTES: '1' });
  const open = fs.open.bind(fs);
  let release, entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (String(file).startsWith(f.directory)) {
      assert.equal(f.retention.snapshot().activeFiles, 1);
      await handle.writeFile('x'.repeat(20));
      entered(file);
      await blocked;
    }
    return handle;
  });
  const pending = f.open();
  const file = await waiting;
  await f.retention.sweep();
  assert.equal(await exists(file), true);
  release();
  const journal = await pending;
  await journal.close();
  assert.equal(await exists(file), false);
});

test('cleanup ignores unrelated files, directories and symlinks', async (t) => {
  const f = await fixture(t, { GENERATION_MAX_BYTES: '1' });
  const unrelated = await f.write(100, 10, 'notes.jsonl');
  const directory = path.join(f.directory, randomUUID() + '.jsonl');
  await fs.mkdir(directory);
  const link = path.join(f.directory, randomUUID() + '.jsonl');
  await fs.symlink(unrelated, link);
  await f.retention.sweep();
  assert.equal(await exists(unrelated), true);
  assert.equal(await exists(directory), true);
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  assert.equal(f.retention.snapshot().closedBytes, 0);
});

test('deletion failures are reported, preserve successful journal closure, and are retried', async (t) => {
  const f = await fixture(t, { GENERATION_MAX_BYTES: '1' });
  const journal = await f.open();
  const file = path.join(f.directory, journal.id + '.jsonl');
  const unlink = fs.unlink.bind(fs);
  const mocked = t.mock.method(fs, 'unlink', async (target) => {
    if (target === file) throw Object.assign(new Error('test permission denied'), { code: 'EACCES' });
    return unlink(target);
  });
  const errors = t.mock.method(console, 'error', () => {});
  await journal.close();
  assert.equal(journal.closed, true);
  assert.equal(await exists(file), true);
  assert.equal(f.retention.snapshot().lastError.code, 'EACCES');
  assert.equal(errors.mock.callCount(), 1);
  mocked.mock.restore();
  await f.retention.sweep();
  assert.equal(await exists(file), false);
  assert.equal(f.retention.snapshot().lastError, null);
});

test('idle timer expires journals without incoming requests and stops with the last owner', async (t) => {
  let tick;
  const timer = { unref() {} };
  t.mock.method(globalThis, 'setInterval', (callback, interval) => {
    assert.equal(interval, 300000);
    tick = callback;
    return timer;
  });
  const cleared = t.mock.method(globalThis, 'clearInterval', () => {});
  const f = await fixture(t);
  const file = await f.write(100, 8);
  tick();
  await f.retention.pending;
  assert.equal(await exists(file), false);
  await f.retention.start();
  f.retention.stop();
  assert.equal(cleared.mock.callCount(), 0);
  f.retention.stop();
  assert.equal(cleared.mock.callCount(), 1);
});

test('configuration clones share active protection and overlapping sweeps never overlap deletion', async (t) => {
  const f = await fixture(t, { GENERATION_MAX_BYTES: '1' });
  const clone = generationRetention({ ...f.config, dataDir: path.join(f.dir, '.') });
  assert.equal(clone, f.retention);
  await f.write(100);
  const unlink = fs.unlink.bind(fs);
  let deleting = false;
  t.mock.method(fs, 'unlink', async (...args) => {
    assert.equal(deleting, false);
    deleting = true;
    try { return await unlink(...args); }
    finally { deleting = false; }
  });
  await Promise.all(Array.from({ length: 10 }, () => clone.sweep()));
  assert.equal(f.retention.snapshot().closedFiles, 0);
});

test('failed journal creation releases protection and a later journal remains usable', async (t) => {
  const f = await fixture(t);
  const open = fs.open.bind(fs);
  const mocked = t.mock.method(fs, 'open', async (file, ...args) => {
    if (String(file).startsWith(f.directory)) throw Object.assign(new Error('test open failure'), { code: 'EIO' });
    return open(file, ...args);
  });
  await assert.rejects(f.open(), { code: 'EIO' });
  assert.equal(f.retention.snapshot().activeFiles, 0);
  mocked.mock.restore();
  const journal = await f.open();
  await journal.close();
  assert.equal(f.retention.snapshot().closedFiles, 1);
});
