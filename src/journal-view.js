// The payload view behind GET /admin/api/requests/:id/journal.
//
// A generation journal is the router's own record of one accepted generation:
// the request as it arrived, the admission decision, the translated backend
// request, every upstream event, and a terminal line. The file is the only
// place the prompt text exists when PROMPT_LOGGING=metadata, which is why the
// portal's request detail reads it - and why the read is bounded. A single
// agentic request can archive tens of megabytes of tool schemas and past
// turns, and a dashboard that streamed all of it to a browser tab would be the
// new outage. So: stat the file, read up to a budget, and say what was left
// behind instead of pretending the view is complete.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';

const ITEM_TEXT_BUDGET = 1400;
const TOOL_DESCRIPTION_BUDGET = 220;
const EVENT_SAMPLES = 40;

function bytes(value) {
  if (value === null || value === undefined) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value);
  return Buffer.byteLength(JSON.stringify(value));
}

function clip(text, budget) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value) <= budget) return { text: value, truncated: false };
  // Cut on characters but report bytes: the budget is about the wire, the
  // reader counts characters.
  const slice = value.slice(0, budget);
  return { text: slice, truncated: true };
}

function partText(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return '';
}

function partKind(part) {
  if (typeof part === 'string') return 'text';
  if (!part || typeof part !== 'object') return 'unknown';
  if (part.type) return String(part.type);
  if (part.image_url) return 'image_url';
  if (part.text !== undefined) return 'text';
  return 'unknown';
}

function isImage(kind) {
  return kind === 'input_image' || kind === 'image_url';
}

function isFile(kind) {
  return kind === 'input_file';
}

/**
 * Flatten the two prompt shapes a journal can hold.
 *
 * The Chat/Ollama wire nests `messages[{role, content}]`; the Responses wire
 * carries `input[]` of typed items (messages, tool calls, tool outputs,
 * reasoning). Both are projected into one ordered list so the UI has a single
 * renderer, with images and files reduced to a size - their bytes are archived,
 * and a base64 blob is not something to paint in a table.
 */
