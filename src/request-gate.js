import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isLlamaWireKind } from './backend-adapters.js';

export class RequestGateError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RequestGateError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class RequestGate {
  constructor(controlFile, options = {}) {
    this.controlFile = controlFile;
    this.now = options.now || (() => new Date());
    this.draining = false;
    this.drainReason = null;
    this.drainUpdatedAt = null;
    // A machine under maintenance drains on its own: a runtime transition on one
    // host must not stop traffic to models that are running somewhere else. The
    // global flag stays the whole-router switch a release can pull.
    this.hostDrain = new Map();
    this.active = new Map();
    this.queues = new Map();
    this.waiters = new Set();
    // Optional observer for admission changes (grant, release, enqueue,
    // cancel). It must be cheap and must not throw into admission.
    this.onChange = options.onChange || null;
  }

  isDraining(host = null) {
    return this.draining || (host != null && this.hostDrain.has(host));
  }

  drainState(host) {
    const perHost = this.hostDrain.get(host) ?? null;
    return {
      draining: this.draining || Boolean(perHost),
      drain_reason: perHost?.reason ?? (this.draining ? this.drainReason : null),
      drain_updated_at: perHost?.updatedAt ?? (this.draining ? this.drainUpdatedAt : null)
    };
  }

  changed() {
    try { this.onChange?.(); } catch { /* observers never affect admission */ }
  }

