> Primary integration adds `src/model-catalog.js`: one atomic schema-v3 marker, canonical entries plus deliberate aliases, and a selected snapshot retained through every request. RequestGate counts leases by upstream identity and keeps global drain accounting. Legacy single-marker behavior below remains available for explicit recovery. See [Primary integration](PRIMARY_INTEGRATION.md).

The deployed primary catalog uses unrestricted output, unrestricted thinking and template-default effort. Its current policy, context recovery, durable archives and client behavior are defined in [Primary integration](PRIMARY_INTEGRATION.md). Legacy singleton-marker examples below are not primary production defaults.

# Architecture

## Goal

LLM Router exposes OpenAI-compatible and Ollama-compatible APIs to clients. Production uses two resident llama.cpp servers; the legacy Ollama backend remains supported. The runtime controller owns model loading and catalog publication.

```text
OpenWebUI -----------\
ComfyUI -------------+--> llm-router --> llama.cpp (production)
                    |              \-> Ollama (legacy)
voice assistant -----/
local AI apps -------/
```

## Legacy Ollama keep-alive policy

For the active deployed model, every request that can refresh or load model state is forwarded with:

```json
{"keep_alive": -1}
```

This is enforced at the router so individual clients do not need to remember or respect the setting.

## Components

### HTTP router

`src/server.js` owns the Node.js HTTP servers, route dispatch, admin endpoints, and Ollama-compatible proxy path. It starts two listeners by default: the Ollama-compatible API listener on `PORT` (`11434`) and the separate human admin listener on `ADMIN_PORT` (`11435`).

`src/responses-api.js` owns the isolated OpenAI Responses compatibility path. `/v1/responses` and `/responses` are dispatched before the generic `/api/*` proxy, translated through the selected backend adapter (llama.cpp Chat Completions or Ollama `/api/chat`), and validated against the active marker/catalog. The module honors `REWRITE_REQUESTED_MODEL_TO_ACTIVE` for client-name compatibility but does not call the legacy proxy-policy evaluator: permissive and allowlist settings cannot change the single marker-model upstream target.

Responses accepts the documented optional `prompt_cache_key` string as a compatibility hint. Its value is validated and then removed before response construction and backend-policy processing. It is never forwarded to Ollama or llama.cpp, does not choose a model or slot, and is not a router response-cache key; backend prompt-prefix/KV reuse remains authoritative. Request telemetry records only presence and the `accepted_ignored` disposition. `prompt_cache_options` and deprecated `prompt_cache_retention` remain unsupported unless separately implemented against proven backend semantics.

### Policy engine

`src/policy.js` validates model requests. The default policy is `active-only`:

- active model request: allowed
- exact public alias: resolved to the active model and allowed
- other non-active model request: rejected
- protected active model request: `keep_alive` overwritten to `-1`
- model-management endpoint: disabled by default

### Active model reader

`src/active-model.js` reads `/app/runtime/active-model.json` or falls back to `ACTIVE_MODEL`. The deployment/profile system should write the marker.

`src/model-discovery.js` turns that active slot into the stable `ROUTER_MODEL_ALIAS`. It re-reads the marker before every catalog response, enriches only with read-only Ollama `/api/ps` and `/api/show` calls, and caches the normalized entry by physical model plus marker revision. The OpenAI catalog contains exactly one alias; `/api/tags` and other native Ollama status routes retain their existing physical-model behavior.

`src/native-tools.js` inspects only native tool-control metadata and prior tool-history markers. The generic proxy and Responses adapter invoke it after resolving/replacing the client model name. A lazy per-request `/api/show` lookup is shared with thinking normalization, so requests containing both enabled thinking and tools issue one capability query and requests containing neither issue none. Unsupported history is rejected rather than rewritten; drop events contain counts and booleans, never schemas, arguments, prompts, or message content.

The marker is also the source of truth for model-specific reasoning capabilities. `src/reasoning.js` validates `supported_think_levels` and `reasoning_effort_map`, whose targets may be declared string levels or boolean `true` for the model/runtime default; `src/upstream.js` applies that map before the shared `/api/show` thinking-capability check. This path is used by Responses, native chat, and native generate requests.

### Proxy and streaming support

The proxy forwards sanitized JSON bodies to raw Ollama and streams response chunks back to the client without buffering the full response. It observes newline-delimited JSON chunks to capture the final usage object when `done: true`.

### Telemetry and history

`src/metrics.js` maintains in-memory metrics from request records. `src/fs-store.js` persists request and event logs as JSONL files under `/app/data`.

### Admin portal

`public/` contains a no-build dashboard served by the separate admin listener at `/` and `/admin`. It uses unauthenticated admin-port JSON APIs under `/admin/api/*` to show active model state, loaded model status, request history, recent rejects/errors, events, metrics, and control actions. The legacy same-port `/admin/api/*` route remains available on the API listener and still honors `ADMIN_TOKEN` when set.

## Compatibility surface

Implemented initial endpoints:

```text
GET  /
GET  /api/tags
POST /api/show
POST /api/chat
POST /api/generate
GET  /api/ps
GET  /api/version
POST /api/embed
POST /api/embeddings
POST /v1/chat/completions
POST /v1/responses
POST /responses
GET  /v1/models
GET  /v1/models/{alias}
```

Disabled/admin-gated model-management routes:

```text
POST   /api/pull
POST   /api/create
POST   /api/copy
POST   /api/push
DELETE /api/delete
```

Unsupported `/api/*` routes return a structured router error instead of silently passing through.

## Data model

### Request record

Request records are metadata-only by default. Prompt text is not logged unless `PROMPT_LOGGING=full` is explicitly set.

Fields include:

- timestamp
- client identity
- source IP
- method and endpoint
- requested model
- active model at request time
- forwarded model and whether the request identifier was rewritten
- incoming and forwarded `keep_alive`
- whether a Responses `prompt_cache_key` was present and, when valid, that it was accepted and ignored
- incoming `think`, incoming Responses reasoning effort, forwarded `think`, mapping/drop state, and the effective reasoning effort
- allow/reject state
- upstream response status
- latency
- streaming flag
- prompt/message length metadata
- Ollama usage metrics when available

### Event record

Events capture operational changes:

- startup
- keep-alive normalization
- rejection
- prewarm
- admin test chat
- maintenance mode changes
- upstream failures

For a `llama_cpp` active profile, prewarm is a residency operation rather than
a capability qualification. The router first requires backend health, then
sends exactly one non-streaming raw `/v1/completions` request through the active
marker's internal backend URL. The request uses a fixed short prompt, one output
token, temperature zero, one sample, and a fixed seed. Raw completion avoids the
chat template and carries neither reasoning controls nor tool definitions. The
entire response must arrive within 55 seconds and 16 KiB; only status, latency,
and token count are retained. Prompt text and generated content are never
returned or written to the event log.

## Deployment states

### Phase 1: API/admin split

The router publishes the Ollama-compatible API on `192.168.1.21:11434` and the human admin portal on `192.168.1.21:11435`. It forwards to raw Ollama at `http://ollama:11434` on the internal Docker network.

### Phase 2: client migration

Repoint OpenWebUI, ComfyUI, the voice assistant, and local apps to the router. Confirm request history shows traffic and raw Ollama `ollama ps` remains `Forever`.

### Phase 3: final cutover

Raw Ollama loses LAN port exposure. The router remains the public compatibility endpoint at `192.168.1.21:11434`, and the no-token admin portal remains on `192.168.1.21:11435` for trusted local/LAN operators.
