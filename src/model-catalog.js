import { parseMarker } from './active-model.js';
import { readHostSources, readHostSource, LOCAL_HOST_ID } from './catalog-source.js';
import { BackendAdapterError, SUPPORTED_BACKEND_KINDS, validatedReasoningPolicy } from './backend-adapters.js';

// Largest one-slot working context a resident entry may publish. The native
// window of the Qwen3.8 models is 262,144; anything above it is a rope-scaled
// extension, and the runtime controller owns per-profile qualification for
// those (measured on the deployment host, stated in the profile). This
// contract only bounds what the router will admit.
export const RESIDENT_CONTEXT_LIMIT = 524288;

function invalid(message, host = null) {
  const error = new BackendAdapterError(503, 'INVALID_MODEL_CATALOG', host ? `${message} (host ${JSON.stringify(host)})` : message, 'model');
  error.host = host;
  throw error;
}

const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '' && value === value.trim();
const optionalTimestamp = (value) => value === undefined || value === null
  || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

// A backend the router cannot reach from where it runs is a topology mistake,
// and it surfaces far from here as an unexplained 503: loopback addresses and
// container DNS names belong to the machine that published them. Reported, not
// refused — the publisher owns the catalog, and only it can state where its
// service is reachable from.
function backendUrlWarnings(entry, config, host) {
  if (!config.expectRoutableBackendUrls) return [];
  let url;
  try { url = new URL(entry.backend_url); } catch { return []; }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost')
    || /^127(\.\d{1,3}){3}$/.test(hostname) || hostname === '::1' || hostname.startsWith('::1');
  if (!loopback) return [];
  return [`BACKEND_URL_NOT_ROUTABLE:${host}:${hostname}`];
}

// Services the runtime knows about but is deliberately not running in the
// selected configuration, such as Nighttime while an exclusive profile holds
// every GPU. Requests for them fail as temporarily offline, not as unknown.
function offlineServices(raw, onlineIds, warnings, host, single) {
  const value = raw.offline_services;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(hostWarning('INVALID_OFFLINE_SERVICES', host, single));
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
      const invalidServices = hostWarning('INVALID_OFFLINE_SERVICES', host, single);
      if (!warnings.includes(invalidServices)) warnings.push(invalidServices);
      continue;
    }
    const ids = [entry.model, ...aliases];
    if (ids.some((id) => onlineIds.has(id) || seen.has(id))) {
      // A running resident always wins over a stale or conflicting declaration.
      const conflict = hostWarning('OFFLINE_SERVICE_CONFLICT', host, single);
      if (!warnings.includes(conflict)) warnings.push(conflict);
      continue;
    }
    for (const id of ids) seen.add(id);
    services.push({
      model: entry.model,
      aliases: [...aliases],
      display_name: entry.display_name ?? entry.model,
      role: nonEmptyString(entry.role) ? entry.role : null,
      reason: entry.reason ?? 'not_running',
      ...(single ? {} : { host })
    });
  }
  return services;
}

// Warnings keep their existing names for a single-host deployment and gain the
// host they belong to as soon as more than one machine publishes here, so one
// machine's bad day never reads as another's.
const hostWarning = (code, host, single) => (single || host === undefined || host === null ? code : `${code}:${host}`);

export function findOfflineService(catalog, id) {
  return (catalog.offlineServices || []).find((entry) => entry.model === id || entry.aliases.includes(id)) || null;
}

export function serviceOfflineMessage(service, configuration) {
  const where = configuration?.id ? ` in runtime configuration ${JSON.stringify(configuration.id)}` : '';
  return `${service.display_name} is offline${where} (${service.reason}). Select a runtime configuration that includes it, or use an available model.`;
}

