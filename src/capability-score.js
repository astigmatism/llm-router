// A deterministic, fully automatic capability score for one resident model.
//
// It ranks models within this router: higher means more capable. Every input
// is published, verified fact. Model size, quantization and file size come
// from the running llama.cpp process; context, modalities, tools and reasoning
// come from the catalog. Nothing is inferred from a model's name. Availability,
// load and speed never affect it, so the score changes only when the model or
// its configuration changes.
//
// Known limits: it cannot measure how well a model actually performs. In
// particular it cannot weigh a fine-tune or abliteration against its base, or
// a mixture-of-experts model (total parameters) against a dense one.

export const CAPABILITY_SCORE_VERSION = 1;

const SIZE_POINTS = 55;       // 1B parameters scores 0, 1T scores the maximum (log10 scale)
const CONTEXT_POINTS = 25;    // 4K scores 0, 256K or more scores the maximum (log2 scale)
const FEATURE_POINTS = { vision: 7, tools: 7, reasoning: 6 };

// Fraction of model quality retained at a given effective bits per weight.
// Piecewise linear between points; 8 bits and above is treated as lossless.
const FIDELITY = [[2, 0.5], [3, 0.75], [4, 0.88], [5, 0.94], [6, 0.97], [8, 1]];

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const round1 = (value) => Math.round(value * 10) / 10;

export function quantizationFidelity(bitsPerWeight) {
  if (!Number.isFinite(bitsPerWeight) || bitsPerWeight <= 0) return null;
  if (bitsPerWeight >= FIDELITY.at(-1)[0]) return 1;
  if (bitsPerWeight <= FIDELITY[0][0]) return FIDELITY[0][1] * (bitsPerWeight / FIDELITY[0][0]);
  for (let index = 1; index < FIDELITY.length; index += 1) {
    const [highBits, highFidelity] = FIDELITY[index];
    const [lowBits, lowFidelity] = FIDELITY[index - 1];
    if (bitsPerWeight <= highBits) {
      return lowFidelity + (highFidelity - lowFidelity) * ((bitsPerWeight - lowBits) / (highBits - lowBits));
    }
  }
  return 1;
}

// Inputs: parameters and sizeBytes from the running model; contextWindow per
// request; boolean vision/tools/reasoning. Returns the public score object.
export function capabilityScore({ parameters, sizeBytes, contextWindow, vision, tools, reasoning }) {
  const bitsPerWeight = Number.isSafeInteger(parameters) && parameters > 0 && Number.isSafeInteger(sizeBytes) && sizeBytes > 0
    ? round1((sizeBytes * 8) / parameters)
    : null;
  const fidelity = bitsPerWeight === null ? null : quantizationFidelity(bitsPerWeight);
  const size = Number.isSafeInteger(parameters) && parameters > 0 && fidelity !== null
    ? round1(SIZE_POINTS * clamp01(Math.log10(parameters / 1e9) / 3) * fidelity)
    : null;
  const context = Number.isSafeInteger(contextWindow) && contextWindow > 0
    ? round1(CONTEXT_POINTS * clamp01(Math.log2(contextWindow / 4096) / 6))
    : null;
  const features = round1((vision === true ? FEATURE_POINTS.vision : 0)
    + (tools === true ? FEATURE_POINTS.tools : 0)
    + (reasoning === true ? FEATURE_POINTS.reasoning : 0));
  const complete = size !== null && context !== null;
  return {
    value: complete ? round1(size + context + features) : null,
    version: CAPABILITY_SCORE_VERSION,
    basis: complete ? 'computed' : 'incomplete',
    components: { size, context, features },
    inputs: {
      parameters: Number.isSafeInteger(parameters) ? parameters : null,
      bits_per_weight: bitsPerWeight,
      context_window: Number.isSafeInteger(contextWindow) ? contextWindow : null,
      vision: vision === true,
      tools: tools === true,
      reasoning: reasoning === true
    }
  };
}
