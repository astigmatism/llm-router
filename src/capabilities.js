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

// Version 2 adds `hosts` and the host each model belongs to, both of which
// appear only once a deployment spans more than one machine. Every field a
// version 1 client reads is unchanged, and unknown fields are ignored.
export const CAPABILITIES_SCHEMA_VERSION = 2;
const LOAD_EVENT_INTERVAL_MS = 1000;
const MAX_SUBSCRIBER_BACKLOG_BYTES = 1024 * 1024;
const RECONNECT_RETRY_MS = 3000;

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
const errorCode = (error) => (typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'MODEL_DISCOVERY_FAILED');
// Two titles are the same title when a client rendering them cannot tell them
// apart: case and spacing are presentation, and a renderer collapses runs of
// whitespace anyway. Comparison normalizes; the published title never does.
const labelKey = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// What a client may render to pick one row out of `models[]` by its title.
//
// A picker offers one option per service and identifies the option a person
// chose by the label it was given, so two rows titled alike cannot be chosen
// apart: a strict name match resolves both and the client's own verification
// fails. Service IDs are already unique across the deployment — a name two
// machines both claim is refused at publication — but the *title* is whatever
// each publisher chose, and two machines may describe the same model the same
// way. That is a presentation collision, and it is fixed here rather than at
// the door: the router does not get to rename somebody else's model.
//
// `display_name` is therefore never rewritten. A model's client-facing name must
// not change because its runtime moved it to another machine (MULTI_HOST.md §4),
// and every consumer that matches on the published title keeps working.
// `display_name_qualified` is the additive answer: equal to `display_name`
// wherever that title already names exactly one row, and carrying the machine or
// the service ID in parentheses only on the rows that genuinely collide.
//
// Determinism: every label is derived from the rows themselves — the whole set
// of rows sharing one title is decided together, and the qualifier comes from
// that row's own host and service — so the result never depends on the order a
// Map happened to yield, and composing the same roster twice gives the same
// bytes.
const DISPLAY_LABEL_QUALIFIERS = ['host', 'service'];

export function qualifyDisplayNames(models, hosts) {
  const hostLabels = new Map((hosts ?? []).map((host) => [host.id, host.display_name ?? host.id]));
  // A row a client may select is one that answers to a service ID; the contract
  // forbids offering the rest as a choice, so they can never be the duplicate in
  // someone's picker and keep their published title untouched.
  const selectable = (model) => model.service !== model.id;
  const selectableRows = models.filter(selectable);
  const groups = new Map();
  for (const model of selectableRows) {
    const key = labelKey(model.display_name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  const qualify = (model, qualifier) => {
    const detail = qualifier === 'host'
      ? (model.host === undefined || model.host === null ? null : hostLabels.get(model.host) ?? String(model.host))
      : model.service;
    return typeof detail === 'string' && detail.trim() ? `${model.display_name} (${detail.trim()})` : null;
  };
  // One qualifier for a whole group, chosen by the first that separates all of
  // its rows: the machine usually does it, and when one machine offers two
  // services under one title the service ID has to.
  const decided = new Map();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    for (const qualifier of DISPLAY_LABEL_QUALIFIERS) {
      const labels = group.map((model) => qualify(model, qualifier));
      if (labels.every((label) => label !== null) && new Set(labels.map(labelKey)).size === labels.length) {
        decided.set(key, qualifier);
        break;
      }
    }
  }
  const uniqueTitles = () => new Set(selectableRows.map((model) => labelKey(model.display_name_qualified))).size === selectableRows.length;
  const apply = (qualifier) => {
    for (const model of models) {
      const kind = selectable(model) ? (qualifier ?? decided.get(labelKey(model.display_name)) ?? null) : null;
      model.display_name_qualified = kind === null ? model.display_name : (qualify(model, kind) ?? model.display_name);
    }
  };
  apply(null);
  // Rare, and only from a publisher whose title is another row's title plus a
  // parenthetical: a qualified label that lands on a title somebody published
  // verbatim. Qualifying every selectable row with its service ID always ends
  // the argument, because the deployment has no two rows sharing one.
  if (!uniqueTitles()) apply('service');
  return models;
}

function modelSummary(entry, acceptingRequests, compatibilityAlias, drainingHosts, host) {
  const meta = entry.x_ollama_router || {};
  const aliases = Array.isArray(meta.aliases) ? [...meta.aliases] : [];
  // A machine under maintenance stops its own traffic; the models that run
  // somewhere else stay available.
  const hostDraining = host !== undefined && host !== null && drainingHosts.has(host);
  return {
    id: entry.id,
    // The stable ID clients should send for this model: its service alias
    // (daytime, nighttime), not the compatibility alias or canonical ID.
    service: aliases.find((alias) => alias !== compatibilityAlias) ?? entry.id,
    display_name: meta.display_name ?? entry.id,
    // Stamped below, once every row is known: the published title, plus a host or
    // service qualifier where two rows would otherwise read alike.
    display_name_qualified: meta.display_name ?? entry.id,
    aliases,
    // A listed model is usable only while its backend answers health checks
    // and the router is admitting new requests.
    available: acceptingRequests && !hostDraining && (meta.health ? meta.health.available === true : true),
    ...(host === undefined || host === null ? {} : { host }),
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
    const drainingHosts = new Set(gate.draining_hosts ?? []);
    // The catalog owns the mapping from a model to the machine running it; the
    // discovery entry describes what that machine's backend reported.
    const hostOf = new Map((catalog?.models ?? []).filter((model) => model.host).map((model) => [model.model, model.host]));
    const models = entries.map((entry) => modelSummary(
      entry,
      router.accepting_requests,
      config.routerModelAlias,
      drainingHosts,
      hostOf.get(entry.id)
    ));
    // Only the legacy local-only deployment omits host identity. One remote
    // publisher still needs it for scoped drain and availability reporting.
    const multiHost = config.routerHosts.length > 1 || config.defaultHost !== 'local';
    const hosts = multiHost ? (catalog?.hosts ?? []).map((host) => {
      const drain = gate.hosts?.[host.id];
      const hosted = models.filter((model) => model.host === host.id);
      return {
        id: host.id,
        display_name: host.display_name ?? host.id,
        default: host.default === true,
        published: host.published === true,
        // The machine can serve something right now: not drained, and at least
        // one of its models answers its own health check.
        available: !gate.draining && !drain?.draining && hosted.some((model) => model.available),
        draining: gate.draining || Boolean(drain?.draining),
        drain_reason: drain?.drain_reason ?? (gate.draining ? gate.drain_reason : null),
        configuration: host.configuration ?? null,
        model_ids: host.model_ids ?? [],
        error: host.error ? { code: host.error.code, message: host.error.message } : null
      };
    }) : null;
    // Titles are the last thing composed, because a title can only be known
    // unique once every row and every machine that publishes one is.
    qualifyDisplayNames(models, hosts);
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
      ids,
      ...(hosts === null ? {} : { hosts })
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
