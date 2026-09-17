import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { loadConfig, publicConfig } from './config.js';
import { readActiveModel } from './active-model.js';
import { selectModel } from './model-catalog.js';
import { JsonlStore } from './fs-store.js';
import { Metrics } from './metrics.js';
import { evaluateProxyPolicy, isLikelyStreamingRequest, MODEL_BODY_ROUTES, routeKey } from './policy.js';
import { handleResponsesRequest, isResponsesPath } from './responses-api.js';
import { NdjsonUsageCollector, extractUsageFromOllamaObject } from './stream-parser.js';
import { getGpuTelemetry } from './telemetry.js';
import {
  activeModelLoadedState,
  checkUpstream,
  createModelCapabilityLookup,
  getOllamaPs,
  normalizeThinkForModel,
  upstreamFetch,
  upstreamJson
} from './upstream.js';
import { resolveDefaultThink, thinkLevelToReasoningEffort } from './reasoning.js';
import { createToolCapabilityLookup, emptyToolPolicy, normalizeToolsForModel } from './native-tools.js';
import {
  BackendAdapterError,
  fetchPrepared,
  isGenerationPath,
  normalizeOpenAiSseModel,
  openAiCompletionToOllama,
  openAiNonstreamForPublic,
  openAiSseToOllamaStream,
  resolveBackendAdapter
} from './backend-adapters.js';
import { RequestGate, RequestGateError } from './request-gate.js';
import { queueHeartbeat, endQueuedError, connectionAbort } from './queue-response.js';
import {
  ModelCatalogDiscovery,
  ifNoneMatchMatches,
  ModelDiscoveryError,
  modelDiscoveryErrorPayload
} from './model-discovery.js';
import {
  copyUpstreamHeaders,
  filterRequestHeaders,
  getClientIdentity,
  getClientIp,
  hasAdminAuth,
  methodAllowsBody,
  parseJsonBuffer,
  readRequestBody,
  requireAdmin,
  sendJson,
  sendText,
  serveStaticFile,
  summarizeBody
} from './http-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_ROOT = path.resolve(__dirname, '..', 'public');
const LLAMA_PREWARM_MAX_MODEL_BYTES = 512;
const LLAMA_PREWARM_MAX_RESPONSE_BYTES = 16 * 1024;
const LLAMA_PREWARM_TIMEOUT_MS = 55_000;
const LLAMA_PREWARM_MAX_TOKENS = 1;
const LLAMA_PREWARM_PROMPT = 'Operational pre-warm.';

function nowIso() {
  return new Date().toISOString();
}