// One host's resident catalog: every entry, the runtime configuration it was
// published under, and the services that configuration deliberately stops.
function parseResidentHost(config, source, single) {
  const raw = source.raw;
  const host = source.host;
  if (raw.host !== undefined && raw.host !== null) {
    const declared = raw.host;
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)
      || (declared.id !== undefined && declared.id !== null && declared.id !== host)
      || (declared.display_name !== undefined && !nonEmptyString(declared.display_name))) {
      invalid('Host identity must be an object naming this host, with an optional display name.', host);
    }
  }
  const declaredHost = (raw.host && typeof raw.host === 'object') ? raw.host : {};
  if (raw.schema_version !== 3 && raw.schema_version !== 4) invalid('Expected a nonempty schema-v3 or v4 model catalog.', host);
  if (!Array.isArray(raw.models) || !raw.models.length) invalid('Expected a nonempty model catalog.', host);
  const ids = new Set();
  const upstreams = new Set();
  const models = raw.models.map((entry) => {
    const model = parseMarker(JSON.stringify(entry), source.file);
    if (!model?.model || !SUPPORTED_BACKEND_KINDS.includes(model.backend_kind)) invalid('Every resident entry must identify a llama.cpp or Strata model.', host);
    if (entry.display_name !== undefined && (typeof entry.display_name !== 'string' || !entry.display_name.trim())) invalid('Invalid model display name.', host);
    let url;
    try { url = new URL(model.backend_url); } catch { invalid(`Invalid upstream URL for ${model.model}.`, host); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid(`Invalid upstream URL for ${model.model}.`, host);
    if (upstreams.has(model.backend_url)) invalid('Independent resident entries must use different upstream URLs; use aliases for one service.', host);
    upstreams.add(model.backend_url);
    // The deployment owner qualifies the actual per-slot allocation before
    // publishing it, including any rope-scaled window above the model's
    // trained context. Any per-request context up to RESIDENT_CONTEXT_LIMIT
    // is admissible. A resident runs one or two backend slots; each slot has
    // the full per-request window, so the total is the window times the slots.
    const slots = model.max_active_requests;
    if (!model.context_length || model.context_length > RESIDENT_CONTEXT_LIMIT || (slots !== 1 && slots !== 2)
      || model.total_context_length !== model.context_length * slots || model.context_safety_reserve !== 1024
      || model.output_policy !== 'unrestricted' || model.default_output_tokens !== null || model.max_output_tokens !== null || !model.capability_profile) {
      invalid(`Invalid context, output, capabilities, or slot contract for ${model.model}; context must be 1–${RESIDENT_CONTEXT_LIMIT} tokens per request with one or two slots.`, host);
    }
    const reasoning = validatedReasoningPolicy(model);
    if (reasoning?.schema_version !== 2 || reasoning.default_level !== 'default'
      || reasoning.output_limit_policy !== 'reject' || reasoning.boolean_true_behavior.level !== 'default'
      || reasoning.levels.default?.template_effort !== 'default'
      || Object.values(reasoning.levels).some((level) => level.enabled && level.reasoning_budget_tokens !== -1)) {
      invalid(`Resident reasoning/output defaults must be unrestricted and use template-default effort for ${model.model}.`, host);
    }
    if (entry.server_default_output_tokens !== -1) invalid(`The backend default must be unrestricted for ${model.model}.`, host);
    const aliases = entry.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some((id) => typeof id !== 'string' || !id.trim() || id !== id.trim())) invalid('Invalid model aliases.', host);
    for (const id of [model.model, ...aliases]) {
      if (ids.has(id)) invalid(`Duplicate model identifier ${id}.`, host);
      ids.add(id);
    }
    return {
      ...model, aliases, catalog_mode: true, ...(single ? {} : { host }),
      loadedFrom: source.loadedFrom,
      file: source.file, file_mtime: source.acceptedAt, file_mtime_ms: source.acceptedAtMs
    };
  });
  if (raw.default_model !== raw.model || !models.some((m) => m.model === raw.default_model)
    || models.some((m) => m.model !== raw.default_model && m.aliases.includes(config.routerModelAlias))) {
    invalid('The default model must identify the root projection; a declared compatibility alias must belong to it.', host);
  }
  const projection = raw.models.find((model) => model.model === raw.default_model);
  for (const key of ['display_name', 'backend_url', 'context_length', 'default_output_tokens', 'max_output_tokens', 'reasoning_policy', 'output_policy', 'server_default_output_tokens']) {
    if (JSON.stringify(raw[key]) !== JSON.stringify(projection[key])) invalid(`Root coding projection disagrees with its catalog entry: ${key}.`, host);
  }
  const warnings = [];
  const configuration = runtimeConfiguration(raw, warnings, host, single);
  // A client conforming to the client contract sends a service alias. The
  // reserved compatibility alias does not count: it names whatever the router
  // has marked active, not a service. When no entry declares any other alias,
  // a conformant client has nothing it is allowed to send, even though every
  // entry is reachable by its canonical ID. The alias list belongs to the
  // publisher; the router reports the state instead of assuming it was meant.
  if (!models.some((entry) => entry.aliases.some((alias) => alias !== config.routerModelAlias))) {
    warnings.push(hostWarning('CATALOG_HAS_NO_SERVICE_ID', host, single));
  }
  for (const model of models) warnings.push(...backendUrlWarnings(model, config, host));
  return {
    id: host,
    display_name: nonEmptyString(declaredHost.display_name) ? declaredHost.display_name : host,
    present: true,
    resident: true,
    defaultModel: raw.default_model,
    models,
    configuration,
    offlineServices: offlineServices(raw, ids, warnings, host, single),
    warnings,
    revision: source.revision,
    acceptedAt: source.acceptedAt,
    file: source.file,
    loadedFrom: source.loadedFrom,
    error: null
  };
}

