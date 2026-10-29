import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { extractUsageFromOllamaObject } from './stream-parser.js';
import { isThinkingEnabled, normalizeThinkValue, validateReasoningCapabilities } from './reasoning.js';

function responseHeaders(message) {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    headers.append(message.rawHeaders[index], message.rawHeaders[index + 1]);
  }
  return headers;
}

function requestWithNodeTransport(url, options = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const method = options.method || 'GET';
  const headers = new Headers(options.headers);
  if (options.body !== undefined && options.body !== null && !headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(options.body)));
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method,
      headers: Object.fromEntries(headers.entries()),
      signal: options.signal
    }, (message) => {
      const status = message.statusCode || 500;
      const hasBody = method !== 'HEAD' && ![101, 204, 205, 304].includes(status);
      const body = hasBody ? Readable.toWeb(message) : null;
      if (!hasBody) message.resume();
      resolve(new Response(body, {
        status,
        statusText: message.statusMessage || '',
        headers: responseHeaders(message)
      }));
    });

    request.once('error', reject);
    if (options.connectTimeoutMs) request.once('socket', (socket) => {
      if (!socket.connecting) return;
      const timer = setTimeout(() => request.destroy(new DOMException('Upstream connection timed out.', 'TimeoutError')), options.connectTimeoutMs);
      const clear = () => clearTimeout(timer);
      socket.once('connect', clear); socket.once('close', clear); request.once('error', clear);
    });
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}