  async init() {
    if (!this.controlFile) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.controlFile, 'utf8'));
      this.draining = parsed?.draining === true;
      this.drainReason = typeof parsed?.reason === 'string' ? parsed.reason : null;
      this.drainUpdatedAt = typeof parsed?.updated_at === 'string' ? parsed.updated_at : null;
      // Schema v1 named no hosts, and a v1 file is a router with one machine:
      // reading it yields the same drain state it was written with.
      for (const [host, state] of Object.entries(parsed?.hosts ?? {})) {
        if (state?.draining === true) {
          this.hostDrain.set(host, {
            reason: typeof state.reason === 'string' ? state.reason : null,
            updatedAt: typeof state.updated_at === 'string' ? state.updated_at : null
          });
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
    }
  }

  snapshot(activeModel = null) {
    const entries = [...this.active.values()];
    const queued = [...this.queues.values()].flat();
    return {
      draining: this.draining,
      drain_reason: this.drainReason,
      drain_updated_at: this.drainUpdatedAt,
      active_count: entries.length,
      active_generation_ids: entries.map((entry) => entry.id),
      active_by_endpoint: entries.reduce((counts, entry) => {
        counts[entry.endpoint] = (counts[entry.endpoint] || 0) + 1;
        return counts;
      }, {}),
      active_by_model: entries.reduce((counts, entry) => {
        counts[entry.model || 'default'] = (counts[entry.model || 'default'] || 0) + 1;
        return counts;
      }, {}),
      // Reported for the default host's active model, which is the model an
      // unnamed request selects; per-machine state is in `hosts`.
      backend_kind: activeModel?.backend_kind || 'ollama',
      profile: activeModel?.profile || null,
      model: activeModel?.model || null,
      max_active_requests: activeModel?.max_active_requests ?? null,
      queue_policy: isLlamaWireKind(activeModel?.backend_kind) ? 'fifo-per-backend' : 'backend-managed',
      queued_count: queued.length,
      queued_by_model: queued.reduce((counts, entry) => {
        counts[entry.model || 'default'] = (counts[entry.model || 'default'] || 0) + 1;
        return counts;
      }, {}),
      queued_by_endpoint: queued.reduce((counts, entry) => {
        counts[entry.endpoint || 'unknown'] = (counts[entry.endpoint || 'unknown'] || 0) + 1;
        return counts;
      }, {}),
      active_by_host: entries.reduce((counts, entry) => {
        counts[entry.host || 'local'] = (counts[entry.host || 'local'] || 0) + 1;
        return counts;
      }, {}),
      queued_by_host: queued.reduce((counts, entry) => {
        counts[entry.host || 'local'] = (counts[entry.host || 'local'] || 0) + 1;
        return counts;
      }, {}),
      // Whole-router drain plus every machine drained on its own. `hosts` is
      // empty for a single-host deployment, exactly as it was undeclared before.
      draining_hosts: [...new Set([
        ...(this.draining ? [activeModel?.host ?? 'local'] : []),
        ...this.hostDrain.keys()
      ])],
      hosts: Object.fromEntries([...this.hostDrain.keys()].map((host) => [host, this.drainState(host)]))
    };
  }

  async acquire({ endpoint, clientIdentity, limit = null, backendKey = 'default', model = null, host = null, signal, onQueued } = {}) {
    signal?.throwIfAborted();
    if (this.draining) {
      throw new RequestGateError(
        503,
        'BACKEND_DRAINING',
        'The active inference backend is draining for a runtime transition. Retry shortly.'
      );
    }
    if (host != null && this.hostDrain.has(host)) {
      const reason = this.hostDrain.get(host).reason;
      throw new RequestGateError(
        503,
        'BACKEND_DRAINING',
        `The inference backend on host ${JSON.stringify(host)} is draining${reason ? ` (${reason})` : ''} for a runtime transition. Retry shortly.`
      );
    }
    const entry = { endpoint, clientIdentity, limit, backendKey, model, host };
    if (!this.queues.has(backendKey) && this.hasCapacity(entry)) return this.grant(entry);
    return await new Promise((resolve, reject) => {
      const queued = { ...entry, resolve, reject, signal, cleanup: () => signal?.removeEventListener('abort', cancel) };
      const cancel = () => {
        const queue = this.queues.get(backendKey);
        const index = queue?.indexOf(queued) ?? -1;
        if (index < 0) return;
        queue.splice(index, 1);
        if (!queue.length) this.queues.delete(backendKey);
        queued.cleanup();
        reject(signal.reason);
        this.advance(backendKey);
      };
      if (!this.queues.has(backendKey)) this.queues.set(backendKey, []);
      this.queues.get(backendKey).push(queued);
      signal?.addEventListener('abort', cancel, { once: true });
      this.changed();
      try { onQueued?.(); }
      catch (error) {
        const queue = this.queues.get(backendKey);
        const index = queue?.indexOf(queued) ?? -1;
        if (index >= 0) queue.splice(index, 1);
        if (!queue?.length) this.queues.delete(backendKey);
        queued.cleanup();
        reject(error);
        this.advance(backendKey);
      }
    });
  }

  hasCapacity({ backendKey, limit }) {
    return !(Number.isSafeInteger(limit) && limit > 0)
      || [...this.active.values()].filter((entry) => entry.backendKey === backendKey).length < limit;
  }

  grant({ endpoint, clientIdentity, backendKey, model, host }) {
    const id = randomUUID();
    const entry = {
      id,
      backendKey,
      model,
      host: host ?? null,
      endpoint: endpoint || 'unknown',
      clientIdentity: clientIdentity || 'unknown',
      startedAt: this.now().toISOString()
    };
    this.active.set(id, entry);
    this.changed();
    let released = false;
    return {
      id,
      release: () => {
        if (released) return false;
        released = true;
        this.active.delete(id);
        this.advance(backendKey);
        return true;
      }
    };
  }

  advance(backendKey) {
    // Drain blocks new arrivals, but already accepted queued work must finish.
    const queue = this.queues.get(backendKey);
    while (queue?.length && this.hasCapacity(queue[0])) {
      const entry = queue.shift();
      entry.cleanup();
      if (entry.signal?.aborted) entry.reject(entry.signal.reason);
      else entry.resolve(this.grant(entry));
    }
    if (!queue?.length) this.queues.delete(backendKey);
    this.changed();
    // Every waiter carries its own condition: a router-wide release waits for
    // the last generation anywhere, a host's maintenance window only for its own.
    for (const waiter of [...this.waiters]) waiter();
  }

  async setDraining(enabled, reason = null, host = null) {
    this.draining = Boolean(enabled) && host == null;
    if (host == null) {
      this.drainReason = this.draining && typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : null;
      this.drainUpdatedAt = this.now().toISOString();
    } else if (enabled) {
      this.hostDrain.set(host, {
        reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : null,
        updatedAt: this.now().toISOString()
      });
    } else {
      this.hostDrain.delete(host);
    }
    await this.persist();
    return this.snapshot();
  }

  // A router-wide release waits for every queue; a host's maintenance window
  // waits only for the generations running on that machine, so one host's
  // transition never blocks behind traffic bound for another.
  async waitForIdle(timeoutMs, host = null) {
    const idle = () => host === null
      ? this.active.size === 0 && this.queues.size === 0
      : ![...this.active.values(), ...[...this.queues.values()].flat()].some((entry) => (entry.host ?? 'local') === host);
    if (idle()) return true;
    return await new Promise((resolve) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.waiters.delete(onIdle);
        resolve(value);
      };
      const onIdle = () => { if (idle()) finish(true); };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.waiters.add(onIdle);
    });
  }

  async persist() {
    if (!this.controlFile) return;
    const directory = path.dirname(this.controlFile);
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${this.controlFile}.tmp-${process.pid}-${randomUUID()}`;
    const payload = `${JSON.stringify({
      schema_version: 2,
      draining: this.draining,
      reason: this.drainReason,
      updated_at: this.drainUpdatedAt,
      hosts: Object.fromEntries([...this.hostDrain.entries()].map(([host, state]) => [host, {
        draining: true,
        reason: state.reason,
        updated_at: state.updatedAt
      }]))
    }, null, 2)}\n`;
    await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.controlFile);
  }
}
