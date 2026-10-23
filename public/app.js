/* Portal boot. Three jobs, in order: find out what this router actually speaks
   (section 1 with graceful degradation to the pre-v2 reads), keep the page current by
   streaming (section 9) with a polling fallback that never asks two endpoints in the
   same tick, and hand every rendered pixel to the section modules through the
   single store so one frame equals one DOM pass. */

import { load, ROUTES } from './modules/api.js';
import { normalizeRecord, synthesizePortal } from './modules/legacy.js';
import { get, invalidate, note, dropNote, requestParams, set, subscribe } from './modules/state.js';
import { startStream } from './modules/stream.js';
import * as chrome from './modules/statusbar.js';
import * as actionsDrawer from './modules/actions.js';
import * as configurations from './modules/configurations.js';
import * as modelsSection from './modules/models.js';
import * as signalsSection from './modules/signals.js';
import * as requestsTable from './modules/requests.js';
import * as detail from './modules/request-detail.js';
import * as inspectorSection from './modules/inspector.js';

const TICK_MS = 1000;

/* One in-flight request per endpoint, tracked so a slow route cannot stack
   requests behind itself while the operator watches. */
const busy = new Set();
/* Which view the table, the state strip and the aggregates currently hold, so a
   history step can tell a reload-worthy change from a modal opening. */
const loaded = { requests: '', window: '', stats: '' };
let pendingInserts = 0;
let polling = false;

async function once(key, task) {
  if (busy.has(key)) return null;
  busy.add(key);
  try {
    return await task();
  } catch (error) {
    console.warn(`[portal] ${key} failed`, error);
    return null;
  } finally {
    busy.delete(key);
  }
}

/* ---- endpoint loaders ---------------------------------------------------- */

async function loadPortal() {
  return once('portal', async () => {
    const view = get().view;
    const result = await load(ROUTES.portalState, { params: { window: view.window } });
    if (result.ok) {
      const previous = get().portal;
      set({
        portal: mergeStreamedFacts(result.data, previous),
        portalSource: 'portal/state',
        loading: { ...get().loading, portal: false }
      });
      loaded.window = get().view.window;
      dropNote('portal');
      return;
    }
    if (!result.missing) {
      note('portal', `${ROUTES.portalState} answered ${result.status} ${result.code || ''}: ${result.message || 'unreachable'}.`);
      set({ portalSource: null });
      return;
    }
    await degrade();
  });
}

/* A router without section 1 can still paint the page from the older reads. Anything
   the older reads cannot prove stays absent, which the sections render as an em
   dash with a reason. */
async function degrade() {
  const [summary, hosts, metrics] = await Promise.all([
    load(ROUTES.summary),
    load(ROUTES.hosts),
    load(ROUTES.metrics)
  ]);
  if (!summary.ok) {
    note('portal', `${ROUTES.portalState} does not exist on this router and ${ROUTES.summary} answered ${summary.status}, so there is nothing to paint.`);
    set({ portal: null, portalSource: null, loading: { ...get().loading, portal: false } });
    return;
  }
  const portal = synthesizePortal({
    summary: summary.data,
    hosts: hosts.ok ? hosts.data : null,
    metrics: metrics.ok ? metrics.data : null
  });
  set({
    portal,
    portalSource: `${ROUTES.summary} + ${ROUTES.hosts} + ${ROUTES.metrics}`,
    loading: { ...get().loading, portal: false }
  });
  loaded.window = get().view.window;
  note('portal', `this router does not expose ${ROUTES.portalState}; the page is assembled from ${ROUTES.summary}, ${ROUTES.hosts} and ${ROUTES.metrics}, so per-window and per-stage figures are absent.`);
}

async function loadStats() {
  return once('stats', async () => {
    const view = get().view;
    // No bucket parameter: the router chooses one that keeps the series under 600
    // buckets and reports what it settled on.
    const result = await load(ROUTES.stats, { params: { window: view.window } });
    if (!result.ok) {
      set({ stats: null });
      if (result.missing) note('stats', `${ROUTES.stats} is not exposed by this router yet`);
      else note('stats', `${ROUTES.stats} answered ${result.status}: ${result.message || 'unreachable'}`);
      invalidate();
      return;
    }
    set({ stats: result.data });
    loaded.stats = get().view.window;
    dropNote('stats');
  });
}

