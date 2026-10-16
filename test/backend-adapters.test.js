import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  BackendAdapterError,
  LlamaCppBackendAdapter,
  normalizeLlamaReasoningRequest,
  normalizeOpenAiSseModel,
  normalizeOutputLimit,
  openAiCompletionToOllama,
  openAiSseToOllamaStream,
  enforcedContextSafetyReserve,
  isLlamaWireKind,
  llamaModelDetails,
  messagesForLlama,
  resolveBackendAdapter,
  StrataBackendAdapter,
  SUPPORTED_BACKEND_KINDS
} from '../src/backend-adapters.js';

const nonReasoningLlamaModel = {
  backend_kind: 'llama_cpp',
  model: 'adapter-unit-model',
  default_output_tokens: 512,
  max_output_tokens: 4096,
  capability_profile: { reasoning: false, tools: false, vision: false }
};

function prepareResponsesTemperature(options) {
  const adapter = new LlamaCppBackendAdapter({}, nonReasoningLlamaModel);
  return adapter.prepareResponses({
    originalBody: { input: 'adapter unit input' },
    upstreamBody: {
      messages: [{ role: 'user', content: 'adapter unit input' }],
      ...(options === undefined ? {} : { options })
    },
    stream: false
  });
}

const reasoningModel = {
  default_output_tokens: 512,
  max_output_tokens: 4096,
  reasoning_policy: {
    schema_version: 1,
    kind: 'llama_cpp_template_budgeted',
    mapping_kind: 'native_low_medium_high_local_max',
    default_level: 'off',
    public_levels: ['off', 'none', 'low', 'medium', 'high', 'max'],
    aliases: { none: 'off', minimal: 'low', xhigh: 'max' },
    boolean_true_behavior: { mode: 'reject' },
    output_limit_policy: 'cap',
    reasoning_format: 'deepseek',
    answer_reserve: 1024,
    levels: {
      off: { enabled: false, default_output_tokens: 512, max_output_tokens: 4096 },
      low: { enabled: true, template_effort: 'low', reasoning_budget_tokens: 512, default_output_tokens: 1536, max_output_tokens: 1536 },
      medium: { enabled: true, template_effort: 'medium', reasoning_budget_tokens: 2048, default_output_tokens: 3072, max_output_tokens: 3072 },
      high: { enabled: true, template_effort: 'high', reasoning_budget_tokens: 8192, default_output_tokens: 9216, max_output_tokens: 9216 },
      max: { enabled: true, template_effort: 'high', reasoning_budget_tokens: -1, default_output_tokens: 16384, max_output_tokens: 16384 }
    }
  }
};

async function streamText(stream) {
  return await new Response(stream).text();
}

test('llama.cpp Responses adapter omits temperature when the translated request omits it', () => {
  const prepared = prepareResponsesTemperature(undefined);
  assert.equal(Object.hasOwn(prepared.body, 'temperature'), false);
  assert.equal(prepared.temperatureForwarding, 'omitted_for_backend_default');
  assert.equal(Object.hasOwn(prepared, 'forwardedTemperature'), false);
});

test('llama.cpp Responses adapter preserves explicit temperature zero', () => {
  const prepared = prepareResponsesTemperature({ temperature: 0 });
  assert.equal(prepared.body.temperature, 0);
  assert.equal(prepared.temperatureForwarding, 'explicit');
  assert.equal(prepared.forwardedTemperature, 0);
});

test('llama.cpp Responses adapter preserves explicit finite temperatures', () => {
  for (const value of [1.0, 0.37]) {
    const prepared = prepareResponsesTemperature({ temperature: value });
    assert.equal(prepared.body.temperature, value);
    assert.equal(prepared.forwardedTemperature, value);
  }
});

function prepareResponsesSampling(originalFields) {
  const adapter = new LlamaCppBackendAdapter({}, nonReasoningLlamaModel);
  return adapter.prepareResponses({
    originalBody: { input: 'adapter unit input', ...originalFields },
    upstreamBody: { messages: [{ role: 'user', content: 'adapter unit input' }] },
    stream: false
  });
}

