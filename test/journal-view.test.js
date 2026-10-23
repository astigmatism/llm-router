import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJournalView } from '../src/journal-view.js';

// The request-detail payload view. A journal is written by the runtime, read
// once by an operator following one request, and can be tens of megabytes of
// tool schemas and past turns - so the interesting behaviour is what it shows
// and what it admits to leaving out.

async function write(lines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-journal-'));
  const id = randomUUID();
  await fs.writeFile(path.join(dir, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return { dir, id };
}

const CHAT_LINES = [
  { at: '2026-10-22T17:27:32.540Z', type: 'request', request: {
    model: 'daytime', stream: true,
    messages: [{ role: 'developer', content: 'Be terse.' }, { role: 'user', content: 'Say OK' }],
    tools: [{ type: 'function', function: { name: 'bash', description: 'Execute a bash command and return stdout.' } }],
    keep_alive: -1 } },
  { at: '2026-10-22T17:27:32.544Z', type: 'admission', inputTokens: 54, outputTokens: null, outputPolicy: 'unrestricted', availableTokens: 64458, reserve: 1024, slotContext: 65536 },
  { at: '2026-10-22T17:27:32.546Z', type: 'backend_request', body: { model: 'qwen3.8-flash-next-iq3_xxs', messages: [{ role: 'user', content: 'say OK' }], stream: true, n_predict: -1, chat_template_kwargs: { enable_thinking: true } } },
  { at: '2026-10-22T17:27:32.549Z', type: 'backend_event', event: { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } },
  { at: '2026-10-22T17:27:33.350Z', type: 'backend_event', event: { choices: [{ index: 0, delta: { content: 'O' }, finish_reason: null }] } },
  { at: '2026-10-22T17:27:33.700Z', type: 'backend_event', event: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'bash' } }] }, finish_reason: null }] } },
  { at: '2026-10-22T17:27:33.805Z', type: 'terminal', status: 'completed', finish_reason: 'stop', stop_reason: 'stop', record_id: 'ef6974ed-9ede-4a38-a7cd-52f5e46fff22', context_transitions: 0, usage: { prompt_tokens: 54, completion_tokens: 28, total_tokens: 82 } }
];

const RESPONSES_LINES = [
  { at: '2026-10-22T18:00:00.000Z', type: 'request', request: {
    model: 'daytime', stream: true,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is in this screenshot?' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(4096) }] },
      { type: 'function_call', name: 'read', arguments: '{"file_path":"a.txt"}', call_id: 'call_1' },
      { type: 'function_call_output', output: 'the file contents', call_id: 'call_1' },
      { type: 'reasoning', summary: ['Compare the two.'] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A dashboard.' }] }
    ],
    tools: [{ type: 'function', function: { name: 'read', description: 'Read a file.' } }] } },
  { at: '2026-10-22T18:00:01.000Z', type: 'terminal', status: 'completed', finish_reason: 'stop', usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }
];

test('a chat journal becomes phases, prompt text and aggregated events', async () => {
  const { dir, id } = await write(CHAT_LINES);
  const view = await readJournalView({ dir, id });
  assert.equal(view.journalId, id);
  assert.equal(view.state, 'archived');
  assert.equal(view.truncated, false);
  assert.equal(view.lines, CHAT_LINES.length);
  assert.deepEqual(view.phases.map((phase) => phase.name), ['request', 'admission', 'backend_request', 'first_event', 'terminal']);
  const offsets = view.phases.map((phase) => phase.offsetMs);
  assert.equal(offsets[0], 0);
  // First content skips the role-only delta: the client waits for content, not
  // for a header line.
  assert.equal(view.phases.find((phase) => phase.name === 'first_event').offsetMs, 810);
  assert.equal(view.phases.at(-1).offsetMs, 1265);
  assert.match(view.phases.find((phase) => phase.name === 'admission').detail, /slot_ctx=65536/);
  assert.equal(view.terminal.status, 'completed');
  assert.equal(view.terminal.usage.total_tokens, 82);

  assert.equal(view.prompt.shape, 'chat');
  assert.equal(view.prompt.itemCount, 2);
  assert.deepEqual(view.prompt.items.map((item) => [item.role, item.text]), [['developer', 'Be terse.'], ['user', 'Say OK']]);
  assert.deepEqual(view.prompt.tools, [{ name: 'bash', description: 'Execute a bash command and return stdout.' }]);
  assert.equal(view.prompt.toolsCount, 1);

  assert.equal(view.events.total, 3);
  assert.equal(view.events.byType.backend_event, 3);
  assert.ok(view.events.samples.some((sample) => sample.summary.includes('delta=content (+1 ch)')));
  assert.ok(view.events.samples.some((sample) => sample.summary.includes('tool_call(bash)')));
  assert.equal(view.backendRequest.model, 'qwen3.8-flash-next-iq3_xxs');
  assert.ok(view.rawUrl.startsWith('/admin/api/generation-record?id='));
  await fs.rm(dir, { recursive: true, force: true });
});

