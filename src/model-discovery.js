import { createHash } from 'node:crypto';
import { readActiveModel } from './active-model.js';
import { findOfflineService, readModelCatalog, selectModel, serviceOfflineMessage } from './model-catalog.js';
import {
  parseDefaultThink,
  thinkLevelToReasoningEffort,
  validateReasoningCapabilities
} from './reasoning.js';
import { upstreamJson } from './upstream.js';
import { capabilityScore } from './capability-score.js';
import {
  enforcedContextSafetyReserve,
  formatParameterSize,
  resolveBackendAdapter,
  validatedReasoningPolicy
} from './backend-adapters.js';

const CANONICAL_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export class ModelDiscoveryError extends Error {
  constructor(statusCode, code, message, param = 'model', type = 'server_error') {
    super(message);
    this.name = 'ModelDiscoveryError';
    this.statusCode = statusCode;
    this.code = code;
    this.param = param;
    this.type = type;
  }
}

export function modelDiscoveryErrorPayload(error) {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code
    }
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

function markerRevisionKey(activeModel) {
  const raw = typeof activeModel.raw === 'string'
    ? activeModel.raw
    : JSON.stringify(activeModel.raw ?? null);
  const rawDigest = createHash('sha256').update(raw).digest('hex');
  return [
    activeModel.model,
    activeModel.revision ?? '',
    activeModel.file_mtime_ms ?? activeModel.file_mtime ?? '',
    activeModel.updated_at ?? '',
    rawDigest
  ].join('\u0000');
}

function createdTimestamp(activeModel, fallbackEpochMs) {
  const updatedEpochMs = typeof activeModel.updated_at === 'string' ? Date.parse(activeModel.updated_at) : Number.NaN;
  const epochMs = Number.isFinite(updatedEpochMs)
    ? updatedEpochMs
    : (Number.isFinite(activeModel.file_mtime_ms) ? activeModel.file_mtime_ms : fallbackEpochMs);
  return Math.floor(epochMs / 1000);
}

function matchingLoadedModel(psBody, activeModel) {
  const models = Array.isArray(psBody?.models) ? psBody.models : [];
  return models.find((model) => model?.name === activeModel || model?.model === activeModel) || null;
}

function loadedContextWindow(loadedModel) {
  if (!loadedModel) return null;
  for (const value of [
    loadedModel.context_length,
    loadedModel.context,
    loadedModel.num_ctx,
    loadedModel.numCtx
  ]) {
    const context = positiveInteger(value);
    if (context !== null) return context;
  }
  return null;
}

function modelContextWindow(showBody) {
  const modelInfo = isPlainObject(showBody?.model_info) ? showBody.model_info : null;
  if (!modelInfo) return null;

  const architectureNames = [
    modelInfo['general.architecture'],
    showBody?.details?.family,
    ...(Array.isArray(showBody?.details?.families) ? showBody.details.families : [])
  ].filter((value) => typeof value === 'string' && value.trim());

  for (const architecture of architectureNames) {
    const context = positiveInteger(modelInfo[`${architecture}.context_length`]);
    if (context !== null) return context;
  }

  const candidates = Object.entries(modelInfo)
    .filter(([key]) => key === 'context_length' || key.endsWith('.context_length'))
    .map(([, value]) => positiveInteger(value))
    .filter((value) => value !== null);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

function normalizeCapabilities(showBody) {
  if (!Array.isArray(showBody?.capabilities)) return null;
  return [...new Set(showBody.capabilities
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().toLowerCase()))];
}

function normalizeModalities(activeModel, capabilities) {
  if (!Array.isArray(activeModel.input_modalities) && capabilities === null) return null;
  const modalities = new Set(Array.isArray(activeModel.input_modalities) ? activeModel.input_modalities : []);
  if (capabilities?.includes('completion')) modalities.add('text');
  if (capabilities?.includes('vision')) modalities.add('image');
  return [...modalities].sort((left, right) => {
    const priority = { text: 0, image: 1 };
    return (priority[left] ?? 2) - (priority[right] ?? 2) || left.localeCompare(right);
  });
}