export async function upstreamFetch(config, pathname, options = {}) {
  if (options.generation) return generationFetch(config, pathname, options);
  const timeoutMs = options.timeoutMs ?? config.upstreamTimeoutMs;
  const controller = options.signal ? null : new AbortController();
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const { timeoutMs: _timeoutMs, signal: suppliedSignal, ...requestOptions } = options;
  try {
    const url = `${config.upstreamUrl}${pathname}`;
    return await requestWithNodeTransport(url, {
      ...requestOptions,
      signal: suppliedSignal || controller.signal
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// A generation may spend arbitrarily long in prefill or decode. Only a failed
// connection, cancellation, or an interval without bytes/backend progress ends it.
export async function generationFetch(config, pathname, options = {}) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const stallMs = config.generationStallTimeoutMs ?? 120000;
  let lastProgress = Date.now();
  let lastSlot = null;
  let checking = false;
  let waiting = true;
  const timer = setInterval(async () => {
    if (checking || signal.aborted) return;
    checking = true;
    try {
      if (options.progressPath) {
        const result = await upstreamJson(config, options.progressPath, { timeoutMs: 5000, signal });
        if (result.ok && Array.isArray(result.body)) {
          const fingerprint = JSON.stringify(result.body.map((slot) => [slot.id_task, slot.n_prompt_tokens_processed,
            slot.next_token?.map((token) => token.n_decoded)]));
          if (fingerprint !== lastSlot) { lastSlot = fingerprint; lastProgress = Date.now(); }
        }
      }
      if (waiting && Date.now() - lastProgress >= stallMs) {
        controller.abort(new DOMException(`No upstream bytes or inference progress for ${stallMs} ms.`, 'TimeoutError'));
      }
    } catch (error) {
      if (waiting && Date.now() - lastProgress >= stallMs) controller.abort(new DOMException(`Upstream stalled: ${error.message}`, 'TimeoutError'));
    } finally { checking = false; }
  }, Math.min(5000, Math.max(5, stallMs / 4)));
  timer.unref?.();
  // The listener must detach itself. Node keeps any composite AbortSignal
  // (AbortSignal.any) that has a live 'abort' listener alive in a module-global
  // set, which pins this scope — and with it options.body, the full serialized
  // upstream request, up to several MB. A generation that completes normally
  // never aborts, so only an explicit removeEventListener releases the pin.
  const cleanup = () => {
    clearInterval(timer);
    signal.removeEventListener('abort', cleanup);
  };
  signal.addEventListener('abort', cleanup, { once: true });
  try {
    const response = await requestWithNodeTransport(`${config.upstreamUrl}${pathname}`, { ...options, signal, connectTimeoutMs: config.upstreamConnectTimeoutMs ?? 10000 });
    lastProgress = Date.now();
    if (!response.body) { cleanup(); return response; }
    const reader = response.body.getReader();
    return new Response(new ReadableStream({
      async pull(target) {
        try {
          waiting = true;
          lastProgress = Date.now();
          const { done, value } = await reader.read();
          waiting = false;
          if (done) { cleanup(); target.close(); return; }
          lastProgress = Date.now(); target.enqueue(value);
        } catch (error) { cleanup(); target.error(signal.reason ?? error); }
      },
      async cancel(reason) { cleanup(); controller.abort(reason); await reader.cancel(reason); }
    }), { status: response.status, headers: response.headers });
  } catch (error) { cleanup(); throw signal.reason ?? error; }
}

function upstreamError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readBoundedResponseText(response, maxResponseBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw upstreamError(
          'UPSTREAM_RESPONSE_TOO_LARGE',
          `Upstream JSON response exceeded the ${maxResponseBytes}-byte limit.`
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

export async function upstreamJson(config, pathname, {
  method = 'GET',
  body = undefined,
  timeoutMs = undefined,
  headers = {},
  maxResponseBytes = undefined,
  signal = undefined
} = {}) {
  const request = {
    method,
    timeoutMs,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
  let response;
  let text;
  {
    if (maxResponseBytes !== undefined && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0)) {
      throw new TypeError('maxResponseBytes must be a positive safe integer.');
    }
    const effectiveTimeoutMs = timeoutMs ?? config.upstreamTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeoutMs);
    try {
      response = await upstreamFetch(config, pathname, { ...request, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      text = maxResponseBytes === undefined ? await response.text() : await readBoundedResponseText(response, maxResponseBytes);
    } catch (error) {
      if (timedOut) {
        throw upstreamError('UPSTREAM_TIMEOUT', `Upstream JSON request exceeded the ${effectiveTimeoutMs} ms timeout.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  let json = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: json,
    text,
    usage: extractUsageFromOllamaObject(json)
  };
}

export async function checkUpstream(config) {
  const started = Date.now();
  try {
    const version = await upstreamJson(config, '/api/version', { timeoutMs: 5000 });
    return {
      ok: version.ok,
      status: version.status,
      latencyMs: Date.now() - started,
      version: version.body,
      error: version.ok ? null : version.text
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - started,
      version: null,
      error: error.message
    };
  }
}

export async function getOllamaPs(config) {
  try {
    const result = await upstreamJson(config, '/api/ps', { timeoutMs: 10000 });
    return result.body;
  } catch (error) {
    return { error: error.message, models: [] };
  }
}

export async function getModelCapabilities(config, model) {
  if (!model) return { known: false, capabilities: [] };

  let result;
  try {
    result = await upstreamJson(config, '/api/show', {
      method: 'POST',
      body: { model },
      timeoutMs: Math.min(config.upstreamTimeoutMs, 10000)
    });
  } catch {
    return { known: false, capabilities: [] };
  }

  if (!result.ok || !Array.isArray(result.body?.capabilities)) {
    return { known: false, capabilities: [] };
  }
  return { known: true, capabilities: [...result.body.capabilities] };
}

export function createModelCapabilityLookup(config, model) {
  let lookupPromise = null;
  return () => {
    if (!lookupPromise) lookupPromise = getModelCapabilities(config, model);
    return lookupPromise;
  };
}

export async function normalizeThinkForModel(config, model, body, reasoningProfile = null, capabilityLookup = null) {
  const incomingThink = body?.think;
  const validatedCapabilities = validateReasoningCapabilities(reasoningProfile);
  // Ollama exposes binary thinking support through /api/show even when the
  // deployment has no safe string-level map. In that case, translate any
  // enabled effort to boolean true and let the binary capability check below
  // either forward it or remove it. Explicit malformed profiles still fail so
  // operator configuration errors are not silently ignored.
  const mappedThink = normalizeThinkValue(incomingThink, validatedCapabilities, { fallbackToBoolean: true });
  const usedBooleanFallback = validatedCapabilities === null
    && typeof incomingThink === 'string'
    && isThinkingEnabled(mappedThink);
  const thinkMapped = mappedThink !== incomingThink;
  const mappedBody = thinkMapped ? { ...body, think: mappedThink } : body;
  const unchanged = {
    body: mappedBody,
    incomingThink,
    forwardedThink: mappedThink,
    thinkMapped,
    thinkDropped: false,
    thinkNormalized: thinkMapped,
    thinkingSupported: null
  };

  if (!model || !body || typeof body !== 'object' || Array.isArray(body) || !isThinkingEnabled(mappedThink)) {
    return unchanged;
  }

  const lookup = capabilityLookup || createModelCapabilityLookup(config, model);
  const capabilityResult = await lookup();
  if (!capabilityResult.known && !usedBooleanFallback) return unchanged;
  if (capabilityResult.capabilities.includes('thinking')) {
    return { ...unchanged, thinkingSupported: true };
  }

  const normalizedBody = { ...body };
  delete normalizedBody.think;
  return {
    body: normalizedBody,
    incomingThink,
    forwardedThink: undefined,
    thinkMapped,
    thinkDropped: true,
    thinkNormalized: true,
    thinkingSupported: capabilityResult.known ? false : null
  };
}

export function activeModelLoadedState(psBody, activeModel) {
  const models = Array.isArray(psBody?.models) ? psBody.models : [];
  const match = models.find((model) => model?.name === activeModel || model?.model === activeModel);
  return {
    loaded: Boolean(match),
    until: match?.expires_at || match?.until || null,
    raw: match || null
  };
}
