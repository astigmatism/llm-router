import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig } from '../src/config.js';

test('retention defaults, overrides and public settings use strictly positive safe integers', () => {
  const settings = [
    ['REQUEST_LOG_MAX_BYTES', 'requestLogMaxBytes', 5242880],
    ['EVENT_LOG_MAX_BYTES', 'eventLogMaxBytes', 5242880],
    ['GENERATION_RETENTION_DAYS', 'generationRetentionDays', 7],
    ['GENERATION_MAX_BYTES', 'generationMaxBytes', 1073741824]
  ];
  for (const [env, key, fallback] of settings) {
    assert.equal(loadConfig({})[key], fallback);
    assert.equal(publicConfig(loadConfig({}))[key], fallback);
    assert.equal(publicConfig(loadConfig({ [env]: '123' }))[key], 123);
    for (const value of ['0', '-1', '1.5', '1x', '1e3', 'Infinity', '9007199254740992']) {
      assert.throws(() => loadConfig({ [env]: value }), new RegExp(`${env} must be a positive integer`));
    }
  }
});

test('parses separate admin listener config', () => {
  const config = loadConfig({
    ADMIN_ENABLED: 'false',
    ADMIN_BIND_HOST: '127.0.0.1',
    ADMIN_PORT: '19000',
    ADMIN_TOKEN: 'legacy-token'
  });

  assert.equal(config.adminEnabled, false);
  assert.equal(config.adminBindHost, '127.0.0.1');
  assert.equal(config.adminPort, 19000);

  const safe = publicConfig(config);
  assert.equal(safe.adminEnabled, false);
  assert.equal(safe.adminBindHost, '127.0.0.1');
  assert.equal(safe.adminPort, 19000);
  assert.equal(safe.adminPortalAuthRequired, false);
  assert.equal(safe.legacyAdminApiAuthEnabled, true);
});

test('defaults admin portal to enabled on port 11435 without changing API port', () => {
  const config = loadConfig({ ADMIN_TOKEN: '' });
  assert.equal(config.port, 11434);
  assert.equal(config.adminEnabled, true);
  assert.equal(config.adminBindHost, '0.0.0.0');
  assert.equal(config.adminPort, 11435);
});

test('defaults request bodies to unlimited while preserving configurable caps', () => {
  const unlimited = loadConfig({});
  assert.equal(unlimited.maxBodyBytes, 0);
  assert.equal(publicConfig(unlimited).maxBodyBytes, 0);

  assert.equal(loadConfig({ MAX_BODY_BYTES: '1048576' }).maxBodyBytes, 1048576);
  assert.equal(loadConfig({ MAX_BODY_BYTES: '-1' }).maxBodyBytes, 0);
});

test('parses optional cross-protocol thinking defaults without changing endpoint defaults when absent', () => {
  const absent = loadConfig({});
  assert.equal(absent.defaultThinkConfigured, false);
  assert.equal(absent.defaultThink, undefined);
  assert.equal(publicConfig(absent).defaultThink, null);

  const configured = loadConfig({ DEFAULT_THINK: 'xhigh' });
  assert.equal(configured.defaultThinkConfigured, true);
  assert.equal(configured.defaultThink, 'xhigh');
  assert.equal(publicConfig(configured).defaultThink, 'xhigh');

  const modelDefault = loadConfig({ DEFAULT_THINK: 'model-default' });
  assert.equal(modelDefault.defaultThinkConfigured, true);
  assert.equal(modelDefault.defaultThink, undefined);
  assert.throws(() => loadConfig({ DEFAULT_THINK: 'turbo' }), /thinking default/);
});

test('disables Responses context shifting by default with an explicit opt-in', () => {
  const defaultConfig = loadConfig({});
  assert.equal(defaultConfig.responsesContextShift, false);
  assert.equal(publicConfig(defaultConfig).responsesContextShift, false);

  const enabled = loadConfig({ RESPONSES_CONTEXT_SHIFT: 'true' });
  assert.equal(enabled.responsesContextShift, true);
  assert.equal(publicConfig(enabled).responsesContextShift, true);
});

test('validates unsupported-tools policy and defaults to backward-compatible passthrough', () => {
  const defaultConfig = loadConfig({});
  assert.equal(defaultConfig.unsupportedToolsPolicy, 'passthrough');
  assert.equal(publicConfig(defaultConfig).unsupportedToolsPolicy, 'passthrough');

  assert.equal(loadConfig({ UNSUPPORTED_TOOLS_POLICY: 'drop' }).unsupportedToolsPolicy, 'drop');
  assert.equal(loadConfig({ UNSUPPORTED_TOOLS_POLICY: 'REJECT' }).unsupportedToolsPolicy, 'reject');
  assert.throws(
    () => loadConfig({ UNSUPPORTED_TOOLS_POLICY: 'remove' }),
    /UNSUPPORTED_TOOLS_POLICY must be one of: passthrough, drop, reject.*remove/
  );
});

test('configures a non-empty stable public model alias and discovery cache TTL', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.routerModelAlias, 'local-active');
  assert.equal(defaults.routerModelMetadataTtlMs, 5000);
  assert.equal(publicConfig(defaults).routerModelAlias, 'local-active');
  assert.equal(publicConfig(defaults).routerModelMetadataTtlMs, 5000);

  const configured = loadConfig({
    ROUTER_MODEL_ALIAS: 'active-slot',
    ROUTER_MODEL_METADATA_TTL_MS: '2500'
  });
  assert.equal(configured.routerModelAlias, 'active-slot');
  assert.equal(configured.routerModelMetadataTtlMs, 2500);
  assert.throws(() => loadConfig({ ROUTER_MODEL_ALIAS: '   ' }), /must be a non-empty string/);
});