function normalizeReasoningDefault(activeModel, validated, warnings) {
  if (!activeModel.default_think_configured) return null;
  try {
    const parsed = parseDefaultThink(activeModel.default_think);
    if (typeof parsed === 'string' && !validated) {
      if (!warnings.includes('INVALID_REASONING_CAPABILITIES')) {
        warnings.push('MISSING_REASONING_CAPABILITIES');
      }
      return null;
    }
    return thinkLevelToReasoningEffort(parsed) ?? null;
  } catch {
    warnings.push('INVALID_ACTIVE_MODEL_THINK_DEFAULT');
    return null;
  }
}

function reasoningMetadata(activeModel, capabilities, warnings) {
  if (activeModel.reasoning_policy !== null && activeModel.reasoning_policy !== undefined) {
    let policy;
    try {
      policy = validatedReasoningPolicy(activeModel);
    } catch {
      warnings.push('INVALID_REASONING_POLICY');
      return {
        supported: null,
        efforts: {},
        aliases: {},
        default: null,
        boolean_true_behavior: null,
        output_limit_policy: null,
        absolute_max_output_tokens: null,
        per_effort: {}
      };
    }

    const backendThinking = capabilities === null ? null : capabilities.includes('thinking');
    if (backendThinking === false) warnings.push('BACKEND_THINKING_CAPABILITY_MISMATCH');
    const efforts = {};
    const perEffort = {};
    for (const [level, entry] of Object.entries(policy.levels)) {
      efforts[level] = level === 'off' ? 'none' : level;
      perEffort[level] = {
        enabled: entry.enabled,
        default_output_tokens: entry.default_output_tokens,
        max_output_tokens: entry.max_output_tokens,
        ...(!activeModel.catalog_mode || entry.reasoning_budget_tokens === undefined ? {} : { reasoning_budget_tokens: entry.reasoning_budget_tokens })
      };
    }
    return {
      supported: backendThinking === false ? false : true,
      efforts,
      aliases: { ...policy.aliases },
      default: policy.default_level,
      boolean_true_behavior: { ...policy.boolean_true_behavior },
      output_limit_policy: policy.output_limit_policy,
      absolute_max_output_tokens: policy.schema_version === 2 ? null : Math.max(...Object.values(policy.levels).map((entry) => entry.max_output_tokens)),
      per_effort: perEffort
    };
  }

  let validated = null;
  try {
    validated = validateReasoningCapabilities(activeModel);
  } catch {
    warnings.push('INVALID_REASONING_CAPABILITIES');
  }

  const ollamaThinking = capabilities === null ? null : capabilities.includes('thinking');
  if (validated && ollamaThinking === false) warnings.push('OLLAMA_THINKING_CAPABILITY_MISMATCH');

  const efforts = { off: 'none' };
  if (validated) {
    for (const effort of CANONICAL_REASONING_EFFORTS) efforts[effort] = effort;
  }

  return {
    supported: ollamaThinking === false ? false : (validated ? true : null),
    efforts,
    upstream_levels: validated ? [...validated.supported_think_levels] : null,
    effort_map: validated ? { ...validated.reasoning_effort_map } : null,
    default: normalizeReasoningDefault(activeModel, validated, warnings)
  };
}

function entryEtag(entry) {
  const digest = createHash('sha256').update(JSON.stringify(entry)).digest('base64url');
  return `"${digest}"`;
}

const nonEmptyText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const booleanOrNull = (value) => (typeof value === 'boolean' ? value : null);

// Public subset of the runtime capability profile: qualification flags only.
function publicCapabilityProfile(profile) {
  if (!isPlainObject(profile)) return null;
  return {
    name: nonEmptyText(profile.name),
    text: booleanOrNull(profile.text),
    streaming: booleanOrNull(profile.streaming),
    vision: booleanOrNull(profile.vision),
    tools: booleanOrNull(profile.tools),
    reasoning: booleanOrNull(profile.reasoning),
    speculative: booleanOrNull(profile.speculative),
    nsfw: booleanOrNull(profile.nsfw)
  };
}

