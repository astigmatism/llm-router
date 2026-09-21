# Test Plan

The deployed primary catalog uses unrestricted output, unrestricted thinking and template-default effort. Its current policy, context recovery, durable archives and client behavior are defined in [Primary integration](PRIMARY_INTEGRATION.md). Legacy singleton-marker examples below are not primary production defaults.

## Static/local tests

From the repository root:

```bash
npm test
npm run lint:syntax
```

The test suite validates:

- active model marker parsing
- config parsing for the API/admin listener split
- fail-closed model policy
- `keep_alive` normalization
- allowlist behavior
- NDJSON final-usage extraction
- metrics aggregation
- bounded metadata history on disk and in memory, including a sparse 600 MB legacy file, UTF-8 chunk boundaries, corrupt/oversized records, concurrent appends, atomic replacement failures, and abandoned snapshot cleanup
- generation archive age/size eviction, active-journal protection, interrupted records, shared retention ownership, idle sweeps, deletion failure retries, and exclusion of unrelated files and symlinks
- authenticated archive retrieval through concurrent eviction, 404 for pruned records, and admin visibility of cleanup failures without affecting generation
- unauthenticated admin listener access
- legacy same-port admin auth behavior
- Ollama-compatible API pass-through and keep-alive preservation/rewriting behavior
- Responses request/message/tool translation
- Responses `prompt_cache_key` string validation, accepted-but-not-forwarded semantics, non-caching behavior, and raw-value exclusion from responses, backend JSON, request/event history, and persisted logs
- explicit continued rejection of unimplemented adjacent `prompt_cache_options` and deprecated `prompt_cache_retention` fields
- day/night profile-specific reasoning negotiation across native chat/generate and Responses, including nighttime `high`/`xhigh`/`max` → boolean `true`, low/medium, defaults, streaming, and non-streaming
- a strict Ollama 0.32.13-style fake that rejects string `"xhigh"`, while successful Responses return visible reasoning and answer output
- binary reasoning fallback when profile metadata is missing, plus rejection of malformed, incomplete, or inconsistent explicit profiles before Ollama generation
- Responses rewrite-mode forwarding for legacy nighttime, exact active, stable Codex, arbitrary, and omitted identifiers
- streaming and non-streaming forwarding only to the active model, with unchanged Ollama residency and no model-management operation
- strict-mode mismatch rejection independent of permissive or allowlist policy modes
- stable-alias discovery list/detail behavior, unknown-ID and no-active errors
- marker-aware metadata cache invalidation, source precedence, partial enrichment, and ETag revalidation
- conservative modality and validated Responses reasoning metadata
- OpenAI-compatible context-overflow classification, exact-boundary admission, stream/non-stream agreement, no generation forwarding, and discovery reserve metadata
- exact-alias forwarding with broad requested-model rewriting disabled
- proof that `/v1/models` never enumerates the installed `/api/tags` catalog
- non-streaming and SSE text/function-call output
- full-history function-result correlation by `call_id`
- stateless, malformed-input, timeout, incomplete-stream, and cancellation behavior
- regression coverage proving existing `/api/*`, streaming, policy, and admin behavior remains unchanged

## Docker build test

```bash
docker build -t llm-router:test .
```

## Router/API/admin health test

```bash
docker compose --env-file .env up --build -d
curl -fsS http://192.168.1.21:11434/health
curl -fsS http://192.168.1.21:11434/api/version
curl -fsS http://192.168.1.21:11435/admin/api/summary
```

Open the no-token admin portal in a browser:

```text
http://192.168.1.21:11435/
```

Expected:

- `11434` behaves like the Ollama-compatible router API
- `11435` serves the human admin portal without a token
- `/api/*` requests on `11435` do not proxy to Ollama

## Keep-alive policy tests

Set the active marker to the currently prewarmed model.

### Missing keep_alive

```bash
curl -fsS http://192.168.1.21:11434/api/chat \
  -H 'content-type: application/json' \
  -H 'x-client-name: manual-missing-keepalive' \
  -d '{
    "model":"<active-model>",
    "stream":false,
    "messages":[{"role":"user","content":"Reply ok."}]
  }'
```

Expected request history in `http://192.168.1.21:11435/`:

```text
incomingKeepAlive: null/undefined
forwardedKeepAlive: -1
keepAliveNormalized: true
```

Expected raw Ollama:

```bash
docker exec local-ai-llm-legacy-ollama ollama ps
# UNTIL should be Forever
```

### Finite keep_alive

```bash
curl -fsS http://192.168.1.21:11434/api/chat \
  -H 'content-type: application/json' \
  -H 'x-client-name: manual-finite-keepalive' \
  -d '{
    "model":"<active-model>",
    "stream":false,
    "keep_alive":"5m",
    "messages":[{"role":"user","content":"Reply ok."}]
  }'
```

Expected request history:

```text
incomingKeepAlive: 5m
forwardedKeepAlive: -1
keepAliveNormalized: true
```

