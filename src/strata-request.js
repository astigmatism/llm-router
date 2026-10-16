// Strata v0.1.43 exposes the model's real tokenizer at the Anthropic count route.
// Keep messages in place (including system/developer turns), so its special
// top-level Anthropic billing-header rewrite cannot change an OpenAI prompt.
//
// The count route accepts image blocks but answers a placeholder for them: a
// 1400x900 image costs 1037 prompt tokens at the backend and 63 here. Image
// parts are therefore dropped from the counted text, which keeps the count
// request free of megabytes of base64, and the adapter adds the per-image
// allowance below on top of the text count instead of paying for a prefill.
export const STRATA_VISION_TOKEN_ALLOWANCE = 1050;

const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text']);
const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image']);

// Content that cannot be represented in a count request at all. That is a
// caller or model-profile mismatch, not a backend outage, so the adapter
// reports it as 400 UNSUPPORTED_PROFILE_CAPABILITY rather than extending the
// 503 TOKENIZER_UNAVAILABLE contract that invites client retries.
export class StrataUncountableContentError extends Error {
  constructor(partType, param) {
    super(`Strata token counting cannot represent ${partType || 'untyped'} message content.`);
    this.name = 'StrataUncountableContentError';
    this.partType = partType;
    this.param = param;
  }
}

function countedContent(content, param) {
  if (typeof content === 'string') return { text: content, images: 0 };
  let text = '';
  let images = 0;
  for (const [index, part] of (Array.isArray(content) ? content : []).entries()) {
    const type = part?.type;
    if (TEXT_PART_TYPES.has(type)) {
      text += part.text || '';
      continue;
    }
    if (IMAGE_PART_TYPES.has(type)) {
      images += 1;
      continue;
    }
    throw new StrataUncountableContentError(type, `${param}.content[${index}]`);
  }
  return { text, images };
}

function countedMessage(message, index) {
  const counted = countedContent(message?.content, `messages[${index}]`);
  const attached = Array.isArray(message?.images) ? message.images.length : 0;
  return { text: counted.text, images: counted.images + attached };
}

// Images carried by the prompt being counted. Each one costs projector patch
// tokens the text tokenizer cannot see, so the count is not the whole input.
export function strataVisionImages(messages) {
  let images = 0;
  for (const [index, message] of (Array.isArray(messages) ? messages : []).entries()) {
    images += countedMessage(message, index).images;
  }
  return images;
}

// Measured upper bound of one image on the resident vision model: +1026 tokens
// at 1024x1024, +977 at 1400x900, +986 at 2048x1200, saturating near 1030
// total because the encoder caps the patch grid. A model that publishes
// vision_token_allowance overrides it; publishing 0 removes the allowance once
// the engine counts patch tokens in its own token count.
export function strataVisionTokenAllowance(activeModel) {
  const published = activeModel?.raw?.vision_token_allowance;
  const value = typeof published === 'string' && /^\d+$/.test(published.trim()) ? Number(published.trim()) : published;
  return Number.isSafeInteger(value) && value >= 0 ? value : STRATA_VISION_TOKEN_ALLOWANCE;
}

export function strataCountRequest(messages, controls, model) {
  const converted = messages.map((message, index) => {
    const role = message.role === 'developer' ? 'system' : message.role;
    const content = countedMessage(message, index).text;
    if (role === 'tool') return { role: 'user', content: [{
      type: 'tool_result', tool_use_id: message.tool_call_id, content
    }] };
    if (!message.tool_calls?.length && !message.reasoning_content) return { role, content };
    const blocks = [{ type: 'text', text: content }];
    if (message.reasoning_content) blocks.push({ type: 'thinking', thinking: message.reasoning_content });
    for (const call of message.tool_calls || []) {
      // Strata's two frontends accept the same raw argument string/object.
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: call.function.arguments });
    }
    return { role, content: blocks };
  });
  const kwargs = controls.chat_template_kwargs || {};
  const effort = kwargs.reasoning_effort || controls.reasoning_effort;
  return {
    model, messages: converted,
    thinking: { type: kwargs.enable_thinking === false || effort === 'none' ? 'disabled' : 'enabled' },
    ...(effort && effort !== 'none' ? { output_config: { effort } } : {}),
    ...(controls.tools ? { tools: controls.tools.map(({ function: fn }) => ({
      name: fn.name, description: fn.description || '', input_schema: fn.parameters || {}
    })) } : {})
  };
}
