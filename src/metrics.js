function increment(map, key, amount = 1) {
  const safeKey = key || 'unknown';
  map[safeKey] = (map[safeKey] || 0) + amount;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue / 100 * sorted.length) - 1));
  return sorted[index];
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export class Metrics {
  constructor(sampleLimit = 2000) {
    this.sampleLimit = sampleLimit;
    this.startedAt = new Date().toISOString();
    this.totalRequests = 0;
    this.allowedRequests = 0;
    this.rejectedRequests = 0;
    this.keepAliveNormalizations = 0;
    this.upstreamErrors = 0;
    this.byEndpoint = {};
    this.byModel = {};
    this.tokensByModel = {};
    this.byClient = {};
    this.byStatus = {};
    this.latencyMsSamples = [];
    this.ttftMsSamples = [];
    this.queueWaitMsSamples = [];
    this.tokenRateSamples = [];
    this.streamingDurationMsSamples = [];
    this.evalTokensPerSecondSamples = [];
    this.promptTokensPerSecondSamples = [];
    this.promptTokens = 0;
    this.outputTokens = 0;
    this.totalDurationNs = 0;
    this.evalDurationNs = 0;
    this.promptEvalDurationNs = 0;
  }

  recordRequest(record) {
    this.totalRequests += 1;
    if (record.allowed) this.allowedRequests += 1;
    if (record.rejected) this.rejectedRequests += 1;
    if (record.keepAliveNormalized) this.keepAliveNormalizations += 1;
    if (record.upstreamError) this.upstreamErrors += 1;
    increment(this.byEndpoint, `${record.method || 'UNKNOWN'} ${record.endpoint || 'unknown'}`);
    increment(this.byModel, record.forwardedModel || record.activeModel || record.requestedModel || 'none');
    increment(this.byClient, record.clientIdentity || record.sourceIp || 'unknown');
    increment(this.byStatus, String(record.responseStatus || record.status || 'unknown'));
    if (Number.isFinite(record.latencyMs)) this.#pushSample(this.latencyMsSamples, record.latencyMs);
    if (record.streaming && Number.isFinite(record.latencyMs)) this.#pushSample(this.streamingDurationMsSamples, record.latencyMs);
    if (Number.isFinite(record.ttftMs)) this.#pushSample(this.ttftMsSamples, record.ttftMs);
    if (Number.isFinite(record.queueWaitMs) && record.queueWaitMs > 0) this.#pushSample(this.queueWaitMsSamples, record.queueWaitMs);
    // The router's own generation rate: output tokens over the time the client
    // actually waited for them. The backend reports no timing of its own here,
    // so this is the only tokens/second figure this router can honestly show.
    const rate = this.constructor.#outputRate(record);
    if (rate !== null) this.#pushSample(this.tokenRateSamples, rate);

    const usage = record.usage;
    if (usage && typeof usage === 'object') {
      const prompt = usage.prompt_eval_count ?? usage.prompt_tokens ?? usage.input_tokens;
      const output = usage.eval_count ?? usage.completion_tokens ?? usage.output_tokens;
      const model = record.forwardedModel || record.activeModel || record.requestedModel || 'none';
      const totals = this.tokensByModel[model] ||= { prompt: 0, output: 0 };
      if (Number.isFinite(prompt)) { this.promptTokens += prompt; totals.prompt += prompt; }
      if (Number.isFinite(output)) { this.outputTokens += output; totals.output += output; }
      if (Number.isFinite(usage.total_duration)) this.totalDurationNs += usage.total_duration;
      if (Number.isFinite(usage.eval_duration)) this.evalDurationNs += usage.eval_duration;
      if (Number.isFinite(usage.prompt_eval_duration)) this.promptEvalDurationNs += usage.prompt_eval_duration;
      if (Number.isFinite(usage.eval_tokens_per_second)) this.#pushSample(this.evalTokensPerSecondSamples, usage.eval_tokens_per_second);
      if (Number.isFinite(usage.prompt_tokens_per_second)) this.#pushSample(this.promptTokensPerSecondSamples, usage.prompt_tokens_per_second);
    }
  }

  rebuild(records) {
    const fresh = new Metrics(this.sampleLimit);
    fresh.startedAt = this.startedAt;
    for (const record of records) fresh.recordRequest(record);
    Object.assign(this, fresh);
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      totalRequests: this.totalRequests,
      allowedRequests: this.allowedRequests,
      rejectedRequests: this.rejectedRequests,
      keepAliveNormalizations: this.keepAliveNormalizations,
      upstreamErrors: this.upstreamErrors,
      byEndpoint: this.byEndpoint,
      byModel: this.byModel,
      tokensByModel: this.tokensByModel,
      byClient: this.byClient,
      byStatus: this.byStatus,
      latencyMs: {
        avg: average(this.latencyMsSamples),
        p50: percentile(this.latencyMsSamples, 50),
        p95: percentile(this.latencyMsSamples, 95),
        p99: percentile(this.latencyMsSamples, 99),
        samples: this.latencyMsSamples.length
      },
      streamingDurationMs: {
        avg: average(this.streamingDurationMsSamples),
        p50: percentile(this.streamingDurationMsSamples, 50),
        p95: percentile(this.streamingDurationMsSamples, 95),
        samples: this.streamingDurationMsSamples.length
      },
      tokens: {
        prompt: this.promptTokens,
        output: this.outputTokens
      },
      durationsNs: {
        total: this.totalDurationNs,
        eval: this.evalDurationNs,
        promptEval: this.promptEvalDurationNs
      },
      ttftMs: {
        avg: average(this.ttftMsSamples),
        p50: percentile(this.ttftMsSamples, 50),
        p95: percentile(this.ttftMsSamples, 95),
        samples: this.ttftMsSamples.length
      },
      queueWaitMs: {
        avg: average(this.queueWaitMsSamples),
        p95: percentile(this.queueWaitMsSamples, 95),
        max: this.queueWaitMsSamples.length ? Math.max(...this.queueWaitMsSamples) : null,
        samples: this.queueWaitMsSamples.length
      },
      tokensPerSecond: {
        avg: average(this.tokenRateSamples),
        p50: percentile(this.tokenRateSamples, 50),
        p95: percentile(this.tokenRateSamples, 95),
        samples: this.tokenRateSamples.length
      },
      throughput: {
        evalTokensPerSecondAvg: average(this.evalTokensPerSecondSamples),
        promptTokensPerSecondAvg: average(this.promptTokensPerSecondSamples),
        evalSamples: this.evalTokensPerSecondSamples.length,
        promptSamples: this.promptTokensPerSecondSamples.length
      }
    };
  }

  // A rate is only meaningful once the first token has been delivered; before
  // that the wait is prompt evaluation, not generation.
  static #outputRate(record) {
    const output = record.usage?.eval_count ?? record.usage?.completion_tokens ?? record.usage?.output_tokens;
    if (!Number.isFinite(output) || output <= 0 || !Number.isFinite(record.latencyMs)) return null;
    const generationMs = record.latencyMs - (Number.isFinite(record.ttftMs) ? record.ttftMs : 0);
    if (generationMs < 250) return null;
    return Number((output / (generationMs / 1000)).toFixed(2));
  }

  #pushSample(list, value) {
    list.push(value);
    if (list.length > this.sampleLimit) list.splice(0, list.length - this.sampleLimit);
  }
}
