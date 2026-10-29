import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import v8 from 'node:v8';
import vm from 'node:vm';
import { upstreamFetch } from '../src/upstream.js';

async function fixture(t, handler, overrides = {}) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { upstreamUrl: `http://127.0.0.1:${server.address().port}`, upstreamTimeoutMs: 5, generationStallTimeoutMs: 80, ...overrides };
}

test('healthy generation survives the old 900-second boundary under a controlled clock', async (t) => {
  let clock = 0;
  t.mock.method(Date, 'now', () => clock);
  let next;
  const config = await fixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('first');
    next = () => { clock = 900001; res.end(' naturally finished'); };
  });
  const response = await upstreamFetch(config, '/v1/chat/completions', { generation: true });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  next();
  const second = await reader.read();
  assert.equal(new TextDecoder().decode(second.value), ' naturally finished');
  assert.equal((await reader.read()).done, true);
});

test('cold prefill stays alive through changing slot progress without a total timer', async (t) => {
  let progress = 0;
  const config = await fixture(t, (req, res) => {
    if (req.url === '/slots') return res.end(JSON.stringify([{ id_task: 1, n_prompt_tokens_processed: ++progress }]));
    const timer = setTimeout(() => res.end('prefill completed'), 240);
    res.once('close', () => clearTimeout(timer));
  });
  const response = await upstreamFetch(config, '/v1/chat/completions', { generation: true, progressPath: '/slots' });
  assert.equal(await response.text(), 'prefill completed');
  assert.ok(progress > 2);
});

test('stalled body fails with TimeoutError while preserving bytes already read', async (t) => {
  const config = await fixture(t, (_, res) => { res.writeHead(200); res.write('retained fragment'); });
  const response = await upstreamFetch(config, '/api/chat', { generation: true });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'retained fragment');
  await assert.rejects(reader.read(), { name: 'TimeoutError' });
});

test('client cancellation interrupts cold prefill immediately', async (t) => {
  const config = await fixture(t, () => {});
  const controller = new AbortController();
  const pending = upstreamFetch(config, '/api/chat', { generation: true, signal: controller.signal });
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
});

// A generation that finishes normally never aborts. While the stall watchdog's
// abort listener stays attached to the composite signal, Node keeps that signal
// alive in a module-global set for the life of the process, and the listener's
// scope goes with it — the options object carrying the multi-megabyte serialized
// upstream request. The tell is marginal retention: with the leak, every extra
// completed generation adds about one request body; with the listener detached,
// a second batch adds nothing measurable. Batching twice in one process cancels
// the constant large-object floor the runtime carries anyway.
function largeObjectBytes() {
  return v8.getHeapSpaceStatistics()
    .reduce((sum, space) => sum + (/large_object/.test(space.space_name) ? space.space_used_size : 0), 0);
}

async function collectGarbage(collect) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    collect();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function completedGenerations(config, count, megabyte) {
  for (let run = 0; run < count; run += 1) {
    const response = await upstreamFetch(config, '/v1/chat/completions', {
      generation: true,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(4 * megabyte) }] }),
      signal: new AbortController().signal
    });
    assert.equal(await response.text(), 'delta completed');
  }
}

test('a completed generation releases the request body it captured', async (t) => {
  const megabyte = 1024 * 1024;
  const perBatch = 8;
  const config = await fixture(t, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('delta completed');
  }, { generationStallTimeoutMs: 120000 });
  v8.setFlagsFromString('--expose-gc');
  await new Promise((resolve) => setImmediate(resolve));
  const collect = vm.runInNewContext('gc');
  assert.equal(typeof collect, 'function', 'this test needs a controllable garbage collection');
  const baseline = largeObjectBytes();
  await completedGenerations(config, perBatch, megabyte);
  await collectGarbage(collect);
  const firstBatch = largeObjectBytes() - baseline;
  await completedGenerations(config, perBatch, megabyte);
  await collectGarbage(collect);
  const marginal = largeObjectBytes() - baseline - firstBatch;
  // A leaking batch of eight holds close to eight bodies; a repaired one holds
  // far less than one body, so the leak must be gone, not merely reduced.
  assert.ok(marginal < 4 * megabyte,
    `each completed generation still holds ${((marginal / perBatch) / megabyte).toFixed(1)} MB of its serialized request body`);
});