function combineAbortSignals(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  const abort = (signal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
}

function createBaseRecord(request, pathname) {
  return {
    id: randomUUID(),
    ts: nowIso(),
    method: request.method,
    endpoint: pathname,
    clientIdentity: getClientIdentity(request),
    sourceIp: getClientIp(request),
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null
  };
}

async function persistRequest(store, metrics, record) {
  metrics.recordRequest(record);
  try {
    await store.appendRequest(record);
  } catch (error) {
    console.error('failed to persist request record', error);
  }
}

async function persistEvent(store, event) {
  try {
    return await store.appendEvent(event);
  } catch (error) {
    console.error('failed to persist event record', error);
    return null;
  }
}

function errorPayload(code, message, details = undefined) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

async function handleHealth(response, context) {
  const activeModel = await readActiveModel(context.config);
  const upstream = await resolveBackendAdapter(context.config, activeModel).health();
  const runtime = context.requestGate.snapshot(activeModel);
  // During a controlled transition the router is intentionally available while
  // its previous backend is offline. Keep the service health check green so the
  // transaction can commit the replacement backend; generation routes still
  // return the explicit BACKEND_DRAINING 503 enforced by the request gate.
  const serviceAvailable = upstream.ok || runtime.draining;
  sendJson(response, serviceAvailable ? 200 : 503, {
    ok: serviceAvailable,
    backend_ready: upstream.ok,
    router: {
      appName: context.config.appName,
      version: context.config.version,
      maintenanceMode: context.state.maintenanceMode,
      runtime,
      startedAt: context.state.startedAt
    },
    upstream,
    activeModel
  });
}

function requestedDiscoveryModelId(pathname) {
  if (pathname === '/v1/models') return null;
  if (!pathname.startsWith('/v1/models/')) return undefined;
  try {
    return decodeURIComponent(pathname.slice('/v1/models/'.length));
  } catch {
    return pathname.slice('/v1/models/'.length);
  }
}

async function recordDiscoveryFailure(context, code, warnings = [], upstreamModel = null) {
  const signature = JSON.stringify({ code, warnings, upstreamModel });
  if (context.state.lastDiscoveryFailureSignature === signature) return;
  context.state.lastDiscoveryFailureSignature = signature;
  await persistEvent(context.store, {
    type: 'model_discovery_failed',
    code,
    warnings,
    alias: context.config.routerModelAlias,
    upstreamModel
  });
}

async function handleModelDiscovery(request, response, pathname, context) {
  const requestedId = requestedDiscoveryModelId(pathname);
  try {
    if (request.method !== 'GET') {
      throw new ModelDiscoveryError(
        405,
        'METHOD_NOT_ALLOWED',
        'The model discovery endpoint only accepts GET requests.',
        null,
        'invalid_request_error'
      );
    }
    const discovery = await context.modelDiscovery.document(requestedId);
    for (const entry of discovery.entries) {
      const metadata = entry.x_ollama_router;
      if (metadata.warnings.length) {
        await recordDiscoveryFailure(context, 'MODEL_METADATA_PARTIAL', metadata.warnings, metadata.upstream_model);
      } else {
        context.state.lastDiscoveryFailureSignature = null;
      }
    }

    const headers = {
      'cache-control': 'no-cache',
      etag: discovery.etag,
      'x-ollama-router': 'llm-router'
    };
    if (ifNoneMatchMatches(request.headers['if-none-match'], discovery.etag)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    sendJson(
      response,
      200,
      requestedId === null ? { object: 'list', data: discovery.entries } : discovery.entries[0],
      headers
    );
  } catch (error) {
    const discoveryError = error instanceof ModelDiscoveryError
      ? error
      : new ModelDiscoveryError(500, 'MODEL_DISCOVERY_FAILED', 'Model metadata discovery failed unexpectedly.');
    if (discoveryError.code !== 'MODEL_NOT_FOUND' && discoveryError.code !== 'METHOD_NOT_ALLOWED') {
      await recordDiscoveryFailure(context, discoveryError.code);
    }
    sendJson(response, discoveryError.statusCode, modelDiscoveryErrorPayload(discoveryError), {
      'cache-control': 'no-cache',
      'x-ollama-router': 'llm-router'
    });
  }
}

async function buildSummary(context) {
  const activeModel = await readActiveModel(context.config);
  const backend = resolveBackendAdapter(context.config, activeModel);
  const [upstream, ps, gpu] = await Promise.all([
    backend.health(),
    backend.ps(),
    getGpuTelemetry(context.config)
  ]);
  const activeLoadedState = activeModel.model ? activeModelLoadedState(ps, activeModel.model) : { loaded: false, until: null, raw: null };
  const recentRequests = context.store.recentRequests(100);
  const recentRejectsOrErrors = recentRequests
    .filter((record) => record?.rejected || record?.upstreamError || Number(record?.responseStatus || record?.status || 0) >= 400)
    .slice(0, 10);
  const recentErrorEvents = context.store.recentEvents(100)
    .filter((event) => /reject|error|fail/i.test(String(event?.type || '')))
    .slice(0, 10);
  return {
    generatedAt: nowIso(),
    router: {
      appName: context.config.appName,
      version: context.config.version,
      startedAt: context.state.startedAt,
      maintenanceMode: context.state.maintenanceMode,
      runtime: context.requestGate.snapshot(activeModel),
      uptimeSeconds: Math.round(process.uptime()),
      api: {
        host: context.config.host,
        port: context.config.port
      },
      admin: {
        enabled: context.config.adminEnabled,
        bindHost: context.config.adminBindHost,
        port: context.config.adminPort,
        authRequired: false
      }
    },
    config: publicConfig(context.config),
    activeModel,
    models: (await context.modelDiscovery.document(null, { includeAliases: false })).entries,
    upstream,
    ollamaPs: ps,
    activeLoadedState,
    gpu,
    metrics: context.metrics.snapshot(),
    recentRejectsOrErrors,
    recentErrorEvents,
    logs: context.store.paths()
  };
}

async function handleAdminApi(request, response, pathname, context, { requireAuth = true } = {}) {
  if (requireAuth && !requireAdmin(request, response, context.config)) return;

  if (['/admin/api/runtime-state', '/admin/api/runtime-drain', '/admin/api/generation-record'].includes(pathname)) {
    if (!context.config.adminToken) {
      sendJson(response, 503, errorPayload('RUNTIME_CONTROL_UNAVAILABLE', 'Runtime control requires a configured admin token.'));
      return;
    }
    if (!requireAdmin(request, response, context.config)) return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/generation-record') {
    const id = new URL(request.url, 'http://router.local').searchParams.get('id');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id ?? '')) {
      sendJson(response, 400, errorPayload('INVALID_RECORD_ID', 'A generation record UUID is required.')); return;
    }
    const file = path.join(context.config.dataDir, 'generations', `${id}.jsonl`);
    try { await stat(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      sendJson(response, 404, errorPayload('RECORD_NOT_FOUND', 'Generation record not found.')); return;
    }
    response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    await pipeline(createReadStream(file), response);
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/runtime-state') {
    const activeModel = await readActiveModel(context.config);
    const backend = resolveBackendAdapter(context.config, activeModel);
    const health = await backend.health();
    const ps = await backend.ps();
    sendJson(response, 200, {
      ok: true,
      runtime: context.requestGate.snapshot(activeModel),
      backend: { kind: backend.kind, health, status: ps },
      models: (await context.modelDiscovery.document(null, { includeAliases: false })).entries,
      active_model: {
        profile: activeModel.profile,
        model: activeModel.model,
        backend_kind: activeModel.backend_kind,
        context_length: activeModel.context_length,
        total_context_length: activeModel.total_context_length,
        max_active_requests: activeModel.max_active_requests,
        gpu_uuids: activeModel.gpu_uuids,
        fit_target: activeModel.fit_target,
        prompt_cache_mode: activeModel.prompt_cache_mode,
        prompt_cache_volatile: activeModel.capability_profile?.prompt_cache_volatile === true,
        prompt_cache_persistence: activeModel.capability_profile?.prompt_cache_persistence === true,
        reasoning_default: activeModel.reasoning_policy?.default_level ?? null,
        reasoning_levels: Object.keys(activeModel.reasoning_policy?.levels || {}),
        reasoning_aliases: activeModel.reasoning_policy?.aliases ?? {}
      }
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/admin/api/runtime-drain') {
    let body;
    try {
      body = parseJsonBuffer(await readRequestBody(request, context.config.maxBodyBytes)) || {};
    } catch (error) {
      sendJson(response, error.statusCode || 400, errorPayload('INVALID_JSON_BODY', error.message));
      return;
    }
    if (typeof body.enabled !== 'boolean') {
      sendJson(response, 400, errorPayload('INVALID_DRAIN_STATE', 'enabled must be a boolean.'));
      return;
    }
    const activeModel = await readActiveModel(context.config);
    const runtime = await context.requestGate.setDraining(body.enabled, body.reason);
    await persistEvent(context.store, {
      type: 'runtime_drain_changed',
      enabled: body.enabled,
      reason: runtime.drain_reason,
      profile: activeModel.profile,
      backendKind: activeModel.backend_kind,
      activeCount: runtime.active_count
    });
    sendJson(response, 200, { ok: true, runtime: context.requestGate.snapshot(activeModel) });
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/summary') {
    sendJson(response, 200, await buildSummary(context));
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/requests') {
    sendJson(response, 200, {
      requests: context.store.recentRequests(Number(new URL(request.url, 'http://router.local').searchParams.get('limit')) || context.config.requestHistoryLimit)
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/events') {
    sendJson(response, 200, {
      events: context.store.recentEvents(Number(new URL(request.url, 'http://router.local').searchParams.get('limit')) || context.config.eventHistoryLimit)
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/config') {
    sendJson(response, 200, publicConfig(context.config));
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/metrics') {
    sendJson(response, 200, context.metrics.snapshot());
    return;
  }

  if (request.method === 'POST' && pathname === '/admin/api/reload-config') {
    const activeModel = await readActiveModel(context.config);
    context.modelDiscovery.invalidate();
    await persistEvent(context.store, { type: 'active_model_marker_reloaded', activeModel });
    sendJson(response, 200, { ok: true, activeModel });
    return;
  }

  if (request.method === 'POST' && pathname === '/admin/api/maintenance') {
    let body = {};
    try {
      body = parseJsonBuffer(await readRequestBody(request, context.config.maxBodyBytes)) || {};
    } catch (error) {
      sendJson(response, error.statusCode || 400, errorPayload('INVALID_JSON_BODY', error.message));
      return;
    }
    context.state.maintenanceMode = Boolean(body.enabled);
    await persistEvent(context.store, { type: 'maintenance_mode_changed', enabled: context.state.maintenanceMode });
    sendJson(response, 200, { ok: true, maintenanceMode: context.state.maintenanceMode });
    return;
  }

  if (request.method === 'POST' && pathname === '/admin/api/prewarm') {
    const body = parseJsonBuffer(await readRequestBody(request, context.config.maxBodyBytes));
    const activeModel = await selectModel(context.config, body?.model);
    if (!activeModel.model) {
      sendJson(response, 503, errorPayload('NO_ACTIVE_MODEL', 'Cannot prewarm because no active model marker is available.'));
      return;
    }
    const backend = resolveBackendAdapter(context.config, activeModel);
    if (backend.kind === 'llama_cpp') {
      if (context.state.maintenanceMode) throw new RequestGateError(503, 'MAINTENANCE_MODE', 'Router maintenance mode is enabled.');
      const adminAbort = connectionAbort(request, response);
      let adminLease;
      try {
      adminLease = await context.requestGate.acquire({ endpoint: pathname, clientIdentity: 'admin', limit: backend.maxActiveRequests, backendKey: backend.admissionKey, model: activeModel.model, signal: adminAbort.signal });
      const started = Date.now();
      if (Buffer.byteLength(activeModel.model, 'utf8') > LLAMA_PREWARM_MAX_MODEL_BYTES) {
        await persistEvent(context.store, {
          type: 'prewarm_failed',
          model: null,
          backendKind: backend.kind,
          stage: 'input',
          code: 'INVALID_ACTIVE_MODEL',
          latencyMs: Date.now() - started,
          ok: false
        });
        sendJson(response, 503, errorPayload(
          'INVALID_ACTIVE_MODEL',
          'The active llama.cpp model identifier exceeds the operational prewarm input limit.'
        ));
        return;
      }
      const health = await backend.health();
      if (!health.ok) {
        await persistEvent(context.store, {
          type: 'prewarm_failed',
          model: activeModel.model,
          backendKind: backend.kind,
          stage: 'readiness',
          status: health.status,
          code: 'BACKEND_NOT_READY',
          latencyMs: Date.now() - started,
          ok: false
        });
        sendJson(response, 503, errorPayload(
          'BACKEND_NOT_READY',
          'The active llama.cpp backend is not ready for operational prewarm.'
        ));
        return;
      }
      // This is an operational residency warm-up, not a qualification probe.
      // A raw completion bypasses chat-template reasoning and has no tool schema;
      // the generated byte content is deliberately neither returned nor logged.
      const body = {
        model: activeModel.model,
        prompt: LLAMA_PREWARM_PROMPT,
        stream: false,
        max_tokens: LLAMA_PREWARM_MAX_TOKENS,
        temperature: 0,
        top_p: 1,
        n: 1,
        seed: 0
      };
      try {
        const result = await upstreamJson(backend.upstreamConfig, '/v1/completions', {
          method: 'POST',
          body,
          timeoutMs: Math.min(context.config.upstreamTimeoutMs, LLAMA_PREWARM_TIMEOUT_MS),
          maxResponseBytes: LLAMA_PREWARM_MAX_RESPONSE_BYTES
        });
        const generatedTokens = Number.isSafeInteger(result.body?.usage?.completion_tokens)
          ? result.body.usage.completion_tokens
          : null;
        const completed = result.ok
          && Array.isArray(result.body?.choices)
          && result.body.choices.length === 1
          && typeof result.body.choices[0]?.text === 'string'
          && generatedTokens !== null
          && generatedTokens > 0
          && generatedTokens <= LLAMA_PREWARM_MAX_TOKENS;
        const latencyMs = Date.now() - started;
        await persistEvent(context.store, {
          type: completed ? 'prewarm_triggered' : 'prewarm_failed',
          model: activeModel.model,
          backendKind: backend.kind,
          stage: 'inference',
          status: result.status,
          latencyMs,
          generatedTokens,
          ...(completed ? {} : { code: result.ok ? 'INVALID_PREWARM_RESPONSE' : 'PREWARM_UPSTREAM_REJECTED' }),
          ok: completed
        });
        if (!completed) {
          sendJson(response, 502, errorPayload(
            result.ok ? 'INVALID_PREWARM_RESPONSE' : 'PREWARM_UPSTREAM_REJECTED',
            'The active llama.cpp backend did not confirm the bounded operational prewarm inference.'
          ));
          return;
        }
        sendJson(response, 200, {
          ok: true,
          model: activeModel.model,
          backend: backend.kind,
          status: result.status,
          latencyMs,
          generatedTokens
        });
      } catch (error) {
        const code = error.code === 'UPSTREAM_TIMEOUT'
          ? 'PREWARM_TIMEOUT'
          : (error.code === 'UPSTREAM_RESPONSE_TOO_LARGE' ? 'PREWARM_RESPONSE_TOO_LARGE' : 'PREWARM_UPSTREAM_ERROR');
        await persistEvent(context.store, {
          type: 'prewarm_failed',
          model: activeModel.model,
          backendKind: backend.kind,
          stage: 'inference',
          latencyMs: Date.now() - started,
          code,
          ok: false
        });
        sendJson(response, code === 'PREWARM_TIMEOUT' ? 504 : 502, errorPayload(
          code,
          code === 'PREWARM_TIMEOUT'
            ? 'The bounded operational prewarm inference timed out.'
            : 'The bounded operational prewarm inference failed.'
        ));
      }
      return;
      } finally { adminAbort.cleanup(); adminLease?.release(); }
    }
    const warmBody = {
      model: activeModel.model,
      prompt: '',
      stream: false,
      keep_alive: context.config.forcedKeepAlive
    };
    const started = Date.now();
    try {
      const result = await upstreamJson(backend.upstreamConfig, '/api/generate', { method: 'POST', body: warmBody, timeoutMs: context.config.upstreamTimeoutMs });
      await persistEvent(context.store, {
        type: 'prewarm_triggered',
        model: activeModel.model,
        status: result.status,
        latencyMs: Date.now() - started,
        ok: result.ok
      });
      sendJson(response, result.ok ? 200 : result.status, {
        ok: result.ok,
        model: activeModel.model,
        status: result.status,
        upstream: result.body
      });
    } catch (error) {
      await persistEvent(context.store, { type: 'prewarm_failed', model: activeModel.model, error: error.message });
      sendJson(response, 502, errorPayload('UPSTREAM_ERROR', error.message));
    }
    return;
  }

  if (request.method === 'POST' && pathname === '/admin/api/test-chat') {
    let activeModel = await selectModel(context.config);
    if (!activeModel.model) {
      sendJson(response, 503, errorPayload('NO_ACTIVE_MODEL', 'Cannot run a test chat because no active model marker is available.'));
      return;
    }
    let body = {};
    try {
      body = parseJsonBuffer(await readRequestBody(request, context.config.maxBodyBytes)) || {};
    } catch (error) {
      sendJson(response, error.statusCode || 400, errorPayload('INVALID_JSON_BODY', error.message));
      return;
    }
    activeModel = await selectModel(context.config, body.model);
    if (context.state.maintenanceMode) throw new RequestGateError(503, 'MAINTENANCE_MODE', 'Router maintenance mode is enabled.');
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : 'Reply with a one sentence health check.';
    const started = Date.now();
    const backend = resolveBackendAdapter(context.config, activeModel);
    let lease = null;
    const adminAbort = connectionAbort(request, response);
    try {
      let result;
      if (backend.kind === 'llama_cpp') {
        lease = await context.requestGate.acquire({ endpoint: '/admin/api/test-chat', clientIdentity: 'admin', limit: backend.maxActiveRequests, backendKey: backend.admissionKey, model: activeModel.model, signal: adminAbort.signal });
        await backend.ensureAvailable(adminAbort.signal);
        const prepared = await backend.prepareProxy({
          method: 'POST',
          pathname: '/api/chat',
          body: { model: activeModel.model, messages: [{ role: 'user', content: prompt }], stream: false },
          query: '', signal: adminAbort.signal
        });
        const upstream = await fetchPrepared(backend, prepared, { 'content-type': 'application/json', accept: 'application/json' }, adminAbort.signal);
        const payload = JSON.parse(await upstream.text());
        result = {
          ok: upstream.ok,
          status: upstream.status,
          body: upstream.ok ? openAiCompletionToOllama(payload, { kind: 'native-chat', model: activeModel.model }) : payload,
          usage: upstream.ok ? payload.usage : null
        };
      } else {
        result = await upstreamJson(backend.upstreamConfig, '/api/chat', {
          method: 'POST',
          timeoutMs: context.config.upstreamTimeoutMs,
          body: {
            model: activeModel.model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            keep_alive: context.config.forcedKeepAlive
          }
        });
      }
      await persistEvent(context.store, {
        type: 'admin_test_chat',
        model: activeModel.model,
        status: result.status,
        latencyMs: Date.now() - started,
        ok: result.ok
      });
      sendJson(response, result.ok ? 200 : result.status, {
        ok: result.ok,
        status: result.status,
        model: activeModel.model,
        upstream: result.body,
        usage: result.usage
      });
    } catch (error) {
      await persistEvent(context.store, { type: 'admin_test_chat_failed', model: activeModel.model, error: error.message });
      sendJson(response, 502, errorPayload('UPSTREAM_ERROR', error.message));
    } finally {
      adminAbort.cleanup();
      lease?.release();
    }
    return;
  }

  sendJson(response, 404, errorPayload('ADMIN_ROUTE_NOT_FOUND', 'Admin API route not found.'));
}

async function rejectProxyRequest(response, context, record, status, code, message, extra = {}, openAiError = null) {
  const finalRecord = {
    ...record,
    ...extra,
    allowed: false,
    rejected: true,
    responseStatus: status,
    status,
    errorCode: code,
    errorSummary: message,
    latencyMs: Date.now() - record.startedEpochMs
  };
  await persistRequest(context.store, context.metrics, finalRecord);
  await persistEvent(context.store, {
    type: 'request_rejected',
    code,
    message,
    endpoint: record.endpoint,
    method: record.method,
    requestedModel: extra.requestedModel,
    forwardedModel: extra.forwardedModel,
    activeModel: extra.activeModel,
    modelRewritten: Boolean(extra.modelRewritten),
    toolsPresent: extra.toolsPresent,
    toolCount: extra.toolCount,
    toolChoicePresent: extra.toolChoicePresent,
    toolHistoryPresent: extra.toolHistoryPresent,
    toolsSupported: extra.toolsSupported,
    toolsDropped: extra.toolsDropped,
    unsupportedToolsPolicy: extra.unsupportedToolsPolicy,
    clientIdentity: record.clientIdentity,
    sourceIp: record.sourceIp
  });
  if (response.headersSent) {
    endQueuedError(response, record.endpoint === '/v1/chat/completions' ? 'chat' : 'native', { code, message });
    return;
  }
  sendJson(response, status, openAiError
    ? {
        error: {
          message,
          type: openAiError.type,
          param: openAiError.param ?? null,
          code
        }
      }
    : errorPayload(code, message));
}

async function ollamaCatalogStatus(context, pathname) {
  // Tags enumerate selectable identifiers; ps enumerates running engines only.
  const { entries } = await context.modelDiscovery.document(null, { includeAliases: pathname === '/api/tags' });
  return { models: entries.filter((entry) => pathname !== '/api/ps' || entry.x_ollama_router.health?.available).map((entry) => {
    const meta = entry.x_ollama_router;
    return { name: entry.id, model: entry.id, modified_at: meta.updated_at,
      digest: meta.revision, size: 0, context_length: meta.context_window,
      ...(pathname === '/api/ps' ? { expires_at: '9999-12-31T23:59:59Z', slots: meta.active_request_limit } : {}),
      details: { format: 'gguf', family: 'qwen3', parameter_size: '27B', quantization_level: meta.quantization },
      capabilities: meta.capabilities, x_ollama_router: meta };
  }) };
}

async function handleProxy(request, response, url, context) {
  const pathname = url.pathname;
  const recordBase = {
    ...createBaseRecord(request, pathname),
    query: url.search || '',
    startedEpochMs: Date.now()
  };

  let incomingBody = null;
  let rawBody = null;
  if (methodAllowsBody(request.method)) {
    try {
      rawBody = await readRequestBody(request, context.config.maxBodyBytes);
      incomingBody = parseJsonBuffer(rawBody);
    } catch (error) {
      await rejectProxyRequest(response, context, recordBase, error.statusCode || 400, 'INVALID_JSON_BODY', error.message);
      return;
    }
  }

  const incomingToolPolicy = emptyToolPolicy(incomingBody, context.config.unsupportedToolsPolicy);
  const bodySummaryMode = incomingToolPolicy.toolRelatedFieldsPresent
    ? 'metadata'
    : context.config.promptLogging;

  let activeModel;
  let backend;
  try {
    activeModel = await selectModel(context.config, incomingBody?.model);
    backend = resolveBackendAdapter(context.config, activeModel);
  } catch (error) {
    await rejectProxyRequest(response, context, recordBase, error.statusCode || 503, error.code || 'INVALID_BACKEND_KIND', error.message, {
      activeModel: activeModel?.model,
      requestedModel: incomingBody?.model || null,
      bodySummary: summarizeBody(incomingBody, bodySummaryMode)
    });
    return;
  }
  const isModelBodyRoute = MODEL_BODY_ROUTES.has(routeKey(request.method, pathname));
  if ((context.state.maintenanceMode || context.requestGate.draining) && isModelBodyRoute) {
    const drainBlocked = context.requestGate.draining;
    await rejectProxyRequest(
      response,
      context,
      recordBase,
      503,
      drainBlocked ? 'BACKEND_DRAINING' : 'MAINTENANCE_MODE',
      drainBlocked ? 'The active inference backend is draining for a runtime transition. Retry shortly.' : 'Router maintenance mode is enabled.',
      {
      activeModel: activeModel?.model,
      requestedModel: incomingBody?.model || null,
      bodySummary: summarizeBody(incomingBody, bodySummaryMode),
      toolsPresent: incomingToolPolicy.toolsPresent,
      toolCount: incomingToolPolicy.toolCount,
      toolChoicePresent: incomingToolPolicy.toolChoicePresent,
      toolHistoryPresent: incomingToolPolicy.toolHistoryPresent,
      toolsSupported: incomingToolPolicy.toolsSupported,
      toolsDropped: incomingToolPolicy.toolsDropped,
      unsupportedToolsPolicy: incomingToolPolicy.unsupportedToolsPolicy
      }
    );
    return;
  }

  const policy = evaluateProxyPolicy({
    method: request.method,
    pathname,
    body: incomingBody,
    activeModelInfo: activeModel,
    config: context.config,
    isAdmin: hasAdminAuth(request, context.config)
  });

  let thinkPolicy = {
    body: policy.sanitizedBody,
    incomingThink: policy.sanitizedBody?.think,
    forwardedThink: policy.sanitizedBody?.think,
    thinkMapped: false,
    thinkDropped: false,
    thinkNormalized: false,
    thinkingSupported: null
  };
  let toolPolicy = emptyToolPolicy(policy.sanitizedBody, context.config.unsupportedToolsPolicy);
  let sanitizedBody = toolPolicy.body;

  const commonRecord = {
    ...recordBase,
    activeModel: policy.activeModel,
    requestedModel: policy.requestedModel,
    forwardedModel: policy.forwardedModel,
    modelRewritten: Boolean(policy.modelRewritten),
    incomingKeepAlive: policy.incomingKeepAlive,
    forwardedKeepAlive: policy.forwardedKeepAlive,
    keepAliveNormalized: Boolean(policy.keepAliveNormalized),
    incomingThink: thinkPolicy.incomingThink,
    forwardedThink: undefined,
    incomingReasoningEffort: thinkLevelToReasoningEffort(policy.sanitizedBody?.think) ?? null,
    thinkMapped: thinkPolicy.thinkMapped,
    thinkDropped: thinkPolicy.thinkDropped,
    thinkNormalized: thinkPolicy.thinkNormalized,
    thinkingSupported: thinkPolicy.thinkingSupported,
    reasoningEffort: thinkLevelToReasoningEffort(thinkPolicy.forwardedThink ?? thinkPolicy.incomingThink),
    toolsPresent: toolPolicy.toolsPresent,
    toolCount: toolPolicy.toolCount,
    toolChoicePresent: toolPolicy.toolChoicePresent,
    toolHistoryPresent: toolPolicy.toolHistoryPresent,
    toolsSupported: toolPolicy.toolsSupported,
    toolsDropped: toolPolicy.toolsDropped,
    unsupportedToolsPolicy: toolPolicy.unsupportedToolsPolicy,
    streaming: isLikelyStreamingRequest(pathname, sanitizedBody),
    bodySummary: summarizeBody(incomingBody, bodySummaryMode)
  };

  if (!policy.allowed) {
    await rejectProxyRequest(response, context, commonRecord, policy.status || 403, policy.code, policy.message, {
      activeModel: policy.activeModel,
      requestedModel: policy.requestedModel,
      forwardedModel: policy.forwardedModel,
      modelRewritten: Boolean(policy.modelRewritten),
      incomingKeepAlive: policy.incomingKeepAlive,
      forwardedKeepAlive: policy.forwardedKeepAlive,
      toolsPresent: toolPolicy.toolsPresent,
      toolCount: toolPolicy.toolCount,
      toolChoicePresent: toolPolicy.toolChoicePresent,
      toolHistoryPresent: toolPolicy.toolHistoryPresent,
      toolsSupported: toolPolicy.toolsSupported,
      toolsDropped: toolPolicy.toolsDropped,
      unsupportedToolsPolicy: toolPolicy.unsupportedToolsPolicy
    });
    return;
  }

  if (['/api/chat', '/api/generate', '/v1/chat/completions'].includes(pathname)) {
    let bodyWithThinkDefault = policy.sanitizedBody;
    const normalizesThinking = ['/api/chat', '/api/generate'].includes(pathname);
    const normalizesTools = ['/api/chat', '/v1/chat/completions'].includes(pathname);
    const canApplyThinkDefault = normalizesThinking && bodyWithThinkDefault
      && typeof bodyWithThinkDefault === 'object'
      && !Array.isArray(bodyWithThinkDefault)
      && !Object.hasOwn(bodyWithThinkDefault, 'think');
    const capabilityLookup = createToolCapabilityLookup(
      activeModel,
      createModelCapabilityLookup(backend.upstreamConfig, policy.forwardedModel)
    );
    try {
      if (backend.kind === 'ollama' && canApplyThinkDefault) {
        let defaultThink;
        defaultThink = resolveDefaultThink(activeModel, context.config);
        if (defaultThink !== undefined) bodyWithThinkDefault = { ...bodyWithThinkDefault, think: defaultThink };
      }
      if (normalizesTools) {
        toolPolicy = await normalizeToolsForModel(
          bodyWithThinkDefault,
          policy.forwardedModel,
          activeModel.catalog_mode ? 'reject' : context.config.unsupportedToolsPolicy,
          capabilityLookup
        );
      } else {
        toolPolicy = emptyToolPolicy(bodyWithThinkDefault, context.config.unsupportedToolsPolicy);
      }
      if (backend.kind === 'ollama' && normalizesThinking) {
        thinkPolicy = await normalizeThinkForModel(
          backend.upstreamConfig,
          policy.forwardedModel,
          toolPolicy.body,
          policy.forwardedModel === activeModel.model ? activeModel : null,
          capabilityLookup
        );
      } else {
        thinkPolicy = { ...thinkPolicy, body: toolPolicy.body };
      }
    } catch (error) {
      if (error.code === 'UNSUPPORTED_TOOLS' || error.code === 'UNSUPPORTED_TOOL_HISTORY') {
        toolPolicy = {
          ...emptyToolPolicy(bodyWithThinkDefault, context.config.unsupportedToolsPolicy),
          toolsSupported: false
        };
      }
      Object.assign(commonRecord, {
        toolsPresent: toolPolicy.toolsPresent,
        toolCount: toolPolicy.toolCount,
        toolChoicePresent: toolPolicy.toolChoicePresent,
        toolHistoryPresent: toolPolicy.toolHistoryPresent,
        toolsSupported: toolPolicy.toolsSupported,
        toolsDropped: toolPolicy.toolsDropped,
        unsupportedToolsPolicy: toolPolicy.unsupportedToolsPolicy
      });
      await rejectProxyRequest(
        response,
        context,
        commonRecord,
        error.statusCode || 503,
        error.code || 'INVALID_ACTIVE_MODEL_THINK_DEFAULT',
        error.message,
        {
          activeModel: policy.activeModel,
          requestedModel: policy.requestedModel,
          forwardedModel: policy.forwardedModel,
          toolsPresent: toolPolicy.toolsPresent,
          toolCount: toolPolicy.toolCount,
          toolChoicePresent: toolPolicy.toolChoicePresent,
          toolHistoryPresent: toolPolicy.toolHistoryPresent,
          toolsSupported: toolPolicy.toolsSupported,
          toolsDropped: toolPolicy.toolsDropped,
          unsupportedToolsPolicy: toolPolicy.unsupportedToolsPolicy
        }
      );
      return;
    }
    sanitizedBody = thinkPolicy.body;
    Object.assign(commonRecord, {
      incomingThink: thinkPolicy.incomingThink,
      forwardedThink: thinkPolicy.forwardedThink,
      thinkMapped: thinkPolicy.thinkMapped,
      thinkDropped: thinkPolicy.thinkDropped,
      thinkNormalized: thinkPolicy.thinkNormalized,
      thinkingSupported: thinkPolicy.thinkingSupported,
      reasoningEffort: thinkLevelToReasoningEffort(thinkPolicy.forwardedThink ?? thinkPolicy.incomingThink),
      toolsPresent: toolPolicy.toolsPresent,
      toolCount: toolPolicy.toolCount,
      toolChoicePresent: toolPolicy.toolChoicePresent,
      toolHistoryPresent: toolPolicy.toolHistoryPresent,
      toolsSupported: toolPolicy.toolsSupported,
      toolsDropped: toolPolicy.toolsDropped,
      unsupportedToolsPolicy: toolPolicy.unsupportedToolsPolicy,
      streaming: isLikelyStreamingRequest(pathname, sanitizedBody)
    });
  }

  if (policy.modelRewritten) {
    await persistEvent(context.store, {
      type: 'model_rewritten_to_active',
      endpoint: pathname,
      method: request.method,
      requestedModel: policy.requestedModel,
      forwardedModel: policy.forwardedModel,
      activeModel: policy.activeModel,
      clientIdentity: commonRecord.clientIdentity,
      sourceIp: commonRecord.sourceIp
    });
  }

  if (policy.keepAliveNormalized) {
    await persistEvent(context.store, {
      type: 'keep_alive_normalized',
      endpoint: pathname,
      method: request.method,
      model: policy.forwardedModel || policy.requestedModel,
      requestedModel: policy.requestedModel,
      modelRewritten: Boolean(policy.modelRewritten),
      incomingKeepAlive: policy.incomingKeepAlive,
      forwardedKeepAlive: policy.forwardedKeepAlive,
      clientIdentity: commonRecord.clientIdentity,
      sourceIp: commonRecord.sourceIp
    });
  }

  if (thinkPolicy.thinkDropped) {
    await persistEvent(context.store, {
      type: 'unsupported_thinking_dropped',
      endpoint: pathname,
      method: request.method,
      model: policy.forwardedModel,
      incomingThink: thinkPolicy.incomingThink,
      clientIdentity: commonRecord.clientIdentity,
      sourceIp: commonRecord.sourceIp
    });
  }

  if (thinkPolicy.thinkMapped && !thinkPolicy.thinkDropped) {
    await persistEvent(context.store, {
      type: 'think_level_mapped',
      endpoint: pathname,
      method: request.method,
      model: policy.forwardedModel,
      incomingReasoningEffort: commonRecord.incomingReasoningEffort,
      incomingThink: thinkPolicy.incomingThink,
      forwardedThink: thinkPolicy.forwardedThink,
      clientIdentity: commonRecord.clientIdentity,
      sourceIp: commonRecord.sourceIp
    });
  }

  if (toolPolicy.toolsDropped) {
    await persistEvent(context.store, {
      type: 'unsupported_tools_dropped',
      endpoint: pathname,
      method: request.method,
      model: policy.forwardedModel,
      toolsPresent: toolPolicy.toolsPresent,
      toolCount: toolPolicy.toolCount,
      toolChoicePresent: toolPolicy.toolChoicePresent,
      toolHistoryPresent: toolPolicy.toolHistoryPresent,
      toolsSupported: toolPolicy.toolsSupported,
      toolsDropped: toolPolicy.toolsDropped,
      unsupportedToolsPolicy: toolPolicy.unsupportedToolsPolicy,
      clientIdentity: commonRecord.clientIdentity,
      sourceIp: commonRecord.sourceIp
    });
  }

  const started = Date.now();
  let prepared;
  let lease = null;
  let upstreamResponse = null;
  let finalStatus = 500;
  let usage = null;
  let responseBytes = 0;
  let parseErrors = 0;
  let requestPersisted = false;
  const clientController = new AbortController();
  let stopQueueHeartbeat = () => {};
  const abortForClient = () => {
    if (!response.writableEnded && !clientController.signal.aborted) clientController.abort(new Error('Client disconnected.'));
  };
  request.once('aborted', abortForClient);
  response.once('close', abortForClient);
  if (request.aborted || response.destroyed) abortForClient();

  try {
    if (isGenerationPath(pathname)) {
      try {
        // Acquire before backend-side template/token validation. A switch that
        // begins during validation must wait for this accepted request instead
        // of stopping its backend underneath it.
        lease = await context.requestGate.acquire({
          endpoint: pathname,
          clientIdentity: commonRecord.clientIdentity,
          limit: backend.maxActiveRequests,
          backendKey: backend.admissionKey,
          model: activeModel.model,
          signal: clientController.signal,
          onQueued: () => {
            stopQueueHeartbeat = queueHeartbeat(response, commonRecord.streaming
              ? (pathname === '/v1/chat/completions' ? 'chat' : 'native') : null, { model: activeModel.model });
          }
        });
        stopQueueHeartbeat();
      } catch (error) {
        if (error instanceof RequestGateError) {
          await rejectProxyRequest(response, context, commonRecord, error.statusCode, error.code, error.message, commonRecord);
          requestPersisted = true;
          return;
        }
        throw error;
      }
    }

    try {
      if (isGenerationPath(pathname)) await backend.ensureAvailable(clientController.signal);
      const catalogStatus = activeModel.catalog_mode && request.method === 'GET' && ['/api/tags', '/api/ps'].includes(pathname);
      prepared = catalogStatus
        ? { localResponse: { status: 200, body: await ollamaCatalogStatus(context, pathname) } }
        : await backend.prepareProxy({
          method: request.method, pathname, body: sanitizedBody,
          query: url.search || '', signal: clientController.signal
        });
      if (backend.kind === 'llama_cpp' && prepared.reasoning) {
        Object.assign(commonRecord, {
          reasoningEffort: prepared.reasoning.level,
          thinkingSupported: true,
          requestedOutputTokens: prepared.reasoning.requestedOutputTokens,
          effectiveOutputTokens: prepared.reasoning.outputTokens,
          outputLimitCapped: prepared.reasoning.outputLimitCapped,
          outputLimitPolicy: prepared.reasoning.outputLimitPolicy
        });
        if (prepared.temperatureForwarding) {
          Object.assign(commonRecord, {
            temperatureForwarding: prepared.temperatureForwarding,
            ...(Object.hasOwn(prepared, 'forwardedTemperature')
              ? { forwardedTemperature: prepared.forwardedTemperature }
              : {})
          });
        }
        if (prepared.reasoning.outputLimitCapped) {
          await persistEvent(context.store, {
            type: 'output_limit_capped',
            endpoint: pathname,
            method: request.method,
            model: policy.forwardedModel,
            reasoningEffort: prepared.reasoning.level,
            requestedOutputTokens: prepared.reasoning.requestedOutputTokens,
            effectiveOutputTokens: prepared.reasoning.outputTokens,
            clientIdentity: commonRecord.clientIdentity,
            sourceIp: commonRecord.sourceIp
          });
        }
      }
    } catch (error) {
      if (error instanceof BackendAdapterError) {
        await rejectProxyRequest(
          response,
          context,
          commonRecord,
          error.statusCode,
          error.code,
          error.message,
          commonRecord,
          pathname === '/v1/chat/completions'
            ? {
                type: error.statusCode >= 500 ? 'server_error' : 'invalid_request_error',
                param: error.param
              }
            : null
        );
        requestPersisted = true;
        return;
      }
      throw error;
    }

    if (prepared.localResponse) {
      finalStatus = prepared.localResponse.status;
      const payload = prepared.localResponse.body;
      responseBytes = Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`);
      sendJson(response, finalStatus, payload, { 'x-ollama-router': 'llm-router' });
      await persistRequest(context.store, context.metrics, {
        ...commonRecord,
        allowed: true,
        rejected: false,
        responseStatus: finalStatus,
        status: finalStatus,
        upstreamError: false,
        latencyMs: Date.now() - started,
        responseBytes,
        usage,
        streamParseErrors: parseErrors,
        backendKind: backend.kind
      });
      requestPersisted = true;
      return;
    }

    const signal = clientController.signal;
    const hasBody = methodAllowsBody(prepared.method || request.method) && (prepared.upstreamBody ?? sanitizedBody) !== null;
    upstreamResponse = await fetchPrepared(
      backend,
      prepared,
      filterRequestHeaders(request.headers, hasBody ? {
        'content-type': 'application/json',
        accept: prepared.streaming ? (prepared.responseKind === 'passthrough' ? (request.headers.accept || '*/*') : 'text/event-stream') : 'application/json'
      } : {}),
      signal
    );
    finalStatus = upstreamResponse.status;

    if (backend.kind === 'llama_cpp' && !upstreamResponse.ok) {
      const text = await upstreamResponse.text();
      let details = null;
      try { details = JSON.parse(text); } catch { details = null; }
      finalStatus = upstreamResponse.status >= 500 ? 502 : upstreamResponse.status;
      const message = details?.error?.message || details?.error || 'The active llama.cpp backend rejected the request.';
      if (response.headersSent) endQueuedError(response, pathname === '/v1/chat/completions' ? 'chat' : 'native', { code: 'BACKEND_REQUEST_FAILED', message });
      else sendJson(response, finalStatus, errorPayload('BACKEND_REQUEST_FAILED', message));
      responseBytes = Buffer.byteLength(text);
      return;
    }

    let streamingBody = upstreamResponse.body;
    if (prepared.journal && !response.headersSent) response.setHeader('x-router-generation-id', prepared.journal.id);
    let contentType = upstreamResponse.headers.get('content-type') || '';
    if (prepared.streaming && backend.kind === 'llama_cpp') {
      if (prepared.responseKind === 'openai-chat') {
        streamingBody = normalizeOpenAiSseModel(upstreamResponse.body, activeModel.model, (payload) => {
          if (payload.usage) usage = payload.usage;
          if (payload.choices?.[0]?.finish_reason) commonRecord.finishReason = payload.choices[0].finish_reason;
          if (payload.x_router) Object.assign(commonRecord, { completionState: payload.x_router.status, generationRecordId: payload.x_router.record_id, stopReason: payload.x_router.stop_reason });
        });
        contentType = 'text/event-stream; charset=utf-8';
      } else {
        streamingBody = openAiSseToOllamaStream(upstreamResponse.body, {
          kind: prepared.responseKind,
          model: activeModel.model
        });
        contentType = 'application/x-ndjson; charset=utf-8';
      }
    }

    if (prepared.streaming && streamingBody) {
      const collector = prepared.responseKind === 'openai-chat' ? null : new NdjsonUsageCollector();
      if (!response.headersSent) {
        response.setHeader('content-type', contentType);
        response.setHeader('cache-control', 'no-store');
        response.setHeader('x-ollama-router', 'llm-router');
        if (prepared.reasoning?.outputLimitCapped) {
          response.setHeader('x-router-effective-max-output-tokens', String(prepared.reasoning.outputTokens));
        }
        response.writeHead(finalStatus);
      }
      const reader = streamingBody.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        responseBytes += buffer.length;
        collector?.observe(buffer);
        if (!response.write(buffer)) await once(response, 'drain', { signal: clientController.signal });
      }
      if (collector) {
        const collected = collector.finish();
        usage = collected.usage;
        parseErrors = collected.parseErrors;
        commonRecord.finishReason = collected.lastObject?.done_reason;
        if (collected.lastObject?.x_router) Object.assign(commonRecord, { completionState: collected.lastObject.x_router.status, generationRecordId: collected.lastObject.x_router.record_id, stopReason: collected.lastObject.x_router.stop_reason });
      }
      response.end();
    } else {
      let payloadBuffer;
      if (backend.kind === 'llama_cpp') {
        const payload = JSON.parse(await upstreamResponse.text());
        const normalized = prepared.responseKind === 'openai-chat'
          ? openAiNonstreamForPublic(payload, activeModel.model)
          : openAiCompletionToOllama(payload, { kind: prepared.responseKind, model: activeModel.model });
        commonRecord.finishReason = payload.choices?.[0]?.finish_reason;
        if (payload.x_router) Object.assign(commonRecord, { completionState: payload.x_router.status, generationRecordId: payload.x_router.record_id, stopReason: payload.x_router.stop_reason });
        usage = prepared.responseKind === 'openai-chat'
          ? payload.usage || null
          : extractUsageFromOllamaObject(normalized);
        payloadBuffer = Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8');
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('x-ollama-router', 'llm-router');
        response.setHeader('cache-control', 'no-store');
      } else {
        payloadBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
        const upstreamContentType = upstreamResponse.headers.get('content-type') || '';
        if (upstreamContentType.includes('application/json') && payloadBuffer.length) {
          try {
            usage = extractUsageFromOllamaObject(JSON.parse(payloadBuffer.toString('utf8')));
          } catch {
            parseErrors = 1;
          }
        }
        copyUpstreamHeaders(upstreamResponse.headers, response, false);
      }
      if (prepared.reasoning?.outputLimitCapped) {
        response.setHeader('x-router-effective-max-output-tokens', String(prepared.reasoning.outputTokens));
      }
      responseBytes = payloadBuffer.length;
      response.setHeader('content-length', payloadBuffer.length);
      response.writeHead(finalStatus);
      response.end(payloadBuffer);
    }
  } catch (error) {
    const clientClosed = clientController.signal.aborted;
    commonRecord.completionState = clientClosed ? 'cancelled' : 'incomplete';
    commonRecord.generationRecordId = prepared?.journal?.id;
    const timedOut = error?.name === 'TimeoutError';
    finalStatus = clientClosed ? 499 : (timedOut || error?.name === 'AbortError' ? 504 : 502);
    await persistEvent(context.store, {
      type: clientClosed ? 'client_cancelled' : 'upstream_request_failed',
      endpoint: pathname,
      backendKind: backend.kind,
      error: error.message
    });
    if (!response.headersSent && !response.destroyed) {
      sendJson(response, finalStatus, { ...errorPayload(
        clientClosed ? 'CLIENT_CLOSED_REQUEST' : (finalStatus === 504 ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_REQUEST_FAILED'),
        clientClosed ? 'Client disconnected before completion.' : error.message
      ), ...(prepared?.journal ? { x_router: { status: 'incomplete', record_id: prepared.journal.id }, partial_response: prepared.journal.partial } : {}) });
    } else if (!clientClosed && !response.destroyed) {
      const info = { code: error.code || 'UPSTREAM_STREAM_FAILED', message: `Response incomplete: ${error.message}` };
      if (pathname === '/v1/chat/completions') {
        response.end(`data: ${JSON.stringify({ error: info, x_router: { status: 'incomplete', record_id: prepared?.journal?.id } })}\n\n`);
      } else {
        response.end(`${JSON.stringify({ error: info.message, done: true, done_reason: 'error', x_router: { status: 'incomplete', record_id: prepared?.journal?.id } })}\n`);
      }
    }
  } finally {
    stopQueueHeartbeat();
    request.off('aborted', abortForClient);
    response.off('close', abortForClient);
    lease?.release();
    if (prepared?.journal && !prepared.journal.closed) {
      try {
        await prepared.journal.append({ type: 'terminal', status: 'incomplete', reason: clientController.signal.aborted ? 'cancelled' : 'delivery_interrupted' });
      } catch (error) { console.error('generation archive finalization failed', error); }
      finally { await prepared.journal.close(); }
    }
    if (!requestPersisted) {
      await persistRequest(context.store, context.metrics, {
        ...commonRecord,
        allowed: true,
        rejected: false,
        responseStatus: finalStatus,
        status: finalStatus,
        upstreamError: finalStatus >= 500,
        latencyMs: Date.now() - started,
        responseBytes,
        usage,
        streamParseErrors: parseErrors,
        backendKind: backend.kind,
        contextPolicy: prepared?.context || null
      });
    }
  }
}

async function handleResponses(request, response, url, context) {
  const recordBase = {
    ...createBaseRecord(request, url.pathname),
    query: url.search || '',
    startedEpochMs: Date.now()
  };
  const outcome = await handleResponsesRequest(request, response, url.pathname, context);
  const record = {
    ...recordBase,
    ...outcome,
    latencyMs: Date.now() - recordBase.startedEpochMs
  };
  await persistRequest(context.store, context.metrics, record);

  if (outcome.rejected) {
    await persistEvent(context.store, {
      type: 'responses_request_rejected',
      code: outcome.errorCode,
      message: outcome.errorSummary,
      endpoint: url.pathname,
      requestedModel: outcome.requestedModel,
      activeModel: outcome.activeModel,
      toolsPresent: outcome.toolsPresent,
      toolCount: outcome.toolCount,
      toolChoicePresent: outcome.toolChoicePresent,
      toolHistoryPresent: outcome.toolHistoryPresent,
      toolsSupported: outcome.toolsSupported,
      toolsDropped: outcome.toolsDropped,
      unsupportedToolsPolicy: outcome.unsupportedToolsPolicy,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  } else if (outcome.incomplete) {
    await persistEvent(context.store, {
      type: 'responses_incomplete',
      reason: outcome.incompleteReason,
      ...(outcome.incompleteDiagnostics ? { diagnostics: outcome.incompleteDiagnostics } : {}),
      endpoint: url.pathname,
      model: outcome.forwardedModel,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  } else if (outcome.upstreamError) {
    await persistEvent(context.store, {
      type: 'responses_upstream_failed',
      code: outcome.errorCode,
      message: outcome.errorSummary,
      ...(outcome.errorDiagnostics ? { diagnostics: outcome.errorDiagnostics } : {}),
      endpoint: url.pathname,
      model: outcome.forwardedModel,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  }

  if (outcome.modelRewritten) {
    await persistEvent(context.store, {
      type: 'model_rewritten_to_active',
      endpoint: url.pathname,
      method: request.method,
      requestedModel: outcome.requestedModel,
      forwardedModel: outcome.forwardedModel,
      activeModel: outcome.activeModel,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  }

  if (outcome.thinkDropped) {
    await persistEvent(context.store, {
      type: 'unsupported_thinking_dropped',
      endpoint: url.pathname,
      method: request.method,
      model: outcome.forwardedModel,
      incomingThink: outcome.incomingThink,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  }

  if (outcome.thinkMapped && !outcome.thinkDropped) {
    await persistEvent(context.store, {
      type: 'think_level_mapped',
      endpoint: url.pathname,
      method: request.method,
      model: outcome.forwardedModel,
      incomingReasoningEffort: outcome.incomingReasoningEffort,
      incomingThink: outcome.incomingThink,
      forwardedThink: outcome.forwardedThink,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  }

  if (outcome.outputLimitCapped) {
    await persistEvent(context.store, {
      type: 'output_limit_capped',
      endpoint: url.pathname,
      method: request.method,
      model: outcome.forwardedModel,
      reasoningEffort: outcome.reasoningEffort,
      requestedOutputTokens: outcome.requestedOutputTokens,
      effectiveOutputTokens: outcome.effectiveOutputTokens,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  }

  if (outcome.toolsDropped) {
    await persistEvent(context.store, {
      type: 'unsupported_tools_dropped',
      endpoint: url.pathname,
      method: request.method,
      model: outcome.forwardedModel,
      toolsPresent: outcome.toolsPresent,
      toolCount: outcome.toolCount,
      toolChoicePresent: outcome.toolChoicePresent,
      toolHistoryPresent: outcome.toolHistoryPresent,
      toolsSupported: outcome.toolsSupported,
      toolsDropped: outcome.toolsDropped,
      unsupportedToolsPolicy: outcome.unsupportedToolsPolicy,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  }
}

function sendRedirect(response, location) {
  response.writeHead(302, {
    location,
    'cache-control': 'no-store'
  });
  response.end();
}

function hostnameFromRequest(request, fallbackHost = '127.0.0.1') {
  const hostHeader = typeof request.headers.host === 'string' ? request.headers.host : '';
  if (!hostHeader) return fallbackHost;
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    if (end !== -1) return hostHeader.slice(0, end + 1);
  }
  return hostHeader.split(':')[0] || fallbackHost;
}

function adminRedirectLocation(request, url, config) {
  const host = hostnameFromRequest(request, config.adminBindHost || config.host || '127.0.0.1');
  return `http://${host}:${config.adminPort}${url.pathname}${url.search || ''}`;
}

async function serveAdminDashboardAsset(response, pathname) {
  const relativePath = pathname === '/' || pathname === '/admin' || pathname === '/admin/'
    ? 'index.html'
    : pathname.slice('/admin/'.length);
  await serveStaticFile(response, PUBLIC_ROOT, relativePath || 'index.html');
}

async function handleAdminRequest(request, response, context) {
  const url = new URL(request.url || '/', 'http://router-admin.local');
  const pathname = url.pathname;

  try {
    if (request.method === 'GET' && pathname === '/health') {
      await handleHealth(response, context);
      return;
    }

    if (pathname.startsWith('/admin/api/')) {
      await handleAdminApi(request, response, pathname, context, { requireAuth: false });
      return;
    }

    if (request.method === 'GET' && (pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/'))) {
      await serveAdminDashboardAsset(response, pathname);
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(response, 404, errorPayload('API_NOT_ON_ADMIN_PORT', 'The Ollama-compatible API is served on the router API port, not the admin portal port.'));
      return;
    }

    sendJson(response, 404, errorPayload('NOT_FOUND', 'Admin portal route not found.'));
  } catch (error) {
    console.error('unhandled admin request error', error);
    if (!response.headersSent) {
      sendJson(response, error.statusCode || 500, errorPayload(error.code || 'INTERNAL_ERROR', error.message));
    } else {
      response.destroy(error);
    }
  }
}

async function handleRequest(request, response, context) {
  const url = new URL(request.url || '/', 'http://router.local');
  const pathname = url.pathname;

  try {
    if (request.method === 'GET' && pathname === '/') {
      sendText(response, 200, 'Ollama is running\n', { 'x-ollama-router': 'llm-router' });
      return;
    }

    if (request.method === 'GET' && pathname === '/health') {
      await handleHealth(response, context);
      return;
    }

    if (pathname.startsWith('/admin/api/')) {
      await handleAdminApi(request, response, pathname, context, { requireAuth: true });
      return;
    }

    if (request.method === 'GET' && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
      if (context.config.adminEnabled) {
        sendRedirect(response, adminRedirectLocation(request, url, context.config));
      } else {
        sendJson(response, 404, errorPayload('ADMIN_PORT_DISABLED', 'The separate admin portal listener is disabled.'));
      }
      return;
    }

    if (isResponsesPath(pathname)) {
      await handleResponses(request, response, url, context);
      return;
    }

    if (pathname === '/v1/models' || pathname.startsWith('/v1/models/')) {
      await handleModelDiscovery(request, response, pathname, context);
      return;
    }

    if (pathname === '/v1/chat/completions') {
      await handleProxy(request, response, url, context);
      return;
    }

    if (pathname.startsWith('/api/')) {
      await handleProxy(request, response, url, context);
      return;
    }

    sendJson(response, 404, errorPayload('NOT_FOUND', 'Route not found.'));
  } catch (error) {
    console.error('unhandled request error', error);
    if (!response.headersSent) {
      sendJson(response, error.statusCode || 500, errorPayload(error.code || 'INTERNAL_ERROR', error.message));
    } else {
      response.destroy(error);
    }
  }
}

export async function createRouterServer(config = loadConfig()) {
  const store = new JsonlStore(config);
  await store.init();
  const metrics = new Metrics();
  metrics.rebuild(store.requests);
  const requestGate = new RequestGate(config.routerControlFile);
  await requestGate.init();
  const context = {
    config,
    store,
    metrics,
    requestGate,
    modelDiscovery: new ModelCatalogDiscovery(config),
    state: {
      startedAt: nowIso(),
      maintenanceMode: false,
      lastDiscoveryFailureSignature: null
    }
  };

  await persistEvent(store, {
    type: 'router_startup',
    version: config.version,
    upstreamUrl: config.upstreamUrl,
    routerModelAlias: config.routerModelAlias,
    routerModelMetadataTtlMs: config.routerModelMetadataTtlMs,
    modelPolicyMode: config.modelPolicyMode,
    rewriteRequestedModelToActive: config.rewriteRequestedModelToActive,
    unsupportedToolsPolicy: config.unsupportedToolsPolicy,
    protectedModelEndpoints: config.protectedModelEndpoints
  });

  const activeRequests = new Set();
  const trackRequest = (requestPromise) => {
    activeRequests.add(requestPromise);
    const finished = () => activeRequests.delete(requestPromise);
    void requestPromise.then(finished, finished);
  };
  const waitForIdle = async () => {
    while (activeRequests.size) await Promise.allSettled([...activeRequests]);
  };
  const server = http.createServer((request, response) => {
    trackRequest(handleRequest(request, response, context));
  });
  const adminServer = config.adminEnabled
    ? http.createServer((request, response) => {
      trackRequest(handleAdminRequest(request, response, context));
    })
    : null;
  return { server, adminServer, context, waitForIdle };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { server, adminServer } = await createRouterServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`${config.appName} ${config.version} API listening on http://${config.host}:${config.port}`);
    console.log(`Upstream Ollama: ${config.upstreamUrl}`);
    console.log(`Active model marker: ${config.activeModelFile}`);
  });

  if (adminServer) {
    adminServer.listen(config.adminPort, config.adminBindHost, () => {
      console.log(`${config.appName} ${config.version} admin portal listening on http://${config.adminBindHost}:${config.adminPort}`);
      console.log('Admin portal authentication: disabled by design for trusted local/LAN use');
    });
  } else {
    console.log('Admin portal listener disabled by ADMIN_ENABLED=false');
  }

  const shutdown = (signal) => {
    console.log(`Received ${signal}; shutting down.`);
    let remaining = adminServer ? 2 : 1;
    const done = () => {
      remaining -= 1;
      if (remaining <= 0) process.exit(0);
    };
    server.close(done);
    if (adminServer) adminServer.close(done);
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
