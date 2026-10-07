import { readActiveModel, parseMarker } from './active-model.js';
import { BackendAdapterError, validatedReasoningPolicy } from './backend-adapters.js';

// Largest one-slot working context a resident entry may publish: the native
// 256K window of the Qwen3.8 models. The runtime controller owns per-profile
// qualification; this contract only bounds what the router will admit.
export const RESIDENT_CONTEXT_LIMIT = 262144;

function invalid(message) {
  throw new BackendAdapterError(503, 'INVALID_MODEL_CATALOG', message, 'model');
}

const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '' && value === value.trim();
const optionalTimestamp = (value) => value === undefined || value === null
  || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

// The runtime controller describes the selected configuration. This is
// presentation metadata: an invalid value is dropped with a warning and never
// prevents inference with an otherwise valid catalog.
function runtimeConfiguration(raw, warnings) {
  const value = raw.configuration;
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !nonEmptyString(value.id)
    || (value.exclusive !== undefined && typeof value.exclusive !== 'boolean')
    || (value.runtime_revision !== undefined && value.runtime_revision !== null && !nonEmptyString(value.runtime_revision))
    || !optionalTimestamp(value.published_at)) {
    warnings.push('INVALID_RUNTIME_CONFIGURATION');
    return null;
  }
  return {
    id: value.id,
    exclusive: value.exclusive ?? null,
    runtime_revision: value.runtime_revision ?? null,
    published_at: value.published_at ? new Date(Date.parse(value.published_at)).toISOString() : null
  };
}

// Services the runtime knows about but is deliberately not running in the
// selected configuration, such as Nighttime while an exclusive profile holds
// every GPU. Requests for them fail as temporarily offline, not as unknown.
function offlineServices(raw, onlineIds, warnings) {
  const value = raw.offline_services;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push('INVALID_OFFLINE_SERVICES');
    return [];
  }
  const services = [];
  const seen = new Set();
  for (const entry of value) {
    const aliases = entry?.aliases ?? [];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !nonEmptyString(entry.model)
      || !Array.isArray(aliases) || !aliases.every(nonEmptyString)
      || (entry.display_name !== undefined && entry.display_name !== null && !nonEmptyString(entry.display_name))
      || (entry.reason !== undefined && entry.reason !== null && !nonEmptyString(entry.reason))) {
      if (!warnings.includes('INVALID_OFFLINE_SERVICES')) warnings.push('INVALID_OFFLINE_SERVICES');
      continue;
    }
    const ids = [entry.model, ...aliases];
    if (ids.some((id) => onlineIds.has(id) || seen.has(id))) {
      // A running resident always wins over a stale or conflicting declaration.
      if (!warnings.includes('OFFLINE_SERVICE_CONFLICT')) warnings.push('OFFLINE_SERVICE_CONFLICT');
      continue;
    }
    for (const id of ids) seen.add(id);
    services.push({
      model: entry.model,
      aliases: [...aliases],
      display_name: entry.display_name ?? entry.model,
      role: nonEmptyString(entry.role) ? entry.role : null,
      reason: entry.reason ?? 'not_running'
    });
  }
  return services;
}

export function findOfflineService(catalog, id) {
  return (catalog.offlineServices || []).find((entry) => entry.model === id || entry.aliases.includes(id)) || null;
}

export function serviceOfflineMessage(service, configuration) {
  const where = configuration?.id ? ` in runtime configuration ${JSON.stringify(configuration.id)}` : '';
  return `${service.display_name} is offline${where} (${service.reason}). Select a runtime configuration that includes it, or use an available model.`;
}

