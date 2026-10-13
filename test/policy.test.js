import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { evaluateProxyPolicy } from '../src/policy.js';

function config(overrides = {}) {
  return loadConfig({
    OLLAMA_UPSTREAM_URL: 'http://ollama:11434',
    ACTIVE_MODEL: 'active:model',
    ACTIVE_MODEL_FILE: '/tmp/missing-active-model.json',
    ADMIN_TOKEN: '',
    ...overrides
  });
}

test('active chat request without keep_alive is allowed and rewritten', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { model: 'active:model', messages: [], stream: false },
    activeModelInfo: { model: 'active:model' },
    config: config()
  });
  assert.equal(result.allowed, true);
  assert.equal(result.sanitizedBody.keep_alive, -1);
  assert.equal(result.keepAliveNormalized, true);
});

test('active generate request with finite keep_alive is overwritten', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/generate',
    body: { model: 'active:model', prompt: 'hi', keep_alive: '5m' },
    activeModelInfo: { model: 'active:model' },
    config: config()
  });
  assert.equal(result.allowed, true);
  assert.equal(result.incomingKeepAlive, '5m');
  assert.equal(result.forwardedKeepAlive, -1);
  assert.equal(result.sanitizedBody.keep_alive, -1);
});

test('non-active model is rejected by default', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { model: 'other:model', messages: [] },
    activeModelInfo: { model: 'active:model' },
    config: config()
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'MODEL_NOT_ACTIVE');
});

test('rewrite requested model to active preserves other request parameters', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: {
      model: 'open-webui-workflow-base:model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      keep_alive: '5m',
      think: false,
      options: {
        temperature: 0.2,
        num_ctx: 4096
      }
    },
    activeModelInfo: { model: 'active:model' },
    config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true' })
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requestedModel, 'open-webui-workflow-base:model');
  assert.equal(result.forwardedModel, 'active:model');
  assert.equal(result.modelRewritten, true);
  assert.equal(result.sanitizedBody.model, 'active:model');
  assert.equal(result.sanitizedBody.keep_alive, -1);
  assert.equal(result.forwardedKeepAlive, -1);
  assert.deepEqual(result.sanitizedBody.options, {
    temperature: 0.2,
    num_ctx: 4096
  });
  assert.equal(result.sanitizedBody.think, false);
  assert.deepEqual(result.sanitizedBody.messages, [{ role: 'user', content: 'hi' }]);
});

test('rewrite requested model to active also fills missing model', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { messages: [{ role: 'user', content: 'hi' }], stream: false },
    activeModelInfo: { model: 'active:model' },
    config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true' })
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requestedModel, null);
  assert.equal(result.forwardedModel, 'active:model');
  assert.equal(result.modelRewritten, true);
  assert.equal(result.sanitizedBody.model, 'active:model');
  assert.equal(result.sanitizedBody.keep_alive, -1);
});

test('OpenAI chat completions rewrites only the model and preserves protocol fields', () => {
  const body = {
    model: 'stable-client-name',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    temperature: 0.3,
    tools: [{ type: 'function', function: { name: 'lookup' } }]
  };
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/v1/chat/completions',
    body,
    activeModelInfo: { model: 'active:model' },
    config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true' })
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requestedModel, 'stable-client-name');
  assert.equal(result.forwardedModel, 'active:model');
  assert.deepEqual(result.sanitizedBody, { ...body, model: 'active:model' });
  assert.equal(Object.hasOwn(result.sanitizedBody, 'keep_alive'), false);
});

test('rewrite requested model to active covers model show requests', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/show',
    body: { model: 'open-webui-workflow-base:model', verbose: true },
    activeModelInfo: { model: 'active:model' },
    config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'true' })
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requestedModel, 'open-webui-workflow-base:model');
  assert.equal(result.forwardedModel, 'active:model');
  assert.equal(result.modelRewritten, true);
  assert.equal(result.sanitizedBody.model, 'active:model');
  assert.equal(result.sanitizedBody.verbose, true);
});

test('the exact public alias resolves to active across native model routes when broad rewrite is disabled', () => {
  for (const pathname of ['/api/chat', '/api/generate', '/api/embed', '/api/embeddings', '/api/show']) {
    const result = evaluateProxyPolicy({
      method: 'POST',
      pathname,
      body: { model: 'local-active' },
      activeModelInfo: { model: 'model-a:test' },
      config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'false' })
    });
    assert.equal(result.allowed, true, pathname);
    assert.equal(result.requestedModel, 'local-active', pathname);
    assert.equal(result.forwardedModel, 'model-a:test', pathname);
    assert.equal(result.sanitizedBody.model, 'model-a:test', pathname);
    assert.equal(result.modelRewritten, true, pathname);
  }
});

test('strict mode does not treat arbitrary non-alias model names as aliases', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { model: 'some-other-name', messages: [] },
    activeModelInfo: { model: 'model-a:test' },
    config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'false' })
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'MODEL_NOT_ACTIVE');
  assert.equal(result.forwardedModel, 'some-other-name');
});

test('missing active marker fails closed', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { model: 'any:model', messages: [] },
    activeModelInfo: { model: null },
    config: config({ ACTIVE_MODEL: '' })
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, 503);
  assert.equal(result.code, 'NO_ACTIVE_MODEL');
});

test('allowlist mode can permit an additional model without active-model keep_alive rewrite', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { model: 'allowed:model', messages: [], keep_alive: '10m' },
    activeModelInfo: { model: 'active:model' },
    config: config({ MODEL_POLICY_MODE: 'allowlist', ALLOWED_MODELS: 'allowed:model' })
  });
  assert.equal(result.allowed, true);
  assert.equal(result.forwardedKeepAlive, '10m');
  assert.equal(result.sanitizedBody.keep_alive, '10m');
});

test('safe status routes are allowed', () => {
  const result = evaluateProxyPolicy({
    method: 'GET',
    pathname: '/api/version',
    body: null,
    activeModelInfo: { model: 'active:model' },
    config: config()
  });
  assert.equal(result.allowed, true);
});

test('the reserved compatibility alias names the active slot even when that entry declares no alias', () => {
  // The alias is a property of the router's active slot, not a service ID the
  // catalog has to declare. Admission here is not addressability: in resident
  // catalog mode the published catalog resolves the name first, and a name no
  // entry declares is answered with 404 before this point is reached.
  for (const pathname of ['/v1/chat/completions', '/api/chat', '/api/show']) {
    const result = evaluateProxyPolicy({
      method: 'POST',
      pathname,
      body: { model: 'local-active', messages: [{ role: 'user', content: 'hi' }] },
      activeModelInfo: { model: 'qwen3.8-flash-next-ud-iq4_xs', aliases: [], catalog_mode: true },
      config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'false' })
    });
    assert.equal(result.allowed, true, pathname);
    assert.equal(result.forwardedModel, 'qwen3.8-flash-next-ud-iq4_xs', pathname);
    assert.equal(result.modelRewritten, true, pathname);
  }
});

test('a declared service alias is forwarded to the entry that declares it', () => {
  const result = evaluateProxyPolicy({
    method: 'POST',
    pathname: '/api/chat',
    body: { model: 'trial', messages: [{ role: 'user', content: 'hi' }] },
    activeModelInfo: { model: 'qwen3.8-flash-next-ud-iq4_xs', aliases: ['trial'], catalog_mode: true },
    config: config({ REWRITE_REQUESTED_MODEL_TO_ACTIVE: 'false' })
  });
  assert.equal(result.allowed, true);
  assert.equal(result.forwardedModel, 'qwen3.8-flash-next-ud-iq4_xs');
});