test('llama.cpp Responses adapter forwards validated top-level seed, stop, and sampling fields', () => {
  const prepared = prepareResponsesSampling({ seed: 9, stop: 'DONE', top_k: 12, repeat_penalty: 1.1 });
  assert.equal(prepared.body.seed, 9);
  assert.deepEqual(prepared.body.stop, ['DONE']);
  assert.equal(prepared.body.top_k, 12);
  assert.equal(prepared.body.repeat_penalty, 1.1);
  assert.deepEqual(prepared.samplingControls, ['repeat_penalty', 'seed', 'stop', 'top_k']);
  assert.equal(prepared.seedForwarded, true);

  const random = prepareResponsesSampling({ seed: -1 });
  assert.equal(Object.hasOwn(random.body, 'seed'), false);
  assert.equal(random.seedForwarded, false);
  assert.deepEqual(random.samplingAcceptedAsDefault, ['seed']);

  const omitted = prepareResponsesSampling({});
  assert.deepEqual(omitted.samplingControls, []);
  assert.equal(omitted.seedForwarded, false);
});

test('llama.cpp Responses adapter rejects invalid sampling and Ollama options objects', () => {
  for (const [fields, code, param] of [
    [{ seed: 4294967296 }, 'INVALID_SAMPLING_OPTION', 'seed'],
    [{ stop: [1] }, 'INVALID_SAMPLING_OPTION', 'stop'],
    [{ tfs_z: 0.5 }, 'UNSUPPORTED_SAMPLING_OPTION', 'tfs_z'],
    [{ options: { seed: 1 } }, 'UNSUPPORTED_OPTION', 'options']
  ]) {
    assert.throws(
      () => prepareResponsesSampling(fields),
      (error) => error instanceof BackendAdapterError
        && error.statusCode === 400
        && error.code === code
        && error.param === param,
      JSON.stringify(fields)
    );
  }
});

test('normalizes bounded output limits without changing Ollama profiles globally', () => {
  const marker = { default_output_tokens: 512, max_output_tokens: 4096 };
  assert.equal(normalizeOutputLimit({}, marker), 512);
  assert.equal(normalizeOutputLimit({ max_completion_tokens: 128 }, marker), 128);
  assert.throws(
    () => normalizeOutputLimit({ max_tokens: 64, max_completion_tokens: 65 }, marker),
    (error) => error instanceof BackendAdapterError && error.code === 'CONFLICTING_OUTPUT_LIMITS'
  );
  assert.throws(
    () => normalizeOutputLimit({ max_tokens: 4097 }, marker),
    (error) => error instanceof BackendAdapterError && error.code === 'OUTPUT_LIMIT_EXCEEDED'
  );
});

test('normalizes native template efforts and local reasoning budgets after removing caller controls', () => {
  const off = normalizeLlamaReasoningRequest({ max_tokens: 32 }, reasoningModel, 'openai-chat');
  assert.equal(off.level, 'off');
  assert.deepEqual(off.controls, { chat_template_kwargs: { enable_thinking: false } });

  const low = normalizeLlamaReasoningRequest({ reasoning_effort: 'low', max_tokens: 1536 }, reasoningModel, 'openai-chat');
  assert.equal(low.level, 'low');
  assert.equal(low.controls.reasoning_effort, 'low');
  assert.equal(low.controls.reasoning_budget_tokens, 512);
  assert.equal(Object.hasOwn(low.cleanBody, 'reasoning_effort'), false);

  const high = normalizeLlamaReasoningRequest({ think: 'high', options: { num_predict: 9216 } }, reasoningModel, 'native-chat');
  assert.equal(high.controls.reasoning_effort, 'high');
  assert.equal(high.controls.reasoning_budget_tokens, 8192);

  const max = normalizeLlamaReasoningRequest({ reasoning: { effort: 'max' }, max_output_tokens: 16384 }, reasoningModel, 'responses');
  assert.equal(max.controls.reasoning_effort, 'high');
  assert.equal(Object.hasOwn(max.controls, 'reasoning_budget_tokens'), false);
});

