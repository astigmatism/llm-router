// The portal's read model.
//
// Stored request records stay exactly as they have always been written: the
// dashboard used to show a few of them raw, which forced the browser to derive
// what a request *was* (protocol, machine, outcome, rate) from whichever keys a
// given code path happened to set. This module derives those once, for every
// record, so every response the portal reads agrees - including records that an
// older build wrote before the field existed. Never invented: a value that was
// not measured is null, and the UI renders a dash rather than a zero.

const PROTOCOLS = new Map([
  ['/v1/responses', { protocol: 'responses', label: 'OpenAI Responses', kind: 'prompt' }],
  ['/v1/chat/completions', { protocol: 'chat', label: 'OpenAI Chat Completions', kind: 'prompt' }],
  ['/api/chat', { protocol: 'ollama-chat', label: 'Ollama chat', kind: 'prompt' }],
  ['/api/generate', { protocol: 'ollama-generate', label: 'Ollama generate', kind: 'prompt' }],
  ['/api/tags', { protocol: 'discovery', label: 'Ollama catalog (tags)', kind: 'discovery' }],
  ['/api/ps', { protocol: 'discovery', label: 'Ollama catalog (ps)', kind: 'discovery' }],
  ['/api/version', { protocol: 'discovery', label: 'Ollama version', kind: 'discovery' }],
  ['/v1/models', { protocol: 'discovery', label: 'OpenAI model list', kind: 'discovery' }],
  ['/v1/router/capabilities', { protocol: 'router-api', label: 'Router capabilities', kind: 'control' }],
  ['/health', { protocol: 'health', label: 'Health probe', kind: 'control' }]
]);

const CANCELLED_CODES = new Set(['CLIENT_CLOSED_REQUEST', 'ABORTED_BY_CLIENT']);
const WINDOW_SECONDS = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, all: null };
const BUCKET_SECONDS = { '10s': 10, '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };

function number(value) {
  return Number.isFinite(value) ? value : null;
}

function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return { input: null, output: null, total: null };
  const input = number(usage.prompt_eval_count ?? usage.prompt_tokens ?? usage.input_tokens);
  const output = number(usage.eval_count ?? usage.completion_tokens ?? usage.output_tokens);
  const total = number(usage.total_tokens) ?? ((input ?? 0) + (output ?? 0) || null);
  return { input, output, total };
}

export function protocolOf(endpoint) {
  const known = PROTOCOLS.get(endpoint);
  if (known) return known;
  if (typeof endpoint === 'string' && endpoint.startsWith('/admin/api/')) {
    return { protocol: 'control', label: 'Router admin API', kind: 'control' };
  }
  return { protocol: 'other', label: endpoint || 'unknown', kind: 'other' };
}

// success | cancelled | rejected | error | pending
//
// The distinction that matters operationally is between a request the router
// never admitted (policy, drain, maintenance, capacity), a client that hung up,
// and a backend that failed after admission. All three land in the 4xx/5xx
// range, and only `rejected` is fixable by changing the router's configuration.
export function outcomeOf(record) {
  const status = number(record.responseStatus ?? record.status);
  if (record.pending || status === null) return 'pending';
  if (status >= 200 && status < 300) return 'success';
  if (status === 499 || CANCELLED_CODES.has(record.errorCode)) return 'cancelled';
  if (record.rejected || record.allowed === false) return 'rejected';
  return 'error';
}

function clientOf(record) {
  const identity = record.clientIdentity || null;
  const name = identity ? String(identity).split('/')[0] : null;
  return { name: name || null, identity, ip: record.sourceIp || null, userAgent: record.userAgent ?? null };
}