// Parameter count and file size are fixed for a published model revision.
// Remember them so a briefly unreachable backend, or a reload that discards
// discovery caches, does not erase the model's capability score.
const MODEL_FACT_LIMIT = 64;

function rememberModelFacts(facts, activeModel, live) {
  const key = `${activeModel.model}\u0000${activeModel.revision ?? ''}`;
  const known = facts.get(key) || {};
  const next = {
    parameters: live?.parameters ?? known.parameters ?? null,
    size_bytes: live?.size_bytes ?? known.size_bytes ?? null
  };
  facts.delete(key);
  facts.set(key, next);
  while (facts.size > MODEL_FACT_LIMIT) facts.delete(facts.keys().next().value);
  return next;
}

// Hardware placement published by the runtime. Card names only: GPU UUIDs,
// device paths, and backend URLs stay private.
function placementMetadata(raw) {
  const textGpus = Array.isArray(raw?.text_gpu_uuids) ? raw.text_gpu_uuids
    : (Array.isArray(raw?.gpu_uuids) ? raw.gpu_uuids : null);
  const names = Array.isArray(raw?.gpu_names) && raw.gpu_names.length && raw.gpu_names.every((name) => nonEmptyText(name))
    ? raw.gpu_names.map((name) => name.trim())
    : null;
  const encoder = raw?.mmproj_offload === 'gpu' || raw?.mmproj_offload === 'cpu' ? raw.mmproj_offload : null;
  return {
    gpu_count: textGpus ? textGpus.length : (names ? names.length : null),
    gpus: names,
    vision_encoder: encoder,
    vision_gpu: encoder === 'gpu' ? nonEmptyText(raw?.vision_gpu_name) : null,
    vision_gpu_shared: encoder === 'gpu' ? booleanOrNull(raw?.vision_gpu_shared) : null,
    exclusive: raw?.exclusive === true
  };
}

// Facts reported by the running llama.cpp process: slot layout from /slots,
// GGUF facts from /v1/models, and modalities/build from /props.
function liveBackendFacts(loadedModel, props) {
  const propsBody = props?.ok ? props.body : null;
  if (!loadedModel && !propsBody) return null;
  const contexts = Array.isArray(loadedModel?.slot_contexts) ? loadedModel.slot_contexts : null;
  const known = contexts?.filter((value) => value !== null) ?? [];
  const unique = [...new Set(known)];
  return {
    slots: Number.isSafeInteger(loadedModel?.slots) ? loadedModel.slots : null,
    slot_context_window: contexts && known.length === contexts.length && unique.length === 1 ? unique[0] : null,
    vision: booleanOrNull(propsBody?.modalities?.vision),
    model_context_window: loadedModel?.meta?.n_ctx_train ?? null,
    parameters: loadedModel?.meta?.n_params ?? null,
    size_bytes: loadedModel?.meta?.size ?? null,
    build: nonEmptyText(propsBody?.build_info)
  };
}

// The runtime verifies these before publication; a disagreement here means
// the advertised capacity or capability is not what the backend provides.
function liveMismatchWarnings(activeModel, loadedModel, live) {
  if (!live) return [];
  const warnings = [];
  const slots = activeModel.max_active_requests;
  if (live.slots !== null && slots && live.slots !== slots) warnings.push('BACKEND_SLOT_COUNT_MISMATCH');
  const contexts = Array.isArray(loadedModel?.slot_contexts) ? loadedModel.slot_contexts : [];
  if (activeModel.context_length && contexts.some((value) => value !== null && value !== activeModel.context_length)) {
    warnings.push('BACKEND_SLOT_CONTEXT_MISMATCH');
  }
  if (activeModel.capability_profile?.vision === true && live.vision === false) warnings.push('BACKEND_VISION_MISMATCH');
  return warnings;
}

export function ifNoneMatchMatches(header, etag) {
  if (typeof header !== 'string' || !header.trim()) return false;
  return header.split(',').some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, '');
    return normalized === '*' || normalized === etag;
  });
}

