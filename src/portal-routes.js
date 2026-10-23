// Routes whose whole purpose is the redesigned portal.
//
// Kept out of server.js because they are read-only projections of state the
// router already holds, and because their inputs arrive as callbacks: the host
// list, the model list and the active-model marker are all resolved by the
// server that owns the listeners, and this module must not reach into that.
// Every route here answers the same question in a different shape - "what has
// this router done, and what is it doing right now" - so they live together.

import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { sendJson } from './http-utils.js';
import { normalizeRecord, queryRequests, resolveWindow } from './portal-records.js';
import { buildStats } from './portal-stats.js';
import { admissionState, fleetWarnings, inFlight, modelsWithWindow, hostsWithWindow } from './portal-state.js';
import { readJournalView } from './journal-view.js';

const JOURNAL_TTL_MS = 15000;

// Same envelope the rest of the router answers with, so a portal client parses
// one error shape no matter which route produced it.
function errorPayload(code, message, details = undefined) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/**
 * Which payload archives exist on disk, refreshed on a short TTL.
 *
 * The dashboard marks a request whose archive retention has already swept. A
 * stale answer here is worse than a lagging one - the reader would go looking
 * for a file that is gone - but re-reading the directory for every row of a
 * page would cost more than the page is worth.
 */
export async function knownJournals(context) {
  const now = Date.now();
  if (!context.journals || now - (context.journalsAt ?? 0) > JOURNAL_TTL_MS) {
    try {
      const names = await readdir(path.join(context.config.dataDir, 'generations'));
      context.journals = new Set(names.filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length)));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('failed to list generation archives', error);
      context.journals = context.journals ?? new Set();
    }
    context.journalsAt = now;
  }
  return context.journals;
}