function projectItems(source, budget) {
  const items = [];
  let used = 0;
  // Two different totals: `used` is the budget spent, measured against the size
  // of each item so a 9 KB message stops the walk, and `shownBytes` is the text
  // that actually reached the response.
  let shownBytes = 0;
  let elidedBytes = 0;
  let images = 0;
  let index = 0;
  let stopped = false;

  const push = (item) => {
    items.push({ index: index++, ...item });
    used += item.bytes;
    shownBytes += Buffer.byteLength(item.text ?? '');
  };

  const parts = (content) => (Array.isArray(content) ? content : [content ?? '']);

  const walk = (entry) => {
    if (stopped) return;
    const kind = entry.type ?? (entry.role ? 'message' : 'item');
    const role = entry.role ?? null;
    if (kind === 'message' || entry.content !== undefined || typeof entry.content === 'string') {
      let position = 0;
      for (const part of parts(entry.content)) {
        const partType = partKind(part);
        const partBytes = bytes(part);
        if (isImage(partType) || isFile(partType)) {
          images += 1;
          elidedBytes += partBytes;
          push({ role, kind: partType, elided: true, bytes: partBytes, part: position++ });
          continue;
        }
        const raw = partText(part);
        const hadBudget = used < budget;
        const shown = hadBudget ? clip(raw, Math.min(ITEM_TEXT_BUDGET, budget - used)) : { text: '', truncated: true };
        // Account the difference against the item's real size: the reader needs
        // to know the message is long, not merely that it was shortened.
        if (shown.truncated) elidedBytes += Math.max(0, partBytes - Buffer.byteLength(shown.text));
        push({ role, kind: partType || 'text', bytes: partBytes, text: shown.text, truncated: shown.truncated, part: position++ });
        if (used >= budget) { stopped = true; break; }
      }
      return;
    }
    if (kind === 'function_call') {
      const raw = typeof entry.arguments === 'string' ? entry.arguments : JSON.stringify(entry.arguments ?? '');
      const hadBudget = used < budget;
      const shown = hadBudget ? clip(raw, Math.min(ITEM_TEXT_BUDGET, budget - used)) : { text: '', truncated: true };
      const itemBytes = bytes(raw);
      if (shown.truncated) elidedBytes += Math.max(0, itemBytes - Buffer.byteLength(shown.text));
      push({ role: 'assistant', kind: 'function_call', name: entry.name ?? null, callId: entry.call_id ?? entry.id ?? null, bytes: itemBytes, text: shown.text, truncated: shown.truncated });
      if (used >= budget) stopped = true;
      return;
    }
    if (kind === 'function_call_output') {
      const raw = typeof entry.output === 'string' ? entry.output : JSON.stringify(entry.output ?? '');
      const hadBudget = used < budget;
      const shown = hadBudget ? clip(raw, Math.min(ITEM_TEXT_BUDGET, budget - used)) : { text: '', truncated: true };
      const itemBytes = bytes(raw);
      if (shown.truncated) elidedBytes += Math.max(0, itemBytes - Buffer.byteLength(shown.text));
      push({ role: 'tool', kind: 'function_call_output', callId: entry.call_id ?? entry.id ?? null, bytes: itemBytes, text: shown.text, truncated: shown.truncated });
      if (used >= budget) stopped = true;
      return;
    }
    if (kind === 'reasoning') {
      const raw = Array.isArray(entry.summary) ? entry.summary.join('\n') : partText(entry.content);
      const shown = clip(raw, 400);
      push({ role: 'reasoning', kind: 'reasoning', bytes: bytes(raw), text: shown.text, truncated: shown.truncated });
      return;
    }
    const raw = JSON.stringify(entry);
    const hadBudget = used < budget;
    const shown = hadBudget ? clip(raw, Math.min(ITEM_TEXT_BUDGET, budget - used)) : { text: '', truncated: true };
    const itemBytes = bytes(raw);
    if (shown.truncated) elidedBytes += Math.max(0, itemBytes - Buffer.byteLength(shown.text));
    push({ role, kind, bytes: itemBytes, text: shown.text, truncated: shown.truncated });
    if (used >= budget) stopped = true;
  };

  return { walk, items, stats: () => ({ used, shownBytes, elidedBytes, images, stopped }) };
}

function promptFrom(request, budget) {
  if (!request || typeof request !== 'object') return null;
  const source = Array.isArray(request.input) ? request.input
    : Array.isArray(request.messages) ? request.messages : [];
  const projection = projectItems(request, budget);
  const totalBytes = bytes(request);
  let itemCount = 0;
  for (const entry of source) {
    if (itemCount > 0 && projection.stats().stopped) break;
    projection.walk(entry);
    itemCount += 1;
  }
  const stats = projection.stats();
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const shown = tools.slice(0, 40).map((tool) => ({
    name: tool?.function?.name ?? tool?.name ?? null,
    description: clip(tool?.function?.description ?? tool?.description ?? '', TOOL_DESCRIPTION_BUDGET).text
  }));
  const toolsBytes = bytes(tools);
  const rest = Math.max(0, source.length - itemCount);
  if (rest > 0) projection.items.push({ index: itemCount, kind: 'more_items', count: rest, elided: true, bytes: 0 });
  return {
    model: request.model ?? null,
    shape: Array.isArray(request.input) ? 'responses' : 'chat',
    stream: request.stream ?? null,
    itemCount: source.length,
    bytes: totalBytes,
    items: projection.items,
    toolsCount: tools.length,
    toolsBytes,
    tools: shown,
    toolsTruncated: tools.length > shown.length,
    imagesElided: stats.images,
    elidedBytes: stats.elidedBytes + (stats.stopped && toolsBytes > shown.reduce((sum, tool) => sum + Buffer.byteLength(tool.description), 0)
      ? toolsBytes - shown.reduce((sum, tool) => sum + Buffer.byteLength(tool.description), 0) : 0),
    bytesShown: stats.shownBytes,
    truncated: stats.stopped || rest > 0
  };
}

