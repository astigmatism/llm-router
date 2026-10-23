/* The single store plus the URL contract. Two rules make the portal shareable:
   the view (window, filters, page, sort, density, open request) lives in the
   query string, and every render happens in one animation frame no matter how
   many stream events arrived in between. Filter churn uses
   history.replaceState so Back is never a wall of no-ops; opening and closing
   the request modal uses pushState so Back closes the modal. */

import { ROUTES } from './api.js';

export const WINDOWS = ['15m', '1h', '6h', '24h', 'all'];
export const WINDOW_LABELS = { '15m': '15m', '1h': '1h', '6h': '6h', '24h': '24h', all: 'Since start' };
export const KINDS = [
  ['all', 'All'],
  ['prompt', 'Prompt calls'],
  ['errors', 'Errors only'],
  ['status', 'Status pings']
];
export const OUTCOMES = ['success', 'cancelled', 'rejected', 'error', 'pending'];
export const PROTOCOLS = ['responses', 'chat', 'ollama-chat', 'ollama-generate', 'discovery', 'other'];
export const SORTS = ['ts', 'duration', 'ttft', 'tokens', 'outcome'];
export const LIMITS = [16, 25, 50, 100];

const DENSITY_KEY = 'router.portal.density';
const LIMIT_KEY = 'router.portal.limit';

export const DEFAULTS = {
  window: '1h',
  q: '',
  model: '',
  host: '',
  client: '',
  outcome: '',
  status: '',
  protocol: '',
  journal: '',
  kind: 'all',
  sort: 'ts',
  dir: 'desc',
  offset: 0,
  request: '',
  density: 'dense'
};

function readStored(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function remember(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A private window with storage disabled must not break the view.
  }
}

export function recall(key, fallback) {
  return readStored(key, fallback);
}

const VIEW_KEYS = ['window', 'q', 'model', 'host', 'client', 'outcome', 'status', 'protocol', 'journal', 'kind', 'sort', 'dir', 'offset', 'limit', 'request', 'density'];

function parseView(search) {
  const params = new URLSearchParams(search);
  const view = {
    ...DEFAULTS,
    density: readStored(DENSITY_KEY, DEFAULTS.density),
    limit: Number(readStored(LIMIT_KEY, '16')) || 16
  };
  for (const key of VIEW_KEYS) {
    if (!params.has(key)) continue;
    const raw = params.get(key);
    if (key === 'offset' || key === 'limit') view[key] = Math.max(0, Number(raw) || 0);
    else view[key] = raw;
  }
  if (!WINDOWS.includes(view.window)) view.window = DEFAULTS.window;
  if (!SORTS.includes(view.sort)) view.sort = DEFAULTS.sort;
  if (view.dir !== 'asc' && view.dir !== 'desc') view.dir = DEFAULTS.dir;
  if (!KINDS.some(([value]) => value === view.kind)) view.kind = 'all';
  if (!LIMITS.includes(view.limit)) view.limit = 16;
  if (view.density !== 'comfortable' && view.density !== 'dense') view.density = 'dense';
  return view;
}

function serializeView(view) {
  const params = new URLSearchParams();
  for (const key of VIEW_KEYS) {
    const value = view[key];
    if (value === null || value === undefined || value === '') continue;
    if (key === 'offset' && Number(value) === 0) continue;
    if (key !== 'request' && DEFAULTS[key] === value) continue;
    if (key === 'limit' && Number(value) === 16) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

const state = {
  view: parseView(window.location.search),

  // Data slots; null always means "not loaded", never "zero".
  portal: null,
  portalSource: null,          // 'portal/state' | 'summary+hosts+metrics'
  stats: null,
  events: null,
  capabilities: null,
  requests: null,              // { records, page, filters, serverSorted }
  requestsSource: 'requests',  // 'requests' | 'stream'
  detail: null,                // { id, record, events, journal, loading, error }
  runtimeState: null,

  live: { mode: 'connecting', reason: 'opening /admin/api/stream', since: Date.now(), lastEventAt: null },
  paused: false,
  drawerOpen: false,
  controlBlocked: null,        // { route, code, message } when a control answers 401
  notes: {},                   // per-section degradation notices, shown once
  loading: { requests: false, portal: false, stats: false },
  error: null
};

const listeners = new Set();
let frame = null;

export function get() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* One DOM pass per frame: stream events, fetch resolutions and URL writes all
   funnel through here. */
export function invalidate() {
  if (frame !== null) return;
  frame = window.requestAnimationFrame(() => {
    frame = null;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        // A broken section must not stop the others from painting.
        console.warn('[portal] render failed', error);
      }
    }
  });
}

