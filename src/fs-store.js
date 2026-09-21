import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

function entryFor(record) {
  const line = `${JSON.stringify(record)}\n`;
  return { record, line, bytes: Buffer.byteLength(line) };
}

// Read backwards without buffering the historical file or an oversized line.
// Decode complete lines so UTF-8 characters split between chunks survive.
async function* reverseLines(file, maxBytes) {
  let position = (await file.stat()).size;
  let parts = [], bytes = 0, oversized = false;
  while (position > 0) {
    const length = Math.min(position, 64 * 1024);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await file.read(buffer, read, length - read, position + read);
      if (!result.bytesRead) throw new Error('History file changed while reading its tail.');
      read += result.bytesRead;
    }
    let end = length;
    while (end > 0) {
      const newline = buffer.lastIndexOf(10, end - 1);
      const part = buffer.subarray(newline + 1, end);
      bytes += part.length;
      if (bytes > maxBytes) { oversized = true; parts = []; }
      else if (!oversized && part.length) parts.push(part);
      if (newline < 0) break;
      if (!oversized && bytes) yield Buffer.concat(parts.reverse(), bytes).toString('utf8');
      parts = []; bytes = 0; oversized = false;
      end = newline;
    }
  }
  if (!oversized && bytes) yield Buffer.concat(parts.reverse(), bytes).toString('utf8');
}

async function readJsonlTail(filePath, limit, maxBytes) {
  let file;
  try { file = await fs.open(filePath, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = [];
  let bytes = 0;
  try {
    for await (const line of reverseLines(file, maxBytes)) {
      let entry;
      try { entry = entryFor(JSON.parse(line)); }
      catch { continue; } // Keep serving healthy history after corrupt/incomplete lines.
      if (entry.bytes > maxBytes) continue;
      if (bytes + entry.bytes > maxBytes) break;
      entries.push(entry);
      bytes += entry.bytes;
      if (entries.length === limit) break;
    }
  } finally { await file.close(); }
  return entries.reverse();
}

async function replaceSnapshot(filePath, entries) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await fs.open(temporary, 'wx', 0o600);
    await file.writeFile(entries.map((entry) => entry.line).join(''), 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await fs.rename(temporary, filePath);
  } finally {
    if (file) await file.close();
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') console.error('failed to remove temporary history snapshot', error);
    });
  }
}

async function removeAbandonedSnapshots(filePath) {
  const directory = path.dirname(filePath);
  const prefix = path.basename(filePath) + '.';
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix) &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(entry.name.slice(prefix.length))) {
      await fs.unlink(path.join(directory, entry.name)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

class BoundedLog {
  constructor(filePath, limit, maxBytes) {
    Object.assign(this, { filePath, limit, maxBytes });
    this.entries = [];
    this.bytes = 0;
    this.pending = [];
    this.writing = false;
  }

  async init() {
    await removeAbandonedSnapshots(this.filePath);
    this.entries = await readJsonlTail(this.filePath, this.limit, this.maxBytes);
    this.bytes = this.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    await replaceSnapshot(this.filePath, this.entries);
  }

  async append(record) {
    const entry = entryFor(record);
    if (entry.bytes > this.maxBytes) {
      console.warn(`omitted oversized metadata record from ${path.basename(this.filePath)}: ${entry.bytes} bytes exceeds ${this.maxBytes}`);
      return;
    }
    this.entries.push(entry);
    this.bytes += entry.bytes;
    while (this.entries.length > this.limit || this.bytes > this.maxBytes) {
      this.bytes -= this.entries.shift().bytes;
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      if (!this.writing) {
        this.writing = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  async flush() {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      const snapshot = this.entries.slice();
      try {
        await replaceSnapshot(this.filePath, snapshot);
        for (const waiter of batch) waiter.resolve();
      } catch (error) {
        for (const waiter of batch) waiter.reject(error);
      }
    }
    this.writing = false;
  }

  records() { return this.entries.map((entry) => entry.record); }
}

export class JsonlStore {
  constructor(config) {
    this.config = config;
    this.requestLog = new BoundedLog(config.requestLogPath, config.requestHistoryLimit, config.requestLogMaxBytes);
    this.eventLog = new BoundedLog(config.eventLogPath, config.eventHistoryLimit, config.eventLogMaxBytes);
  }

  get requests() { return this.requestLog.records(); }
  get events() { return this.eventLog.records(); }

  async init() {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    await this.requestLog.init();
    await this.eventLog.init();
  }

  async appendRequest(record) { await this.requestLog.append(record); }

  async appendEvent(event) {
    const withDefaults = { id: event.id || randomUUID(), ts: event.ts || new Date().toISOString(), ...event };
    await this.eventLog.append(withDefaults);
    return withDefaults;
  }

  recentRequests(limit = this.config.requestHistoryLimit) { return this.requests.slice(-limit).reverse(); }
  recentEvents(limit = this.config.eventHistoryLimit) { return this.events.slice(-limit).reverse(); }

  paths() {
    return {
      dataDir: path.resolve(this.config.dataDir),
      requestLogPath: path.resolve(this.config.requestLogPath),
      eventLogPath: path.resolve(this.config.eventLogPath)
    };
  }
}