export class ActiveModelDiscovery {
  constructor(config, options = {}) {
    this.config = config;
    this.readActiveModel = options.readActiveModel || readActiveModel;
    this.upstreamJson = options.upstreamJson || upstreamJson;
    this.now = options.now || (() => Date.now());
    this.startedAtMs = this.now();
    this.currentKey = null;
    this.generation = 0;
    this.cached = null;
    this.pending = null;
    this.modelFacts = options.modelFacts || new Map();
  }

  invalidate() {
    this.currentKey = null;
    this.generation += 1;
    this.cached = null;
    this.pending = null;
  }

  async get(activeModelOverride = null) {
    const activeModel = activeModelOverride || await this.readActiveModel(this.config);
    if (!activeModel?.model) {
      this.invalidate();
      throw new ModelDiscoveryError(
        503,
        'NO_ACTIVE_MODEL',
        'No active model marker is available.',
        'model',
        'server_error'
      );
    }

    const key = markerRevisionKey(activeModel);
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.generation += 1;
      this.cached = null;
      this.pending = null;
    }

    if (this.cached?.key === key && this.cached.expiresAt > this.now()) {
      return { ...this.cached.value, refreshed: false };
    }
    if (this.pending?.key === key) return this.pending.promise;

    const generation = this.generation;
    const promise = this.refresh(activeModel, key, generation);
    this.pending = { key, promise };
    try {
      return await promise;
    } catch (error) {
      if (this.pending?.promise === promise) this.pending = null;
      throw error;
    }
  }

  async refresh(activeModel, key, generation) {
    const adapter = activeModel.catalog_mode ? resolveBackendAdapter(this.config, activeModel) : null;
    const [ps, show, health, props] = await Promise.all([
      this.readUpstreamPs(activeModel),
      this.readUpstreamShow(activeModel),
      adapter ? adapter.health() : null,
      typeof adapter?.props === 'function' ? adapter.props() : null
    ]);
    const warnings = [...(activeModel.metadata_warnings || [])];
    if (activeModel.loadedFrom !== 'file') warnings.push('ACTIVE_MODEL_MARKER_UNAVAILABLE');
    const updatedAt = normalizeTimestamp(activeModel.updated_at);
    if (activeModel.updated_at && !updatedAt) warnings.push('INVALID_MARKER_UPDATED_AT');
    if (ps.warning) warnings.push(ps.warning);
    if (show.warning) warnings.push(show.warning);

    const capabilities = show.available ? normalizeCapabilities(show.body) : null;
    if (show.available && capabilities === null) warnings.push('OLLAMA_SHOW_CAPABILITIES_UNAVAILABLE');
    const loadedModel = ps.available ? matchingLoadedModel(ps.body, activeModel.model) : null;
    const loadedContext = loadedContextWindow(loadedModel);
    const architecturalContext = show.available ? modelContextWindow(show.body) : null;
    const live = activeModel.catalog_mode ? liveBackendFacts(loadedModel, props) : null;
    if (activeModel.catalog_mode) warnings.push(...liveMismatchWarnings(activeModel, loadedModel, live));
    const uniqueWarnings = [...new Set(warnings)];
    const raw = isPlainObject(activeModel.raw) ? activeModel.raw : {};
    const contextWindow = loadedContext ?? activeModel.context_length ?? architecturalContext;
    const inputModalities = normalizeModalities(activeModel, capabilities);
    const facts = activeModel.catalog_mode ? rememberModelFacts(this.modelFacts, activeModel, live) : null;

    const entry = {
      id: this.config.routerModelAlias,
      object: 'model',
      created: createdTimestamp(activeModel, this.startedAtMs),
      owned_by: this.config.appName,
      x_ollama_router: {
        schema_version: 2,
        alias: true,
        backend_kind: activeModel.backend_kind || 'ollama',
        upstream_model: activeModel.model,
        display_name: activeModel.raw?.display_name ?? activeModel.model,
        profile: activeModel.profile || null,
        updated_at: updatedAt,
        context_window: contextWindow,
        total_context_window: activeModel.total_context_length ?? loadedContext ?? activeModel.context_length ?? architecturalContext,
        context_safety_reserve: enforcedContextSafetyReserve(activeModel),
        active_request_limit: activeModel.max_active_requests ?? null,
        model_context_window: live?.model_context_window ?? architecturalContext,
        output_policy: activeModel.output_policy ?? 'legacy',
        max_output_tokens: activeModel.max_output_tokens ?? null,
        default_output_tokens: activeModel.default_output_tokens ?? null,
        server_default_output_tokens: activeModel.raw?.server_default_output_tokens ?? null,
        ...(health ? { health: { available: health.ok, status: health.status },
          aliases: activeModel.aliases, artifact: activeModel.raw.artifact ?? null,
          revision: activeModel.revision, quantization: activeModel.raw.quantization ?? null } : {}),
        ...(activeModel.catalog_mode ? {
          family: nonEmptyText(raw.family),
          parameter_size: formatParameterSize(live?.parameters) ?? nonEmptyText(raw.parameter_size),
          capability_profile: publicCapabilityProfile(activeModel.capability_profile),
          // Declared by the runtime catalog for each model; never inferred from a name.
          nsfw: booleanOrNull(activeModel.capability_profile?.nsfw),
          capability_score: capabilityScore({
            parameters: facts.parameters,
            sizeBytes: facts.size_bytes,
            contextWindow,
            vision: inputModalities?.includes('image') === true,
            tools: capabilities?.includes('tools') === true,
            reasoning: capabilities?.includes('thinking') === true
          }),
          placement: placementMetadata(raw),
          qualification_notes: [...(activeModel.deployment_warnings || [])],
          live
        } : {}),
        input_modalities: inputModalities,
        capabilities,
        reasoning: reasoningMetadata(activeModel, capabilities, uniqueWarnings),
        sources: {
          active_model_marker: activeModel.loadedFrom === 'file',
          ollama_ps: ps.available,
          ollama_show: show.available,
          ...((activeModel.backend_kind || 'ollama') === 'llama_cpp'
            ? { backend_status: ps.available, backend_metadata: show.available }
            : {}),
          ...(activeModel.catalog_mode ? { backend_props: props?.ok === true } : {})
        },
        complete: uniqueWarnings.length === 0,
        warnings: uniqueWarnings
      }
    };
    const value = { entry, etag: entryEtag(entry) };

    const latestActiveModel = await this.readActiveModel(this.config);
    const latestKey = latestActiveModel?.model ? markerRevisionKey(latestActiveModel) : null;
    if (generation !== this.generation || key !== this.currentKey || latestKey !== key) {
      if (latestKey !== this.currentKey) {
        this.currentKey = latestKey;
        this.generation += 1;
        this.cached = null;
        this.pending = null;
      }
      return this.get(latestActiveModel);
    }

    this.cached = {
      key,
      expiresAt: this.now() + this.config.routerModelMetadataTtlMs,
      value
    };
    if (this.pending?.key === key) this.pending = null;
    return { ...value, refreshed: true };
  }

  async readUpstreamPs(activeModel) {
    try {
      if ((activeModel.backend_kind || 'ollama') === 'ollama') {
        const result = await this.upstreamJson(this.config, '/api/ps', {
          timeoutMs: Math.min(this.config.upstreamTimeoutMs, 10000)
        });
        if (!result.ok) return { available: false, body: null, warning: 'OLLAMA_PS_UNAVAILABLE' };
        if (!isPlainObject(result.body) || !Array.isArray(result.body.models)) {
          return { available: false, body: null, warning: 'OLLAMA_PS_INVALID_RESPONSE' };
        }
        return { available: true, body: result.body, warning: null };
      }
      const body = await resolveBackendAdapter(this.config, activeModel).ps();
      if (!isPlainObject(body) || !Array.isArray(body.models)) {
        return { available: false, body: null, warning: 'BACKEND_STATUS_INVALID_RESPONSE' };
      }
      return { available: true, body, warning: null };
    } catch {
      return { available: false, body: null, warning: activeModel.backend_kind === 'llama_cpp' ? 'BACKEND_STATUS_UNAVAILABLE' : 'OLLAMA_PS_UNAVAILABLE' };
    }
  }

  async readUpstreamShow(activeModel) {
    try {
      const result = (activeModel.backend_kind || 'ollama') === 'ollama'
        ? await this.upstreamJson(this.config, '/api/show', {
          method: 'POST',
          body: { model: activeModel.model },
          timeoutMs: Math.min(this.config.upstreamTimeoutMs, 10000)
        })
        : await resolveBackendAdapter(this.config, activeModel).show(activeModel.model);
      if (!result.ok) return { available: false, body: null, warning: activeModel.backend_kind === 'llama_cpp' ? 'BACKEND_METADATA_UNAVAILABLE' : 'OLLAMA_SHOW_UNAVAILABLE' };
      if (!isPlainObject(result.body)) {
        return { available: false, body: null, warning: activeModel.backend_kind === 'llama_cpp' ? 'BACKEND_METADATA_INVALID_RESPONSE' : 'OLLAMA_SHOW_INVALID_RESPONSE' };
      }
      return { available: true, body: result.body, warning: null };
    } catch {
      return { available: false, body: null, warning: activeModel.backend_kind === 'llama_cpp' ? 'BACKEND_METADATA_UNAVAILABLE' : 'OLLAMA_SHOW_UNAVAILABLE' };
    }
  }
}

