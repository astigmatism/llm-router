import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

function positiveInteger(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstPositiveInteger(candidates) {
  for (const value of candidates) {
    const normalized = positiveInteger(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function markerMetadata(parsed) {
  const rawModalities = parsed.input_modalities ?? parsed.modalities;
  const contextCandidates = [
    parsed.context_window,
    parsed.context_length,
    parsed.context,
    parsed.num_ctx,
    parsed.numCtx,
    parsed.options?.num_ctx
  ];
  const maxOutputCandidates = [
    parsed.max_output_tokens,
    parsed.maxOutputTokens,
    parsed.num_predict,
    parsed.options?.num_predict
  ];
  const contextLength = firstPositiveInteger(contextCandidates);
  const maxOutputTokens = firstPositiveInteger(maxOutputCandidates);
  const contextSafetyReserve = nonNegativeInteger(parsed.context_safety_reserve);
  const inputModalities = Array.isArray(rawModalities)
    ? [...new Set(rawModalities
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim().toLowerCase()))]
    : null;
  const warnings = [];
  if (rawModalities !== undefined && rawModalities !== null && !Array.isArray(rawModalities)) {
    warnings.push('INVALID_MARKER_INPUT_MODALITIES');
  }
  if (Array.isArray(rawModalities) && rawModalities.some((value) => typeof value !== 'string' || !value.trim())) {
    warnings.push('INVALID_MARKER_INPUT_MODALITIES');
  }
  if (contextCandidates.some((value) => value !== undefined && value !== null) && contextLength === null) {
    warnings.push('INVALID_MARKER_CONTEXT_LENGTH');
  }
  if (maxOutputCandidates.some((value) => value !== undefined && value !== null) && maxOutputTokens === null) {
    warnings.push('INVALID_MARKER_MAX_OUTPUT_TOKENS');
  }
  if (parsed.context_safety_reserve !== undefined
    && parsed.context_safety_reserve !== null
    && contextSafetyReserve === null) {
    warnings.push('INVALID_MARKER_CONTEXT_SAFETY_RESERVE');
  }

  return {
    context_length: contextLength,
    output_policy: parsed.output_policy ?? 'legacy',
    max_output_tokens: maxOutputTokens,
    input_modalities: inputModalities,
    metadata_warnings: warnings,
    revision: typeof parsed.revision === 'string' || typeof parsed.revision === 'number'
      ? String(parsed.revision)
      : null,
    backend_kind: typeof parsed.backend_kind === 'string' && parsed.backend_kind.trim()
      ? parsed.backend_kind.trim().toLowerCase()
      : 'ollama',
    backend_url: typeof parsed.backend_url === 'string' && parsed.backend_url.trim()
      ? parsed.backend_url.trim().replace(/\/+$/, '')
      : null,
    backend_revision: typeof parsed.backend_revision === 'string' ? parsed.backend_revision.trim() || null : null,
    total_context_length: positiveInteger(parsed.total_context_length),
    max_active_requests: positiveInteger(parsed.max_active_requests),
    default_output_tokens: positiveInteger(parsed.default_output_tokens),
    context_safety_reserve: contextSafetyReserve,
    gpu_uuids: Array.isArray(parsed.gpu_uuids)
      ? parsed.gpu_uuids.filter((value) => typeof value === 'string' && value.startsWith('GPU-'))
      : null,
    fit_target: typeof parsed.fit_target === 'string' ? parsed.fit_target.trim() || null : null,
    model_path: typeof parsed.model_path === 'string' ? parsed.model_path.trim() || null : null,
    prompt_cache_mode: typeof parsed.prompt_cache_mode === 'string' ? parsed.prompt_cache_mode.trim() || null : null,
    reasoning_policy: parsed.reasoning_policy && typeof parsed.reasoning_policy === 'object' && !Array.isArray(parsed.reasoning_policy)
      ? parsed.reasoning_policy
      : null,
    capability_profile: parsed.capability_profile && typeof parsed.capability_profile === 'object' && !Array.isArray(parsed.capability_profile)
      ? parsed.capability_profile
      : null,
    deployment_warnings: Array.isArray(parsed.deployment_warnings)
      ? parsed.deployment_warnings.filter((value) => typeof value === 'string' && value.trim())
      : []
  };
}

function emptyMarkerMetadata() {
  return {
    context_length: null,
    max_output_tokens: null,
    input_modalities: null,
    metadata_warnings: [],
    revision: null,
    backend_kind: 'ollama',
    backend_url: null,
    backend_revision: null,
    total_context_length: null,
    max_active_requests: null,
    default_output_tokens: null,
    context_safety_reserve: null,
    gpu_uuids: null,
    fit_target: null,
    model_path: null,
    prompt_cache_mode: null,
    reasoning_policy: null,
    capability_profile: null,
    deployment_warnings: []
  };
}

export function parseMarker(raw, filePath) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string' && parsed.model.trim()) {
      const hasSupportedThinkLevels = Object.hasOwn(parsed, 'supported_think_levels');
      const hasReasoningEffortMap = Object.hasOwn(parsed, 'reasoning_effort_map');
      return {
        model: parsed.model.trim(),
        profile: typeof parsed.profile === 'string' ? parsed.profile : null,
        keep_alive: parsed.keep_alive ?? null,
        default_think: Object.hasOwn(parsed, 'default_think') ? parsed.default_think : null,
        default_think_configured: Object.hasOwn(parsed, 'default_think') && parsed.default_think !== null,
        supported_think_levels: hasSupportedThinkLevels ? parsed.supported_think_levels : null,
        reasoning_effort_map: hasReasoningEffortMap ? parsed.reasoning_effort_map : null,
        reasoning_capabilities_configured: hasSupportedThinkLevels || hasReasoningEffortMap,
        updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
        source: typeof parsed.source === 'string' ? parsed.source : filePath,
        ...markerMetadata(parsed),
        raw: parsed
      };
    }
    return null;
  } catch {
    return {
      model: trimmed,
      profile: null,
      keep_alive: null,
      default_think: null,
      default_think_configured: false,
      supported_think_levels: null,
      reasoning_effort_map: null,
      reasoning_capabilities_configured: false,
      updated_at: null,
      source: filePath,
      ...emptyMarkerMetadata(),
      raw: trimmed
    };
  }
}