/** How a stored record maps onto the fleet: model -> machine, machine -> drain. */
export function statsView(context, gate = context.requestGate.snapshot()) {
  const draining = new Set([...(gate.draining_hosts ?? []), ...(gate.draining ? context.config.routerHosts : [])]);
  return {
    defaultHost: context.config.defaultHost,
    hostIds: context.config.routerHosts,
    hostOf: (model) => (model ? context.modelHosts.get(model) ?? null : null),
    hostDraining: (host) => (host ? draining.has(host) : null),
    hostDrainingMap: draining
  };
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Window aggregates plus the facts that make them readable.
 *
 * A machine with no traffic still needs a row, otherwise a host that stopped
 * serving looks like a host that was never declared; and "since start" has to
 * mean the process start, not the beginning of the retention window.
 */
function withRouterContext(context, stats) {
  return {
    ...stats,
    router: { startedAt: context.state.startedAt, uptimeSeconds: Math.round(process.uptime()), version: context.config.version },
    fleet: { hosts: context.config.routerHosts, defaultHost: context.config.defaultHost }
  };
}

async function handleJournal(response, id, context) {
  await knownJournals(context);
  // A row links to the archive by its own id; the file is named after the
  // generation. Resolve one to the other here, or every request-detail read
  // would answer "expired" for an archive sitting on disk.
  const linked = context.store.requests.find((entry) => entry.id === id || entry.generationRecordId === id);
  const journalId = linked?.generationRecordId ?? id;
  let view;
  try {
    view = await readJournalView({
      dir: path.join(context.config.dataDir, 'generations'),
      id: journalId,
      maxBytes: context.config.portalJournalViewBytes,
      promptBytes: context.config.portalPromptViewBytes
    });
  } catch (error) {
    if (error.code === 'INVALID_RECORD_ID') {
      sendJson(response, 400, errorPayload('INVALID_RECORD_ID', error.message));
      return;
    }
    throw error;
  }
  if (!view) {
    const details = { recordId: linked?.id ?? id, journalId, retentionDays: context.config.generationRetentionDays };
    if (!linked) {
      sendJson(response, 404, errorPayload('JOURNAL_NOT_FOUND',
        'No generation archive with that id, and no request in the retained window refers to one.', details));
      return;
    }
    if (!linked.generationRecordId) {
      // The distinction an operator needs: expired means "too late", this means
      // "this backend never wrote one" (only catalog-backed runtimes archive).
      sendJson(response, 404, errorPayload('JOURNAL_NEVER_OPENED',
        'That request has no generation archive. Requests refused before admission never open one, and a backend serving an active-model marker instead of a published catalog does not write them.',
        { ...details, outcome: linked.outcome, errorCode: linked.errorCode ?? null }));
      return;
    }
    sendJson(response, 404, errorPayload('JOURNAL_EXPIRED',
      'That generation archive is gone: retention has removed it, or it is still being written.', details));
    return;
  }
  sendJson(response, 200, {
    ...view,
    recordId: linked?.id ?? id,
    record: linked ? normalizeRecord(linked, context.portalView) : null
  });
}

async function handlePortalState(response, params, context, deps) {
  await knownJournals(context);
  const window = resolveWindow(params.get('window') ?? undefined, '1h');
  const activeModel = await deps.readDeploymentActiveModel(context.config);
  const gate = context.requestGate.snapshot(activeModel);
  const [hostsResult, models] = await Promise.all([deps.deploymentHosts(context), deps.summaryModels(context)]);
  const stats = withRouterContext(context, buildStats(context.store.requests, { window: params.get('window') ?? undefined, view: statsView(context, gate) }));
  const byModel = new Map(stats.byModel.map((row) => [row.key, row]));
  const byHost = new Map(stats.byHost.map((row) => [row.key, row]));
  const retention = {
    requestHistoryLimit: context.config.requestHistoryLimit,
    requestLogMaxBytes: context.config.requestLogMaxBytes,
    eventHistoryLimit: context.config.eventHistoryLimit,
    promptLogging: context.config.promptLogging,
    generationRetentionDays: context.config.generationRetentionDays,
    generationMaxBytes: context.config.generationMaxBytes,
    archives: context.generationRetention.snapshot()
  };
  const admission = admissionState({
    draining: gate.draining,
    maintenanceMode: context.state.maintenanceMode,
    hostDrain: new Map(Object.entries(gate.hosts ?? {}))
  });
  const warnings = fleetWarnings({ hosts: hostsResult.hosts, config: context.config, gate, metrics: context.metrics.snapshot(), retention });
  if (!window.valid) {
    warnings.unshift({ severity: 'info', code: 'WINDOW_FALLBACK', message: `Unknown window ${JSON.stringify(window.requested)}; using ${window.resolved}.` });
  }
  if (hostsResult.error) {
    warnings.unshift({ severity: 'error', code: 'HOSTS_UNREADABLE', message: `The host list could not be read: ${hostsResult.error.message || hostsResult.error}` });
  }
  sendJson(response, 200, {
    generatedAt: nowIso(),
    schema: 2,
    window: {
      requested: window.requested,
      resolved: window.resolved,
      seconds: window.seconds,
      from: window.from === null ? null : new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString()
    },
    router: {
      appName: context.config.appName,
      version: context.config.version,
      startedAt: context.state.startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      api: { host: context.config.host, port: context.config.port },
      admin: { enabled: context.config.adminEnabled, bindHost: context.config.adminBindHost, port: context.config.adminPort, authRequired: false },
      portal: { schema: 2, endpoints: ['portal/state', 'requests', 'requests/:id', 'requests/:id/journal', 'stats', 'events', 'capabilities', 'stream'] }
    },
    state: {
      admission: admission.state,
      admissionDetail: admission.detail,
      draining: Boolean(gate.draining),
      drainReason: gate.drain_reason ?? null,
      maintenanceMode: context.state.maintenanceMode,
      inFlight: inFlight(gate, hostsResult.hosts),
      listeners: {
        api: { host: context.config.host, port: context.config.port },
        admin: { enabled: context.config.adminEnabled, host: context.config.adminBindHost, port: context.config.adminPort, authRequired: false }
      },
      retention,
      fleet: { hosts: context.config.routerHosts, defaultHost: context.config.defaultHost },
      capabilities: { revision: context.capabilities?.revision ?? null }
    },
    hosts: hostsWithWindow(hostsResult.hosts, byHost, window),
    models: modelsWithWindow(models, byModel, window),
    stats,
    metrics: context.metrics.snapshot(),
    warnings
  });
}

/**
 * Dispatch one portal route.
 *
 * @returns true when the route was handled here, false to fall through to the
 *   caller's own routing (the legacy list endpoints stay in server.js)
 */
export async function handlePortalRoute(request, response, pathname, context, deps) {
  const url = new URL(request.url, 'http://router.local');
  const params = url.searchParams;

  if (request.method === 'GET' && pathname === '/admin/api/portal/state') {
    await handlePortalState(response, params, context, deps);
    return true;
  }

  if (request.method === 'GET' && pathname === '/admin/api/stats') {
    sendJson(response, 200, withRouterContext(context, buildStats(context.store.requests, {
      window: params.get('window') ?? undefined,
      bucket: params.get('bucket') ?? undefined,
      view: statsView(context)
    })));
    return true;
  }

  if (request.method === 'GET' && pathname === '/admin/api/requests') {
    const query = Object.fromEntries(params);
    const result = queryRequests(context.store.requests, query, context.portalView);
    // A bare ?limit= keeps the historical shape; any other parameter implies a
    // paged reader that needs the total to print a page count.
    if (query.raw === '1') {
      sendJson(response, 200, { requests: context.store.recentRequests(query.limit) });
      return true;
    }
    const paged = Object.keys(query).some((key) => key !== 'limit');
    sendJson(response, 200, paged ? { ...result, generatedAt: nowIso() } : { requests: result.requests });
    return true;
  }

  const journalRoute = pathname.match(/^\/admin\/api\/requests\/([0-9a-f-]{36})\/journal$/);
  if (request.method === 'GET' && journalRoute) {
    await handleJournal(response, journalRoute[1], context);
    return true;
  }

  const requestRoute = pathname.match(/^\/admin\/api\/requests\/([0-9a-f-]{36})$/);
  if (request.method === 'GET' && requestRoute) {
    const found = context.store.requests.find((record) => record.id === requestRoute[1]);
    if (!found) {
      sendJson(response, 404, errorPayload('REQUEST_NOT_FOUND',
        'That request id is not in the retained history window.',
        { requestHistoryLimit: context.config.requestHistoryLimit, promptLogging: context.config.promptLogging }));
      return true;
    }
    const related = context.store.recentEvents(context.config.eventHistoryLimit)
      .filter((event) => event.requestId === found.id || (found.generationRecordId && event.generationRecordId === found.generationRecordId));
    sendJson(response, 200, { record: normalizeRecord(found, context.portalView), events: related });
    return true;
  }

  if (request.method === 'GET' && pathname === '/admin/api/capabilities') {
    await deps.handleCapabilities(request, response, url, context);
    return true;
  }

  if (request.method === 'GET' && pathname === '/admin/api/stream') {
    const subscribed = context.portalBus.subscribe(request, response, () => ({
      schema: 2,
      at: nowIso(),
      window: context.config.requestHistoryLimit,
      startedAt: context.state.startedAt,
      heartbeatMs: context.config.eventsHeartbeatMs
    }));
    if (!subscribed) {
      sendJson(response, 503, errorPayload('TOO_MANY_SUBSCRIBERS', 'The portal event stream is full. Poll /admin/api/portal/state instead.'));
    }
    return true;
  }

  return false;
}
