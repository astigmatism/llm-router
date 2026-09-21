# Configuration

The deployed primary catalog uses unrestricted output, unrestricted thinking and template-default effort. Its current policy, context recovery, durable archives and client behavior are defined in [Primary integration](PRIMARY_INTEGRATION.md). Legacy singleton-marker examples below are not primary production defaults.

All configuration is environment-variable driven. `.env.example` is the starting point for Docker Compose.

## Router API listener

| Variable | Default | Purpose |
|---|---:|---|
| `HOST` | `0.0.0.0` | Interface for the Ollama-compatible API listener inside the container. |
| `PORT` | `11434` | Ollama-compatible API port inside the container. |
| `ROUTER_BIND_IP` | `192.168.1.21` | Host IP used by Compose for published ports. |
| `ROUTER_PUBLIC_PORT` | `11434` | Host port for the Ollama-compatible router API. |

Clients should use the API listener, for example:

```text
http://192.168.1.21:11434
```

## Admin portal listener

| Variable | Default | Purpose |
|---|---:|---|
| `ADMIN_ENABLED` | `true` | Starts the separate browser/admin listener when true. |
| `ADMIN_BIND_HOST` | `0.0.0.0` | Interface for the admin listener inside the container. |
| `ADMIN_PORT` | `11435` | Admin listener port inside the container. |
| `ADMIN_PUBLIC_PORT` | `11435` | Host port used by Compose for the admin portal. |

The human dashboard is available at:

```text
http://192.168.1.21:11435/
http://192.168.1.21:11435/admin
```

The admin portal and its admin-port JSON APIs are intentionally unauthenticated. This is a local/LAN trust assumption; do not publish the admin port to untrusted networks.

## Upstream Ollama

| Variable | Default | Purpose |
|---|---:|---|
| `OLLAMA_UPSTREAM_URL` | `http://ollama:11434` | Raw Ollama backend URL. |
| `OLLAMA_UPSTREAM_TIMEOUT_MS` | `30000` | Timeout for metadata/control operations; not a generation lifetime. |
| `GENERATION_STALL_TIMEOUT_MS` | `120000` | Inactivity watchdog; bytes and actual backend prefill/decode progress reset it. No total generation deadline. |
| `RESPONSES_CONTEXT_SHIFT` | `false` | Controls Ollama `shift` only for `/v1/responses` and `/responses`; disabled by default so Codex requests fail instead of silently shifting old context. |

The router uses Node's native HTTP transport. `OLLAMA_UPSTREAM_TIMEOUT_MS` bounds legacy Ollama calls and primary metadata/control operations. It does not limit the primary router's FIFO queue wait or total llama.cpp generation time; generation uses connection and inactivity checks. Client JSON read/header timeouts must cover waiting plus generation. Streaming queue waits receive keepalives. JSON request bodies use explicit byte `Content-Length`.

## Active model

| Variable | Default | Purpose |
|---|---:|---|
| `ACTIVE_MODEL_FILE` | `/app/runtime/active-model.json` | Marker file written by deployment/profile system. |
| `ACTIVE_MODEL` | empty | Temporary fallback only. |
| `ROUTER_MODEL_ALIAS` | `local-active` | Non-empty, stable public ID for the active router slot. Exact requests for this alias always resolve to the active physical model. |
| `ROUTER_MODEL_METADATA_TTL_MS` | `5000` | Cache lifetime in milliseconds for `/api/ps` and `/api/show` discovery enrichment. Marker changes invalidate immediately regardless of TTL. |

Marker format:

```json
{
  "profile": "example-profile",
  "model": "model-a:test",
  "keep_alive": -1,
  "context_length": 16384,
  "max_output_tokens": 2048,
  "input_modalities": ["text", "image"],
  "backend_kind": "llama_cpp",
  "capability_profile": {
    "tools": true,
    "vision": true
  },
  "supported_think_levels": ["low", "medium"],
  "reasoning_effort_map": {
    "minimal": "low",
    "low": "low",
    "medium": "medium",
    "high": true,
    "xhigh": true,
    "max": true
  },
  "updated_at": "2026-06-29T00:00:00-07:00",
  "source": "local-ai-config.sh apply nighttime"
}
```

