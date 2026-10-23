// Pure pieces of GET /admin/api/portal/state.
//
// Split out of server.js so the interesting logic - what the dashboard is
// allowed to claim from the facts it was given - can be tested without
// starting a listener or talking to a backend.

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

/** The single word the header prints, and the reason behind it. */
export function admissionState({ draining, maintenanceMode, hostDrain } = {}) {
  if (maintenanceMode) return { state: 'maintenance', detail: 'Router maintenance mode is enabled; generation requests are refused.' };
  if (draining) return { state: 'draining', detail: 'The router is draining for a runtime transition.' };
  if (hostDrain && hostDrain.size) {
    return { state: 'degraded', detail: `Draining on ${[...hostDrain.keys()].join(', ')}; other machines still accept.` };
  }
  return { state: 'accepting', detail: 'Admission control is accepting new generation requests.' };
}

function pushWarning(list, severity, code, message) {
  list.push({ severity, code, message });
}

/**
 * Router-level advisories.
 *
 * Each one is a condition that makes a number on the dashboard lie: a metrics
 * field the backend never fills, a catalog nobody published, a host id that no
 * request can ever be attributed to. The UI shows them once, in the state
 * section, instead of letting the reader infer them from a dash.
 */
export function fleetWarnings({ hosts, config, gate, metrics, retention } = {}) {
  const warnings = [];
  for (const host of hosts ?? []) {
    if (host.error) pushWarning(warnings, 'error', `HOST_${host.id}_UNAVAILABLE`, `${host.id}: ${host.error.message || host.error.code || 'catalog unavailable'}`);
    else if (!host.published) pushWarning(warnings, 'warning', `HOST_${host.id}_NOT_PUBLISHED`, `${host.id} has never published a catalog, so its models are not selectable.`);
    if (host.warnings?.length) {
      for (const warning of host.warnings) pushWarning(warnings, 'warning', warning.code || `HOST_${host.id}_WARNING`, `${host.id}: ${warning.message || warning.detail || 'catalog warning'}`);
    }
  }
  const declared = new Set(config?.routerHosts ?? []);
  for (const key of Object.keys(gate?.active_by_host ?? {})) {
    if (declared.size && !declared.has(key) && key !== 'default') {
      pushWarning(warnings, 'info', 'HOST_ATTRIBUTION_MISMATCH', `In-flight requests are attributed to ${JSON.stringify(key)}, which is not a declared host (${[...declared].join(', ')}).`);
    }
  }
  if (metrics && metrics.throughput && metrics.throughput.evalSamples === 0 && metrics.totalRequests > 0) {
    pushWarning(warnings, 'info', 'BACKEND_THROUGHPUT_SILENT',
      'The backend reports no generation timing, so backend throughput stays empty; the router measures its own tokens/second instead.');
  }
  if (retention?.promptLogging === 'metadata') {
    pushWarning(warnings, 'info', 'PROMPT_LOGGING_METADATA',
      'Prompts are archived in the generation journal only, not in the request log; the request detail reads the journal for payload text.');
  }
  return warnings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}

/** Live in-flight counts, shaped for the state strip. */
export function inFlight(gate = {}, hosts = []) {
  const byHost = {};
  for (const host of hosts) byHost[host.id] = finite(host.active) ?? 0;
  for (const [host, count] of Object.entries(gate.active_by_host ?? {})) byHost[host] = count;
  return {
    active: finite(gate.active_count) ?? 0,
    queued: finite(gate.queued_count) ?? 0,
    byHost,
    byEndpoint: gate.active_by_endpoint ?? {},
    byModel: gate.active_by_model ?? {},
    queuePolicy: gate.queue_policy ?? null,
    limit: finite(gate.max_active_requests)
  };
}

/**
 * Attach window statistics to the selectable-model list.
 *
 * A model that has never been asked for is not broken, so an empty window is
 * reported as `requests: 0` with null percentiles rather than a zero latency.
 */
export function modelsWithWindow(models, statsByModel, window) {
  return (models ?? []).map((model) => {
    const meta = model.x_ollama_router ?? model;
    const id = model.id ?? meta.id;
    // A request is logged under the model it was served by, which is the
    // backend's own name; a selectable entry is often an alias of it. Matching
    // only the selectable id would report a busy model as idle.
    const candidates = [id, meta.upstream_model, model.upstream_model, ...(meta.aliases ?? []), ...(model.aliases ?? [])]
      .filter((value, index, list) => value && list.indexOf(value) === index);
    const row = candidates.map((key) => statsByModel.get(key)).find((entry) => entry !== undefined);
    const host = meta.host ?? null;
    return {
      id,
      service: meta.service ?? null,
      aliases: meta.aliases ?? [],
      display_name: meta.display_name ?? null,
      display_name_qualified: meta.display_name_qualified ?? null,
      host,
      available: meta.health?.available ?? meta.available ?? null,
      complete: meta.complete ?? null,
      capability_score: finite(meta.capability_score),
      slots: finite(meta.active_request_limit),
      active_request_limit: finite(meta.active_request_limit),
      context_window: finite(meta.context_window),
      model_context_window: finite(meta.model_context_window),
      capabilities: meta.capabilities ?? [],
      input_modalities: meta.input_modalities ?? [],
      backend_kind: meta.backend_kind ?? null,
      quantization: meta.quantization ?? null,
      parameter_size: meta.parameter_size ?? null,
      family: meta.family ?? null,
      placement: meta.placement ?? null,
      runtime_revision: meta.runtime_revision ?? null,
      profile: meta.profile ?? null,
      qualification_notes: meta.qualification_notes ?? [],
      health: meta.health ?? null,
      configuration: meta.configuration ?? null,
      window: row
        ? { requests: row.requests, successRate: row.successRate ?? null, p50Ms: row.p50Ms ?? null, p95Ms: row.p95Ms ?? null,
            tokensIn: row.tokensIn ?? 0, tokensOut: row.tokensOut ?? 0, cancelled: row.cancelled ?? 0,
            rejected: row.rejected ?? 0, errors: row.errors ?? 0, lastTs: row.lastTs ?? null, window: window.resolved }
        : { requests: 0, successRate: null, p50Ms: null, p95Ms: null, tokensIn: 0, tokensOut: 0, cancelled: 0,
            rejected: 0, errors: 0, lastTs: null, window: window.resolved }
    };
  });
}

/** Per-machine window statistics for the configuration cards. */
export function hostsWithWindow(hosts, statsByHost, window) {
  return (hosts ?? []).map((host) => {
    const row = statsByHost.get(host.id);
    return {
      ...host,
      window: row
        ? { requests: row.requests, successRate: row.successRate ?? null, p50Ms: row.p50Ms ?? null, p95Ms: row.p95Ms ?? null,
            tokensOut: row.tokensOut ?? 0, cancelled: row.cancelled ?? 0, draining: row.draining ?? null,
            active: finite(host.active) ?? 0, queued: finite(host.queued) ?? 0, lastTs: row.lastTs ?? null, window: window.resolved }
        : { requests: 0, successRate: null, p50Ms: null, p95Ms: null, tokensOut: 0, cancelled: 0,
            draining: host.draining ?? null, active: finite(host.active) ?? 0, queued: finite(host.queued) ?? 0,
            lastTs: null, window: window.resolved }
    };
  });
}
