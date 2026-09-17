export const SAFE_PROXY_ROUTES = new Set([
  'GET /api/tags',
  'GET /api/ps',
  'GET /api/version',
  'POST /api/show',
  'GET /'
]);

export const MODEL_MANAGEMENT_ROUTES = new Set([
  'POST /api/pull',
  'POST /api/create',
  'POST /api/copy',
  'POST /api/push',
  'DELETE /api/delete'
]);

export const MODEL_BODY_ROUTES = new Set([
  'POST /api/chat',
  'POST /api/generate',
  'POST /api/embed',
  'POST /api/embeddings',
  'POST /v1/chat/completions'
]);

const PUBLIC_ALIAS_ROUTES = new Set([
  'POST /api/chat',
  'POST /api/generate',
  'POST /api/embed',
  'POST /api/embeddings',
  'POST /api/show',
  'POST /v1/chat/completions'
]);

export function routeKey(method, pathname) {
  return `${String(method).toUpperCase()} ${pathname}`;
}

export function isProtectedModelEndpoint(config, pathname) {
  return config.protectedModelEndpoints.includes(pathname);
}

export function getRequestedModel(body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.model === 'string' && body.model.trim()) return body.model.trim();
  return null;
}

export function cloneJson(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function keepAliveEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function modelAllowedByMode({ requestedModel, activeModel, config }) {
  if (config.modelPolicyMode === 'permissive') return true;
  if (requestedModel && config.allowedModels.includes(requestedModel)) return true;
  if (config.modelPolicyMode === 'allowlist') return requestedModel && config.allowedModels.includes(requestedModel);
  return requestedModel && activeModel && requestedModel === activeModel;
}

export function evaluateProxyPolicy({ method, pathname, body, activeModelInfo, config, isAdmin = false }) {
  const key = routeKey(method, pathname);
  const activeModel = activeModelInfo?.model || null;
  const requestedModel = getRequestedModel(body);
  const publicAliasRequested = PUBLIC_ALIAS_ROUTES.has(key)
    && (requestedModel === config.routerModelAlias || activeModelInfo?.aliases?.includes(requestedModel));
  const rewriteToActive = !activeModelInfo?.catalog_mode && config.rewriteRequestedModelToActive;
  const incomingKeepAlive = body && typeof body === 'object' && Object.hasOwn(body, 'keep_alive') ? body.keep_alive : undefined;

  if (publicAliasRequested && !activeModel) {
    return {
      allowed: false,
      status: 503,
      code: 'NO_ACTIVE_MODEL',
      message: 'No active model marker is available. The router fails closed by default.',
      requestedModel,
      forwardedModel: null,
      activeModel,
      incomingKeepAlive,
      forwardedKeepAlive: undefined,
      sanitizedBody: body,
      modelRewritten: false
    };
  }

  if (MODEL_MANAGEMENT_ROUTES.has(key)) {
    if (!config.allowModelManagement) {
      return {
        allowed: false,
        status: 403,
        code: 'MODEL_MANAGEMENT_DISABLED',
        message: 'Model-management endpoints are disabled by router policy.',
        requestedModel,
        forwardedModel: requestedModel,
        activeModel,
        incomingKeepAlive,
        forwardedKeepAlive: undefined,
        sanitizedBody: body,
        modelRewritten: false
      };
    }
    if (!isAdmin) {
      return {
        allowed: false,
        status: 401,
        code: 'ADMIN_REQUIRED',
        message: 'This model-management endpoint requires router admin authorization.',
        requestedModel,
        forwardedModel: requestedModel,
        activeModel,
        incomingKeepAlive,
        forwardedKeepAlive: undefined,
        sanitizedBody: body,
        modelRewritten: false
      };
    }
    return {
      allowed: true,
      requestedModel,
      forwardedModel: requestedModel,
      activeModel,
      incomingKeepAlive,
      forwardedKeepAlive: incomingKeepAlive,
      sanitizedBody: body,
      keepAliveNormalized: false,
      modelRewritten: false,
      adminModelManagement: true
    };
  }

  if (SAFE_PROXY_ROUTES.has(key)) {
    let sanitizedBody = body;
    let forwardedModel = requestedModel;
    let modelRewritten = false;

    if (
      key === 'POST /api/show'
      && body
      && typeof body === 'object'
      && !Array.isArray(body)
      && activeModel
      && (rewriteToActive || publicAliasRequested || (activeModelInfo?.catalog_mode && !requestedModel))
    ) {
      sanitizedBody = cloneJson(body);
      if (requestedModel !== activeModel) {
        sanitizedBody.model = activeModel;
        forwardedModel = activeModel;
        modelRewritten = true;
      }
    }

    return {
      allowed: true,
      requestedModel,
      forwardedModel,
      activeModel,
      incomingKeepAlive,
      forwardedKeepAlive: incomingKeepAlive,
      sanitizedBody,
      keepAliveNormalized: false,
      modelRewritten
    };
  }

  if (!MODEL_BODY_ROUTES.has(key)) {
    return {
      allowed: false,
      status: 404,
      code: 'ROUTE_NOT_SUPPORTED',
      message: 'This route is not enabled in the LLM router.',
      requestedModel,
      forwardedModel: requestedModel,
      activeModel,
      incomingKeepAlive,
      forwardedKeepAlive: undefined,
      sanitizedBody: body,
      modelRewritten: false
    };
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      allowed: false,
      status: 400,
      code: 'INVALID_JSON_BODY',
      message: 'Expected a JSON object body.',
      requestedModel,
      forwardedModel: requestedModel,
      activeModel,
      incomingKeepAlive,
      forwardedKeepAlive: undefined,
      sanitizedBody: body,
      modelRewritten: false
    };
  }

  let effectiveModel = requestedModel;
  let forwardedModel = requestedModel;
  let modelRewritten = false;
  const sanitizedBody = cloneJson(body);

  if (activeModel && (rewriteToActive || publicAliasRequested)) {
    if (effectiveModel !== activeModel) {
      sanitizedBody.model = activeModel;
      effectiveModel = activeModel;
      forwardedModel = activeModel;
      modelRewritten = true;
    }
  } else if (!effectiveModel && (config.useActiveModelWhenMissing || activeModelInfo?.catalog_mode) && activeModel) {
    sanitizedBody.model = activeModel;
    effectiveModel = activeModel;
    forwardedModel = activeModel;
  }

  if (!activeModel && config.modelPolicyMode !== 'permissive') {
    return {
      allowed: false,
      status: 503,
      code: 'NO_ACTIVE_MODEL',
      message: 'No active model marker is available. The router fails closed by default.',
      requestedModel,
      forwardedModel: effectiveModel,
      activeModel,
      incomingKeepAlive,
      forwardedKeepAlive: undefined,
      sanitizedBody,
      modelRewritten
    };
  }

  if (!effectiveModel) {
    return {
      allowed: false,
      status: 400,
      code: 'MODEL_REQUIRED',
      message: 'Ollama-compatible generation endpoints require a model.',
      requestedModel,
      forwardedModel: effectiveModel,
      activeModel,
      incomingKeepAlive,
      forwardedKeepAlive: undefined,
      sanitizedBody,
      modelRewritten
    };
  }

  if (!modelAllowedByMode({ requestedModel: effectiveModel, activeModel, config })) {
    return {
      allowed: false,
      status: 409,
      code: 'MODEL_NOT_ACTIVE',
      message: 'Requested model is not the active deployed model for this router profile.',
      requestedModel,
      forwardedModel: effectiveModel,
      activeModel,
      incomingKeepAlive,
      forwardedKeepAlive: undefined,
      sanitizedBody,
      modelRewritten
    };
  }

  let forwardedKeepAlive = incomingKeepAlive;
  let keepAliveNormalized = false;
  if (effectiveModel === activeModel && isProtectedModelEndpoint(config, pathname)) {
    forwardedKeepAlive = config.forcedKeepAlive;
    sanitizedBody.keep_alive = forwardedKeepAlive;
    keepAliveNormalized = !keepAliveEqual(incomingKeepAlive, forwardedKeepAlive);
  }

  return {
    allowed: true,
    requestedModel,
    forwardedModel: effectiveModel,
    activeModel,
    incomingKeepAlive,
    forwardedKeepAlive,
    sanitizedBody,
    keepAliveNormalized,
    modelRewritten,
    activeModelRequest: effectiveModel === activeModel
  };
}

export function isLikelyStreamingRequest(pathname, body) {
  if (pathname === '/v1/chat/completions') return body?.stream === true;
  if (!['/api/chat', '/api/generate', '/api/pull', '/api/create'].includes(pathname)) return false;
  if (!body || typeof body !== 'object') return false;
  return body.stream !== false;
}