test('normalizes Open WebUI boolean compatibility input and xhigh through the active marker', () => {
  const normalized = normalizeLlamaReasoningRequest({
    think: true,
    options: { reasoning_effort: 'xhigh', num_predict: 32768 }
  }, reasoningModel, 'native-chat');

  assert.equal(normalized.level, 'max');
  assert.equal(normalized.outputTokens, 16384);
  assert.equal(normalized.requestedOutputTokens, 32768);
  assert.equal(normalized.outputLimitCapped, true);
  assert.equal(normalized.controls.reasoning_effort, 'high');
  assert.equal(Object.hasOwn(normalized.cleanBody.options, 'reasoning_effort'), false);
});

test('rejects a named enabled effort when native think explicitly disables reasoning', () => {
  assert.throws(
    () => normalizeLlamaReasoningRequest({
      think: false,
      options: { reasoning_effort: 'high', num_predict: 9216 }
    }, reasoningModel, 'native-chat'),
    (error) => error instanceof BackendAdapterError
      && error.statusCode === 400
      && error.code === 'CONFLICTING_REASONING_EFFORT'
  );
});

test('caps output limits downward only and supports marker-configured strict rejection', () => {
  const below = normalizeLlamaReasoningRequest({
    think: 'max', options: { num_predict: 12000 }
  }, reasoningModel, 'native-chat');
  assert.equal(below.outputTokens, 12000);
  assert.equal(below.outputLimitCapped, false);

  const capped = normalizeLlamaReasoningRequest({
    think: 'max', options: { num_predict: 32768 }
  }, reasoningModel, 'native-chat');
  assert.equal(capped.outputTokens, 16384);
  assert.equal(capped.outputLimitCapped, true);

  const strictModel = JSON.parse(JSON.stringify(reasoningModel));
  strictModel.reasoning_policy.output_limit_policy = 'reject';
  assert.throws(
    () => normalizeLlamaReasoningRequest({
      think: 'max', options: { num_predict: 32768 }
    }, strictModel, 'native-chat'),
    (error) => error instanceof BackendAdapterError
      && error.statusCode === 400
      && error.code === 'OUTPUT_LIMIT_EXCEEDED'
  );
});

test('uses a synthetic non-Qwen marker policy without model-name inference', () => {
  const syntheticModel = {
    model: 'orion-reasoner-synthetic',
    default_output_tokens: 111,
    max_output_tokens: 2222,
    reasoning_policy: {
      schema_version: 1,
      default_level: 'off',
      aliases: { none: 'off', xhigh: 'deep' },
      boolean_true_behavior: { mode: 'map', level: 'deep' },
      output_limit_policy: 'cap',
      answer_reserve: 100,
      reasoning_format: 'none',
      levels: {
        off: { enabled: false, default_output_tokens: 111, max_output_tokens: 444 },
        deep: {
          enabled: true,
          template_effort: 'medium',
          reasoning_budget_tokens: 500,
          default_output_tokens: 777,
          max_output_tokens: 2222
        }
      }
    }
  };

  const normalized = normalizeLlamaReasoningRequest({
    think: true, options: { num_predict: 9000 }
  }, syntheticModel, 'native-chat');
  assert.equal(normalized.level, 'deep');
  assert.equal(normalized.outputTokens, 2222);
  assert.equal(normalized.controls.reasoning_effort, 'medium');
  assert.equal(normalized.controls.reasoning_budget_tokens, 500);
});

