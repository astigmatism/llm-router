import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RequestGate, RequestGateError } from '../src/request-gate.js';

test('request gate persists drain state and releases leases exactly once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-gate-test-'));
  const controlFile = path.join(dir, 'control.json');
  try {
    const gate = new RequestGate(controlFile);
    await gate.init();
    const first = await gate.acquire({ endpoint: '/api/chat', clientIdentity: 'a', limit: 2 });
    const second = await gate.acquire({ endpoint: '/api/chat', clientIdentity: 'b', limit: 2 });
    assert.equal(gate.snapshot().active_count, 2);
    const pending = gate.acquire({ endpoint: '/api/chat', clientIdentity: 'c', limit: 2 });
    assert.equal(gate.snapshot().queued_count, 1);
    assert.equal(first.release(), true);
    assert.equal(first.release(), false);
    const third = await pending;
    assert.equal(gate.snapshot().active_count, 2);
    second.release();
    third.release();
    assert.equal(await gate.waitForIdle(50), true);

    await gate.setDraining(true, 'unit test');
    await assert.rejects(
      () => gate.acquire({ endpoint: '/api/chat', clientIdentity: 'd', limit: 2 }),
      (error) => error instanceof RequestGateError && error.statusCode === 503 && error.code === 'BACKEND_DRAINING'
    );
    const reloaded = new RequestGate(controlFile);
    await reloaded.init();
    assert.equal(reloaded.snapshot().draining, true);
    assert.equal(reloaded.snapshot().drain_reason, 'unit test');
    await reloaded.setDraining(false);
    assert.equal(reloaded.snapshot().draining, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('waitForIdle times out while a generation is still active', async () => {
  const gate = new RequestGate(null);
  const lease = await gate.acquire({ endpoint: '/v1/chat/completions' });
  assert.equal(await gate.waitForIdle(5), false);
  lease.release();
  assert.equal(await gate.waitForIdle(5), true);
});

test('FIFO queues share a backend, cancel waiting work, and drain accepted work across independent backends', async () => {
  const gate = new RequestGate(null);
  const opts = { limit: 1, backendKey: 'day', model: 'day', endpoint: '/api/chat' };
  const first = await gate.acquire(opts);
  const cancelled = new AbortController();
  const skip = gate.acquire({ ...opts, signal: cancelled.signal });
  const skipped = assert.rejects(skip, { name: 'AbortError' });
  const order = [];
  const second = gate.acquire(opts).then((lease) => { order.push(2); return lease; });
  const third = gate.acquire({ ...opts, endpoint: '/v1/responses' }).then((lease) => { order.push(3); return lease; });
  const night = await gate.acquire({ ...opts, backendKey: 'night', model: 'night' });
  assert.deepEqual(gate.snapshot().queued_by_model, { day: 3 });
  cancelled.abort(); await skipped;
  assert.equal(gate.snapshot().queued_count, 2);
  await gate.setDraining(true);
  await assert.rejects(gate.acquire(opts), { code: 'BACKEND_DRAINING' });
  const idle = gate.waitForIdle(1000);
  first.release();
  const secondLease = await second;
  assert.deepEqual(order, [2]);
  assert.equal(await gate.waitForIdle(5), false);
  secondLease.release();
  const thirdLease = await third;
  assert.deepEqual(order, [2, 3]);
  thirdLease.release();
  assert.equal(await gate.waitForIdle(5), false);
  night.release();
  assert.equal(await idle, true);
  assert.equal(gate.snapshot().queued_count, 0);
  await gate.setDraining(false);
  await assert.rejects(gate.acquire({ ...opts, signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(gate.snapshot().active_count, 0);
});

test('request gate notifies its observer of every admission change without letting it fail admission', async () => {
  let changes = 0;
  const gate = new RequestGate(null, { onChange: () => { changes += 1; throw new Error('observer failure'); } });
  const first = await gate.acquire({ endpoint: '/api/chat', limit: 1, backendKey: 'day', model: 'day' });
  assert.equal(changes, 1);
  const controller = new AbortController();
  const queued = gate.acquire({ endpoint: '/api/chat', limit: 1, backendKey: 'day', model: 'day', signal: controller.signal });
  assert.equal(changes, 2);
  controller.abort();
  await assert.rejects(queued);
  assert.ok(changes >= 3);
  const before = changes;
  first.release();
  assert.ok(changes > before);
  assert.equal(gate.snapshot().active_count, 0);
  assert.equal(gate.snapshot().queued_count, 0);
});