function deltaSummary(event) {
  const choice = event?.choices?.[0] ?? event?.choice;
  if (!choice) {
    if (event?.response) return `response ${event.response.status ?? ''}`.trim();
    if (event?.type) return String(event.type);
    return 'event';
  }
  const delta = choice.delta ?? choice.message ?? {};
  const parts = [];
  if (delta.role) parts.push(`role=${delta.role}`);
  if (typeof delta.content === 'string' && delta.content.length) parts.push(`delta=content (+${delta.content.length} ch)`);
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) parts.push(`delta=reasoning (+${delta.reasoning_content.length} ch)`);
  for (const call of delta.tool_calls ?? []) parts.push(`delta=tool_call(${call.function?.name ?? call.index ?? '?'})`);
  if (choice.finish_reason) parts.push(`finish=${choice.finish_reason}`);
  if (event?.x_router) parts.push(`router=${event.x_router.status}`);
  return parts.join(' ') || 'delta';
}

function firstContentAt(lines) {
  for (const line of lines) {
    if (line.type !== 'backend_event') continue;
    const choice = line.event?.choices?.[0];
    if (!choice) return line.at;
    const delta = choice.delta ?? choice.message ?? {};
    if ((typeof delta.content === 'string' && delta.content.length) || (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length)
      || (Array.isArray(delta.tool_calls) && delta.tool_calls.length) || choice.finish_reason) return line.at;
  }
  return null;
}

function phases(lines, terminal) {
  const opened = lines[0]?.at ? Date.parse(lines[0].at) : null;
  const offset = (at) => (opened && at ? Math.max(0, Date.parse(at) - opened) : null);
  const out = [];
  const request = lines.find((line) => line.type === 'request');
  if (request) out.push({ name: 'request', label: 'Received', at: request.at, offsetMs: 0,
    detail: `model=${request.request?.model ?? '?'} stream=${String(request.request?.stream ?? false)} items=${Array.isArray(request.request?.input) ? request.request.input.length : (Array.isArray(request.request?.messages) ? request.request.messages.length : 0)}` });
  const admission = lines.find((line) => line.type === 'admission');
  if (admission) out.push({ name: 'admission', label: 'Admitted', at: admission.at, offsetMs: offset(admission.at),
    detail: `input=${admission.inputTokens ?? '?'} slot_ctx=${admission.slotContext ?? '?'} reserve=${admission.reserve ?? '?'} output=${admission.outputPolicy ?? '?'}` });
  const backend = lines.find((line) => line.type === 'backend_request');
  if (backend) out.push({ name: 'backend_request', label: 'Upstream request', at: backend.at, offsetMs: offset(backend.at),
    detail: `n_predict=${backend.body?.n_predict ?? backend.body?.max_tokens ?? '?'}${backend.body?.chat_template_kwargs ? ` thinking=${JSON.stringify(backend.body.chat_template_kwargs)}` : ''}` });
  const transition = lines.find((line) => line.type === 'context_transition');
  if (transition) out.push({ name: 'context_transition', label: 'Context transition', at: transition.at, offsetMs: offset(transition.at), detail: 'backend context rotated' });
  const firstContent = firstContentAt(lines);
  if (firstContent) out.push({ name: 'first_event', label: 'First content', at: firstContent, offsetMs: offset(firstContent), detail: 'first delta delivered to the client' });
  if (terminal) out.push({ name: 'terminal', label: terminal.status === 'completed' ? 'Complete' : String(terminal.status ?? 'terminal'),
    at: terminal.at, offsetMs: offset(terminal.at),
    detail: `finish=${terminal.finish_reason ?? 'n/a'} stop=${terminal.stop_reason ?? 'n/a'} tokens=${terminal.usage?.total_tokens ?? terminal.usage?.total ?? 'n/a'}${terminal.reason ? ` reason=${terminal.reason}` : ''}` });
  return out;
}