test('converts llama.cpp non-streaming responses to native chat and generate shapes', () => {
  const openai = {
    model: 'physical',
    choices: [{ message: { role: 'assistant', content: 'adapter ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3 }
  };
  const chat = openAiCompletionToOllama(openai, { kind: 'native-chat', model: 'pinned' });
  assert.equal(chat.model, 'pinned');
  assert.equal(chat.message.content, 'adapter ok');
  assert.equal(chat.prompt_eval_count, 7);
  assert.equal(chat.eval_count, 3);
  const generate = openAiCompletionToOllama(openai, { kind: 'native-generate', model: 'pinned' });
  assert.equal(generate.response, 'adapter ok');
  assert.equal(generate.message, undefined);
});

test('keeps parsed llama.cpp reasoning separate from visible native chat content', () => {
  const openai = {
    model: 'physical',
    choices: [{ message: { role: 'assistant', reasoning_content: 'private trace', content: 'visible answer' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 8 }
  };
  const chat = openAiCompletionToOllama(openai, { kind: 'native-chat', model: 'pinned' });
  assert.equal(chat.message.thinking, 'private trace');
  assert.equal(chat.message.content, 'visible answer');
  assert.equal(chat.response, undefined);
});

test('converts chunked SSE including a final partial line to Ollama NDJSON', async () => {
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"model":"wrong","choices":[{"delta":{"content":"hel"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"model":"wrong","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]'));
      controller.close();
    }
  });
  const text = await streamText(openAiSseToOllamaStream(input, { kind: 'native-chat', model: 'pinned' }));
  const lines = text.trim().split('\n').map(JSON.parse);
  assert.equal(lines.map((line) => line.message.content).join(''), 'hello');
  assert.equal(lines.at(-1).done, true);
  assert.equal(lines.at(-1).model, 'pinned');
});

test('waits for a streaming usage trailer before emitting the final Ollama object', async () => {
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"model":"wrong","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
      ));
      controller.enqueue(new TextEncoder().encode(
        'data: {"model":"wrong","choices":[],"usage":{"prompt_tokens":37,"completion_tokens":5,"total_tokens":42}}\n\n'
      ));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  const text = await streamText(openAiSseToOllamaStream(input, { kind: 'native-chat', model: 'pinned' }));
  const lines = text.trim().split('\n').map(JSON.parse);
  assert.equal(lines.filter((line) => line.done).length, 1);
  assert.equal(lines.at(-1).done_reason, 'stop');
  assert.equal(lines.at(-1).prompt_eval_count, 37);
  assert.equal(lines.at(-1).eval_count, 5);
});

test('reports the backend kinds the router can serve', () => {
  assert.deepEqual(SUPPORTED_BACKEND_KINDS, ['ollama', 'llama_cpp', 'strata']);
  assert.equal(isLlamaWireKind('llama_cpp'), true);
  assert.equal(isLlamaWireKind('strata'), true);
  assert.equal(isLlamaWireKind('ollama'), false);
  assert.equal(isLlamaWireKind(undefined), false);
  assert.equal(isLlamaWireKind('mistral'), false);
});

test('resolves Strata catalogs to the inherited llama.cpp wire adapter', () => {
  const strata = resolveBackendAdapter({}, { backend_kind: 'strata', model: 'strata-model' });
  assert.ok(strata instanceof StrataBackendAdapter);
  assert.ok(strata instanceof LlamaCppBackendAdapter);
  assert.equal(strata.kind, 'strata');
  assert.equal(resolveBackendAdapter({}, { backend_kind: 'llama_cpp', model: 'model' }).kind, 'llama_cpp');
  assert.equal(resolveBackendAdapter({}, { model: 'model' }).kind, 'ollama');
  assert.throws(
    () => resolveBackendAdapter({}, { backend_kind: 'mistral', model: 'model' }),
    (error) => error instanceof BackendAdapterError
      && error.statusCode === 503
      && error.code === 'INVALID_BACKEND_KIND'
      && /Unsupported active backend kind: mistral/.test(error.message)
  );
});

test('applies the llama.cpp wire contract to Strata models', () => {
  assert.equal(enforcedContextSafetyReserve({ backend_kind: 'strata', model: 'strata-model' }), 1024);
  assert.equal(enforcedContextSafetyReserve({ backend_kind: 'strata', model: 'strata-model', context_safety_reserve: 2048 }), 2048);
  assert.equal(enforcedContextSafetyReserve({ backend_kind: 'llama_cpp', model: 'model' }), 1024);
  assert.equal(enforcedContextSafetyReserve({ backend_kind: 'ollama', model: 'model' }), null);
  assert.equal(llamaModelDetails({ backend_kind: 'strata', raw: {} }, null, 'strata').backend, 'strata');
  assert.equal(llamaModelDetails({ backend_kind: 'llama_cpp', raw: {} }, null, 'llama_cpp').backend, 'llama_cpp');
});

test('normalizes model identity in OpenAI streaming frames', async () => {
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"model":"wrong","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":96}},"timings":{"cache_n":96,"prompt_n":4}}\n\ndata: [DONE]\n\n'));
      controller.close();
    }
  });
  const text = await streamText(normalizeOpenAiSseModel(input, 'pinned'));
  assert.match(text, /"model":"pinned"/);
  assert.match(text, /"cache_n":96/);
  assert.match(text, /"cached_tokens":96/);
  assert.match(text, /data: \[DONE\]/);
  assert.doesNotMatch(text, /"model":"wrong"/);
});