export async function readActiveModel(config) {
  const filePath = config.activeModelFile;
  if (filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const marker = parseMarker(raw, filePath);
      if (marker?.model) {
        let mtime = null;
        let mtimeMs = null;
        try {
          const stat = statSync(filePath);
          mtime = stat.mtime.toISOString();
          mtimeMs = stat.mtimeMs;
        } catch {
          mtime = null;
          mtimeMs = null;
        }
        return {
          ...marker,
          loadedFrom: 'file',
          file: filePath,
          file_mtime: mtime,
          file_mtime_ms: mtimeMs
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return {
          model: config.activeModelFallback || null,
          profile: null,
          keep_alive: null,
          default_think: null,
          default_think_configured: false,
          supported_think_levels: null,
          reasoning_effort_map: null,
          reasoning_capabilities_configured: false,
          updated_at: null,
          source: `fallback after marker read error: ${error.message}`,
          ...emptyMarkerMetadata(),
          loadedFrom: config.activeModelFallback ? 'env-fallback' : 'missing',
          file: filePath,
          file_mtime: null,
          file_mtime_ms: null,
          error: error.message
        };
      }
    }
  }

  if (config.activeModelFallback) {
    return {
      model: config.activeModelFallback,
      profile: null,
      keep_alive: null,
      default_think: null,
      default_think_configured: false,
      supported_think_levels: null,
      reasoning_effort_map: null,
      reasoning_capabilities_configured: false,
      updated_at: null,
      source: 'ACTIVE_MODEL environment fallback',
      ...emptyMarkerMetadata(),
      loadedFrom: 'env-fallback',
      file: filePath,
      file_mtime: null,
      file_mtime_ms: null
    };
  }

  return {
    model: null,
    profile: null,
    keep_alive: null,
    default_think: null,
    default_think_configured: false,
    supported_think_levels: null,
    reasoning_effort_map: null,
    reasoning_capabilities_configured: false,
    updated_at: null,
    source: 'no active model marker or ACTIVE_MODEL fallback',
    ...emptyMarkerMetadata(),
    loadedFrom: 'missing',
    file: filePath,
    file_mtime: null,
    file_mtime_ms: null
  };
}

export async function writeActiveModelMarker(filePath, marker) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Legacy writers must not silently dismantle a resident catalog.
  const existing = await fs.readFile(filePath, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '{}';
  });
  if (parseMarker(existing, filePath)?.raw?.models && !marker.models) {
    throw new Error('Resident model catalog requires a complete catalog update; legacy marker replacement refused.');
  }
  const payload = {
    ...(marker.models ? { schema_version: 3, default_model: marker.default_model ?? marker.model, models: marker.models } : {}),
    model: marker.model,
    profile: marker.profile ?? null,
    keep_alive: marker.keep_alive ?? -1,
    ...(marker.default_think === undefined ? {} : { default_think: marker.default_think }),
    ...(marker.supported_think_levels === undefined ? {} : { supported_think_levels: marker.supported_think_levels }),
    ...(marker.reasoning_effort_map === undefined ? {} : { reasoning_effort_map: marker.reasoning_effort_map }),
    ...(marker.context_length === undefined ? {} : { context_length: marker.context_length }),
    ...(marker.max_output_tokens === undefined ? {} : { max_output_tokens: marker.max_output_tokens }),
    ...(marker.input_modalities === undefined ? {} : { input_modalities: marker.input_modalities }),
    ...(marker.revision === undefined ? {} : { revision: marker.revision }),
    ...(marker.backend_kind === undefined ? {} : { backend_kind: marker.backend_kind }),
    ...(marker.backend_url === undefined ? {} : { backend_url: marker.backend_url }),
    ...(marker.backend_revision === undefined ? {} : { backend_revision: marker.backend_revision }),
    ...(marker.total_context_length === undefined ? {} : { total_context_length: marker.total_context_length }),
    ...(marker.max_active_requests === undefined ? {} : { max_active_requests: marker.max_active_requests }),
    ...(marker.default_output_tokens === undefined ? {} : { default_output_tokens: marker.default_output_tokens }),
    ...(marker.context_safety_reserve === undefined ? {} : { context_safety_reserve: marker.context_safety_reserve }),
    ...(marker.gpu_uuids === undefined ? {} : { gpu_uuids: marker.gpu_uuids }),
    ...(marker.fit_target === undefined ? {} : { fit_target: marker.fit_target }),
    ...(marker.model_path === undefined ? {} : { model_path: marker.model_path }),
    ...(marker.prompt_cache_mode === undefined ? {} : { prompt_cache_mode: marker.prompt_cache_mode }),
    ...(marker.reasoning_policy === undefined ? {} : { reasoning_policy: marker.reasoning_policy }),
    ...(marker.capability_profile === undefined ? {} : { capability_profile: marker.capability_profile }),
    ...(marker.deployment_warnings === undefined ? {} : { deployment_warnings: marker.deployment_warnings }),
    updated_at: marker.updated_at ?? new Date().toISOString(),
    source: marker.source ?? 'llm-router'
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}
