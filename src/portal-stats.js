// Window aggregates for the portal, computed on demand from the retained
// request ring.
//
// Deliberately stateless: the ring already holds the records with their
// timestamps, so a window query is a single in-memory pass rather than a second
// copy of history that could disagree with the first. A restart loses the
// window along with the records it was built from, which is the honest
// behaviour of a router that keeps no time-series store.

import { normalizeRecords, resolveWindow, BUCKET_SECONDS } from './portal-records.js';

const BUCKET_CAP = 600;
const DEFAULT_BUCKET = '1m';

function percentile(sorted, percentileValue) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue / 100 * sorted.length) - 1));
  return sorted[index];
}

function summary(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return { avg: null, p50: null, p95: null, p99: null, max: null, samples: 0 };
  const sum = clean.reduce((total, value) => total + value, 0);
  return {
    avg: Number((sum / clean.length).toFixed(2)),
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    p99: percentile(clean, 99),
    max: clean[clean.length - 1],
    samples: clean.length
  };
}

function rate(group) {
  const total = group.length;
  const success = group.filter((record) => record.outcome === 'success').length;
  return {
    requests: total,
    success: group.filter((record) => record.outcome === 'success').length,
    cancelled: group.filter((record) => record.outcome === 'cancelled').length,
    rejected: group.filter((record) => record.outcome === 'rejected').length,
    errors: group.filter((record) => record.outcome === 'error').length,
    pending: group.filter((record) => record.outcome === 'pending').length,
    successRate: total ? Number(((success / total) * 100).toFixed(1)) : null
  };
}

function latencyBlock(records) {
  const durations = records.map((record) => record.durationMs).filter((value) => Number.isFinite(value));
  const ttft = records.map((record) => record.ttftMs).filter((value) => Number.isFinite(value));
  const waits = records.map((record) => record.queueWaitMs).filter((value) => Number.isFinite(value));
  const rates = records.map((record) => record.tokensPerSecond).filter((value) => Number.isFinite(value));
  return { latencyMs: summary(durations), ttftMs: summary(ttft), queueWaitMs: summary(waits), tokensPerSecond: summary(rates) };
}

function groupBy(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    if (key === null || key === undefined) continue;
    const bucket = groups.get(key) || [];
    bucket.push(record);
    groups.set(key, bucket);
  }
  return groups;
}