// --- Strata multimodal token counting -------------------------------------
// Strata counts the formatted prompt at its Anthropic route, which answers a
// placeholder for image blocks. The adapter must add the projector cost itself
// without ever paying for a generation (Strata ignores zero-generation prefill).

function createFakeStrataCount(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    requests.push({
      pathname: new URL(request.url || '/', 'http://fake-strata.local').pathname,
      body: raw.trim() ? JSON.parse(raw) : null
    });
    const { status, payload } = handler(requests.at(-1).body);
    const out = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': out.length });
    response.end(out);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise((done) => server.close(done))
    }));
  });
}

const strataVisionModel = {
  backend_kind: 'strata',
  model: 'strata-vision-model',
  context_length: 4096,
  capability_profile: { text: true, vision: true }
};

function strataAdapter(fake, activeModel = strataVisionModel) {
  return new StrataBackendAdapter({ upstreamUrl: fake.url, upstreamTimeoutMs: 5000 }, activeModel);
}

const imagePart = { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(4096)}` } };

async function withStrataCount(handler, run) {
  const fake = await createFakeStrataCount(handler);
  try {
    return await run(fake);
  } finally {
    await fake.close();
  }
}

test('Strata multimodal count adds the vision allowance and keeps image data out of the count request', async () => {
  await withStrataCount(() => ({ status: 200, payload: { input_tokens: 60 } }), async (fake) => {
    const context = await strataAdapter(fake).validateContext(
      [{ role: 'user', content: [{ type: 'text', text: 'Describe' }, imagePart] }], 128, {});
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].pathname, '/v1/messages/count_tokens');
    assert.equal(fake.requests[0].body.messages[0].content, 'Describe');
    assert.equal(JSON.stringify(fake.requests[0].body).includes('data:image'), false);
    assert.equal(context.inputTokens, 60 + 1050);
    assert.equal(context.availableTokens, 4096 - (60 + 1050) - 1024);
  });
});

test('Strata text-only count is unchanged by the vision allowance', async () => {
  await withStrataCount(() => ({ status: 200, payload: { input_tokens: 60 } }), async (fake) => {
    const context = await strataAdapter(fake).validateContext(
      [{ role: 'user', content: [{ type: 'text', text: 'Plain' }] }], 128, {});
    assert.equal(context.inputTokens, 60);
    assert.equal(context.availableTokens, 4096 - 60 - 1024);
  });
});

test('Strata counts every image in the history, including earlier turns', async () => {
  await withStrataCount(() => ({ status: 200, payload: { input_tokens: 60 } }), async (fake) => {
    const context = await strataAdapter(fake).validateContext([
      { role: 'user', content: [{ type: 'text', text: 'first' }, imagePart] },
      { role: 'assistant', content: 'seen' },
      { role: 'user', content: [{ type: 'text', text: 'second' }, imagePart] },
      { role: 'user', content: 'now answer in text' }
    ], 128, {});
    assert.equal(context.inputTokens, 60 + 2 * 1050);
  });
});

test('Strata image overflow is a context error, not a tokenizer outage', async () => {
  const tight = { ...strataVisionModel, context_length: 2048 };
  await withStrataCount(() => ({ status: 200, payload: { input_tokens: 60 } }), async (fake) => {
    await assert.rejects(
      () => strataAdapter(fake, tight).validateContext(
        [{ role: 'user', content: [{ type: 'text', text: 'big' }, imagePart] }], null, {}),
      (error) => error instanceof BackendAdapterError
        && error.statusCode === 400
        && error.code === 'context_length_exceeded'
        && /Formatted input \(1110\)/.test(error.message)
    );
  });
});

test('Strata honours a published vision allowance on the active model', async () => {
  const model = { ...strataVisionModel, raw: { vision_token_allowance: 2000 } };
  await withStrataCount(() => ({ status: 200, payload: { input_tokens: 60 } }), async (fake) => {
    const context = await strataAdapter(fake, model).validateContext(
      [{ role: 'user', content: [{ type: 'text', text: 'Describe' }, imagePart] }], 128, {});
    assert.equal(context.inputTokens, 60 + 2000);
  });
});

test('Strata reports an unrepresentable part as a capability error without calling the count route', async () => {
  await withStrataCount(() => ({ status: 200, payload: { input_tokens: 60 } }), async (fake) => {
    await assert.rejects(
      () => strataAdapter(fake).validateContext(
        [{ role: 'user', content: [{ type: 'text', text: 'hear this' }, { type: 'audio' }] }], 128, {}),
      (error) => error instanceof BackendAdapterError
        && error.statusCode === 400
        && error.code === 'UNSUPPORTED_PROFILE_CAPABILITY'
        && error.param === 'messages[0].content[1]'
    );
    assert.equal(fake.requests.length, 0);
  });
});

test('Strata keeps a failed or invalid count a 503 tokenizer outage', async () => {
  for (const failure of [
    { status: 500, payload: { error: { message: 'tokenizer is reloading' } } },
    { status: 200, payload: { input_tokens: 'not-a-count' } }
  ]) {
    await withStrataCount(() => failure, async (fake) => {
      await assert.rejects(
        () => strataAdapter(fake).validateContext([{ role: 'user', content: 'hi' }], 128, {}),
        (error) => error instanceof BackendAdapterError
          && error.statusCode === 503
          && error.code === 'TOKENIZER_UNAVAILABLE'
      );
    });
  }
});

// Native `messages[].images` carries bare base64 because Ollama's native endpoint wants it that
// way. The OpenAI chat wire rejects bare base64 outright, so the adapter must re-attach a data URL.
test('Native images[] become data URLs on the OpenAI chat wire', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUg';
  const [message] = messagesForLlama(
    [{ role: 'user', content: 'what is this?', images: [png] }], 'openai-chat', true);
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.content[0].text, 'what is this?');
  assert.equal(message.content[1].type, 'image_url');
  assert.equal(message.content[1].image_url.url, `data:image/png;base64,${png}`);
});

test('The re-attached media type comes from the image bytes, since the declared subtype was lost', () => {
  const cases = [
    ['/9j/4AAQSkZJRg', 'image/jpeg'],
    ['R0lGODlhAQABAIAA', 'image/gif'],
    ['UklGRhoAAABXRUtMQVJBTVgA', 'image/webp'],
    ['Qk02AAAAAAAAADYA', 'image/bmp'],
    ['iVBORw0KGgoAAAANSUhEUg', 'image/png'],
    ['unknownbase64data', 'image/png']
  ];
  for (const [base64, mediaType] of cases) {
    const [message] = messagesForLlama([{ role: 'user', images: [base64] }], 'openai-chat', true);
    assert.equal(message.content[0].image_url.url, `data:${mediaType};base64,${base64}`);
  }
});

test('An images[] entry that is already a data URL is passed through unchanged', () => {
  const url = 'data:image/jpeg;base64,/9j/4AAQSkZJRg';
  const [message] = messagesForLlama([{ role: 'user', images: [url] }], 'openai-chat', true);
  assert.equal(message.content[0].image_url.url, url);
});