The canonical optional discovery fields are `context_length`, `context_safety_reserve`, `max_output_tokens`, `input_modalities`, and `revision`. `context_safety_reserve` is a nonnegative integer added by the llama.cpp router preflight to formatted input and requested output; it defaults to `1024` when absent or invalid and is not model context or output capacity. Existing context hints (`context`, `num_ctx`, `numCtx`, or `options.num_ctx`) remain accepted, as do the documented compatibility aliases in [Stable Active-Model Discovery](MODEL_DISCOVERY.md). Older markers do not need any new field.

For a `llama_cpp` deployment, `capability_profile.tools` and `capability_profile.vision` are profile-owned authorization facts rather than model-name heuristics. Set `vision: true` and include `image` in `input_modalities` only after the running backend has loaded the exact matching multimodal projector and `GET /props` reports `modalities.vision: true`. The usual llama.cpp startup control is `--mmproj /path/to/mmproj-*.gguf`. The projector revision must match the deployed model artifacts. A marker update must not advertise vision merely because the base checkpoint family is multimodal.

Reasoning capability metadata belongs to the active deployment profile; the router does not infer it from `model` or `profile` names. When configured, `supported_think_levels` and `reasoning_effort_map` must appear together. The map must define `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. A string target must be listed in `supported_think_levels`; boolean `true` selects the model/runtime's enabled default reasoning mode and need not be listed. No other boolean target is valid. `none` is not part of the map because it always becomes boolean `false`. With neither field configured, generation falls back to Ollama's binary `thinking` capability and uses boolean `true` for any enabled effort. Invalid/incomplete explicit profiles fail generation with HTTP 503 before an upstream generation request.

For manual marker updates, `scripts/write-active-model.sh` accepts a capability JSON file as its fourth argument. `runtime/reasoning-capabilities.day.example.json` preserves the historical `xhigh`/`max` → `"max"` behavior, while `runtime/reasoning-capabilities.night.example.json` maps `high`/`xhigh`/`max` to boolean `true`.

## Policy

| Variable | Default | Purpose |
|---|---:|---|
| `MODEL_POLICY_MODE` | `active-only` | `active-only`, `allowlist`, or `permissive`. |
| `ALLOWED_MODELS` | empty | CSV of additional models for `allowlist` mode or exceptions. |
| `REWRITE_REQUESTED_MODEL_TO_ACTIVE` | `false` | When true, all non-empty client model names are advisory and model-bearing requests—including `/v1/responses` and `/responses`—forward only the active marker model. The exact `ROUTER_MODEL_ALIAS` always resolves to active even when this broader behavior is false; other mismatches retain strict policy behavior. Responses also accepts an omitted model. |
| `FORCE_KEEP_ALIVE` | `-1` | Forwarded keep-alive for active protected requests. |
| `UNSUPPORTED_TOOLS_POLICY` | `passthrough` | `passthrough`, `drop`, or `reject`. When the rewritten active model lacks `tools`, drop mode removes native tool controls and reject mode returns a router error. Unsupported prior tool-use history is always rejected explicitly. |
| `PROTECTED_MODEL_ENDPOINTS` | `/api/chat,/api/generate,/api/embed,/api/embeddings` | Endpoints receiving keep-alive rewrite. |
| `USE_ACTIVE_MODEL_WHEN_MISSING` | `false` | When true, a missing model is filled for native model-body routes. Responses always resolves an omitted model from the active marker and does not consult this setting. |
| `ALLOW_MODEL_MANAGEMENT` | `false` | Enables pull/create/copy/push/delete only with legacy admin auth when `ADMIN_TOKEN` is set. |

## Legacy admin token

| Variable | Default | Purpose |
|---|---:|---|
| `ADMIN_TOKEN` | `change-me-before-lan-exposure` | Optional token for legacy same-port `/admin/api/*` endpoints and model-management authorization on the API listener. It is not required by the separate browser admin portal. |
| `ADMIN_SESSION_HEADER` | `X-Admin-Token` | Header accepted by legacy admin auth. |

Legacy same-port admin requests may use either:

```text
Authorization: Bearer <token>
```

or:

```text
X-Admin-Token: <token>
```

The browser portal on `ADMIN_PORT` ignores this token and remains no-login by design.

## Persistence

| Variable | Default | Purpose |
|---|---:|---|
| `DATA_DIR` | `/app/data` | JSONL log directory. |
| `REQUEST_HISTORY_LIMIT` | `500` | Maximum request records in memory and on disk. |
| `EVENT_HISTORY_LIMIT` | `500` | Maximum event records in memory and on disk. |
| `REQUEST_LOG_MAX_BYTES` | `5242880` | Maximum persisted request log size (5 MiB); oldest whole records are removed first. |
| `EVENT_LOG_MAX_BYTES` | `5242880` | Maximum persisted event log size (5 MiB); oldest whole records are removed first. |
| `GENERATION_RETENTION_DAYS` | `7` | Closed generation archive age limit, measured from last modification. |
| `GENERATION_MAX_BYTES` | `1073741824` | Total closed generation archive budget (1 GiB); oldest archives are evicted first. |
| `MAX_BODY_BYTES` | `0` | Maximum accepted request body size in bytes. `0` disables the router-level cap; positive values restore it. Requests are still buffered in router memory and remain subject to client, Node.js, system-memory, Ollama, and model-context constraints. |
| `PROMPT_LOGGING` | `metadata` | `off`, `metadata`, or `full`. Use `full` only for explicit debugging. |

The four new byte/age settings require positive safe integers; zero does not disable retention. Each data directory must have a single router writer. Startup compacts existing metadata logs using bounded tail reads, skipping corrupt, incomplete and oversized records. Each update atomically replaces a bounded snapshot. A single metadata record larger than its byte cap is omitted with a payload-free warning; inference and full generation journal contents are unaffected. Temporary snapshots require up to one additional log-sized file per log while writing; abandoned router snapshot files are removed at startup. Metadata persistence errors are logged and subsequent writes retry with the current bounded history.

Generation cleanup runs at startup, after journal closure, and every five minutes while the router is running. Closed archives expire after seven days by default; the byte budget can remove them sooner. Active journals are excluded from both limits and consume additional disk space. Interrupted archives from earlier processes use the same retention policy after restart. Cleanup deletes only regular UUID-named files directly inside `DATA_DIR/generations`; unrelated files, symlinks and operator backups are outside the budget and are not removed. Cleanup failures appear in admin summary status and the dashboard, and retry automatically without failing successful inference. Pruned archive IDs return 404; downloads already opened continue normally.

Deploying this source applies retention to existing active logs and eligible generation archives during the first startup. Export any history that must be preserved before that startup. Metadata history and startup metrics cover only retained records; metrics continue accumulating during the current process lifetime. No changes are made to client-owned conversation storage.

## GPU/model directory visibility

| Variable | Default | Purpose |
|---|---:|---|
| `ENABLE_NVIDIA_SMI` | `false` | Enables optional GPU telemetry collection. |
| `NVIDIA_SMI_BIN` | `nvidia-smi` | Binary path inside container. |
| `GPU_TELEMETRY_TIMEOUT_MS` | `2500` | Timeout for GPU telemetry command. |
| `UNIFIED_MODELS_DIR` | `/home/astigmatism/ai-models` | Host-side model directory mounted by Compose. |
| `MODELS_DIR_IN_CONTAINER` | `/models` | Read-only in-container model path shown in admin config. |
