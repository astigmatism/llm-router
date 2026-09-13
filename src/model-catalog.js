import { readActiveModel, parseMarker } from './active-model.js';
import { BackendAdapterError, validatedReasoningPolicy } from './backend-adapters.js';

function invalid(message) {
  throw new BackendAdapterError(503, 'INVALID_MODEL_CATALOG', message, 'model');
}

// One atomic marker contains both the default's legacy projection and the
// complete resident catalog. A request retains this snapshot for its lifetime.
export async function readModelCatalog(config) {
  const active = await readActiveModel(config);
  if (!Object.hasOwn(active.raw || {}, 'models')) {
    return { resident: false, defaultModel: active.model, models: [active] };
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
    // publishing it. Permit the reviewed 144K/160K extensions; the retired
    // 256K profile remains outside this resident contract.
    if (!model.context_length || model.context_length > 163840 || model.total_context_length !== model.context_length
      || model.max_active_requests !== 1 || model.context_safety_reserve !== 1024
      || model.output_policy !== 'unrestricted' || model.default_output_tokens !== null || model.max_output_tokens !== null || !model.capability_profile) {
      invalid(`Invalid context, output, capabilities, or one-slot contract for ${model.model}; 256K is retired.`);
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
  return { resident: true, defaultModel: raw.default_model, models };
}

export function selectCatalogModel(catalog, requested) {
  if (!catalog.resident) return catalog.models[0];
  if (requested !== undefined && requested !== null && (typeof requested !== 'string' || !requested.trim())) {
    throw new BackendAdapterError(400, 'INVALID_MODEL', 'model must be a non-empty string.', 'model');
  }
  const id = requested?.trim() ?? catalog.defaultModel;
  const selected = catalog.models.find((entry) => entry.model === id || entry.aliases.includes(id));
  if (!selected) throw new BackendAdapterError(404, 'MODEL_NOT_FOUND', `Model ${JSON.stringify(id)} was not found. Available models: ${catalog.models.map((m) => m.model).join(', ')}.`, 'model');
  return selected;
}

export async function selectModel(config, requested) {
  return selectCatalogModel(await readModelCatalog(config), requested);
}
