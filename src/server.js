import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { loadConfig, publicConfig } from './config.js';
import { readActiveModel } from './active-model.js';
import { inspectPublishedCatalog, readDeploymentActiveModel, readModelCatalog, selectModel } from './model-catalog.js';
import { LOCAL_HOST_ID, readHostSource, removeHostCatalog, writeHostCatalog } from './catalog-source.js';
import { JsonlStore } from './fs-store.js';
import { generationRetention } from './generation-retention.js';
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
  resolveBackendAdapter,
  SUPPORTED_BACKEND_KINDS,
  isLlamaWireKind
} from './backend-adapters.js';
import { RequestGate, RequestGateError } from './request-gate.js';
import { PortalBus } from './portal-bus.js';
import { normalizeRecord, queryEvents } from './portal-records.js';
import { handlePortalRoute } from './portal-routes.js';
import { CapabilityPublisher } from './capabilities.js';
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

async function persistRequest(context, record) {
  context.metrics.recordRequest(record);
  try {
    await context.store.appendRequest(record);
  } catch (error) {
    console.error('failed to persist request record', error);
    return;
  }
  // Live view of the table below: the dashboard subscribes and prepends, so a
  // request appears the moment it is durable rather than on the next poll.
  context.portalBus?.publish('request', normalizeRecord(record, portalView(context)));
}

// What a stored record means to a reader: which machine served it (the host of
// the model it was served by, falling back to the default), and which payload
// archives still exist. Derived per read, never persisted, so a record written
// before a field existed still renders completely.
function portalView(context) {
  return {
    defaultHost: context.config.defaultHost,
    hostOf: (model) => (model ? context.modelHosts?.get(model) ?? null : null),
    upstreamOf: (host) => (host === context.config.defaultHost ? context.config.upstreamUrl : null),
    journals: context.journals
  };
}

