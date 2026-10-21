import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { readActiveModel, writeActiveModelMarker } from '../src/active-model.js';
import { markerWarnings } from '../src/model-discovery.js';

test('reads active model JSON marker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-marker-'));
  const file = path.join(dir, 'active-model.json');
  await writeActiveModelMarker(file, { model: 'active:model', profile: 'test', source: 'unit-test' });
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.equal(info.model, 'active:model');
  assert.equal(info.profile, 'test');
  assert.equal(info.loadedFrom, 'file');
});

test('falls back to ACTIVE_MODEL when marker missing', async () => {
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: '/tmp/does-not-exist-router-marker.json', ACTIVE_MODEL: 'fallback:model', ADMIN_TOKEN: '' }));
  assert.equal(info.model, 'fallback:model');
  assert.equal(info.loadedFrom, 'env-fallback');
});

test('reads and writes an optional per-model thinking default', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-marker-think-'));
  const file = path.join(dir, 'active-model.json');
  await writeActiveModelMarker(file, {
    model: 'thinking:model',
    profile: 'reasoning',
    default_think: 'medium'
  });
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.equal(info.default_think_configured, true);
  assert.equal(info.default_think, 'medium');
});

test('reads and writes model/profile-specific reasoning capabilities', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-marker-reasoning-'));
  const file = path.join(dir, 'active-model.json');
  const supportedThinkLevels = ['low', 'medium'];
  const reasoningEffortMap = {
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: true,
    xhigh: true,
    max: true
  };
  await writeActiveModelMarker(file, {
    model: 'thinking:model',
    profile: 'night',
    supported_think_levels: supportedThinkLevels,
    reasoning_effort_map: reasoningEffortMap
  });
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.equal(info.reasoning_capabilities_configured, true);
  assert.deepEqual(info.supported_think_levels, supportedThinkLevels);
  assert.deepEqual(info.reasoning_effort_map, reasoningEffortMap);
});

test('normalizes optional discovery metadata without requiring it on older markers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-marker-discovery-'));
  const file = path.join(dir, 'active-model.json');
  await writeActiveModelMarker(file, {
    model: 'model-a:test',
    context_length: 16384,
    max_output_tokens: 2048,
    input_modalities: ['text', 'image', 'text'],
    revision: 7
  });
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.equal(info.context_length, 16384);
  assert.equal(info.max_output_tokens, 2048);
  assert.deepEqual(info.input_modalities, ['text', 'image']);
  assert.equal(info.revision, '7');
  assert.equal(typeof info.file_mtime_ms, 'number');
});

test('validates the context safety reserve as a nonnegative marker integer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-marker-context-reserve-'));
  const file = path.join(dir, 'active-model.json');
  await writeActiveModelMarker(file, {
    model: 'model-a:test',
    context_safety_reserve: 0
  });
  const zero = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.equal(zero.context_safety_reserve, 0);
  assert.equal(zero.metadata_warnings.includes('INVALID_MARKER_CONTEXT_SAFETY_RESERVE'), false);

  await writeActiveModelMarker(file, {
    model: 'model-a:test',
    context_safety_reserve: -1
  });
  const invalid = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.equal(invalid.context_safety_reserve, null);
  assert.equal(invalid.metadata_warnings.includes('INVALID_MARKER_CONTEXT_SAFETY_RESERVE'), true);
});

test('reads and writes additive volatile prompt-cache metadata while old markers default to null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-marker-cache-'));
  const file = path.join(dir, 'active-model.json');
  await writeActiveModelMarker(file, {
    model: 'cache:model',
    profile: 'cache-profile',
    prompt_cache_mode: 'volatile_slot_lcp',
    capability_profile: {
      prompt_cache_volatile: true,
      prompt_cache_persistence: false
    }
  });
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.equal(info.prompt_cache_mode, 'volatile_slot_lcp');
  assert.equal(info.capability_profile.prompt_cache_volatile, true);
  assert.equal(info.capability_profile.prompt_cache_persistence, false);

  const oldFile = path.join(dir, 'old-marker.json');
  await fs.writeFile(oldFile, JSON.stringify({ model: 'old:model' }));
  const oldInfo = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: oldFile, ADMIN_TOKEN: '' }));
  assert.equal(oldInfo.prompt_cache_mode, null);
  assert.equal(oldInfo.reasoning_policy, null);
});

test('reads and writes additive Flash reasoning policy metadata', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-marker-llama-reasoning-'));
  const file = path.join(dir, 'active-model.json');
  const reasoningPolicy = {
    kind: 'llama_cpp_template_budgeted',
    mapping_kind: 'native_low_medium_high_local_max',
    default_level: 'off',
    public_levels: ['off', 'none', 'low', 'medium', 'high', 'max'],
    answer_reserve: 1024,
    levels: { off: { enabled: false, default_output_tokens: 512, max_output_tokens: 4096 } }
  };
  await writeActiveModelMarker(file, {
    model: 'flash:model',
    profile: 'flash',
    reasoning_policy: reasoningPolicy
  });
  const info = await readActiveModel(loadConfig({ ACTIVE_MODEL_FILE: file, ADMIN_TOKEN: '' }));
  assert.deepEqual(info.reasoning_policy, reasoningPolicy);
});

// Completeness is `no warnings at all`, and a client refuses an incomplete model rather than guessing at
// its limits — so a warning about a file a pushed catalog never needed is not cosmetic noise, it is the
// household having no model to route. See docs/MULTI_HOST.md for what a push carries by itself.
test('a catalog that arrived by push is not asked for a marker it cannot have', () => {
  assert.deepEqual(markerWarnings({ loadedFrom: 'pushed', catalog_mode: true }), []);
  assert.deepEqual(markerWarnings({ loadedFrom: 'file' }), []);
});

test('a router unsure of its own answer still reports the marker it is missing', () => {
  assert.deepEqual(markerWarnings({ loadedFrom: 'env-fallback' }), ['ACTIVE_MODEL_MARKER_UNAVAILABLE']);
  assert.deepEqual(markerWarnings({ loadedFrom: 'missing' }), ['ACTIVE_MODEL_MARKER_UNAVAILABLE']);
  assert.deepEqual(markerWarnings({}), ['ACTIVE_MODEL_MARKER_UNAVAILABLE']);
});
