// Reference client for LLM Router capability changes (Node 18+, Deno, browsers).
// Copy this file into a project, or port it. One watcher per process.
//
//   const watch = watchRouter('http://192.168.1.4:11434', (doc) => log(doc.configuration), { signal });
//   await watch.ready.catch(() => {});            // tolerate an unreachable router at startup
//   const service = resolveService(watch.current, 'nighttime', ['daytime']);        // by name
//   const service = pickService(watch.current, { nsfw: true, fallbackAny: true });  // by capability
//   if (service === WAIT) ...                      // router draining: wait, do not switch
//   else if (service === UNAVAILABLE) ...          // nothing usable: retry later
//   else modelFor(watch.current, service)          // limits for the model `service` targets
//
// On a failed request, classifyError(status, body) says what to do next.
// Contract: docs/CAPABILITIES.md in https://github.com/astigmatism/llm-router.

export const WAIT = 'wait';
export const UNAVAILABLE = 'unavailable';
export const FALLBACK = 'fallback';
export const RETRY = 'retry';
export const FAIL = 'fail';

const FALLBACK_CODES = new Set(['SERVICE_OFFLINE', 'BACKEND_UNAVAILABLE', 'MODEL_NOT_FOUND']);
const WAIT_CODES = new Set(['BACKEND_DRAINING', 'MAINTENANCE_MODE']);

export function resolveService(doc, preferred, fallbacks = []) {
  if (!doc) return preferred;
  if (!doc.router.accepting_requests) return WAIT;
  for (const service of [preferred, ...fallbacks]) {
    const model = doc.models.find((m) => m.id === service || m.aliases.includes(service));
    if (model?.available) return service;
  }
  return UNAVAILABLE;
}

const FEATURES = {
  vision: (m) => (m.input_modalities || []).includes('image'),
  tools: (m) => (m.capabilities || []).includes('tools'),
  reasoning: (m) => (m.capabilities || []).includes('thinking')
};

// The most capable usable service matching the filters, WAIT, or UNAVAILABLE.
// nsfw: true = only models declared NSFW (abliterated), false = only models
// declared not NSFW, undefined/null = either. require: subset of
// ['vision', 'tools', 'reasoning']. exclude: service IDs that just failed.
// fallbackAny: when no model matches `nsfw`, use the most capable usable model.
export function pickService(doc, { nsfw = null, require = [], exclude = [], fallbackAny = false } = {}) {
  if (!doc) return UNAVAILABLE;
  if (!doc.router.accepting_requests) return WAIT;
  const unknown = require.filter((feature) => !FEATURES[feature]);
  if (unknown.length) throw new Error(`unknown required feature: ${unknown.join(', ')}`);
  const usable = doc.models.filter((m) => m.available && !exclude.includes(m.service) && !exclude.includes(m.id)
    && require.every((feature) => FEATURES[feature](m)));
  const matching = usable.filter((m) => nsfw === null || nsfw === undefined || m.nsfw === nsfw);
  const candidates = matching.length ? matching : (fallbackAny ? usable : []);
  if (!candidates.length) return UNAVAILABLE;
  const rank = (m) => [m.capability_score === null || m.capability_score === undefined ? 0 : 1, m.capability_score ?? 0, m.context_window ?? 0];
  const better = (a, b) => { const x = rank(a); const y = rank(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  return candidates.reduce((best, m) => (better(m, best) ? m : best)).service;
}

export function modelFor(doc, service) {
  const canonical = doc?.ids?.[service];
  return doc?.models.find((m) => m.id === canonical) ?? null;
}

export function errorCode(body) {
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const error = parsed?.error;
    return error && typeof error === 'object' ? error.code ?? null : null;
  } catch {
    return null;
  }
}

// status null/undefined means the request failed before any HTTP response.
export function classifyError(status, body = null) {
  const code = errorCode(body);
  if (WAIT_CODES.has(code)) return WAIT;
  if (FALLBACK_CODES.has(code)) return FALLBACK;
  if (status == null || status === 408 || status === 429 || status >= 500) return RETRY;
  return FAIL;
}

export function watchRouter(baseUrl, onChange = () => {}, { signal, pollMs = 30000 } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  let current = null;
  let etag = null;
  const update = (doc) => {
    if (current?.revision === doc.revision) return;
    current = doc;
    onChange(doc);
  };
  const poll = async () => {
    const response = await fetch(`${base}/v1/router/capabilities`, { headers: etag ? { 'if-none-match': etag } : {}, signal });
    if (response.status === 304) return current;
    if (!response.ok) throw new Error(`capabilities HTTP ${response.status}`);
    etag = response.headers.get('etag');
    update(await response.json());
    return current;
  };
  const follow = async () => {
    let delay = 3000;
    while (!signal?.aborted) {
      try {
        const response = await fetch(`${base}/v1/router/events`, { headers: { accept: 'text/event-stream' }, signal });
        if (!response.ok) throw new Error(`events HTTP ${response.status}`);
        delay = 3000;
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = null;
            const data = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith(':')) continue;
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
              else if (line.startsWith('retry:')) delay = Number(line.slice(6)) || delay;
            }
            if (event === 'capabilities' && data.length) update(JSON.parse(data.join('\n')));
          }
        }
      } catch {
        if (signal?.aborted) return;
        delay = Math.min(delay * 2, pollMs);
      }
      await poll().catch(() => {});
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  };
  const ready = poll();
  void follow();
  return { ready, refresh: poll, get current() { return current; } };
}