async function loadEvents() {
  return once('events', async () => {
    const result = await load(ROUTES.events, { params: { limit: 80 } });
    if (!result.ok) {
      if (result.missing) note('events', `${ROUTES.events} is not exposed by this router`);
      return;
    }
    const events = Array.isArray(result.data?.events) ? result.data.events : [];
    set({ events });
    dropNote('events');
  });
}

async function loadCapabilities() {
  return once('capabilities', async () => {
    const result = await load(ROUTES.capabilities, { params: { include: 'load' }, useEtag: true });
    if (!result.ok) {
      if (result.missing) note('capabilities', `${ROUTES.capabilities} is not reachable from this port`);
      return;
    }
    set({ capabilities: result.data });
    dropNote('capabilities');
  });
}

async function loadRequests() {
  return once('requests', async () => {
    const before = get();
    set({ loading: { ...before.loading, requests: true } });
    const result = await load(ROUTES.requests, { params: requestParams(before.view) });
    const state = get();
    if (!result.ok) {
      note('requests', `${ROUTES.requests} answered ${result.status} ${result.code || ''}: ${result.message || 'unreachable'}`);
      set({ loading: { ...state.loading, requests: false } });
      return;
    }
    dropNote('requests');
    loaded.requests = fingerprint(state.view).requests;
    const payload = { ...result.data, requests: (result.data?.requests || []).map(normalizeRecord) };
    requestsTable.ingest(payload, state);
    set({ loading: { ...state.loading, requests: false } });
  });
}

/* Drain flips and heartbeats that arrived before the next portal/state read. */
function mergeStreamedFacts(portal, previous) {
  if (!previous || !portal) return portal;
  if (portal.state?.inFlight?.active == null && previous.state?.inFlight?.active != null) {
    portal.state = { ...portal.state, inFlight: previous.state.inFlight };
  }
  return portal;
}

/* ---- refresh ------------------------------------------------------------- */

async function refresh() {
  await Promise.all([loadPortal(), loadStats(), loadEvents(), loadCapabilities(), loadRequests()]);
}

/* ---- polling fallback ---------------------------------------------------- */

const POLLERS = [
  { key: 'requests', every: 5000, task: loadRequests, priority: 0 },
  { key: 'portal', every: 10000, task: loadPortal, priority: 1 },
  { key: 'stats', every: 10000, task: loadStats, priority: 2 },
  { key: 'events', every: 10000, task: loadEvents, priority: 3 },
  { key: 'capabilities', every: 30000, task: loadCapabilities, priority: 4 }
];
const lastRun = new Map();
let tickTimer = null;

function tick() {
  const state = get();
  if (state.paused || busy.size || document.hidden) return;
  const now = Date.now();
  const due = POLLERS
    .filter((poller) => now - (lastRun.get(poller.key) || 0) >= poller.every)
    .sort((left, right) => left.priority - right.priority);
  if (!due.length) return;
  const poller = due[0];
  lastRun.set(poller.key, now);
  poller.task();
}

function startPolling(reason) {
  if (polling) return;
  polling = true;
  note('stream', `${reason}; falling back to polling ${ROUTES.requests} every 5 s and the rest every 10 s, one endpoint per second.`);
  for (const poller of POLLERS) lastRun.set(poller.key, Date.now() - poller.every);
  tickTimer = setInterval(tick, TICK_MS);
  tick();
}

function stopPolling() {
  polling = false;
  clearInterval(tickTimer);
  tickTimer = null;
}

/* ---- live subscription --------------------------------------------------- */

function onStreamEvent(type, data) {
  const state = get();
  if (type === 'request') {
    const result = requestsTable.applyStreamedRecord(normalizeRecord(data), state);
    if (result === 'prepended') pendingInserts += 1;
  } else if (type === 'event') {
    const events = state.events || [];
    set({ events: [data, ...events].slice(0, 200) });
  } else if (type === 'drain') {
    applyDrain(data);
  } else if (type === 'capabilities') {
    set({ capabilities: data });
    const portal = state.portal;
    if (portal) {
      portal.state = { ...portal.state, capabilities: { revision: data?.revision, observedAt: data?.observedAt, complete: data?.complete, warnings: data?.warnings || [] } };
    }
  } else if (type === 'heartbeat') {
    const portal = state.portal;
    if (portal) {
      portal.state = { ...portal.state, inFlight: { ...portal.state?.inFlight, active: data?.active ?? null, queued: data?.queued ?? null } };
    }
  }
  invalidate();
}