async function persistEvent(target, event, bus) {
  const store = target?.store ?? target;
  const publisher = bus ?? target?.portalBus ?? null;
  try {
    const persisted = await store.appendEvent(event);
    publisher?.publish('event', persisted);
    return persisted;
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

// The catalog facts an owner needs to repair the router when it cannot serve the
// catalog it was given. Served from every runtime-state response, 200 or 503.
function activeModelMetadata(activeModel) {
  return {
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
  };
}

async function handleHealth(response, context) {
  // Reported for the machine this deployment answers as its default host, which
  // is the model an unnamed request selects. The container's own health stays
  // bound to that machine alone: a second machine in maintenance is reported
  // below and never takes this check, or the container, down.
  const activeModel = await readDeploymentActiveModel(context.config);
  const runtime = context.requestGate.snapshot(activeModel);
  const router = {
    appName: context.config.appName,
    version: context.config.version,
    maintenanceMode: context.state.maintenanceMode,
    runtime,
    startedAt: context.state.startedAt,
    supported_backend_kinds: SUPPORTED_BACKEND_KINDS
  };
  let upstream;
  try {
    upstream = await resolveBackendAdapter(context.config, activeModel).health();
  } catch (error) {
    // A catalog of a kind the router cannot serve would otherwise take this endpoint
    // down with a bare 503. The router keeps answering health while its active model
    // is unusable, naming the kind list and the catalog it holds, so its owner can see
    // the wedge and repair the catalog the same way it repairs any other failure.
    const code = error instanceof BackendAdapterError ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof BackendAdapterError ? error.message : (error?.message || String(error));
    sendJson(response, 503, {
      ok: false,
      backend_ready: false,
      router,
      upstream: { ok: false, status: null, latencyMs: 0, backendKind: activeModel.backend_kind || null, version: null, error: message },
      activeModel: publicActiveModel(activeModel),
      ...errorPayload(code, message)
    });
    return;
  }
  // During a controlled transition the router is intentionally available while
  // its previous backend is offline. Keep the service health check green so the
  // transaction can commit the replacement backend; generation routes still
  // return the explicit BACKEND_DRAINING 503 enforced by the request gate.
  const serviceAvailable = upstream.ok || runtime.draining;
  sendJson(response, serviceAvailable ? 200 : 503, {
    ok: serviceAvailable,
    backend_ready: upstream.ok,
    router,
    upstream,
    activeModel: publicActiveModel(activeModel),
    ...await hostStatus(context, runtime)
  });
}

// Where a model physically lives is the publisher's business. The marker carries
// the upstream URL, the file paths, and the GPU identity of one machine; the
// client-facing health endpoint names the model, its contract, and the machine
// it belongs to, and leaves the rest in the admin view where it is actionable.
const MODEL_LOCATION_FIELDS = ['backend_url', 'model_path', 'mmproj_path', 'gpu_uuids', 'raw', 'file', 'file_mtime', 'file_mtime_ms', 'loadedFrom', 'metadata_warnings'];

function publicActiveModel(activeModel) {
  if (!activeModel?.model) return { model: null, loadedFrom: activeModel?.loadedFrom ?? null };
  return Object.fromEntries(Object.entries(activeModel)
    .filter(([key, value]) => !MODEL_LOCATION_FIELDS.includes(key) && value !== undefined)
    .map(([key, value]) => [key, value]));
}

// Every declared machine, with whether it can serve. The per-machine answers
// come from the capability publisher, which is already probing each backend on
// its own schedule: a health check must not start probing the deployment itself
// and answer late because one machine far away is slow to reply.
async function hostStatus(context, runtime) {
  if (context.config.routerHosts.length === 1 && context.config.defaultHost === LOCAL_HOST_ID) return {};
  let catalog = null;
  try {
    catalog = await readModelCatalog(context.config);
  } catch {
    catalog = null;
  }
  const published = context.capabilities?.current?.capability?.hosts ?? null;
  const hosts = (catalog?.hosts ?? context.config.routerHosts.map((id) => ({ id, default: id === context.config.defaultHost, model_ids: [], published: false })))
    .map((host) => {
      const probed = published?.find((entry) => entry.id === host.id);
      const drain = runtime.hosts?.[host.id];
      return {
        id: host.id,
        default: host.default === true,
        published: host.published === true,
        model_count: host.model_ids?.length ?? 0,
        available: probed ? probed.available : null,
        draining: runtime.draining || Boolean(drain?.draining),
        drain_reason: drain?.drain_reason ?? (runtime.draining ? runtime.drain_reason : null),
        error: host.error ? { code: host.error.code, message: host.error.message } : (probed?.error ?? null)
      };
    });
  // The service answers, so the router is healthy; `degraded` says some other
  // machine the deployment advertises is not contributing.
  return { hosts, degraded: hosts.some((host) => host.published === false || host.available === false || host.draining) };
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
  await persistEvent(context, {
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
    if (!['MODEL_NOT_FOUND', 'METHOD_NOT_ALLOWED', 'SERVICE_OFFLINE'].includes(discoveryError.code)) {
      await recordDiscoveryFailure(context, discoveryError.code);
    }
    sendJson(response, discoveryError.statusCode, modelDiscoveryErrorPayload(discoveryError), {
      'cache-control': 'no-cache',
      'x-ollama-router': 'llm-router'
    });
  }
}

function routerApiError(response, status, code, message) {
  sendJson(response, status, { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', param: null, code } }, {
    'cache-control': 'no-cache',
    'x-ollama-router': 'llm-router'
  });
}

async function handleCapabilities(request, response, url, context) {
  if (request.method !== 'GET') {
    routerApiError(response, 405, 'METHOD_NOT_ALLOWED', 'The capabilities endpoint only accepts GET requests.');
    return;
  }
  const include = (url.searchParams.get('include') || '').split(',').map((value) => value.trim());
  const { body, etag } = await context.capabilities.document({ includeLoad: include.includes('load') });
  const headers = { 'cache-control': 'no-cache', etag, 'x-ollama-router': 'llm-router' };
  if (ifNoneMatchMatches(request.headers['if-none-match'], etag)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  sendJson(response, 200, body, headers);
}

function handleCapabilityEvents(request, response, context) {
  if (request.method !== 'GET') {
    routerApiError(response, 405, 'METHOD_NOT_ALLOWED', 'The events endpoint only accepts GET requests.');
    return;
  }
  // The stream outlives this handler; the publisher owns its lifecycle so
  // graceful shutdown never waits on a subscriber.
  if (!context.capabilities.subscribe(request, response)) {
    routerApiError(response, 503, 'TOO_MANY_SUBSCRIBERS', 'The router event stream has reached its subscriber limit. Poll /v1/router/capabilities instead.');
  }
}

function notifyCapabilities(context) {
  void context.capabilities.refresh().catch(() => {});
}

// The portal lists what a client can select, so each row names the machine
// running it as soon as the deployment spans more than one.
async function summaryModels(context) {
  const entries = (await context.modelDiscovery.document(null, { includeAliases: false })).entries;
  if (context.config.routerHosts.length === 1 && context.config.defaultHost === LOCAL_HOST_ID) return entries;
  const catalog = await readModelCatalog(context.config);
  const hostOf = new Map((catalog.models ?? []).filter((model) => model.host).map((model) => [model.model, model.host]));
  return entries.map((entry) => (hostOf.has(entry.id)
    ? { ...entry, x_ollama_router: { ...entry.x_ollama_router, host: hostOf.get(entry.id) } }
    : entry));
}

async function buildSummary(context) {
  const activeModel = await readDeploymentActiveModel(context.config);
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
    ...((context.config.routerHosts.length === 1 && context.config.defaultHost === LOCAL_HOST_ID) ? {} : { hosts: (await deploymentHosts(context)).hosts }),
    models: await summaryModels(context),
    upstream,
    ollamaPs: ps,
    activeLoadedState,
    gpu,
    metrics: context.metrics.snapshot(),
    recentRejectsOrErrors,
    recentErrorEvents,
    logs: { ...context.store.paths(), generationRetention: context.generationRetention.snapshot() }
  };
}

// One machine's published catalog, accepted at the door and held until it is
// replaced. The publisher authenticates with CATALOG_PUSH_TOKEN (or the admin
// token, for a router that has one credential); the check lives here rather
// than on the listener because the portal port is unauthenticated by design and
// a catalog is not a page.
const CATALOG_PUBLISH_ROUTE = /^\/admin\/api\/hosts\/([a-z0-9][a-z0-9._-]{0,63})\/catalog$/;
const MAX_PUBLISHED_CATALOG_BYTES = 262144;

function catalogPublisherAuth(request, response, config) {
  // Either credential publishes: the publisher token is what a runtime holds,
  // and the admin token already governs everything else an operator can do.
  const accepted = [config.catalogPushToken, config.adminToken].filter(Boolean);
  if (!accepted.length) {
    sendJson(response, 503, errorPayload('CATALOG_PUSH_UNAVAILABLE',
      'Catalog publication is disabled: set CATALOG_PUSH_TOKEN (or ADMIN_TOKEN) to the token the runtime will present.'));
    return null;
  }
  const authorization = String(request.headers.authorization || '');
  const presented = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : String(request.headers[config.adminSessionHeader.toLowerCase()] || '');
  if (!presented || !accepted.includes(presented)) {
    sendJson(response, 401, errorPayload('CATALOG_PUBLISH_AUTH_REQUIRED',
      'Catalog publication requires CATALOG_PUSH_TOKEN, presented as Authorization: Bearer <token>.'));
    return null;
  }
  return presented;
}

async function handleCatalogPublish(request, response, host, context) {
  const { config } = context;
  if (!config.routerHosts.includes(host)) {
    sendJson(response, 404, errorPayload('HOST_NOT_DECLARED', `Host ${JSON.stringify(host)} is not declared in ROUTER_HOSTS (${config.routerHosts.join(', ')}).`, { hosts: config.routerHosts }));
    return;
  }
  if (host === LOCAL_HOST_ID) {
    sendJson(response, 400, errorPayload('LOCAL_HOST_IS_FILE_BACKED', `Host ${JSON.stringify(LOCAL_HOST_ID)} is published by ${config.activeModelFile}; it cannot also be written over HTTP.`));
    return;
  }
  let payload;
  try {
    payload = parseJsonBuffer(await readRequestBody(request, MAX_PUBLISHED_CATALOG_BYTES));
  } catch (error) {
    sendJson(response, error.statusCode || 400, errorPayload('INVALID_CATALOG_BODY', error.message));
    return;
  }
  let parsed;
  try {
    parsed = await inspectPublishedCatalog(config, host, payload);
  } catch (error) {
    const status = error instanceof BackendAdapterError ? error.statusCode : 500;
    const code = error instanceof BackendAdapterError ? error.code : 'INTERNAL_ERROR';
    sendJson(response, status, errorPayload(code, error.message, error.diagnostics ?? undefined));
    return;
  }
  const stored = await writeHostCatalog(config, host, JSON.stringify(payload, null, 2));
  context.modelDiscovery.invalidate();
  notifyCapabilities(context);
  await refreshModelHosts(context);
  await persistEvent(context, {
    type: 'model_catalog_published',
    host,
    revision: stored.revision.slice(0, 12),
    models: parsed.models.map((model) => model.model),
    offlineServices: parsed.offlineServices.map((service) => service.model),
    warnings: parsed.warnings
  });
  sendJson(response, 200, {
    ok: true,
    host,
    revision: stored.revision,
    accepted_at: stored.acceptedAt,
    file: stored.file,
    default_model: parsed.defaultModel,
    models: parsed.models.map((model) => ({ model: model.model, aliases: model.aliases, backend_url: model.backend_url })),
    offline_services: parsed.offlineServices.map((service) => service.model),
    configuration: parsed.configuration && !parsed.configuration.invalid ? parsed.configuration : null,
    warnings: parsed.warnings
  });
}

async function handleCatalogRetire(request, response, host, context) {
  const { config } = context;
  if (!config.routerHosts.includes(host)) {
    sendJson(response, 404, errorPayload('HOST_NOT_DECLARED', `Host ${JSON.stringify(host)} is not declared in ROUTER_HOSTS (${config.routerHosts.join(', ')}).`));
    return;
  }
  if (host === LOCAL_HOST_ID) {
    sendJson(response, 400, errorPayload('LOCAL_HOST_IS_FILE_BACKED', `Host ${JSON.stringify(LOCAL_HOST_ID)} is published by ${config.activeModelFile}; retire its runtime instead.`));
    return;
  }
  const result = await removeHostCatalog(config, host);
  context.modelDiscovery.invalidate();
  notifyCapabilities(context);
  await persistEvent(context, { type: 'model_catalog_retired', host, removed: result.removed });
  sendJson(response, 200, { ok: true, host, removed: result.removed, file: result.file });
}

async function deploymentHosts(context) {
  const gate = context.requestGate.snapshot();
  let catalog = null;
  let error = null;
  try {
    catalog = await readModelCatalog(context.config);
  } catch (readError) {
    error = { code: readError.code || 'INTERNAL_ERROR', message: readError.message };
  }
  const fallback = await Promise.all(context.config.routerHosts.map(async (host) => {
    const source = await readHostSource(context.config, host);
    return {
      id: host, display_name: host, default: host === context.config.defaultHost, resident: false,
      published: source.present, model_ids: [], configuration: null, revision: source.revision,
      accepted_at: source.acceptedAt, file: source.file, loaded_from: source.loadedFrom, warnings: [],
      error: source.readError ? { code: 'HOST_CATALOG_UNPUBLISHED', message: source.readError } : null
    };
  }));
  const hosts = (catalog?.hosts ?? fallback).map((host) => ({
    ...host,
    draining: gate.draining || Boolean(gate.hosts?.[host.id]?.draining),
    drain_reason: gate.hosts?.[host.id]?.drain_reason ?? (gate.draining ? gate.drain_reason : null),
    active: gate.active_by_host?.[host.id] ?? 0,
    queued: gate.queued_by_host?.[host.id] ?? 0
  }));
  return { hosts, error };
}

async function handleHostsList(response, context) {
  const { hosts, error } = await deploymentHosts(context);
  sendJson(response, 200, { ok: true, default_host: context.config.defaultHost, hosts, ...(error ? { error } : {}) });
}

// Which machine serves a model, as published. Rebuilt when a catalog is
// published or retired: the attribution in the request table has to follow the
// catalogs the router actually accepted, not a snapshot from boot.
async function refreshModelHosts(context) {
  const map = new Map();
  try {
    const catalog = await readModelCatalog(context.config);
    for (const entry of catalog.models ?? []) {
      if (!entry?.model || !entry.host) continue;
      map.set(entry.model, entry.host);
      for (const alias of entry.aliases ?? []) map.set(alias, entry.host);
    }
  } catch (error) {
    // A catalog the router cannot resolve is already reported by the catalog
    // endpoints; here it only means a row shows the default host.
    context.modelHostsError = error.message;
  }
  context.modelHosts = map;
  return map;
}

function portalDeps(context) {
  return {
    deploymentHosts: (ctx) => deploymentHosts(ctx),
    summaryModels: (ctx) => summaryModels(ctx),
    handleCapabilities: (request, response, url, ctx) => handleCapabilities(request, response, url, ctx),
    readDeploymentActiveModel
  };
}

async function handleAdminApi(request, response, pathname, context, { requireAuth = true } = {}) {
  // Catalog publication carries its own publisher credential and is admitted on
  // either listener: the portal port is unauthenticated by design, and an operator
  // may give a relocated router only the publisher token.
  const publishRoute = pathname.match(CATALOG_PUBLISH_ROUTE);
  if (publishRoute && ['PUT', 'POST'].includes(request.method)) {
    if (!catalogPublisherAuth(request, response, context.config)) return;
    await handleCatalogPublish(request, response, publishRoute[1], context);
    return;
  }
  if (publishRoute && request.method === 'DELETE') {
    if (!catalogPublisherAuth(request, response, context.config)) return;
    await handleCatalogRetire(request, response, publishRoute[1], context);
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/hosts') {
    await handleHostsList(response, context);
    return;
  }

  if (requireAuth && !requireAdmin(request, response, context.config)) return;

  // These three read or move the running inference state, so on the API port
  // they demand the admin token as always. On the admin portal port they do
  // not: the portal is unauthenticated by design, and a dashboard that cannot
  // reach them can neither show a payload nor drain a machine. That is the
  // trade this deployment makes - reach 11435 and you can read archived prompt
  // text - so the port stays bound to the LAN.
  if (requireAuth && ['/admin/api/runtime-state', '/admin/api/runtime-drain', '/admin/api/generation-record'].includes(pathname)) {
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
    let handle;
    try { handle = await open(file, 'r'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      sendJson(response, 404, errorPayload('RECORD_NOT_FOUND', 'Generation record not found.')); return;
    }
    try {
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      await pipeline(handle.createReadStream({ autoClose: false }), response);
    } finally { await handle.close(); }
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/runtime-state') {
    const activeModel = await readDeploymentActiveModel(context.config);
    const runtime = context.requestGate.snapshot(activeModel);
    try {
      const backend = resolveBackendAdapter(context.config, activeModel);
      const health = await backend.health();
      const ps = await backend.ps();
      sendJson(response, 200, {
        ok: true,
        runtime,
        router: { supported_backend_kinds: SUPPORTED_BACKEND_KINDS },
        backend: { kind: backend.kind, health, status: ps },
        models: (await context.modelDiscovery.document(null, { includeAliases: false })).entries,
        active_model: activeModelMetadata(activeModel)
      });
    } catch (error) {
      // A catalog of a kind the router cannot serve wedges adapter resolution. This
      // endpoint keeps answering: the runtime reads the error code, the kinds the router
      // can serve, the drain state, and the catalog on file from here, and repairs the
      // catalog file itself (it is the only writer) before retrying - no restart needed.
      const code = error instanceof BackendAdapterError ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof BackendAdapterError ? error.message : (error?.message || String(error));
      sendJson(response, error.statusCode || 503, {
        ok: false,
        runtime,
        router: { supported_backend_kinds: SUPPORTED_BACKEND_KINDS },
        active_model: activeModelMetadata(activeModel),
        ...errorPayload(code, message)
      });
    }
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
    // A drain may name one machine: the runtime taking a host in for maintenance
    // stops traffic to that host's models and leaves every other machine
    // serving. Without `host` it remains the whole-router switch it has always
    // been, which is what a router release pulls.
    const host = body.host === undefined || body.host === null ? null : String(body.host).trim();
    if (host !== null && !context.config.routerHosts.includes(host)) {
      sendJson(response, 400, errorPayload('HOST_NOT_DECLARED', `Host ${JSON.stringify(host)} is not declared in ROUTER_HOSTS (${context.config.routerHosts.join(', ')}).`));
      return;
    }
    const activeModel = await readDeploymentActiveModel(context.config);
    const runtime = await context.requestGate.setDraining(body.enabled, body.reason, host);
    notifyCapabilities(context);
    await persistEvent(context, {
      type: 'runtime_drain_changed',
      enabled: body.enabled,
      host,
      reason: runtime.drain_reason,
      profile: activeModel.profile,
      backendKind: activeModel.backend_kind,
      activeCount: runtime.active_count
    });
    sendJson(response, 200, {
      ok: true,
      host,
      runtime: context.requestGate.snapshot(activeModel),
      drain: host === null
        ? { draining: runtime.draining, reason: runtime.drain_reason }
        : context.requestGate.drainState(host)
    });
    return;
  }

  if (request.method === 'GET' && pathname === '/admin/api/summary') {
    sendJson(response, 200, await buildSummary(context));
    return;
  }

  // The redesigned portal reads these; see docs/PORTAL_API.md. They live behind
  // the same auth as the rest of this function, which on the admin listener is
  // none by design and on the API listener is the admin token.
  if (await handlePortalRoute(request, response, pathname, context, portalDeps(context))) return;

  if (request.method === 'GET' && pathname === '/admin/api/events') {
    const params = Object.fromEntries(new URL(request.url, 'http://router.local').searchParams);
    const result = queryEvents(context.store.recentEvents(context.config.eventHistoryLimit), params);
    sendJson(response, 200, Object.keys(params).some((key) => key !== 'limit') ? result : { events: result.events });
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
    notifyCapabilities(context);
    await persistEvent(context, { type: 'active_model_marker_reloaded', activeModel });
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
    notifyCapabilities(context);
    await persistEvent(context, { type: 'maintenance_mode_changed', enabled: context.state.maintenanceMode });
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
    if (isLlamaWireKind(backend.kind)) {
      if (context.state.maintenanceMode) throw new RequestGateError(503, 'MAINTENANCE_MODE', 'Router maintenance mode is enabled.');
      const adminAbort = connectionAbort(request, response);
      let adminLease;
      try {
      adminLease = await context.requestGate.acquire({ endpoint: pathname, clientIdentity: 'admin', limit: backend.maxActiveRequests, backendKey: backend.admissionKey, model: activeModel.model, host: activeModel.host ?? null, signal: adminAbort.signal });
      const started = Date.now();
      if (Buffer.byteLength(activeModel.model, 'utf8') > LLAMA_PREWARM_MAX_MODEL_BYTES) {
        await persistEvent(context, {
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
        await persistEvent(context, {
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
        await persistEvent(context, {
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
        await persistEvent(context, {
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
      await persistEvent(context, {
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
      await persistEvent(context, { type: 'prewarm_failed', model: activeModel.model, error: error.message });
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
      if (isLlamaWireKind(backend.kind)) {
        lease = await context.requestGate.acquire({ endpoint: '/admin/api/test-chat', clientIdentity: 'admin', limit: backend.maxActiveRequests, backendKey: backend.admissionKey, model: activeModel.model, host: activeModel.host ?? null, signal: adminAbort.signal });
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
      await persistEvent(context, {
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
      await persistEvent(context, { type: 'admin_test_chat_failed', model: activeModel.model, error: error.message });
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
  // What the caller was actually told. The code and summary are the index, but
  // the reason an operator reads at 3 a.m. is the body: the offending field,
  // the limit that was hit. Clipped because a schema rejection can echo a
  // whole tool definition.
  const errorBody = openAiError
    ? { error: { message, type: openAiError.type, param: openAiError.param ?? null, code } }
    : errorPayload(code, message, extra.details);
  const finalRecord = {
    errorBodyExcerpt: JSON.stringify(errorBody).slice(0, 4096),
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
  await persistRequest(context, finalRecord);
  await persistEvent(context, {
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
      digest: meta.revision, size: meta.live?.size_bytes ?? 0, context_length: meta.context_window,
      ...(pathname === '/api/ps' ? { expires_at: '9999-12-31T23:59:59Z', slots: meta.active_request_limit } : {}),
      details: { format: 'gguf', family: meta.family ?? null, parameter_size: meta.parameter_size ?? null, quantization_level: meta.quantization },
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
      // The size the client actually sent, before any translation. With
      // PROMPT_LOGGING=metadata this is the only measure of request volume.
      recordBase.requestBytes = rawBody?.length ?? null;
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
    await persistEvent(context, {
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
    await persistEvent(context, {
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
    await persistEvent(context, {
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
    await persistEvent(context, {
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
    await persistEvent(context, {
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
  let queuedAt = null;
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
          host: activeModel.host ?? null,
          signal: clientController.signal,
          onQueued: () => {
            // Two waits that are usually conflated and never equal: how long the
            // request sat behind another generation, and how long from arrival to
            // admission, which also covers reading and validating the body.
            queuedAt = Date.now();
            stopQueueHeartbeat = queueHeartbeat(response, commonRecord.streaming
              ? (pathname === '/v1/chat/completions' ? 'chat' : 'native') : null, { model: activeModel.model });
          }
        });
        stopQueueHeartbeat();
        if (queuedAt !== null) commonRecord.queueWaitMs = Date.now() - queuedAt;
        commonRecord.admissionWaitMs = Date.now() - recordBase.startedEpochMs;
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
      // Recorded as soon as the archive opens: a generation that is killed
      // mid-stream, or whose client disappears, is exactly the one a reader
      // comes looking for, and it never reaches the terminal write.
      // Recorded either way: `null` means this build knows there is no archive,
      // which is not the same statement as an older record that never said.
      commonRecord.generationRecordId = prepared?.journal?.id ?? null;
      if (isLlamaWireKind(backend.kind) && prepared.reasoning) {
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
        if (Array.isArray(prepared.samplingControls)) {
          // Field names and booleans only; sampling values and content are not recorded.
          Object.assign(commonRecord, {
            samplingControls: prepared.samplingControls,
            seedForwarded: prepared.seedForwarded,
            samplingAcceptedAsDefault: prepared.samplingAcceptedAsDefault
          });
        }
        if (prepared.reasoning.outputLimitCapped) {
          await persistEvent(context, {
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
      await persistRequest(context, {
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

    if (isLlamaWireKind(backend.kind) && !upstreamResponse.ok) {
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
    if (prepared.streaming && isLlamaWireKind(backend.kind)) {
      if (prepared.responseKind === 'openai-chat') {
        streamingBody = normalizeOpenAiSseModel(upstreamResponse.body, activeModel.model, (payload) => {
          if (payload.usage) usage = payload.usage;
          if (payload.choices?.[0]?.finish_reason) commonRecord.finishReason = payload.choices[0].finish_reason;
          if (payload.x_router) Object.assign(commonRecord, { completionState: payload.x_router.status, generationRecordId: payload.x_router.record_id ?? commonRecord.generationRecordId ?? null, stopReason: payload.x_router.stop_reason });
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
        if (commonRecord.ttftMs === undefined && isGenerationPath(pathname) && buffer.length) {
          commonRecord.ttftMs = Date.now() - recordBase.startedEpochMs;
        }
        responseBytes += buffer.length;
        collector?.observe(buffer);
        if (!response.write(buffer)) await once(response, 'drain', { signal: clientController.signal });
      }
      if (collector) {
        const collected = collector.finish();
        usage = collected.usage;
        parseErrors = collected.parseErrors;
        commonRecord.finishReason = collected.lastObject?.done_reason;
        if (collected.lastObject?.x_router) Object.assign(commonRecord, { completionState: collected.lastObject.x_router.status, generationRecordId: collected.lastObject.x_router.record_id ?? commonRecord.generationRecordId ?? null, stopReason: collected.lastObject.x_router.stop_reason });
      }
      response.end();
    } else {
      let payloadBuffer;
      if (isLlamaWireKind(backend.kind)) {
        const payload = JSON.parse(await upstreamResponse.text());
        const normalized = prepared.responseKind === 'openai-chat'
          ? openAiNonstreamForPublic(payload, activeModel.model)
          : openAiCompletionToOllama(payload, { kind: prepared.responseKind, model: activeModel.model });
        commonRecord.finishReason = payload.choices?.[0]?.finish_reason;
        if (payload.x_router) Object.assign(commonRecord, { completionState: payload.x_router.status, generationRecordId: payload.x_router.record_id ?? commonRecord.generationRecordId ?? null, stopReason: payload.x_router.stop_reason });
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
    commonRecord.generationRecordId = prepared?.journal?.id ?? null;
    const timedOut = error?.name === 'TimeoutError';
    finalStatus = clientClosed ? 499 : (timedOut || error?.name === 'AbortError' ? 504 : 502);
    await persistEvent(context, {
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
      await persistRequest(context, {
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
  await persistRequest(context, record);

  if (outcome.rejected) {
    await persistEvent(context, {
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
    await persistEvent(context, {
      type: 'responses_incomplete',
      reason: outcome.incompleteReason,
      ...(outcome.incompleteDiagnostics ? { diagnostics: outcome.incompleteDiagnostics } : {}),
      endpoint: url.pathname,
      model: outcome.forwardedModel,
      clientIdentity: record.clientIdentity,
      sourceIp: record.sourceIp
    });
  } else if (outcome.upstreamError) {
    await persistEvent(context, {
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
    await persistEvent(context, {
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
    await persistEvent(context, {
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
    await persistEvent(context, {
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
    await persistEvent(context, {
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
    await persistEvent(context, {
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

const ASSET_ROUTE = /^\/[-\w.]+(?:\/[-\w.]+)*\.(?:css|js|map|svg|png|ico|woff2?)$/;

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

    // The page is written with root-relative assets, so it works identically at
    // `/` and at `/admin`: an absolute `href="/style.css"` from `/admin` would
    // otherwise ask the server for a path the page can only guess at. The admin
    // listener serves no Ollama API, so the only collision left is /health,
    // which is answered above.
    if (request.method === 'GET' && ASSET_ROUTE.test(pathname)) {
      await serveStaticFile(response, PUBLIC_ROOT, pathname.slice(1));
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

    if (pathname === '/v1/router/capabilities') {
      await handleCapabilities(request, response, url, context);
      return;
    }

    if (pathname === '/v1/router/events') {
      handleCapabilityEvents(request, response, context);
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
    modelHosts: new Map(),
    journals: new Set(),
    generationRetention: generationRetention(config),
    metrics,
    requestGate,
    modelDiscovery: new ModelCatalogDiscovery(config),
    state: {
      startedAt: nowIso(),
      maintenanceMode: false,
      lastDiscoveryFailureSignature: null
    }
  };
  context.capabilities = new CapabilityPublisher(context);
  context.portalView = {
    defaultHost: config.defaultHost,
    hostOf: (model) => (model ? context.modelHosts.get(model) ?? null : null),
    upstreamOf: (host) => (host === config.defaultHost ? config.upstreamUrl : null),
    journals: context.journals
  };
  context.portalBus = new PortalBus({
    heartbeatMs: config.eventsHeartbeatMs,
    heartbeat: () => ({
      at: nowIso(),
      active: context.requestGate.snapshot().active_count,
      queued: context.requestGate.snapshot().queued_count
    })
  });
  await refreshModelHosts(context);
  requestGate.onChange = () => context.capabilities.loadChanged();

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
    await context.generationRetention.pending;
  };
  const server = http.createServer((request, response) => {
    trackRequest(handleRequest(request, response, context));
  });
  const adminServer = config.adminEnabled
    ? http.createServer((request, response) => {
      trackRequest(handleAdminRequest(request, response, context));
    })
    : null;
  await context.generationRetention.start();
  let listeners = adminServer ? 2 : 1;
  const releaseRetention = () => {
    if (--listeners === 0) context.generationRetention.stop();
  };
  server.once('close', releaseRetention);
  server.once('close', () => {
    context.capabilities.close();
    context.portalBus?.close();
  });
  adminServer?.once('close', releaseRetention);
  return { server, adminServer, context, waitForIdle };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { server, adminServer, context, waitForIdle } = await createRouterServer(config);
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
      if (remaining <= 0) {
        void waitForIdle().then(() => process.exit(0), (error) => {
          console.error('failed to finish persistence during shutdown', error);
          process.exit(1);
        });
      }
    };
    // End event streams first: server.close() waits for open connections.
    context.capabilities.close();
    server.close(done);
    if (adminServer) adminServer.close(done);
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