/**
 * Read one generation journal and project it for the portal.
 *
 * @param options.dir DATA_DIR/generations
 * @param options.id the journal (record) id
 * @param options.maxBytes ceiling for the read itself
 * @param options.promptBytes ceiling for the projected prompt
 */
export async function readJournalView(options) {
  const { dir, id } = options;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(id))) {
    const error = new Error('A generation record UUID is required.');
    error.code = 'INVALID_RECORD_ID';
    error.statusCode = 400;
    throw error;
  }
  const file = path.join(dir, `${id}.jsonl`);
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const lines = [];
  let read = 0;
  let truncated = false;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file, { encoding: 'utf8' });
    let pending = '';
    stream.on('data', (chunk) => {
      read += Buffer.byteLength(chunk);
      pending += chunk;
      let cut = pending.indexOf('\n');
      while (cut >= 0) {
        const line = pending.slice(0, cut).trim();
        pending = pending.slice(cut + 1);
        if (line) {
          try {
            lines.push(JSON.parse(line));
          } catch {
            // A half-written final line is normal for an interrupted
            // generation; skipping it is what the retention sweep would do too.
          }
        }
        cut = pending.indexOf('\n');
      }
      if (read > maxBytes) {
        truncated = true;
        stream.destroy();
        resolve();
      }
    });
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', reject);
  });

  const terminal = lines.filter((line) => line.type === 'terminal').pop() ?? null;
  const request = lines.find((line) => line.type === 'request') ?? null;
  const backendRequest = lines.find((line) => line.type === 'backend_request') ?? null;
  const byType = {};
  for (const line of lines) byType[line.type] = (byType[line.type] || 0) + 1;
  const openedAt = lines[0]?.at ? Date.parse(lines[0].at) : null;
  const lastAt = lines.length ? Date.parse(lines[lines.length - 1].at) : null;
  const firstContent = firstContentAt(lines);
  const events = lines.filter((line) => line.type === 'backend_event');
  const step = Math.max(1, Math.ceil(events.length / EVENT_SAMPLES));
  const samples = events.filter((unused, index) => index % step === 0).slice(0, EVENT_SAMPLES)
    .map((line) => ({ at: line.at, offsetMs: openedAt ? Date.parse(line.at) - openedAt : null, type: 'backend_event', summary: deltaSummary(line.event) }));

  return {
    journalId: id,
    file,
    bytes: stat.size,
    lines: lines.length,
    truncated,
    readBytes: Math.min(read, stat.size),
    state: truncated ? 'truncated' : 'archived',
    phases: phases(lines, terminal),
    terminal: terminal ? {
      status: terminal.status ?? null,
      finishReason: terminal.finish_reason ?? null,
      stopReason: terminal.stop_reason ?? null,
      reason: terminal.reason ?? null,
      usage: terminal.usage ?? null,
      contextTransitions: terminal.context_transitions ?? null,
      recordId: terminal.record_id ?? null
    } : null,
    prompt: promptFrom(request?.request ?? request, options.promptBytes ?? 24576),
    backendRequest: backendRequest ? {
      model: backendRequest.body?.model ?? null,
      bytes: bytes(backendRequest.body),
      body: backendRequest.body ?? null
    } : null,
    events: {
      total: events.length,
      byType,
      samples,
      omitted: Math.max(0, events.length - samples.length),
      firstByteMs: openedAt && firstContent ? Date.parse(firstContent) - openedAt : null,
      lastByteMs: openedAt && lastAt && lastAt !== openedAt ? lastAt - openedAt : null
    },
    rawUrl: `/admin/api/generation-record?id=${encodeURIComponent(id)}`
  };
}