function lastOf(records) {
  let latest = null;
  for (const record of records) {
    if (record.tsEpochMs !== null && (latest === null || record.tsEpochMs > latest)) latest = record.tsEpochMs;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function tokensOf(records, key) {
  return records.reduce((total, record) => total + (record.tokens[key] ?? 0), 0);
}

function topModels(records, limit) {
  const groups = groupBy(records, (record) => record.servedModel || record.requestedModel);
  return [...groups.entries()].map(([key, rows]) => {
    const lat = latencyBlock(rows);
    return { key, host: rows.find((row) => row.host)?.host ?? null, ...rate(rows),
      p50Ms: lat.latencyMs.p50, p95Ms: lat.latencyMs.p95, ttftP50Ms: lat.ttftMs.p50,
      tokensIn: tokensOf(rows, 'input'), tokensOut: tokensOf(rows, 'output'), lastTs: lastOf(rows) };
  }).sort((a, b) => b.requests - a.requests).slice(0, limit);
}

function topClients(records, limit) {
  const groups = groupBy(records, (record) => record.client.identity || record.client.ip);
  return [...groups.entries()].map(([key, rows]) => {
    const lat = latencyBlock(rows);
    return { key, ip: rows.find((row) => row.client.ip)?.client.ip ?? null, name: rows.find((row) => row.client.name)?.client.name ?? null,
      ...rate(rows), p95Ms: lat.latencyMs.p95, tokensOut: tokensOf(rows, 'output'), lastTs: lastOf(rows) };
  }).sort((a, b) => b.requests - a.requests).slice(0, limit);
}

function byKey(records, keyOf, extra = () => ({}), limit = 20) {
  const groups = groupBy(records, keyOf);
  return [...groups.entries()].map(([key, rows]) => {
    const lat = latencyBlock(rows);
    return { key, ...extra(key, rows), ...rate(rows), p50Ms: lat.latencyMs.p50, p95Ms: lat.latencyMs.p95,
      tokensIn: tokensOf(rows, 'input'), tokensOut: tokensOf(rows, 'output'), lastTs: lastOf(rows) };
  }).sort((a, b) => b.requests - a.requests).slice(0, limit);
}

function emptyBucket(epochMs) {
  return { epochMs, t: new Date(epochMs).toISOString(), requests: 0, ok: 0, cancelled: 0, rejected: 0, errors: 0, pending: 0,
    promptTokens: 0, outputTokens: 0, p50Ms: null, p95Ms: null, ttftP50Ms: null, active: null, queued: null };
}

/**
 * Bucket a window into a continuous series.
 *
 * Empty buckets are emitted rather than skipped: a chart with a gap where the
 * router was idle reads as missing data, and the reader cannot tell the two
 * apart. The interval widens itself to stay under BUCKET_CAP points so a 24 h
 * window still draws in one pass.
 */
function buildSeries(records, window, requestedBucket) {
  const requested = Object.hasOwn(BUCKET_SECONDS, requestedBucket ?? '') ? requestedBucket : DEFAULT_BUCKET;
  let seconds = BUCKET_SECONDS[requested];
  const spanMs = Math.max(seconds * 1000, (window.to ?? Date.now()) - (window.from ?? Date.now()));
  let buckets = Math.ceil(spanMs / (seconds * 1000));
  if (buckets > BUCKET_CAP) {
    const ladder = Object.values(BUCKET_SECONDS).sort((a, b) => a - b);
    seconds = ladder.find((candidate) => Math.ceil(spanMs / (candidate * 1000)) <= BUCKET_CAP) ?? ladder[ladder.length - 1];
    buckets = Math.ceil(spanMs / (seconds * 1000));
  }
  const rawStart = window.from ?? window.to - spanMs;
  // Aligned down to the interval, and always covering the current instant:
  // otherwise the newest request falls in the bucket after the last one and the
  // chart is silently a minute behind.
  const start = Math.floor(rawStart / (seconds * 1000)) * (seconds * 1000);
  buckets = Math.floor((window.to - start) / (seconds * 1000)) + 1;
  const series = Array.from({ length: Math.max(1, Math.min(BUCKET_CAP, buckets)) }, (unused, index) => emptyBucket(start + index * seconds * 1000));
  const rows = new Map(series.map((bucket) => [bucket.epochMs, []]));
  for (const record of records) {
    if (record.tsEpochMs === null) continue;
    const index = Math.floor((record.tsEpochMs - start) / (seconds * 1000));
    const bucket = series[index];
    if (bucket) rows.get(bucket.epochMs).push(record);
  }
  for (const bucket of series) {
    const group = rows.get(bucket.epochMs);
    if (!group.length) continue;
    const stats = rate(group);
    const lat = latencyBlock(group);
    Object.assign(bucket, stats, { p50Ms: lat.latencyMs.p50, p95Ms: lat.latencyMs.p95, ttftP50Ms: lat.ttftMs.p50,
      promptTokens: tokensOf(group, 'input'), outputTokens: tokensOf(group, 'output') });
    bucket.ok = stats.success;
  }
  return { requested, widened: requested !== null && BUCKET_SECONDS[requested] !== seconds, bucketSeconds: seconds,
    from: series[0].t, to: series[series.length - 1].t, kept: series.length, buckets: series };
}

function totals(records) {
  const stats = rate(records);
  const lat = latencyBlock(records);
  const byStatus = {};
  for (const record of records) {
    const key = String(record.status ?? 'unknown');
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  return { requests: records.length, allowed: records.filter((record) => record.allowed === true).length,
    // A count of upstream failures, not of non-2xx responses: a client hanging
    // up is not the backend being broken, and an operator triages them apart.
    upstreamErrors: records.filter((record) => record.outcome === 'error').length,
    rejected: records.filter((record) => record.outcome === 'rejected').length,
    cancelled: records.filter((record) => record.outcome === 'cancelled').length,
    errors: records.filter((record) => record.outcome === 'error').length,
    pending: records.filter((record) => record.outcome === 'pending').length,
    successRate: stats.successRate, ...lat, byStatus,
    tokens: { input: tokensOf(records, 'input'), output: tokensOf(records, 'output') },
    requestsWithJournal: records.filter((record) => record.journal.state === 'archived').length,
    firstTs: records.length ? new Date(Math.min(...records.filter((record) => record.tsEpochMs !== null).map((record) => record.tsEpochMs))).toISOString() : null,
    lastTs: lastOf(records) };
}

/**
 * The response body of GET /admin/api/stats.
 *
 * @param records raw stored request records (the retained ring)
 * @param options.window `1h`, `6h`, `24h`, `all`, or an ISO timestamp
 * @param options.hosts the declared fleet, so per-host rows exist even at zero
 */
export function buildStats(records, options = {}) {
  const window = resolveWindow(options.window, options.defaultWindow ?? '1h');
  const view = options.view ?? {};
  const all = normalizeRecords(records, view);
  const inWindow = window.seconds === null ? all
    : all.filter((record) => record.tsEpochMs !== null && record.tsEpochMs >= window.from && record.tsEpochMs <= window.to);

  const hosts = byKey(inWindow, (record) => record.host, (key, rows) => ({
    default: key === view.defaultHost,
    draining: view.hostDraining?.(key) ?? null
  }), 20);
  const known = new Set(hosts.map((row) => row.key));
  for (const hostId of view.hostIds ?? []) {
    if (known.has(hostId)) continue;
    hosts.push({ key: hostId, default: hostId === view.defaultHost, draining: view.hostDraining?.(hostId) ?? null,
      requests: 0, success: 0, cancelled: 0, rejected: 0, errors: 0, pending: 0, successRate: null,
      p50Ms: null, p95Ms: null, tokensIn: 0, tokensOut: 0, lastTs: null });
  }

  const byError = [...groupBy(inWindow.filter((record) => record.errorCode), (record) => record.errorCode).entries()]
    .map(([code, rows]) => ({ code, count: rows.length, lastTs: lastOf(rows) }))
    .sort((a, b) => b.count - a.count);

  const series = buildSeries(inWindow, window, options.bucket);
  const windowTotals = totals(inWindow);
  return {
    window: { requested: window.requested, resolved: window.resolved, seconds: window.seconds,
      from: window.from === null ? null : new Date(window.from).toISOString(), to: new Date(window.to).toISOString(),
      valid: window.valid },
    series,
    totals: windowTotals,
    sinceStart: totals(all),
    byModel: topModels(inWindow, options.modelLimit ?? 30),
    byHost: hosts,
    byClient: topClients(inWindow, options.clientLimit ?? 12),
    byEndpoint: byKey(inWindow, (record) => `${record.method} ${record.endpoint}`, (key, rows) => ({
      protocol: rows[0].protocol, streaming: rows[0].streaming, host: rows[0].host }), 12),
    byProtocol: byKey(inWindow, (record) => record.protocol, () => ({}), 10),
    byError,
    // Repeated at the top level, as documented in docs/PORTAL_API.md §6: these
    // are window aggregates rather than per-group rows, and a caller reading
    // `stats.latencyMs` should not have to know they also live in `totals`.
    bucket: { requested: series.requested ?? null, seconds: series.bucketSeconds, kept: series.kept, widened: series.widened },
    byStatus: windowTotals.byStatus,
    latencyMs: windowTotals.latencyMs,
    ttftMs: windowTotals.ttftMs,
    queueWaitMs: windowTotals.queueWaitMs,
    tokensPerSecond: windowTotals.tokensPerSecond,
    tokens: windowTotals.tokens,
    generatedAt: new Date().toISOString()
  };
}

/** Per-model window statistics, merged into the model list of portal/state. */
export function modelWindowStats(records, options = {}) {
  const stats = buildStats(records, { ...options, modelLimit: Number.MAX_SAFE_INTEGER });
  const byModel = new Map(stats.byModel.map((row) => [row.key, row]));
  return { stats, byModel };
}

export { buildSeries };