function applyDrain(data) {
  const portal = get().portal;
  if (!portal || !data) return;
  if (data.host) {
    portal.hosts = (portal.hosts || []).map((entry) => (entry.id === data.host
      ? { ...entry, draining: !!data.draining, drain_reason: data.draining ? data.reason : null }
      : entry));
  } else {
    portal.state = { ...portal.state, draining: !!data.draining, admission: data.draining ? 'draining' : 'accepting' };
  }
  invalidate();
}

/* ---- chrome actions ------------------------------------------------------ */

const actions = {
  state: get,
  invalidate,
  loadRequests,
  openRequest: (id) => detail.open(id),
  drainHost: (host, enabled) => actionsDrawer.drainHost(host, enabled)
};

const chromeHandlers = {
  refresh: () => refresh(),
  togglePause: () => {
    const state = get();
    const paused = !state.paused;
    set({ paused });
    if (!paused) refresh();
  },
  toggleDrawer: () => actionsDrawer.toggle(),
  windowChanged: () => {
    loadPortal();
    loadStats();
    loadRequests();
  }
};

/* ---- render loop --------------------------------------------------------- */

/* A section that cannot paint itself must not take the rest of the page down
   with it: each one is painted behind its own guard and reports in the console
   with its name. */
function paint(name, task) {
  try {
    task();
  } catch (error) {
    console.warn(`[portal] ${name} could not paint`, error);
  }
}

function render(state) {
  paint('chrome', () => chrome.render(state));
  paint('configurations', () => configurations.render(state));
  paint('models', () => modelsSection.render(state));
  paint('signals', () => signalsSection.render(state));
  paint('requests', () => requestsTable.render(state));
  paint('inspector', () => inspectorSection.render(state));
  paint('actions', () => actionsDrawer.render(state));
  paint('detail', () => detail.sync(state));
  if (pendingInserts) {
    const count = pendingInserts;
    pendingInserts = 0;
    const queued = state.requests?.staleCount || 0;
    requestsTable.announce(count === 1
      ? 'One new request was added to this page.'
      : `${count} new requests were added to this page.${queued ? ` ${queued} more arrived while you were on another page; reload to see them.` : ''}`);
  }
}

/* ---- boot ---------------------------------------------------------------- */

function fingerprint(view) {
  const requestKeys = ['q', 'model', 'host', 'client', 'outcome', 'status', 'protocol', 'journal', 'sort', 'dir', 'offset', 'limit'];
  return {
    requests: requestKeys.map((key) => `${key}=${view[key]}`).join('&'),
    window: view.window
  };
}

async function boot() {
  subscribe(render);
  chrome.configure(chromeHandlers);
  chrome.mountChrome();
  actionsDrawer.wire(chromeHandlers);
  configurations.wire(actions);
  modelsSection.wire();
  requestsTable.wire(actions);
  detail.wire();

  await refresh();
  startStream({
    onEvent: onStreamEvent,
    onFallback: (reason) => startPolling(reason),
    onLive: () => stopPolling()
  });

  // Back and Forward change the view without going through any of our handlers,
  // so the restored view is compared with what is actually on screen: a step
  // that only opens or closes a request modal touches no network at all, a step
  // that changes the filters or the window reloads exactly what it invalidates.
  window.addEventListener('popstate', () => {
    const next = fingerprint(get().view);
    if (next.window !== loaded.window) loadPortal();
    if (next.window !== loaded.stats) loadStats();
    if (next.window !== loaded.window || next.requests !== loaded.requests) loadRequests();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && polling && !get().paused) refresh();
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.warn('[portal] unhandled rejection', event.reason);
    event.preventDefault();
  });

  invalidate();
}

boot();
