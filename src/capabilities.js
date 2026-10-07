import { createHash } from 'node:crypto';

// Deployment-wide capability document and its push stream.
//
// Sources, in order of authority:
// - the runtime-published catalog (declared models, service aliases, policy,
//   qualified capabilities, the selected configuration, offline services);
// - the running llama.cpp processes (health, slots, modalities), merged into
//   each model's discovery metadata;
// - this router's own admission gate (drain, maintenance, slot occupancy).
//
// Clients read GET /v1/router/capabilities at startup and subscribe to
// GET /v1/router/events for changes. Every event carries a complete document,
// so a client never has to apply a diff.

export const CAPABILITIES_SCHEMA_VERSION = 1;
const LOAD_EVENT_INTERVAL_MS = 1000;
const MAX_SUBSCRIBER_BACKLOG_BYTES = 1024 * 1024;
const RECONNECT_RETRY_MS = 3000;

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
const errorCode = (error) => (typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'MODEL_DISCOVERY_FAILED');

function modelSummary(entry, acceptingRequests, compatibilityAlias) {
  const meta = entry.x_ollama_router || {};
  const aliases = Array.isArray(meta.aliases) ? [...meta.aliases] : [];
  return {
    id: entry.id,
    // The stable ID clients should send for this model: its service alias
    // (daytime, nighttime), not the compatibility alias or canonical ID.
    service: aliases.find((alias) => alias !== compatibilityAlias) ?? entry.id,
    display_name: meta.display_name ?? entry.id,
    aliases,
    // A listed model is usable only while its backend answers health checks
    // and the router is admitting new requests.
    available: acceptingRequests && (meta.health ? meta.health.available === true : true),
    slots: meta.active_request_limit ?? null,
    context_window: meta.context_window ?? null,
    input_modalities: meta.input_modalities ?? null,
    capabilities: meta.capabilities ?? null,
    // Declared per model by the runtime; null when the catalog does not say.
    nsfw: typeof meta.nsfw === 'boolean' ? meta.nsfw : null,
    // Higher is more capable; comparable only between models of this router.
    capability_score: meta.capability_score?.value ?? null,
    metadata: meta
  };
}

export class CapabilityPublisher {
  constructor(context, options = {}) {
    this.context = context;
    this.now = options.now || (() => new Date());
    this.subscribers = new Set();
    this.current = null;
    this.refreshing = null;
    this.rerun = false;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.loadTimer = null;
    this.lastLoadSentAt = 0;
    this.closed = false;
  }

  get config() {
    return this.context.config;
  }

  async build() {
    const { config, modelDiscovery, requestGate, state } = this.context;
    const gate = requestGate.snapshot();
    const maintenance = Boolean(state.maintenanceMode);
    const router = {
      name: config.appName,
      version: config.version,
      accepting_requests: !gate.draining && !maintenance,
      draining: gate.draining,
      drain_reason: gate.drain_reason,
      maintenance
    };
    const warnings = [];
    let entries = [];
    let catalog = null;
    try {
      ({ entries, catalog } = await modelDiscovery.document(null, { includeAliases: false }));
    } catch (error) {
      warnings.push(errorCode(error));
    }
    if (Array.isArray(catalog?.warnings)) warnings.push(...catalog.warnings);
    const models = entries.map((entry) => modelSummary(entry, router.accepting_requests, config.routerModelAlias));
    const ids = {};
    for (const model of models) {
      ids[model.id] = model.id;
      for (const alias of model.aliases) ids[alias] = model.id;
    }
    const uniqueWarnings = [...new Set(warnings)];
    const capability = {
      complete: uniqueWarnings.length === 0 && models.length > 0 && models.every((model) => model.metadata.complete === true),
      warnings: uniqueWarnings,
      router,
      configuration: catalog?.configuration ?? null,
      default_model: catalog?.resident ? catalog.defaultModel : (models[0]?.id ?? null),
      models,
      offline_services: (catalog?.offlineServices || []).map((service) => ({ ...service, aliases: [...service.aliases] })),
      ids
    };
    return { capability, revision: digest(capability) };
  }

