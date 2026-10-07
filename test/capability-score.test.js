import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityScore, quantizationFidelity, CAPABILITY_SCORE_VERSION } from '../src/capability-score.js';

const ALL = { vision: true, tools: true, reasoning: true };
const QWEN_27B = 27_320_697_856;

test('scores production-shaped models in the expected order from published facts only', () => {
  const daytime = capabilityScore({ parameters: QWEN_27B, sizeBytes: 25_288_065_024, contextWindow: 163840, ...ALL });
  const nighttime = capabilityScore({ parameters: QWEN_27B, sizeBytes: 22_420_004_864, contextWindow: 98304, ...ALL });
  assert.deepEqual(daytime, {
    value: 68.3, version: CAPABILITY_SCORE_VERSION, basis: 'computed',
    components: { size: 26.1, context: 22.2, features: 20 },
    inputs: { parameters: QWEN_27B, bits_per_weight: 7.4, context_window: 163840, vision: true, tools: true, reasoning: true }
  });
  assert.equal(nighttime.value, 64.9);
  assert.ok(daytime.value > nighttime.value);
});

test('more context, higher precision, more parameters and more features each raise the score', () => {
  const base = { parameters: QWEN_27B, sizeBytes: 22_420_004_864, contextWindow: 131072, ...ALL };
  const score = (changes) => capabilityScore({ ...base, ...changes }).value;
  assert.ok(score({ contextWindow: 163840 }) > score({}));
  assert.ok(score({}) > score({ contextWindow: 98304 }));
  assert.ok(score({ sizeBytes: 29_030_000_000 }) > score({}));            // Q8 versus Q6_K
  assert.ok(score({ sizeBytes: 14_600_000_000 }) < score({}));            // about 4.3 bits per weight
  assert.ok(score({ parameters: 70_000_000_000, sizeBytes: 58_000_000_000 }) > score({}));
  assert.ok(score({ vision: false }) < score({}));
  assert.equal(score({ contextWindow: 262144 }), score({ contextWindow: 1048576 }));  // capped at 256K
});

test('a score is never guessed when a required fact is missing', () => {
  for (const missing of [{ parameters: null }, { sizeBytes: null }, { contextWindow: null }]) {
    const result = capabilityScore({ parameters: QWEN_27B, sizeBytes: 25_288_065_024, contextWindow: 163840, ...ALL, ...missing });
    assert.equal(result.value, null);
    assert.equal(result.basis, 'incomplete');
  }
  assert.equal(quantizationFidelity(0), null);
  assert.equal(quantizationFidelity(16), 1);
  assert.equal(quantizationFidelity(4), 0.88);
  assert.ok(quantizationFidelity(4.27) > 0.88 && quantizationFidelity(4.27) < 0.94);
});