test('a Responses journal projects typed items and elides binary parts', async () => {
  const { dir, id } = await write(RESPONSES_LINES);
  const view = await readJournalView({ dir, id });
  assert.equal(view.prompt.shape, 'responses');
  assert.equal(view.prompt.itemCount, 6);
  const image = view.prompt.items.find((item) => item.kind === 'input_image');
  assert.equal(image.elided, true);
  assert.ok(image.bytes > 4000, 'the archived size is reported even though the bytes are not painted');
  assert.equal(view.prompt.imagesElided, 1);
  assert.ok(view.prompt.elidedBytes >= image.bytes);
  const call = view.prompt.items.find((item) => item.kind === 'function_call');
  assert.equal(call.name, 'read');
  assert.match(call.text, /a\.txt/);
  const output = view.prompt.items.find((item) => item.kind === 'function_call_output');
  assert.equal(output.role, 'tool');
  assert.equal(output.text, 'the file contents');
  assert.equal(view.prompt.items.find((item) => item.kind === 'reasoning').text, 'Compare the two.');
  await fs.rm(dir, { recursive: true, force: true });
});

test('the prompt budget truncates and says so', async () => {
  const long = 'x'.repeat(9000);
  const { dir, id } = await write([
    { at: '2026-10-22T18:00:00.000Z', type: 'request', request: { model: 'm', messages: [
      { role: 'user', content: long }, { role: 'assistant', content: 'second' }, { role: 'user', content: 'third' }] } },
    { at: '2026-10-22T18:00:00.100Z', type: 'terminal', status: 'completed' }
  ]);
  const view = await readJournalView({ dir, id, promptBytes: 1500 });
  assert.equal(view.prompt.truncated, true);
  assert.ok(view.prompt.items[0].truncated, 'the long message is cut');
  assert.ok(Buffer.byteLength(view.prompt.items[0].text) <= 1500);
  assert.ok(view.prompt.elidedBytes > 7000, 'the reader is told how much was not shown');
  assert.ok(view.prompt.items.some((item) => item.kind === 'more_items'), 'and how many messages were left out');
  assert.ok(view.prompt.bytesShown <= 1500);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a read is bounded by bytes, not by whatever the file grew to', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-journal-big-'));
  const id = randomUUID();
  const lines = [JSON.stringify(CHAT_LINES[0]), ...CHAT_LINES.slice(1).map((line) => JSON.stringify(line))];
  for (let index = 0; index < 400; index += 1) {
    lines.push(JSON.stringify({ at: '2026-10-22T17:27:33.000Z', type: 'backend_event', event: { choices: [{ delta: { content: 'y'.repeat(200) } }] } }));
  }
  await fs.writeFile(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n', 'utf8');
  const view = await readJournalView({ dir, id, maxBytes: 20000 });
  assert.equal(view.truncated, true);
  assert.equal(view.state, 'truncated');
  assert.ok(view.bytes > view.readBytes, 'the file size is still reported honestly');
  assert.ok(view.lines < 400);
  await fs.rm(dir, { recursive: true, force: true });
});

test('an interrupted journal still reads, and a missing one is not an error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-journal-cut-'));
  const id = randomUUID();
  // A generation killed mid-stream leaves a half-written last line behind.
  await fs.writeFile(path.join(dir, `${id}.jsonl`),
    `${JSON.stringify(CHAT_LINES[0])}\n${JSON.stringify(CHAT_LINES[3])}\n{"type":"backend_event","eve`, 'utf8');
  const view = await readJournalView({ dir, id });
  assert.equal(view.lines, 2);
  assert.equal(view.terminal, null);
  assert.deepEqual(view.phases.map((phase) => phase.name), ['request']);

  assert.equal(await readJournalView({ dir, id: randomUUID() }), null);
  await assert.rejects(() => readJournalView({ dir, id: 'not-a-uuid' }), (error) => error.code === 'INVALID_RECORD_ID');
  await fs.rm(dir, { recursive: true, force: true });
});

test('a Responses request whose input is a plain string still shows its prompt', async () => {
  const { dir, id } = await write([
    { at: '2026-10-22T18:00:00.000Z', type: 'request', request: { model: 'm', input: 'Reply with exactly: portal ok', instructions: 'Be terse.', stream: true } },
    { at: '2026-10-22T18:00:01.000Z', type: 'terminal', status: 'completed' }
  ]);
  const view = await readJournalView({ dir, id });
  assert.equal(view.prompt.shape, 'responses');
  assert.deepEqual(view.prompt.items.map((item) => [item.role, item.text]),
    [['system', 'Be terse.'], ['user', 'Reply with exactly: portal ok']]);
  await fs.rm(dir, { recursive: true, force: true });
});
