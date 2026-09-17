> Current production contract: [Primary resident integration](PRIMARY_INTEGRATION.md). Explicit IDs select independently; omitted models select coding. Chat Completions on llama.cpp defaults to SSE unless `stream: false`; Responses defaults to JSON and remains stateless.

The deployed primary catalog uses unrestricted output, unrestricted thinking and template-default effort. Its current policy, context recovery, durable archives and client behavior are defined in [Primary integration](PRIMARY_INTEGRATION.md). Legacy singleton-marker examples below are not primary production defaults.

# API Reference

## Port split

| Listener | Default | Purpose |
|---|---:|---|
| Router API | `11434` | Ollama-compatible API for Open WebUI, ComfyUI, and local clients. |
| Admin portal | `11435` | Human browser dashboard and admin-port JSON APIs. No token or login. |

The browser admin portal is available at both:

```text
http://<host>:11435/
http://<host>:11435/admin
```

The admin portal is intentionally unauthenticated for trusted local/LAN use. Do not expose it to untrusted networks.

## Primary resident APIs

The deployed two-model API, status codes, output/reasoning policies and streaming defaults are specified in [Primary integration](PRIMARY_INTEGRATION.md#endpoint-behavior). All supported generation routes accept an omitted model (coding), a canonical model ID, or the coding alias. Catalog mode ignores legacy broad rewriting; unknown IDs return 404. Discovery and native metadata describe each resident separately.

## Legacy single-marker Ollama API reference

The remaining backend-specific pass-through and rewrite rules below describe the retained legacy mode unless explicitly stated otherwise. They do not override the primary contract above.

These routes are served on the router API listener, normally `http://<host>:11434`.

### `GET /`

Returns a simple compatibility health message:

```text
Ollama is running
```

### `GET /api/version`

Passes through to raw Ollama.

### `GET /api/tags`

Passes through to raw Ollama.

### `GET /api/ps`

Passes through to raw Ollama.

### `POST /api/show`

Passes through to raw Ollama. This endpoint is considered safe/status-like by default. The exact `ROUTER_MODEL_ALIAS` always resolves to the active model; when `REWRITE_REQUESTED_MODEL_TO_ACTIVE=true`, other `/api/show` model names are also rewritten.

### `POST /api/chat`

Policy-enforced. Default behavior:

- requires JSON body
- requires `body.model`
- accepts the exact active model or exact `ROUTER_MODEL_ALIAS`; rejects other non-active models under the default policy
- overwrites `keep_alive` to `-1` for active model
- preserves non-model request fields such as `messages`, `stream`, `options`, and `format`
- accepts `think` as `true`, `false`, or a supported reasoning effort string
- maps string values through the active marker's validated `reasoning_effort_map`; when omitted, composes the active marker's `default_think` over the optional global `DEFAULT_THINK`
- drops enabled `think` when `/api/show` reports that the model lacks the `thinking` capability
- applies `UNSUPPORTED_TOOLS_POLICY` against the rewritten active model when tool controls or prior tool history are present
- streams response when `stream` is omitted or true
- captures final usage fields when available

### `POST /api/generate`

Same policy and streaming behavior as `/api/chat`.

### `POST /api/embed` and `POST /api/embeddings`

Policy-enforced. Default behavior requires the active model and rewrites `keep_alive` for protected active-model requests.

### Model-management endpoints

These are disabled by default:

```text
POST   /api/pull
POST   /api/create
POST   /api/copy
POST   /api/push
DELETE /api/delete
```

To enable them, set `ALLOW_MODEL_MANAGEMENT=true`. Even then, the request must include legacy admin authorization on the router API listener when `ADMIN_TOKEN` is set.

Upstream calls use Node's native HTTP transport. For legacy Ollama routes, `OLLAMA_UPSTREAM_TIMEOUT_MS` covers the upstream wait through response headers. Primary llama.cpp generation instead uses connection and inactivity checks, without a total generation deadline. Its router-owned FIFO queues have no wait deadline: Daytime and Nighttime queue independently, and disconnecting cancels waiting work. Streaming requests receive keepalives; JSON callers must allow their timeout to cover queue wait plus generation. See [Primary admission policy](PRIMARY_INTEGRATION.md). JSON request bodies use explicit byte `Content-Length`.

## OpenAI chat completions compatibility

`POST /v1/chat/completions` is policy-enforced and proxied to Ollama's matching OpenAI-compatible endpoint. Model rewriting uses the same active-model rules as `/api/chat`. Messages, streaming, sampling parameters, and other OpenAI fields remain unchanged; the router does not inject Ollama `keep_alive` into this protocol. Native tool fields are normalized according to `UNSUPPORTED_TOOLS_POLICY` before forwarding.

For a `llama_cpp` active profile, `/v1/chat/completions`, `/v1/responses`, and `/responses` share the same formatted-context admission guard. The router applies the active template, tokenizes the complete formatted prompt, and permits a request only when `formatted input + requested output + context safety reserve <= per-request context window`. An overflow is rejected before generation with HTTP 400 and this OpenAI error shape on all three endpoints, regardless of the requested streaming mode:

```json
{
  "error": {
    "message": "Formatted input (101165) plus requested output (32768) and safety reserve (1024) exceeds the 131072-token slot.",
    "type": "invalid_request_error",
    "param": "messages",
    "code": "context_length_exceeded"
  }
}
```

`context_length_exceeded` is the stable OpenAI-compatible classification code; clients should route on it rather than parse the arithmetic message. Native `/api/chat` and `/api/generate` use the same guard but retain the router's native `{error:{code,message}}` envelope. The router never truncates, summarizes, or forwards an over-capacity request.

## OpenAI Responses compatibility

`POST /v1/responses` is a stateless compatibility endpoint for Codex CLI. `POST /responses` is an equivalent alias. Both translate to the existing Ollama `/api/chat` operation; neither proxies an arbitrary client-selected path.

The router implements `GET /v1/models` and `GET /v1/models/{id}`. In primary mode the list has both canonical resident model IDs and a `local-active` compatibility row (or the configured `ROUTER_MODEL_ALIAS`). The alias also resolves through detail lookup and generation requests. Limits, reasoning, health, and capabilities belong to each selected model; the alias inherits its target's metadata without increasing capacity. Native discovery and admin state count canonical residents only. Legacy single-marker mode still exposes its stable alias. The full schema and field semantics are documented in [Stable Active-Model Discovery](MODEL_DISCOVERY.md).

### Active-model routing rules

- An omitted `model` resolves to the current active-model marker.
- The exact active model is accepted.
- The exact `ROUTER_MODEL_ALIAS` is accepted and replaced with the active physical model even when broad rewriting is disabled.
- With `REWRITE_REQUESTED_MODEL_TO_ACTIVE=true`, every non-empty client model identifier is accepted and replaced with the active marker model.
- With `REWRITE_REQUESTED_MODEL_TO_ACTIVE=false`, every other mismatched model receives HTTP 400 `MODEL_NOT_ACTIVE`.
- A missing active marker receives HTTP 503 `NO_ACTIVE_MODEL`.
- Ollama always receives the active model, the configured `FORCE_KEEP_ALIVE` value, and `shift: false` by default. `RESPONSES_CONTEXT_SHIFT=true` is an explicit opt-in to the old shifting behavior.
- Responses requests never invoke model pull, create, copy, push, delete, fallback, or switching logic.
- `MODEL_POLICY_MODE`, `ALLOWED_MODELS`, and `USE_ACTIVE_MODEL_WHEN_MISSING` do not alter these Responses rules.
- Native tool support is checked against this resolved active model, never the client identifier.

### Supported request fields

| Field | Behavior |
|---|---|
| `model` | Optional. The stable alias and exact active model are accepted in strict mode; in broad rewrite mode any non-empty identifier is advisory. Ollama always receives the marker model. |
| `input` | Required string or array of supported input items. |
| `instructions` | Prepended as a system message without removing developer/system input. |
| `stream` | `false` by default; `true` produces Responses SSE events. |
| `tools` | Function tools and function-only Codex namespace groups are translated to Ollama function definitions. |
| `tool_choice` | `auto` and `none` only. Other forms receive HTTP 400. |
| `parallel_tool_calls` | Boolean accepted, forwarded, and reflected in the response. Call IDs remain individually correlated. |
| `reasoning.effort` | Accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. `none` becomes boolean `false`; other values are mapped by the active model/profile's `reasoning_effort_map`. |
| `reasoning_effort` | Top-level compatibility alias for `reasoning.effort`; conflicting simultaneous values receive HTTP 400. |
| `text.format` | Plain text, `json_object`, and `json_schema` formats. |
| `store` | May be omitted or `false`; `true` and other values receive HTTP 400. |
| `temperature` | Maps to Ollama `options.temperature`. |
| `max_output_tokens` | Maps to Ollama `options.num_predict`. |

Unknown optional fields are ignored only when doing so does not claim unsupported behavior. Any non-null `previous_response_id` is rejected because the adapter does not persist response state. WebSocket Responses transport is not implemented.

### Thinking defaults and precedence

Thinking is composed without changing model selection:

1. Protocol-specific explicit request: native `think`, or Responses `reasoning.effort`/`reasoning_effort`.
2. `default_think` in the active-model marker.
3. The optional global `DEFAULT_THINK` environment setting.
4. Endpoint compatibility default: Responses sends `think: false`; native Ollama leaves `think` omitted.

Allowed configured defaults are `true`, `false`/`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `model-default`. `model-default` omits the upstream field; string defaults use the same active-profile map as explicit requests. Invalid active-marker defaults fail the generation request with HTTP 503 instead of guessing.

Ollama's `thinking` capability is binary metadata; it does not enumerate valid string levels. Each active marker may therefore declare:

```json
{
  "supported_think_levels": ["low", "medium"],
  "reasoning_effort_map": {
    "minimal": "low",
    "low": "low",
    "medium": "medium",
    "high": true,
    "xhigh": true,
    "max": true
  }
}
```

Both fields are required when either is present. The map must cover `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; each target must be boolean `true` or a string present in `supported_think_levels`. Boolean `true` selects the model/runtime's enabled default reasoning mode. Without profile metadata, an enabled string effort degrades to boolean `true`; the router forwards it when `/api/show` advertises `thinking` and removes it when thinking is unsupported or cannot be established. An incomplete or inconsistent explicit profile receives HTTP 503 `INVALID_REASONING_CAPABILITIES` before `/api/show` or generation. Native boolean `true`/`false` remains supported without a string-level map, subject to the same binary `/api/show` check for enabled thinking.

Request records log `requestedModel`, `activeModel`, `forwardedModel`, and `modelRewritten`, plus `incomingReasoningEffort` separately from `forwardedThink`, incoming `think`, the effective effort, and mapping/drop state. Tool metadata is limited to `toolsPresent`, `toolCount`, `toolChoicePresent`, `toolsSupported`, `toolsDropped`, `unsupportedToolsPolicy`, and the boolean `toolHistoryPresent`. Metadata-mode body summaries also record `messageImageCount` or `inputImageCount` when images are present, without retaining image bytes or URLs. The `unsupported_tools_dropped` event uses the same metadata and never contains tool schemas, arguments, prompts, or message content. If llama.cpp returns malformed streamed tool arguments, the request record and audit event retain only value-free diagnostics: tool index/name, whether an ID was present, capped ordered argument-delta types, argument byte length and SHA-256, normalized JSON error category/offset, terminal finish reason, completion-token count, requested limit, and whether that numeric limit was reached. Output-limit truncation is recorded as `responses_incomplete`; other malformed arguments remain `responses_upstream_failed`. Neither event retains argument text. Thus both a stable client identifier rewritten to the marker and a policy-driven capability decision remain distinguishable without logging private payloads. Prompt content remains governed by `PROMPT_LOGGING`; the default records metadata only.

Supported input items are:

- `message` with `system`, `developer`, `user`, or `assistant` role
- `input_text` and `output_text` content parts
- `input_image` using a base64 `data:image/...` URL
- `reasoning` with `summary` (`summary_text` parts), raw `content` (`reasoning_text` parts), or both; raw content takes precedence when both are present
- `function_call` with a unique `call_id` and JSON-object arguments encoded as text or an object
- `function_call_output` associated with a known, not-yet-completed `call_id`; output may be text/JSON or an array of `input_text` and inline-base64 `input_image` parts

For a tool follow-up, resend the preceding function-call item, append one `function_call_output` item per `call_id` in result order, and resend the tool definitions. Unknown or duplicate call IDs and malformed function arguments are rejected.

On a vision-enabled `llama_cpp` profile, image-bearing function output becomes an associated text tool-result message followed by a user image message for llama.cpp Chat Completions. This preserves both the tool-call association and the visual payload without placing an image on the unsupported Chat Completions tool role. Native `messages[].images`, Chat Completions `image_url`, and Responses `input_image` inputs use the same marker-driven gate. Only inline base64 image data is accepted; remote URLs and server filesystem paths are rejected. A text-only marker rejects image-bearing history before backend template application or inference.

Ollama assistant `message.thinking` is returned as a Responses `reasoning` item with an `rs_...` ID, an empty `summary`, and raw `reasoning_text` content. Streaming emits `response.output_item.added`, `response.reasoning_text.delta`, `response.reasoning_text.done`, and `response.output_item.done` before any following assistant message or function call. The adapter does not synthesize a reasoning summary.

Ollama's aggregate `prompt_eval_count` and `eval_count` map exactly to Responses `input_tokens`, `output_tokens`, and `total_tokens`, including when thinking is present. This preserves the context accounting clients need for automatic compaction during long reasoning sessions. Ollama does not expose the reasoning/visible-output split, so the adapter conservatively attributes all aggregate output tokens to `reasoning_tokens` when thinking was emitted; that attribution is not an exact split, while `output_tokens` and `total_tokens` remain exact. Without thinking, `reasoning_tokens` is zero.

A completion must contain non-whitespace assistant text or at least one function call. Thinking-only, whitespace-only, and otherwise blank results receive `EMPTY_UPSTREAM_RESPONSE` instead of a fabricated empty message. For an already-started SSE response this is the final `response.failed` event, with no `response.completed` event; tool-only results remain valid.

Top-level `type: "function"` tools and Codex `type: "namespace"` groups containing only functions are accepted. Namespace members are given collision-safe qualified names for Ollama, then restored to separate `namespace` and `name` fields in Responses function-call items so Codex can dispatch them locally. When tools are supported or passed through, built-in provider tools such as `web_search`, `file_search`, `computer_use`, and `image_generation` receive HTTP 400 even when `tool_choice` is `none`; this prevents silent loss of capabilities assumed by the client. In `drop` mode with an unsupported active model, all tool controls are removed before this adapter validation so ordinary chat can continue.

### Non-streaming example

```bash
curl -fsS http://192.168.1.21:11434/v1/responses \
  -H 'content-type: application/json' \
  -d '{
    "input": "Reply with exactly: adapter ready",
    "store": false,
    "stream": false,
    "max_output_tokens": 32
  }'
```

The result is an OpenAI Responses object containing `id`, `object: "response"`, `created_at`, `status`, the active `model`, `output`, `usage`, `error`, and `incomplete_details`. Ollama prompt/evaluation token counters always map to exact aggregate `input_tokens`, `output_tokens`, and `total_tokens`.

### Streaming example

```bash
curl -N http://192.168.1.21:11434/v1/responses \
  -H 'content-type: application/json' \
  -d '{"input":"Give a five-word health check.","stream":true,"store":false}'
```

The stream uses `Content-Type: text/event-stream`, disables buffering, and emits monotonic `sequence_number` values. Its lifecycle includes `response.created`, `response.in_progress`, output-item/content-part events, text or function-argument deltas and done events, and finally `response.completed`. If llama.cpp reaches its output-token limit before closing streamed function arguments, the router discards the unsafe partial call and emits `response.incomplete` with `incomplete_details.reason: "max_output_tokens"`. Other generation failures after the SSE headers have been sent emit `response.failed`. Every terminal event is followed by `[DONE]`.

### Codex configuration

```toml
model_provider = "llm_router"
model = "local-active"
model_reasoning_effort = "none"
web_search = "disabled"

[model_providers.llm_router]
name = "LLM Router"
base_url = "http://192.168.1.21:11434/v1"
wire_api = "responses"
requires_openai_auth = false
```

This exact stable-name configuration works with either value of `REWRITE_REQUESTED_MODEL_TO_ACTIVE`; enable broad rewriting only for clients that must send other advisory IDs. `model_reasoning_effort = "none"` is recommended for deterministic local tool use; explicit supported efforts are forwarded to Ollama when reasoning is wanted. Streaming function-call `response.output_item.done` events carry the completed call that Codex executes; a later request returns the tool result as `function_call_output`.

### Responses error shape

Errors returned before streaming begins use the OpenAI-compatible envelope. For example, strict mode returns:

```json
{
  "error": {
    "message": "Requested model is not the active deployed model for this router profile.",
    "type": "invalid_request_error",
    "param": "model",
    "code": "MODEL_NOT_ACTIVE"
  }
}
```

Common adapter-only codes include `STATEFUL_REQUEST_UNSUPPORTED`, `UNSUPPORTED_TOOLS`, `UNSUPPORTED_TOOL_HISTORY`, `UNSUPPORTED_TOOL_CHOICE`, `UNSUPPORTED_TOOL_TYPE`, `UNKNOWN_TOOL_CALL_ID`, `MALFORMED_TOOL_ARGUMENTS`, `INVALID_REASONING_CAPABILITIES`, `EMPTY_UPSTREAM_RESPONSE`, `UPSTREAM_TIMEOUT`, and `INCOMPLETE_UPSTREAM_STREAM`.

## Router errors

Router-generated errors use this shape:

```json
{
  "error": {
    "code": "MODEL_NOT_ACTIVE",
    "message": "Requested model is not the active deployed model for this router profile."
  }
}
```

Common codes:

| Code | Meaning |
|---|---|
| `NO_ACTIVE_MODEL` | No active marker was found and policy is fail-closed. |
| `MODEL_REQUIRED` | Generation request did not include a model. |
| `MODEL_NOT_ACTIVE` | Requested/effective model does not match active model. |
| `MODEL_MANAGEMENT_DISABLED` | Pull/create/delete/copy/push disabled. |
| `ADMIN_REQUIRED` | Legacy admin auth required for a gated model-management endpoint. |
| `MAINTENANCE_MODE` | Router maintenance mode rejects generation. |
| `INVALID_THINK_VALUE` | Native `think` is not a boolean or recognized reasoning effort. |
| `INVALID_REASONING_CAPABILITIES` | Active-profile reasoning metadata is incomplete or inconsistent. |
| `UNSUPPORTED_TOOLS` | Reject policy blocked native tool controls for an active model without tool support. |
| `UNSUPPORTED_TOOL_HISTORY` | The active model lacks tool support and the conversation contains prior tool calls/results that cannot be safely dropped. |
| `UPSTREAM_REQUEST_FAILED` | Raw Ollama request failed before response. |
| `API_NOT_ON_ADMIN_PORT` | `/api/*` was requested from the admin portal listener instead of the router API listener. |

## Admin portal JSON API on `11435`

These routes are used by the browser dashboard and do not require a token on the admin listener.

### `GET /admin/api/summary`

Returns router config summary, active model marker, upstream health, `/api/ps`, active loaded state, optional GPU telemetry, metrics, recent reject/error records, and log paths.

### `GET /admin/api/requests?limit=100`

Returns recent request records, newest first.

### `GET /admin/api/events?limit=50`

Returns recent operational events, newest first.

### `GET /admin/api/metrics`

Returns the metrics snapshot.

### `GET /admin/api/config`

Returns safe public config. It does not return the legacy admin token.

### `POST /admin/api/prewarm`

Runs a non-streaming empty `/api/generate` request against the active model with `keep_alive: -1`.

### `POST /admin/api/test-chat`

Runs a non-streaming `/api/chat` against the active model with `keep_alive: -1`.

Body:

```json
{"prompt":"Reply with a short health check."}
```

### `POST /admin/api/reload-config`

Re-reads the active model marker and records an event.

### `POST /admin/api/maintenance`

Body:

```json
{"enabled":true}
```

When enabled, model-body generation endpoints are rejected while safe status endpoints continue to work.

## Legacy same-port admin API

For backward compatibility, the router API listener still accepts `/admin/api/*`. Those machine-readable endpoints require `Authorization: Bearer <token>` or `X-Admin-Token: <token>` when `ADMIN_TOKEN` is set. The separate browser portal on `11435` ignores this token requirement by design.