// The selected configuration the runtime describes. This is presentation
// metadata: an invalid value is dropped with a warning and never prevents
// inference with an otherwise valid catalog.
function runtimeConfiguration(raw, warnings, host, single) {
  const value = raw.configuration;
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !nonEmptyString(value.id)
    || (value.exclusive !== undefined && typeof value.exclusive !== 'boolean')
    || (value.runtime_revision !== undefined && value.runtime_revision !== null && !nonEmptyString(value.runtime_revision))
    || !optionalTimestamp(value.published_at)) {
    // Presentation metadata only: the warning tells the publisher its
    // declaration is unusable, and inference proceeds with a valid catalog.
    warnings.push(hostWarning('INVALID_RUNTIME_CONFIGURATION', host, single));
    return { invalid: true };
  }
  return {
    id: value.id,
    exclusive: value.exclusive ?? null,
    runtime_revision: value.runtime_revision ?? null,
    published_at: value.published_at ? new Date(Date.parse(value.published_at)).toISOString() : null,
    ...(single ? {} : { host })
  };
}

// A host that publishes something the router cannot use is reported and then
// left out of the deployment; the machines that did publish keep serving.
function unavailableHost(config, source, error, single) {
  const code = error?.code || 'HOST_CATALOG_UNAVAILABLE';
  return {
    id: source.host,
    display_name: source.host,
    present: false,
    resident: false,
    defaultModel: null,
    models: [],
    configuration: null,
    offlineServices: [],
    warnings: [hostWarning(`${code}`, source.host, single)],
    revision: source.revision,
    acceptedAt: source.acceptedAt,
    file: source.file,
    loadedFrom: source.loadedFrom,
    error: { code, message: error?.message || source.readError || 'No catalog has been published.' }
  };
}

function parseHostCatalog(config, source, single) {
  const marker = source.host === LOCAL_HOST_ID ? source.marker : null;
  try {
    if (source.raw && typeof source.raw === 'object' && !Array.isArray(source.raw) && Object.hasOwn(source.raw, 'models')) {
      const host = parseResidentHost(config, source, single);
      if (config.catalogMaxAgeMs > 0 && source.acceptedAtMs
        && Date.now() - source.acceptedAtMs > config.catalogMaxAgeMs) {
        host.warnings.push(hostWarning('CATALOG_STALE', source.host, single));
      }
      return host;
    }
    // A single-host deployment answers with its marker contract exactly as every
    // previous release did: the file, the ACTIVE_MODEL fallback, or no model at
    // all — and "no model yet" is discovery's NO_ACTIVE_MODEL, not an error.
    if (single && marker) {
      return {
        id: source.host,
        display_name: marker.raw?.display_name ?? marker.model ?? null,
        present: Boolean(marker.model),
        resident: false,
        defaultModel: marker.model ?? null,
        models: [marker],
        configuration: null,
        offlineServices: [],
        warnings: [],
        revision: source.revision,
        acceptedAt: source.acceptedAt,
        file: source.file,
        loadedFrom: source.loadedFrom,
        error: null
      };
    }
    if (!source.present) {
      const missing = new Error(source.readError || 'No catalog has been published.');
      missing.code = 'HOST_CATALOG_UNPUBLISHED';
      throw missing;
    }
    // A bare marker is the historical single-marker shape: valid for the
    // machine this router runs on, handled above, and not something another
    // machine can publish, because it carries no contract to admit against.
    if (marker?.model) {
      const incompatible = new Error('Published catalog must be a model catalog; a bare model marker is not accepted from a host.');
      incompatible.code = 'HOST_CATALOG_INCOMPATIBLE';
      throw incompatible;
    }
    const error = new Error(source.readError || 'No catalog has been published.');
    error.code = 'HOST_CATALOG_UNPUBLISHED';
    throw error;
  } catch (error) {
    return unavailableHost(config, source, error, single);
  }
}