function samplingOf(record) {
  return {
    thinking: record.incomingThink ?? null,
    forwardedThinking: record.forwardedThink ?? null,
    reasoningEffort: record.reasoningEffort ?? null,
    thinkMapped: record.thinkMapped ?? null,
    thinkDropped: record.thinkDropped ?? null,
    outputLimitPolicy: record.outputLimitPolicy ?? null,
    requestedOutputTokens: record.requestedOutputTokens ?? null,
    effectiveOutputTokens: record.effectiveOutputTokens ?? null,
    temperatureForwarding: record.temperatureForwarding ?? null,
    forwardedTemperature: record.forwardedTemperature ?? null,
    seedForwarded: record.seedForwarded ?? null,
    samplingControls: Array.isArray(record.samplingControls) ? record.samplingControls : null,
    keepAlive: { incoming: record.incomingKeepAlive ?? null, forwarded: record.forwardedKeepAlive ?? null, normalized: record.keepAliveNormalized ?? null }
  };
}

function toolsOf(record) {
  const count = number(record.toolCount);
  const dropped = number(record.toolsDropped);
  return {
    present: record.toolsPresent ?? (count !== null && count > 0),
    count,
    forwarded: count !== null && dropped !== null ? Math.max(0, count - dropped) : null,
    dropped,
    unsupportedPolicy: record.unsupportedToolsPolicy ?? null,
    supported: record.toolsSupported ?? null,
    historyPresent: record.toolHistoryPresent ?? null
  };
}

// Which payload archive exists for this request, and why when it does not.
//
// A journal is only opened once a request is admitted and a generation starts,
// so a pre-admission refusal can never have one; claiming otherwise would send
// the reader looking for a file that was never created.
function journalOf(record, journals) {
  const id = record.generationRecordId ?? null;
  const preAdmission = outcomeOf(record) === 'rejected' || record.allowed === false;
  if (id) {
    const exists = journals?.has?.(id);
    return { id, available: exists !== false, state: exists === false ? 'expired' : 'archived' };
  }
  if (preAdmission) return { id: null, available: false, state: 'pre_admission' };
  if (protocolOf(record.endpoint).kind !== 'prompt') return { id: null, available: false, state: 'not_applicable' };
  return { id: null, available: false, state: 'not_archived' };
}

/**
 * Normalize one stored record for the portal.
 *
 * @param record a record exactly as persisted by the request pipeline
 * @param view.hostOf model id (or alias) -> host id, from the published catalogs
 * @param view.defaultHost the host an unnamed request falls back to
 * @param view.upstreamOf host id -> backend base URL
 * @param view.journals set of generation journal ids that still exist on disk
 */
