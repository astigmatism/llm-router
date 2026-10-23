/* The portal is live by streaming: one EventSource on /admin/api/stream (section 9 of
   docs/PORTAL_API.md). Payloads are queued and applied in one batch per frame,
   so a burst of streamed requests costs one render. When the stream errors or
   is not there at all (an older router), this module hands over to app.js's
   polling scheduler exactly once and says why in the live chip. */

import { ROUTES } from './api.js';
import { get, set } from './state.js';
import { ago } from './format.js';

const RETRY_STEPS = [2000, 3000, 5000, 10000, 15000, 30000];
const STALE_AFTER_MS = 45000;
const MAX_ATTEMPTS = 6;

let source = null;
let attempts = 0;
let retryTimer = null;
let watchdog = null;
let queue = [];
let flushScheduled = false;
let stopped = true;
let handlers = null;
let wasPolling = false;

function setLive(mode, reason) {
  const previous = get().live;
  if (previous.mode === mode && previous.reason === reason) return;
  set({ live: { ...previous, mode, reason, since: Date.now() } });
  if (mode === 'polling') {
    wasPolling = true;
    return;
  }
  // A stream that comes back on its own retires the poller: two live feeds on
  // one page is how a dashboard starts lying about its own freshness.
  if (mode === 'live' && wasPolling) {
    wasPolling = false;
    handlers?.onLive?.();
  }
}

function touch() {
  const previous = get().live;
  const now = Date.now();
  set({ live: { ...previous, mode: 'live', reason: 'Server-Sent Events on ' + ROUTES.stream, lastEventAt: now } });
  armWatchdog();
}

function armWatchdog() {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (stopped) return;
    // A silent subscription is worse than a closed one: the router heartbeats,
    // so nothing for 45 s means the connection is a zombie.
    fail('no heartbeat from the router for 45 s');
  }, STALE_AFTER_MS);
}

function flush() {
  flushScheduled = false;
  if (!queue.length || !handlers) return;
  const batch = queue;
  queue = [];
  for (const entry of batch) {
    try {
      handlers.onEvent(entry.type, entry.data);
    } catch (error) {
      console.warn('[portal] stream handler failed for', entry.type, error);
    }
  }
}

function enqueue(type, data) {
  if (get().paused) return;
  queue.push({ type, data });
  if (!flushScheduled) {
    flushScheduled = true;
    window.requestAnimationFrame(flush);
  }
}

function parseData(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function fail(reason) {
  clearTimeout(retryTimer);
  closeSource();
  if (stopped) return;
  if (attempts >= MAX_ATTEMPTS) {
    setLive('polling', `${reason}; falling back to polling after ${MAX_ATTEMPTS} attempts`);
    if (handlers?.onFallback) handlers.onFallback(reason);
    return;
  }
  const delay = RETRY_STEPS[Math.min(attempts, RETRY_STEPS.length - 1)];
  attempts += 1;
  setLive('reconnecting', `${reason}; retry ${attempts} of ${MAX_ATTEMPTS} in ${Math.round(delay / 1000)} s`);
  retryTimer = setTimeout(open, delay);
}

function closeSource() {
  clearTimeout(watchdog);
  if (source) {
    source.close();
    source = null;
  }
}

function open() {
  if (stopped || typeof window.EventSource !== 'function') {
    setLive('polling', 'this browser has no EventSource; polling instead');
    if (handlers?.onFallback) handlers.onFallback('no EventSource');
    return;
  }
  closeSource();
  source = new window.EventSource(ROUTES.stream);
  const types = ['hello', 'capabilities', 'request', 'event', 'drain', 'heartbeat'];
  for (const type of types) {
    source.addEventListener(type, (message) => {
      attempts = 0;
      touch();
      if (type === 'hello' && message.lastEventId) return;
      enqueue(type, parseData(message.data));
    });
  }
  source.onopen = () => {
    touch();
    setLive('live', 'Server-Sent Events on ' + ROUTES.stream);
  };
  source.onerror = () => {
    const status = source?.readyState;
    if (status === 2) {
      // readyState CLOSED without ever opening is the signature of a route that
      // does not exist on this router - do not retry a 404 for a minute.
      setLive('polling', 'this router does not expose ' + ROUTES.stream + '; polling instead');
      stopped = true;
      closeSource();
      if (handlers?.onFallback) handlers.onFallback('stream route missing');
      return;
    }
    fail('the stream dropped');
  };
}

export function startStream(next) {
  handlers = next;
  stopped = false;
  attempts = 0;
  open();
}

export function stopStream() {
  stopped = true;
  clearTimeout(retryTimer);
  closeSource();
  queue = [];
}

/* Pause drops queued payloads but keeps the connection and the rendered state:
   resuming refetches once, which is cheaper and less confusing than replaying. */
export function describeStream() {
  const live = get().live;
  if (live.mode === 'live' && live.lastEventAt) return `${live.mode} - last event ${ago(live.lastEventAt)}`;
  return live.mode;
}