// One atomic catalog contains the default's legacy projection and every
// resident entry. A request retains this snapshot for its lifetime.
export async function readModelCatalog(config) {
  const sources = await readHostSources(config);
  const single = config.routerHosts.length === 1;
  const hosts = sources.map((source) => parseHostCatalog(config, source, single));
  const serving = hosts.filter((host) => host.models.length);
  if (!serving.length) {
    // Nothing is servable. Surface the first publisher's complaint the way a
    // single-host deployment always has, so the operator repairs the same file
    // with the same tools.
    const first = hosts.find((host) => host.error);
    if (first) invalid(first.error.message, single ? null : first.id);
    invalid('No model catalog is available.');
  }
  const ids = new Map();
  const models = [];
  const offlineServices = [];
  const warnings = [];
  for (const host of hosts) {
    for (const model of host.models) {
      // A single-marker host has no alias contract; only catalog entries do.
      const entries = [model.model, ...(Array.isArray(model.aliases) ? model.aliases : [])];
      const clash = entries.map((id) => ids.get(id)).find((owner) => owner && owner !== host.id);
      if (clash) {
        // Two machines claiming one client-facing name: the first-declared host
        // keeps it, because ROUTER_HOSTS order is the only precedence the
        // publishers share. The rest of that host's models still serve.
        warnings.push(hostWarning(`CATALOG_ID_CONFLICT:${clash}`, host.id, single));
        continue;
      }
      for (const id of entries) ids.set(id, host.id);
      models.push(model);
    }
    warnings.push(...host.warnings);
  }
  const online = new Set(models.map((model) => model.model));
  for (const host of hosts) {
    for (const service of host.offlineServices) {
      if ([service.model, ...service.aliases].some((id) => online.has(id))) continue;
      offlineServices.push(service);
    }
  }
  const defaultHost = hosts.find((host) => host.id === config.defaultHost && host.models.length);
  const usableConfiguration = (host) => (host?.configuration && !host.configuration.invalid ? host.configuration : null);
  const anchor = defaultHost ?? serving[0];
  if (!defaultHost) warnings.push(hostWarning('DEFAULT_HOST_UNAVAILABLE', config.defaultHost, single));
  return {
    resident: serving.some((host) => host.resident),
    defaultModel: anchor.defaultModel,
    models,
    configuration: usableConfiguration(defaultHost) ?? null,
    // A host whose runtime declaration is unusable reports no configuration;
    // the deployment then names none rather than borrowing another machine's.
    ...(single ? {} : { configuration_by_host: Object.fromEntries(serving
      .map((host) => [host.id, usableConfiguration(host)])
      .filter(([, configuration]) => configuration).map(([id, configuration]) => [id, configuration])) }),
    offlineServices,
    hosts: hosts.map((host) => ({
      id: host.id,
      display_name: host.display_name,
      default: host.id === anchor.id,
      resident: host.resident,
      published: host.present,
      model_ids: host.models.map((model) => model.model),
      online: host.models.length > 0,
      configuration: host.configuration && !host.configuration.invalid ? host.configuration : null,
      revision: host.revision,
      accepted_at: host.acceptedAt,
      file: host.file,
      loaded_from: host.loadedFrom,
      warnings: host.warnings,
      error: host.error
    })),
    warnings
  };
}

export async function selectModel(config, requested) {
  return selectCatalogModel(await readModelCatalog(config), requested);
}

// The default host's active model: the same shape the marker contract has
// always returned, plus the host it came from. Endpoints that report "what is
// running now" use this instead of reading the local file directly, so a router
// that no longer shares a machine with its backends reports the machine it was
// asked about rather than the machine it happens to run on.
export async function readDeploymentActiveModel(config) {
  const source = await readHostSource(config, config.defaultHost);
  const single = config.routerHosts.length === 1;
  const host = parseHostCatalog(config, source, single);
  if (host.models.length) return host.models.find((model) => model.model === host.defaultModel) ?? host.models[0];
  return source.marker ?? {
    model: null,
    loadedFrom: source.loadedFrom,
    source: source.readError || 'No catalog has been published.',
    raw: null
  };
}

// Selection within one host's published models. Aliases resolve to their
// target; a service the configuration stops answers as offline, never as
// unknown and never as a different model.
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

export { parseHostCatalog };