export function normalizeRecord(record, view = {}) {
  const wire = protocolOf(record.endpoint);
  const served = record.forwardedModel || record.activeModel || null;
  // Attribution, in order of trust: what the request itself recorded, then the
  // catalog that was accepted for the model it was served by, then the default
  // machine - which is where an unattributed request in fact ran, but is
  // labelled as an inference so the dashboard can say so out loud.
  const mapped = record.host ?? view.hostOf?.(served ?? record.requestedModel) ?? null;
  const host = mapped ?? view.defaultHost ?? null;
  const hostSource = record.host ? 'record' : (mapped ? 'catalog' : (host ? 'default' : null));
  const status = number(record.responseStatus ?? record.status);
  const outcome = outcomeOf(record);
  const tokens = usageTokens(record.usage);
  const ttftMs = number(record.ttftMs);
  const durationMs = number(record.latencyMs);
  // Two different rates, deliberately not blended: the router's own view
  // (tokens over the wait the client experienced) and, when a backend reports
  // throughput, its view. Mixing them would make two rows look comparable when
  // they were measured on different clocks.
  const generationMs = durationMs !== null ? durationMs - (ttftMs ?? 0) : null;
  const rate = tokens.output && generationMs > 250 ? Number((tokens.output / (generationMs / 1000)).toFixed(2)) : null;
  const promptCacheKey = Object.hasOwn(record, 'promptCacheKeyPresent')
    ? { present: Boolean(record.promptCacheKeyPresent), disposition: record.promptCacheKeyDisposition ?? null }
    : null;
  return {
    schema: 2,
    id: record.id ?? null,
    ts: record.ts ?? null,
    tsEpochMs: record.ts ? Date.parse(record.ts) : null,
    method: record.method ?? null,
    endpoint: record.endpoint ?? null,
    query: record.query ?? '',
    protocol: wire.protocol,
    protocolLabel: wire.label,
    kind: wire.kind,
    host,
    hostSource,
    hostDefault: host !== null && host === view.defaultHost,
    upstreamUrl: (host && view.upstreamOf?.(host)) ?? record.upstreamUrl ?? null,
    requestedModel: record.requestedModel ?? null,
    servedModel: served,
    activeModel: record.activeModel ?? null,
    modelRewritten: record.modelRewritten ?? null,
    alias: record.requestedModel && record.requestedModel !== served ? record.requestedModel : null,
    client: clientOf(record),
    status,
    responseStatus: number(record.responseStatus),
    outcome,
    allowed: record.allowed ?? null,
    rejected: record.rejected ?? null,
    errorCode: record.errorCode ?? null,
    errorMessage: record.errorSummary ?? record.errorMessage ?? null,
    errorBodyExcerpt: record.errorBodyExcerpt ?? null,
    durationMs,
    ttftMs,
    queueWaitMs: number(record.queueWaitMs),
    admissionWaitMs: number(record.admissionWaitMs),
    streaming: record.streaming ?? null,
    requestBytes: number(record.requestBytes),
    responseBytes: number(record.responseBytes),
    tokens,
    tokensPerSecond: rate,
    tokensPerSecondBasis: rate !== null && ttftMs !== null ? 'ttft-adjusted' : (rate !== null ? 'duration' : null),
    backendTokensPerSecond: number(record.usage?.eval_tokens_per_second ?? record.usage?.generation_tokens_per_second),
    usage: record.usage ?? null,
    finishReason: record.finishReason ?? null,
    completionState: record.completionState ?? null,
    stopReason: record.stopReason ?? null,
    incomplete: record.incomplete ?? null,
    incompleteReason: record.incompleteReason ?? null,
    outputItems: number(record.outputItems),
    sampling: samplingOf(record),
    tools: toolsOf(record),
    promptCacheKey,
    contextTransitions: number(record.contextTransitions),
    contextPolicy: record.contextPolicy ?? null,
    streamParseErrors: number(record.streamParseErrors),
    backendKind: record.backendKind ?? null,
    journal: journalOf(record, view.journals),
    bodySummary: record.bodySummary ?? null
  };
}

export function normalizeRecords(records, view = {}) {
  return records.map((record) => normalizeRecord(record, view));
}

function parseWhen(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value).trim();
  const window = WINDOW_SECONDS[text];
  if (window === undefined) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  return window === null ? null : Date.now() - window * 1000;
}

export function resolveWindow(value, fallback = '1h') {
  const requested = value === undefined || value === null || value === '' ? fallback : String(value).trim();
  const known = Object.hasOwn(WINDOW_SECONDS, requested) ? requested : fallback;
  const seconds = WINDOW_SECONDS[known];
  const to = Date.now();
  return {
    requested,
    resolved: known,
    seconds,
    from: seconds === null ? null : to - seconds * 1000,
    to,
    valid: known === requested
  };
}

function matchesQuery(record, needle) {
  const q = needle.toLowerCase();
  const fields = [record.id, record.requestedModel, record.servedModel, record.activeModel, record.endpoint,
    record.client?.identity, record.client?.ip, record.errorCode, record.errorMessage, record.protocolLabel];
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(q));
}

/**
 * Filter and page normalized records, newest first.
 *
 * `total` counts the rows that matched before paging, which is what lets the
 * portal print a real page count; the previous endpoint could only promise
 * "the last N records", and the dashboard could not tell a full window from a
 * truncated one.
 */