// One atomic marker contains both the default's legacy projection and the
// complete resident catalog. A request retains this snapshot for its lifetime.
export async function readModelCatalog(config) {
  const active = await readActiveModel(config);
  if (!Object.hasOwn(active.raw || {}, 'models')) {
    return { resident: false, defaultModel: active.model, models: [active], configuration: null, offlineServices: [], warnings: [] };
  }
  const raw = active.raw;
  if (raw.schema_version !== 3 || !Array.isArray(raw.models) || !raw.models.length) invalid('Expected a nonempty schema-v3 model catalog.');
  const ids = new Set();
  const upstreams = new Set();
  const models = raw.models.map((entry) => {
    const model = parseMarker(JSON.stringify(entry), active.file);
    if (!model?.model || model.backend_kind !== 'llama_cpp') invalid('Every resident entry must identify a llama.cpp model.');
    if (entry.display_name !== undefined && (typeof entry.display_name !== 'string' || !entry.display_name.trim())) invalid('Invalid model display name.');
    let url;
    try { url = new URL(model.backend_url); } catch { invalid(`Invalid upstream URL for ${model.model}.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid(`Invalid upstream URL for ${model.model}.`);
    if (upstreams.has(model.backend_url)) invalid('Independent resident entries must use different upstream URLs; use aliases for one service.');
    upstreams.add(model.backend_url);
    // The deployment owner qualifies the actual per-slot allocation before
    // publishing it. Any per-request context up to the native 256K window is
    // admissible. A resident runs one or two backend slots; each slot has the
    // full per-request window, so the total is the window times the slots.
    const slots = model.max_active_requests;
    if (!model.context_length || model.context_length > RESIDENT_CONTEXT_LIMIT || (slots !== 1 && slots !== 2)
      || model.total_context_length !== model.context_length * slots || model.context_safety_reserve !== 1024
      || model.output_policy !== 'unrestricted' || model.default_output_tokens !== null || model.max_output_tokens !== null || !model.capability_profile) {
      invalid(`Invalid context, output, capabilities, or slot contract for ${model.model}; context must be 1–${RESIDENT_CONTEXT_LIMIT} tokens per request with one or two slots.`);
    }
    const reasoning = validatedReasoningPolicy(model);
    if (reasoning?.schema_version !== 2 || reasoning.default_level !== 'default'
      || reasoning.output_limit_policy !== 'reject' || reasoning.boolean_true_behavior.level !== 'default'
      || reasoning.levels.default?.template_effort !== 'default'
      || Object.values(reasoning.levels).some((level) => level.enabled && level.reasoning_budget_tokens !== -1)) {
      invalid(`Resident reasoning/output defaults must be unrestricted and use template-default effort for ${model.model}.`);
    }
    if (entry.server_default_output_tokens !== -1) invalid(`The backend default must be unrestricted for ${model.model}.`);
    const aliases = entry.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some((id) => typeof id !== 'string' || !id.trim() || id !== id.trim())) invalid('Invalid model aliases.');
    for (const id of [model.model, ...aliases]) {
      if (ids.has(id)) invalid(`Duplicate model identifier ${id}.`);
      ids.add(id);
    }
    return { ...model, aliases, catalog_mode: true, loadedFrom: active.loadedFrom,
      file: active.file, file_mtime: active.file_mtime, file_mtime_ms: active.file_mtime_ms };
  });
  if (raw.default_model !== active.model || !models.some((m) => m.model === raw.default_model && m.aliases.includes(config.routerModelAlias))) {
    invalid('The default model and compatibility alias must identify the legacy coding projection.');
  }
  const projection = raw.models.find((model) => model.model === raw.default_model);
  for (const key of ['display_name', 'backend_url', 'context_length', 'default_output_tokens', 'max_output_tokens', 'reasoning_policy', 'output_policy', 'server_default_output_tokens']) {
    if (JSON.stringify(raw[key]) !== JSON.stringify(projection[key])) invalid(`Root coding projection disagrees with its catalog entry: ${key}.`);
  }
  const warnings = [];
  const configuration = runtimeConfiguration(raw, warnings);
  return { resident: true, defaultModel: raw.default_model, models, configuration,
    offlineServices: offlineServices(raw, ids, warnings), warnings };
}

export function selectCatalogModel(catalog, requested) {
  if (!catalog.resident) return catalog.models[0];
  if (requested !== undefined && requested !== null && (typeof requested !== 'string' || !requested.trim())) {
    throw new BackendAdapterError(400, 'INVALID_MODEL', 'model must be a non-empty string.', 'model');
  }
  const id = requested?.trim() ?? catalog.defaultModel;
  const selected = catalog.models.find((entry) => entry.model === id || entry.aliases.includes(id));
  if (!selected) {
    const offline = findOfflineService(catalog, id);
    if (offline) throw new BackendAdapterError(503, 'SERVICE_OFFLINE', serviceOfflineMessage(offline, catalog.configuration), 'model');
    throw new BackendAdapterError(404, 'MODEL_NOT_FOUND', `Model ${JSON.stringify(id)} was not found. Available models: ${catalog.models.map((m) => m.model).join(', ')}.`, 'model');
  }
  return selected;
}

export async function selectModel(config, requested) {
  return selectCatalogModel(await readModelCatalog(config), requested);
}
