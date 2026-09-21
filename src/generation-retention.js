import fs from 'node:fs/promises';
import path from 'node:path';

const managers = new Map();
const JOURNAL_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.jsonl$/;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// DATA_DIR has a single router writer. Sharing by directory also covers adapters
// that clone configuration; active journal protection must not depend on identity.
export function generationRetention(config) {
  const root = path.resolve(config.dataDir);
  if (!managers.has(root)) managers.set(root, new GenerationRetention(root, config));
  return managers.get(root);
}

class GenerationRetention {
  constructor(root, config) {
    this.root = root;
    this.directory = path.join(root, 'generations');
    this.days = config.generationRetentionDays;
    this.maxBytes = config.generationMaxBytes;
    this.active = new Set();
    this.owners = 0;
    this.timer = null;
    this.pending = null;
    this.requested = false;
    this.status = { lastRunAt: null, lastSuccessAt: null, lastError: null, closedFiles: 0, closedBytes: 0 };
  }

  async start() {
    this.owners++;
    if (!this.timer) {
      this.timer = setInterval(() => { void this.sweep(); }, SWEEP_INTERVAL_MS);
      this.timer.unref();
    }
    await this.sweep();
  }

  stop() {
    this.owners = Math.max(0, this.owners - 1);
    if (!this.owners) { clearInterval(this.timer); this.timer = null; }
    this.forgetIfUnused();
  }

  forgetIfUnused() {
    if (!this.owners && !this.active.size && !this.pending && managers.get(this.root) === this) managers.delete(this.root);
  }

  register(id) { this.active.add(`${id}.jsonl`); }

  async release(id) {
    this.active.delete(`${id}.jsonl`);
    await this.sweep();
  }

  snapshot() {
    return { ...this.status, retentionDays: this.days, maxBytes: this.maxBytes, activeFiles: this.active.size };
  }

  sweep() {
    this.requested = true;
    if (!this.pending) {
      this.pending = this.runSweeps().finally(() => {
        this.pending = null;
        this.forgetIfUnused();
      });
    }
    return this.pending;
  }

  async runSweeps() {
    do {
      this.requested = false;
      this.status.lastRunAt = new Date().toISOString();
      try {
        await this.prune();
        this.status.lastSuccessAt = new Date().toISOString();
        this.status.lastError = null;
      } catch (error) {
        this.status.lastError = { code: error.code || 'RETENTION_FAILED', message: error.message };
        console.error('generation archive cleanup failed', error);
      }
    } while (this.requested);
  }

  async prune() {
    let entries;
    try { entries = await fs.readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
    const closed = [];
    for (const entry of entries) {
      if (!JOURNAL_NAME.test(entry.name) || !entry.isFile() || this.active.has(entry.name)) continue;
      const file = path.join(this.directory, entry.name);
      let info;
      try { info = await fs.lstat(file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (info.isFile() && !this.active.has(entry.name)) closed.push({ name: entry.name, file, bytes: info.size, mtime: info.mtimeMs });
    }
    closed.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    this.status.closedFiles = closed.length;
    this.status.closedBytes = closed.reduce((sum, item) => sum + item.bytes, 0);
    const cutoff = Date.now() - this.days * 86400000;
    for (const item of closed) {
      if (item.mtime > cutoff && this.status.closedBytes <= this.maxBytes) break;
      if (this.active.has(item.name)) continue;
      try {
        // Recheck file type before deletion; never follow links or recurse.
        const info = await fs.lstat(item.file);
        if (!info.isFile() || this.active.has(item.name)) continue;
        await fs.unlink(item.file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.status.closedFiles--;
      this.status.closedBytes -= item.bytes;
    }
  }
}
