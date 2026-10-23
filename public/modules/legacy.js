/* Compatibility shim for a router that predates the portal API. Nothing here
   invents a number: it renames what the older fields already said, and leaves
   everything else absent so the renderers draw their honest em dash. Used only
   when /admin/api/portal/state answers 404 (see app.js). */

const ENDPOINT_PROTOCOLS = [
  ['/v1/responses', 'responses', 'OpenAI Responses'],
  ['/responses', 'responses', 'OpenAI Responses'],
  ['/v1/chat/completions', 'chat', 'OpenAI Chat'],
  ['/chat/completions', 'chat', 'OpenAI Chat'],
  ['/api/chat', 'ollama-chat', 'Ollama chat'],
  ['/api/generate', 'ollama-generate', 'Ollama generate'],
  ['/api/tags', 'discovery', 'Ollama discovery'],
  ['/api/ps', 'discovery', 'Ollama ps'],
  ['/api/show', 'discovery', 'Ollama show'],
  ['/v1/models', 'discovery', 'Model discovery']
];

export function protocolOf(endpoint = '') {
  const path = String(endpoint).split('?')[0];
  for (const [prefix, protocol, label] of ENDPOINT_PROTOCOLS) {
    if (path === prefix || path.endsWith(prefix)) return { protocol, protocolLabel: label };
  }
  return { protocol: 'other', protocolLabel: 'Other' };
}

export function kindOf(endpoint = '') {
  const { protocol } = protocolOf(endpoint);
  if (protocol === 'discovery') return 'discovery';
  if (protocol === 'other') return 'control';
  return 'prompt';
}

function usageTokens(usage = {}) {
  const input = usage.prompt_eval_count ?? usage.prompt_tokens ?? usage.input_tokens ?? null;
  const output = usage.eval_count ?? usage.completion_tokens ?? usage.output_tokens ?? null;
  const total = usage.total_tokens ?? (input != null || output != null ? (input || 0) + (output || 0) : null);
  return { input, output, total: total === 0 ? null : total };
}

function outcomeOf(record) {
  const status = Number(record.responseStatus ?? record.status ?? 0);
  const code = record.errorCode || record.errorSummary || '';
  if (!status && !record.responseStatus) return 'pending';
  if (status >= 200 && status < 300) return 'success';
  if (status === 499 || String(code).includes('CLIENT_CLOSED_REQUEST')) return 'cancelled';
  if (record.rejected === true || record.allowed === false) return 'rejected';
  return 'error';
}

export function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return record;
  if (record.schema === 2) return record;
  const { protocol, protocolLabel } = protocolOf(record.endpoint);
  const tokens = usageTokens(record.usage || {});
  const tokensPerSecond = tokens.output && record.latencyMs && record.ttftMs == null
    ? Number(((tokens.output / record.latencyMs) * 1000).toFixed(1))
    : record.tokensPerSecond ?? null;
  return {
    ...record,
    schema: record.schema ?? 1,
    tsEpochMs: record.tsEpochMs ?? (record.ts ? new Date(record.ts).getTime() : null),
    protocol,
    protocolLabel,
    kind: record.kind || kindOf(record.endpoint),
    host: record.host ?? null,
    hostDefault: record.hostDefault ?? false,
    requestedModel: record.requestedModel ?? null,
    servedModel: record.forwardedModel ?? record.activeModel ?? null,
    client: {
      name: String(record.clientIdentity || '').split('/')[0] || null,
      identity: record.clientIdentity ?? null,
      ip: record.sourceIp ?? null,
      userAgent: record.userAgent ?? null
    },
    outcome: record.outcome || outcomeOf(record),
    durationMs: record.latencyMs ?? null,
    ttftMs: record.ttftMs ?? null,
    queueWaitMs: record.queueWaitMs ?? null,
    admissionWaitMs: record.admissionWaitMs ?? null,
    tokens: record.tokens || (tokens.input != null || tokens.output != null ? tokens : {}),
    tokensPerSecond,
    journal: record.journal || (record.generationRecordId
      ? { id: record.generationRecordId, available: true, state: 'archived' }
      : { available: false, state: 'not_archived' }),
    errorCode: record.errorCode ?? null,
    errorMessage: record.errorMessage ?? record.errorSummary ?? null
  };
}