// Cache each resident's metadata independently. Keep canonical entries and the
// stable public aliases discoverable; each alias is a view of its target, not a
// separate backend, capability profile, or admission slot.
export class ModelCatalogDiscovery extends ActiveModelDiscovery {
  constructor(config, options = {}) {
    super(config, options);
    this.residents = new Map();
  }

  // Residents share the parent's fact cache, which survives invalidate().

  invalidate() {
    super.invalidate();
    this.residents?.clear();
  }

  async document(requestedId = null, { includeAliases = true } = {}) {
    const catalog = await readModelCatalog(this.config);
    if (!catalog.resident) {
      if (requestedId !== null && requestedId !== this.config.routerModelAlias) {
        throw new ModelDiscoveryError(404, 'MODEL_NOT_FOUND', `Model ${JSON.stringify(requestedId)} was not found.`, 'model', 'invalid_request_error');
      }
      const result = await super.get(catalog.models[0]);
      return { entries: [result.entry], etag: result.etag, catalog };
    }
    const selected = requestedId === null ? catalog.models : catalog.models.filter((m) => m.model === requestedId || m.aliases.includes(requestedId));
    if (!selected.length) {
      const offline = findOfflineService(catalog, requestedId);
      if (offline) throw new ModelDiscoveryError(503, 'SERVICE_OFFLINE', serviceOfflineMessage(offline, catalog.configuration), 'model', 'server_error');
      throw new ModelDiscoveryError(404, 'MODEL_NOT_FOUND', `Model ${JSON.stringify(requestedId)} was not found.`, 'model', 'invalid_request_error');
    }
    const entries = await Promise.all(selected.map(async (model) => {
      if (!this.residents.has(model.model)) {
        this.residents.set(model.model, new ActiveModelDiscovery(this.config, {
          readActiveModel: () => selectModel(this.config, model.model),
          modelFacts: this.modelFacts
        }));
      }
      const { entry } = await this.residents.get(model.model).get(model);
      const id = requestedId ?? model.model;
      return { ...entry, id, x_ollama_router: { ...entry.x_ollama_router, alias: id !== model.model } };
    }));
    if (requestedId === null && includeAliases) {
      // The catalog validates uniqueness across canonical IDs and all aliases.
      // Preserve canonical rows first so consumers can deduplicate by target.
      for (const target of [...entries]) {
        for (const id of target.x_ollama_router.aliases) {
          entries.push({ ...target, id, x_ollama_router: { ...target.x_ollama_router, alias: true } });
        }
      }
    }
    return { entries, etag: entryEtag(entries), catalog };
  }
}