  // Recompute the document. Concurrent callers share one computation; a
  // request that arrives during it causes one more pass so a reload or drain
  // change is never answered with a document computed before it.
  async refresh() {
    if (this.refreshing) {
      this.rerun = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        let current;
        do {
          this.rerun = false;
          current = await this.compute();
        } while (this.rerun && !this.closed);
        return current;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async compute() {
    const built = await this.build();
    const changed = built.revision !== this.current?.revision;
    this.current = {
      ...built,
      observedAt: changed || !this.current ? this.now().toISOString() : this.current.observedAt
    };
    if (changed) {
      for (const subscriber of [...this.subscribers]) this.sendCapabilities(subscriber);
      this.loadChanged();
    }
    return this.current;
  }

  body(current = this.current) {
    return {
      object: 'router.capabilities',
      schema_version: CAPABILITIES_SCHEMA_VERSION,
      revision: current.revision,
      observed_at: current.observedAt,
      ...current.capability
    };
  }

  load(current = this.current) {
    const gate = this.context.requestGate.snapshot();
    const load = {};
    for (const model of current?.capability.models || []) {
      // Admission counts physical models; aliases share their target's slots.
      const physical = model.metadata.upstream_model ?? model.id;
      const active = gate.active_by_model[physical] || 0;
      const queued = gate.queued_by_model[physical] || 0;
      load[model.id] = {
        active,
        queued,
        free_slots: Number.isSafeInteger(model.slots) ? Math.max(0, model.slots - active) : null
      };
    }
    return load;
  }

  async document({ includeLoad = false } = {}) {
    const current = await this.refresh();
    const body = this.body(current);
    if (!includeLoad) return { body, etag: `"${current.revision}"` };
    const load = this.load(current);
    return { body: { ...body, load }, etag: `"${current.revision}.${digest(load)}"` };
  }

  // Returns false when the subscriber limit is reached; the caller answers.
  subscribe(request, response) {
    if (this.closed || this.subscribers.size >= this.config.eventsMaxSubscribers) return false;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-ollama-router': 'llm-router'
    });
    const subscriber = { response, revision: null, loadKey: null };
    this.subscribers.add(subscriber);
    response.once('close', () => this.unsubscribe(subscriber));
    request.socket?.setKeepAlive?.(true);
    this.write(subscriber, `retry: ${RECONNECT_RETRY_MS}\n\n`);
    this.startTimers();
    // Every connection starts with the complete current state; reconnecting
    // clients deduplicate by revision instead of replaying missed events.
    void this.refresh().then(() => {
      if (!this.subscribers.has(subscriber)) return;
      this.sendCapabilities(subscriber);
      this.sendLoad(subscriber, this.load());
    }, () => {});
    return true;
  }

  unsubscribe(subscriber) {
    if (!this.subscribers.delete(subscriber)) return;
    if (this.subscribers.size === 0) this.stopTimers();
  }

  write(subscriber, chunk) {
    const { response } = subscriber;
    if (response.destroyed || response.writableEnded) {
      this.unsubscribe(subscriber);
      return false;
    }
    if (response.writableLength > MAX_SUBSCRIBER_BACKLOG_BYTES) {
      // A consumer that stops reading must not grow router memory.
      this.unsubscribe(subscriber);
      response.destroy();
      return false;
    }
    response.write(chunk);
    return true;
  }

  sendCapabilities(subscriber) {
    if (!this.current || subscriber.revision === this.current.revision) return;
    if (this.write(subscriber, `event: capabilities\nid: ${this.current.revision}\ndata: ${JSON.stringify(this.body())}\n\n`)) {
      subscriber.revision = this.current.revision;
    }
  }

  sendLoad(subscriber, load) {
    if (!this.current) return;
    const key = JSON.stringify(load);
    if (subscriber.loadKey === key) return;
    if (this.write(subscriber, `event: load\ndata: ${JSON.stringify({ revision: this.current.revision, load })}\n\n`)) {
      subscriber.loadKey = key;
    }
  }

  // Admission changes are frequent; coalesce them to one event per second.
  loadChanged() {
    if (!this.subscribers.size || this.loadTimer || this.closed) return;
    const wait = Math.max(0, this.lastLoadSentAt + LOAD_EVENT_INTERVAL_MS - Date.now());
    this.loadTimer = setTimeout(() => {
      this.loadTimer = null;
      this.lastLoadSentAt = Date.now();
      const load = this.load();
      for (const subscriber of [...this.subscribers]) this.sendLoad(subscriber, load);
    }, wait);
    this.loadTimer.unref?.();
  }

  startTimers() {
    if (!this.pollTimer) {
      // Catches backend health changes and catalog edits that were not
      // followed by a reload notification.
      this.pollTimer = setInterval(() => void this.refresh().catch(() => {}), this.config.capabilityPollMs);
      this.pollTimer.unref?.();
    }
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        for (const subscriber of [...this.subscribers]) this.write(subscriber, ': keepalive\n\n');
      }, this.config.eventsHeartbeatMs);
      this.heartbeatTimer.unref?.();
    }
  }

  stopTimers() {
    clearInterval(this.pollTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.loadTimer);
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.loadTimer = null;
  }

  close() {
    this.closed = true;
    this.stopTimers();
    for (const subscriber of [...this.subscribers]) {
      this.subscribers.delete(subscriber);
      if (!subscriber.response.writableEnded) subscriber.response.end();
    }
  }
}
