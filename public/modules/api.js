/* Every request the portal makes goes through this module: one place that knows
   the route table (docs/PORTAL_API.md), the router's error envelope, the ETag
   cache for the conditional routes, and how to abort in-flight work when a view
   is replaced. Modules ask for data and get `{ ok, data, status, code }` back -
   a missing route is a value, not an exception, because the backend for this
   release is being written in parallel and the page has to render anyway. */

export const ROUTES = {
  portalState: '/admin/api/portal/state',
  requests: '/admin/api/requests',
  request: (id) => `/admin/api/requests/${encodeURIComponent(id)}`,
  journal: (id) => `/admin/api/requests/${encodeURIComponent(id)}/journal`,
  stats: '/admin/api/stats',
  events: '/admin/api/events',
  capabilities: '/admin/api/capabilities',
  stream: '/admin/api/stream',
  generationRecord: '/admin/api/generation-record',
  runtimeState: '/admin/api/runtime-state',
  runtimeDrain: '/admin/api/runtime-drain',
  maintenance: '/admin/api/maintenance',
  reloadConfig: '/admin/api/reload-config',
  prewarm: '/admin/api/prewarm',
  // Reads used only to paint the page when /admin/api/portal/state does not
  // exist yet on this router (see app.js degrade()).
  summary: '/admin/api/summary',
  hosts: '/admin/api/hosts',
  metrics: '/admin/api/metrics'
};

export const MISSING_ROUTES = new Set([404, 405, 501]);

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'NETWORK', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.missing = MISSING_ROUTES.has(status);
  }
}

const etagCache = new Map();

function envelopeFrom(status, payload, fallbackCode) {
  const envelope = payload && typeof payload === 'object' ? payload.error : null;
  if (envelope && typeof envelope === 'object') {
    return {
      code: String(envelope.code || fallbackCode),
      message: String(envelope.message || `HTTP ${status}`),
      details: envelope.details ?? null
    };
  }
  return { code: fallbackCode, message: `HTTP ${status}`, details: null };
}

async function readError(response) {
  const text = await response.text().catch(() => '');
  try {
    return envelopeFrom(response.status, JSON.parse(text), 'ADMIN_ROUTE_ERROR');
  } catch {
    return {
      code: response.status === 404 ? 'ADMIN_ROUTE_NOT_FOUND' : 'ADMIN_ROUTE_ERROR',
      message: text ? text.slice(0, 240).replace(/\s+/g, ' ') : `HTTP ${response.status}`,
      details: null
    };
  }
}

/* Low-level JSON GET. Throws ApiError; callers normally want `load()` below. */
export async function fetchJson(path, { params, signal, timeout = 15000, useEtag = false } = {}) {
  const url = `${path}${queryString(params)}`;
  const headers = { accept: 'application/json' };
  const cached = useEtag ? etagCache.get(url) : null;
  if (cached?.etag) headers['if-none-match'] = cached.etag;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const relay = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', relay, { once: true });
  }

  let response;
  try {
    response = await fetch(url, { headers, cache: 'no-store', signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new ApiError(`${path} timed out after ${timeout} ms`, { status: 0, code: 'TIMEOUT' });
    if (error?.name === 'AbortError') throw new ApiError('request aborted', { status: 0, code: 'ABORTED' });
    throw new ApiError(`${path} unreachable: ${error?.message || error}`, { status: 0, code: 'NETWORK' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }

  if (response.status === 304 && cached) return cached.data;
  if (response.status === 204) return null;
  if (!response.ok) {
    const envelope = await readError(response);
    throw new ApiError(envelope.message, { status: response.status, code: envelope.code, details: envelope.details });
  }

  const data = await response.json().catch(() => {
    throw new ApiError(`${path} answered invalid JSON`, { status: response.status, code: 'INVALID_JSON' });
  });
  if (useEtag) {
    const etag = response.headers.get('etag');
    if (etag) etagCache.set(url, { etag, data });
  }
  return data;
}

/* The value-shaped variant: never throws for an HTTP or transport error, so a
   section can decide what its own absence means. `notModified` lets a polling
   caller skip a render. */
export async function load(path, options = {}) {
  try {
    const data = await fetchJson(path, options);
    return { ok: true, status: 200, data };
  } catch (error) {
    if (error?.code === 'ABORTED') return { ok: false, aborted: true, status: 0, code: 'ABORTED', data: null };
    return { ok: false, missing: !!error?.missing, status: error?.status || 0, code: error?.code || 'NETWORK', message: error?.message || 'unreachable', data: null };
  }
}

export async function postJson(path, body, { signal, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const relay = () => controller.abort();
  if (signal) signal.addEventListener('abort', relay, { once: true });
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body ?? {}),
      signal: controller.signal
    });
    const raw = await response.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { raw: raw.slice(0, 500) };
      }
    }
    if (!response.ok) {
      const envelope = envelopeFrom(response.status, payload, 'ADMIN_ROUTE_ERROR');
      return { ok: false, status: response.status, code: envelope.code, message: envelope.message, data: payload };
    }
    return { ok: true, status: response.status, data: payload };
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, status: 0, code: 'TIMEOUT', message: `${path} timed out`, data: null };
    return { ok: false, status: 0, code: 'NETWORK', message: `${path} unreachable: ${error?.message || error}`, data: null };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

export function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export function absoluteUrl(path) {
  return new URL(path, window.location.origin).href;
}

export function streamUrl() {
  return ROUTES.stream;
}