Expected raw Ollama:

```text
UNTIL Forever
```

## Model mismatch test

```bash
curl -i http://192.168.1.21:11434/api/chat \
  -H 'content-type: application/json' \
  -d '{
    "model":"not-the-active-model:latest",
    "stream":false,
    "messages":[{"role":"user","content":"test"}]
  }'
```

Expected:

```text
HTTP 409
MODEL_NOT_ACTIVE
```

The dashboard's recent rejects/errors panel should show the rejection.

## Streaming test

```bash
curl -N http://192.168.1.21:11434/api/generate \
  -H 'content-type: application/json' \
  -H 'x-client-name: manual-streaming-test' \
  -d '{"model":"<active-model>","prompt":"Count to three."}'
```

Expected:

- client receives streaming chunks
- final request record includes usage fields when Ollama provides them
- latency reflects streaming duration

## Responses API integration smoke test

After deploying the new endpoint, run the text and real tool-cycle smoke test:

```bash
ROUTER_URL=http://192.168.1.21:11434 \
ADMIN_URL=http://192.168.1.21:11435 \
./scripts/responses-smoke-test.sh
```

The script reads the active marker, snapshots `/api/ps`, and explicitly disables
reasoning so the small deterministic output ceilings cannot be consumed by a
profile default. It streams a text response, asks the model to call the harmless
`get_test_value` function, returns `router-smoke-42` as a
`function_call_output`, and verifies that the final answer incorporates it. It
then confirms both the active marker and loaded-model set are unchanged. It
never requests a model pull or switch.

Expected final lines include:

```text
Responses smoke test passed.
Active model remained: <active-model>
Tool result incorporated: ...router-smoke-42...
```

### Exact Codex CLI smoke test

Codex CLI 0.144.3 must be tested with a function call, not only a curl text request:

```bash
ROUTER_URL=http://192.168.1.21:11434 \
./scripts/codex-responses-smoke-test.sh
```

The script uses `--ignore-user-config --ephemeral` and temporary custom-provider command-line overrides, including `wire_api = "responses"`, `requires_openai_auth = false`, `web_search = "disabled"`, and `model_reasoning_effort = "none"`. Nonessential plugins, apps, and multi-agent tools are disabled to keep this single-function smoke deterministic. It asks Codex to use its shell function for a harmless `printf`, verifies both the completed command item and final assistant item in Codex JSONL output, and checks that the active and loaded model snapshots remain identical. It does not modify the user's persistent Codex configuration.

If the script reports an unsupported `web_search` tool, verify the installed Codex version honors `web_search = "disabled"`. The adapter rejects provider-executed tools deliberately rather than silently removing them.

## Admin portal and controls

No token is required on the admin port:

```bash
curl -fsS http://192.168.1.21:11435/
curl -fsS http://192.168.1.21:11435/admin/api/summary
curl -fsS -X POST http://192.168.1.21:11435/admin/api/prewarm
curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"enabled":true}' http://192.168.1.21:11435/admin/api/maintenance
```

For a `llama_cpp` profile, a successful prewarm response confirms one generated
token. It does not expose the raw completion. A readiness failure returns
`BACKEND_NOT_READY`; response overflow, timeout, rejection, and malformed-success
cases fail closed with specific prewarm error codes. The switch workflow must
keep the router drained until this call and its final backend consistency check
both succeed.

While maintenance mode is enabled, `/api/chat` and `/api/generate` on `11434` should return `MAINTENANCE_MODE`, while `/api/version` should still pass through.

Legacy same-port admin APIs still honor `ADMIN_TOKEN` when it is set:

```bash
curl -i http://192.168.1.21:11434/admin/api/summary
curl -fsS -H "X-Admin-Token: $ADMIN_TOKEN" http://192.168.1.21:11434/admin/api/summary
```

The first command should return `401` when `ADMIN_TOKEN` is non-empty; the second should succeed.

## Client migration verification

For each client, send one request and verify:

1. Router request history shows the client.
2. `forwardedKeepAlive` is `-1` for active model generation.
3. Raw Ollama `ollama ps` still shows `Forever`.
4. No request bypasses router history.
5. Clients use `11434`, not the admin portal on `11435`.

## Primary resident integration

`test/model-catalog.test.js` checks canonical discovery, aliases, unknown IDs even with legacy rewrite enabled, all four generation APIs, independent gates, global drain, cancellation during template/tokenization, model-specific boundaries/defaults, unavailable health, and legacy-writer protection. Catalog tests run with the legacy tool policy set to `drop` to ensure unsupported resident tools are still rejected. `integrations/dsh/test-model-discovery.mjs` checks retirement/provisioning and idempotent refresh. Live synthetic probes and controlled outage/restart checks are in `scripts/primary/verify-router.py` and `verify-lifecycle.py`; these deliberately use deployed services and the lifecycle script stops model containers after draining.