export function queryRequests(records, params = {}, view = {}) {
  const normalized = normalizeRecords(records, view);
  const since = parseWhen(params.since, null);
  const until = parseWhen(params.until, null);
  const limit = Math.max(1, Math.min(500, Number(params.limit ?? 50) || 50));
  const offset = Math.max(0, Number(params.offset ?? 0) || 0);
  const models = listParam(params.model);
  const hosts = listParam(params.host);
  const statuses = listParam(params.status);
  const errorCodes = listParam(params.error_code);
  const client = params.client ? String(params.client).toLowerCase() : null;
  const filters = { since: since === null ? null : new Date(since).toISOString(), until: until === null ? null : new Date(until).toISOString(),
    model: models, host: hosts, status: statuses, error_code: errorCodes, client, outcome: params.outcome || null,
    protocol: params.protocol || null, streaming: params.streaming === undefined ? null : params.streaming === 'true',
    has_journal: params.has_journal === undefined ? null : params.has_journal === 'true', q: params.q || null };

  const matched = normalized.filter((record) => {
    if (since !== null && (record.tsEpochMs === null || record.tsEpochMs < since)) return false;
    if (until !== null && (record.tsEpochMs === null || record.tsEpochMs > until)) return false;
    if (models.length && !models.some((model) => model === record.requestedModel || model === record.servedModel || model === record.alias)) return false;
    if (hosts.length && !hosts.includes(record.host)) return false;
    if (statuses.length && !statuses.some((status) => (
      /x$/.test(status) ? String(record.status ?? '').startsWith(status[0]) : String(record.status ?? '') === status))) return false;
    if (errorCodes.length && !errorCodes.includes(record.errorCode)) return false;
    if (params.outcome && record.outcome !== params.outcome) return false;
    if (params.protocol && record.protocol !== params.protocol) return false;
    if (filters.streaming !== null && Boolean(record.streaming) !== filters.streaming) return false;
    if (filters.has_journal !== null && (record.journal.state === 'archived') !== filters.has_journal) return false;
    if (client && !(`${record.client.identity} ${record.client.ip}`.toLowerCase().includes(client))) return false;
    if (filters.q && !matchesQuery(record, filters.q)) return false;
    return true;
  });

  const sort = String(params.sort || 'ts');
  const dir = params.dir === 'asc' ? 1 : -1;
  const sortable = { ts: (r) => r.tsEpochMs ?? 0, duration: (r) => r.durationMs ?? -1, ttft: (r) => r.ttftMs ?? -1,
    tokens: (r) => r.tokens.total ?? -1, outcome: (r) => r.status ?? 0, model: (r) => r.servedModel ?? '' };
  if (sortable[sort]) matched.sort((a, b) => (sortable[sort](a) < sortable[sort](b) ? -1 : sortable[sort](a) > sortable[sort](b) ? 1 : 0) * dir);

  return { requests: matched.slice(offset, offset + limit), page: { limit, offset, returned: Math.min(limit, Math.max(0, matched.length - offset)), total: matched.length, hasMore: offset + limit < matched.length }, filters };
}

function listParam(value) {
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(',').map((part) => part.trim()).filter(Boolean);
}

/** Same newest-first view the request log keeps, filtered by event type. */
export function queryEvents(events, params = {}) {
  const types = listParam(params.type);
  const needle = params.q ? String(params.q).toLowerCase() : null;
  const limit = Math.max(1, Math.min(500, Number(params.limit ?? 100) || 100));
  const offset = Math.max(0, Number(params.offset ?? 0) || 0);
  const since = parseWhen(params.since, null);
  const matched = events.filter((event) => {
    if (types.length && !types.includes(event.type)) return false;
    if (since !== null && Date.parse(event.ts) < since) return false;
    if (needle && !JSON.stringify(event).toLowerCase().includes(needle)) return false;
    return true;
  });
  return { events: matched.slice(offset, offset + limit), page: { limit, offset, returned: Math.min(limit, Math.max(0, matched.length - offset)), total: matched.length, hasMore: offset + limit < matched.length } };
}

export { BUCKET_SECONDS, WINDOW_SECONDS };