export function set(patch) {
  Object.assign(state, patch);
  invalidate();
}

/* ---- URL <-> view ------------------------------------------------------- */

export function setView(patch, { push = false, scroll = false } = {}) {
  const next = { ...state.view, ...patch };
  if (patch.limit) remember(LIMIT_KEY, String(patch.limit));
  if (patch.density && patch.density !== DEFAULTS.density) remember(DENSITY_KEY, patch.density);
  else if (patch.density === DEFAULTS.density) remember(DENSITY_KEY, patch.density);
  const search = serializeView(next);
  const url = `${window.location.pathname}${search}${window.location.hash}`;
  if (`${window.location.search}${window.location.hash}` !== search || next.request !== state.view.request) {
    if (push) window.history.pushState({ request: next.request || null }, '', url);
    else window.history.replaceState({ request: next.request || null }, '', url);
  }
  state.view = next;
  if (!scroll) {
    // Keep the scroll position the browser would otherwise reset on pushState.
    void 0;
  }
  invalidate();
  return next;
}

export function viewUrl(overrides = {}) {
  const next = { ...state.view, ...overrides };
  return `${window.location.pathname}${serializeView(next)}`;
}

export function requestUrl(id) {
  const next = { ...state.view, request: id || '' };
  return `${window.location.pathname}${serializeView(next)}`;
}

/* Filters that reach /admin/api/requests. `kind` is not a documented parameter:
   it is sent anyway (unknown parameters are ignored by the router) and applied
   to the current page as an overlay so the segmented control keeps working on
   an older build. */
export function requestParams(view = state.view) {
  return {
    limit: view.limit,
    offset: view.offset,
    since: view.window === DEFAULTS.window ? '' : view.window,
    model: view.model,
    host: view.host,
    client: view.client,
    outcome: view.outcome,
    status: view.status,
    protocol: view.protocol,
    has_journal: view.journal,
    q: view.q,
    sort: view.sort,
    dir: view.dir,
    kind: view.kind === 'all' ? '' : view.kind
  };
}

export function activeFilters(view = state.view) {
  const chips = [];
  const add = (key, label, value) => {
    if (value) chips.push({ key, label, value });
  };
  add('q', 'search', view.q);
  add('model', 'model', view.model);
  add('host', 'machine', view.host);
  add('client', 'client', view.client);
  add('outcome', 'outcome', view.outcome);
  add('status', 'status', view.status);
  add('protocol', 'protocol', view.protocol);
  add('journal', 'has journal', view.journal === 'true' ? 'payload archive' : view.journal);
  return chips;
}

export function clearFilter(key) {
  if (key === 'all') {
    setView({ q: '', model: '', host: '', client: '', outcome: '', status: '', protocol: '', journal: '', offset: 0 });
    return;
  }
  setView({ [key]: '', offset: 0 });
}

window.addEventListener('popstate', () => {
  state.view = parseView(window.location.search);
  invalidate();
});

/* ---- derived helpers ---------------------------------------------------- */

export function hosts() {
  return state.portal?.hosts || [];
}

export function models() {
  return state.portal?.models || [];
}

export function routerInfo() {
  return state.portal?.router || {};
}

export function stateStrip() {
  return state.portal?.state || {};
}

/* Requests currently visible, after the `kind` overlay. Sorting and paging are
   the server's job; this overlay is optimistic and marked as such in the UI. */
export function visibleRequests() {
  const bucket = state.requests;
  if (!bucket) return [];
  const kind = state.view.kind;
  if (kind === 'all') return bucket.records;
  return bucket.records.filter((row) => {
    if (kind === 'prompt') return row.kind === 'prompt';
    if (kind === 'status') return row.kind === 'discovery';
    if (kind === 'errors') return row.outcome === 'error' || row.outcome === 'rejected' || row.outcome === 'cancelled';
    return true;
  });
}

export function recordIds() {
  return visibleRequests().map((row) => row.id).filter(Boolean);
}

export function note(key, message) {
  if (state.notes[key] === message) return;
  state.notes = { ...state.notes, [key]: message };
  invalidate();
}

export function dropNote(key) {
  if (!(key in state.notes)) return;
  const notes = { ...state.notes };
  delete notes[key];
  state.notes = notes;
  invalidate();
}

export function streamEndpoint() {
  return ROUTES.stream;
}