function modelWindow(metrics, id) {
  const counts = metrics?.byModel?.[id];
  const tokens = metrics?.tokensByModel?.[id];
  if (counts == null && tokens == null) return null;
  return {
    requests: counts ?? null,
    successRate: null,
    p50Ms: null,
    p95Ms: null,
    tokensIn: tokens?.prompt ?? null,
    tokensOut: tokens?.output ?? null,
    cancelled: null,
    rejected: null,
    lastTs: null
  };
}

/* The pre-v2 summary/hosts/metrics trio reshaped into the portal/state document
   the renderers expect, so a router without section 1 still paints every section it
   can prove. */
export function synthesizePortal({ summary, hosts, metrics }) {
  const router = summary?.router || {};
  const config = summary?.config || {};
  const runtime = summary?.runtime || {};
  const retention = summary?.logs?.generationRetention || {};
  const models = (summary?.models || []).map((entry) => {
    const meta = entry.x_ollama_router || {};
    const id = entry.id || meta.upstream_model;
    return {
      id,
      service: meta.service || (meta.aliases || [])[0] || id,
      aliases: meta.aliases || [],
      display_name: meta.display_name || id,
      display_name_qualified: meta.display_name_qualified || meta.display_name || id,
      host: meta.host || null,
      available: meta.health ? meta.health.available !== false : true,
      complete: true,
      capability_score: meta.capability_score ?? null,
      slots: meta.active_request_limit ?? meta.slots ?? null,
      active_request_limit: meta.active_request_limit ?? meta.slots ?? null,
      context_window: meta.context_window ?? null,
      model_context_window: meta.model_context_window ?? meta.context_window ?? null,
      capabilities: meta.capabilities || [],
      input_modalities: meta.input_modalities || [],
      backend_kind: meta.backend_kind ?? null,
      quantization: meta.quantization ?? null,
      placement: meta.placement ?? null,
      health: meta.health ?? null,
      window: modelWindow(metrics, id)
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    window: null,
    router: {
      version: router.version ?? null,
      startedAt: router.startedAt ?? null,
      uptimeSeconds: router.uptimeSeconds ?? null,
      maintenanceMode: router.maintenanceMode ?? false,
      api: router.api || {},
      admin: router.admin ? { host: router.admin.bindHost, port: router.admin.port, authRequired: router.admin.authRequired } : {}
    },
    state: {
      admission: runtime.draining ? 'draining' : router.maintenanceMode ? 'maintenance' : 'accepting',
      draining: runtime.draining ?? null,
      maintenanceMode: router.maintenanceMode ?? null,
      inFlight: {
        active: runtime.active_count ?? null,
        queued: runtime.queued_count ?? null,
        byHost: runtime.byHost ?? null
      },
      listeners: {
        api: router.api || null,
        admin: router.admin ? { host: router.admin.bindHost, port: router.admin.port, authRequired: router.admin.authRequired } : null
      },
      retention: {
        requestHistoryLimit: config.requestHistoryLimit ?? null,
        requestLogMaxBytes: config.requestLogMaxBytes ?? null,
        eventHistoryLimit: config.eventHistoryLimit ?? null,
        promptLogging: config.promptLogging ?? null,
        generationRetentionDays: retention.retentionDays ?? config.generationRetentionDays ?? null,
        generationMaxBytes: retention.maxBytes ?? config.generationMaxBytes ?? null,
        archives: {
          activeFiles: retention.activeFiles ?? null,
          closedFiles: retention.closedFiles ?? null,
          closedBytes: retention.closedBytes ?? null,
          lastRunAt: retention.lastRunAt ?? null,
          lastError: retention.lastError ?? null
        }
      },
      fleet: { hosts: config.routerHosts || [], defaultHost: config.defaultHost ?? null, catalogMaxAgeMs: config.catalogMaxAgeMs ?? null },
      capabilities: null
    },
    hosts: hosts?.hosts || summary?.hosts || [],
    models,
    offlineServices: summary?.offlineServices || [],
    metrics: metrics || null,
    warnings: summary?.warnings || []
  };
}
