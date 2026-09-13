# Local AI Ollama Router

The deployed primary catalog uses unrestricted output, unrestricted thinking and template-default effort. Its current policy, context recovery, durable archives and client behavior are defined in [Primary integration](docs/PRIMARY_INTEGRATION.md). Legacy singleton-marker examples below are not primary production defaults.

The deployed `primary` runtime exposes two resident models with independent one-request admission: coding `qwen3.8-27b-q8_0` (128K) and everyday `qwen3.8-27b-abliterated-q6_k` (128K). `local-active` remains a coding alias. See [the primary integration contract and deployment report](docs/PRIMARY_INTEGRATION.md) for current operations, clients, validation, and recovery. The single-marker deployment examples below describe legacy operation.


A Docker-ready, Ollama-compatible router that sits between local AI clients and the real Ollama container. It enforces active-model policy, overwrites protected requests with `keep_alive: -1`, preserves streaming responses, persists request history, extracts Ollama response telemetry, and serves a simple human admin portal on a separate port.

This project is designed for the local AI topology where Open WebUI, ComfyUI, local apps, and a voice assistant should call the router instead of raw Ollama.

## What this gives you

- Ollama-compatible API on the router API listener, normally `http://192.168.1.21:11434`:
  - `GET /api/tags`
  - `POST /api/show`
  - `POST /api/chat`
  - `POST /api/generate`
  - `GET /api/ps`
  - `GET /api/version`
- Optional policy-aware routes:
  - `POST /api/embed`
  - `POST /api/embeddings`
  - model-management routes are disabled by default and require legacy admin auth when enabled
- Stateless OpenAI Responses compatibility for Codex CLI:
  - `POST /v1/responses`
  - `POST /responses` alias
  - streamed text and function calls translated to and from Ollama `/api/chat`
- Stable active-slot model discovery:
  - `GET /v1/models`
  - `GET /v1/models/{alias}`
  - one configurable public alias enriched from the active marker, Ollama `/api/ps`, and `/api/show`
- Separate browser admin portal, normally `http://192.168.1.21:11435/` or `http://192.168.1.21:11435/admin`.
- No token or login for the browser admin portal. It is intended for trusted local/LAN use only.
- Active-model fail-closed policy by default.
- Request-level `keep_alive` normalization to `-1` for protected active-model requests.
- Profile-specific `think` negotiation that maps OpenAI reasoning efforts only to string levels declared safe for the active model.
- Cross-protocol thinking composition with request, active-model, and optional global defaults.
- Streaming and non-streaming pass-through.
- Native Node HTTP transport with cancellation and progress-aware generation stall recovery; no total generation deadline.
- Persistent request log in JSONL.
- Persistent activity/event log in JSONL.
- Telemetry extraction from Ollama final response chunks and non-streaming responses.
- Optional GPU telemetry through `nvidia-smi` when available.
- No runtime npm dependencies; the application runs on Node.js 22 built-ins.

## Ports and URLs

| Port | Purpose | URL |
|---:|---|---|
| `11434` | Ollama-compatible router API for clients | `http://192.168.1.21:11434/api/version` |
| `11435` | Human admin portal for local/LAN operators | `http://192.168.1.21:11435/` |

The API port remains Ollama-compatible. The admin portal is intentionally not buried under the Ollama API URL structure. The old same-port `/admin/api/*` machine endpoints are still present for compatibility and still honor `ADMIN_TOKEN` when it is set, but the browser portal and its admin-port JSON APIs do not require a token.

## Quick start

```bash
cd /home/astigmatism/apps/local-ai-ollama-router
cp .env.example .env

# Write an active model marker for initial testing:
./scripts/write-active-model.sh 'model-a:test' example-profile medium \
  runtime/reasoning-capabilities.night.example.json

docker compose --env-file .env up --build -d
curl http://192.168.1.21:11434/api/version
```

Open the admin portal in a browser:

```text
http://192.168.1.21:11435/
```

The same dashboard is also available at:

```text
http://192.168.1.21:11435/admin
```

## Active model source of truth

The router reads the active model from `ACTIVE_MODEL_FILE`, defaulting to `/app/runtime/active-model.json`. The deployment/profile system should write this file during `local-ai-config.sh apply <profile>` or from the LLM deploy script.

Example marker:

```json
{
  "profile": "example-profile",
  "model": "model-a:test",
  "keep_alive": -1,
  "context_length": 16384,
  "max_output_tokens": 2048,
  "input_modalities": ["text"],
  "default_think": "medium",
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

## Stable public model alias

`ROUTER_MODEL_ALIAS` defaults to `local-active`. It names the router's active slot, not an installed Ollama model. The exact alias resolves to the current marker model on Responses, native chat/generate/embed/embeddings/show, and OpenAI chat-completions requests even when `REWRITE_REQUESTED_MODEL_TO_ACTIVE=false`. That strict setting still rejects other mismatched names; setting it to `true` preserves the broader compatibility behavior where every non-empty requested name is advisory.

`GET /v1/models` returns exactly this one alias, and `GET /v1/models/local-active` returns the same entry with current context, modality, capability, and reasoning metadata. Physical models remain visible through native Ollama routes such as `/api/tags`; they are never enumerated by the OpenAI discovery endpoint. See [Stable Active-Model Discovery](docs/MODEL_DISCOVERY.md) for the schema, source precedence, partial-data rules, caching, and downstream integration guidance.

`ACTIVE_MODEL` exists only as a temporary fallback. Prefer the file marker so the router does not invent model selection.

`scripts/write-active-model.sh` accepts an optional fourth argument containing the capability object. The example day and night objects under `runtime/` can be copied and adapted by the deployment/profile system; they do not select a model themselves.

`default_think` is optional. It can be `true`, `false`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `model-default`, and applies only while that marker's model is active. String defaults are negotiated through the marker's capability map.

`supported_think_levels` and `reasoning_effort_map` are model/profile-specific. When supplied, they must appear together. Each map target must either be a declared string level or boolean `true`, which asks Ollama to use the model template's enabled default reasoning mode. A daytime model that accepts `max` can retain the historical behavior with a separate profile:

```json
{
  "supported_think_levels": ["low", "medium", "high", "max"],
  "reasoning_effort_map": {
    "minimal": "low",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "max",
    "max": "max"
  }
}
```

## Policy defaults

The default policy is intentionally conservative:

```text
MODEL_POLICY_MODE=active-only
ROUTER_MODEL_ALIAS=local-active
REWRITE_REQUESTED_MODEL_TO_ACTIVE=false
FORCE_KEEP_ALIVE=-1
DEFAULT_THINK=
UNSUPPORTED_TOOLS_POLICY=passthrough
RESPONSES_CONTEXT_SHIFT=false
ALLOW_MODEL_MANAGEMENT=false
USE_ACTIVE_MODEL_WHEN_MISSING=false
```

For `POST /api/chat`, `POST /api/generate`, `POST /api/embed`, and `POST /api/embeddings`, the default policy accepts the exact active model or the exact public alias. The alias is resolved before policy enforcement. If the request targets the active slot, the router forwards it with `keep_alive: -1`, regardless of whether the client omitted `keep_alive` or sent a finite value such as `5m`.

The exact `ROUTER_MODEL_ALIAS` always forwards only to the active marker model. Set `REWRITE_REQUESTED_MODEL_TO_ACTIVE=true` only when compatibility clients such as Open WebUI should also be allowed to send other advisory model names. In that broader mode, the router replaces any non-empty requested model on native generation/embed requests, `/api/show`, `/v1/chat/completions`, `/v1/responses`, and `/responses`. Other request parameters are preserved. For `/api/chat` and `/api/generate`, boolean `think` controls are preserved, while string controls are negotiated through the active profile. The router then checks `/api/show` and drops enabled thinking when the model does not advertise the `thinking` capability.

`UNSUPPORTED_TOOLS_POLICY` controls function tools on `/api/chat`, `/v1/chat/completions`, `/v1/responses`, and `/responses`. The active marker's `capability_profile.tools` value is authoritative for every backend, so model names and backend-specific guesses are never used. `drop` removes tool definitions and tool-choice/parallel controls for a `tools: false` profile; `reject` returns a router error instead. Prior tool-call/output history is never silently removed: a non-tool profile receives `UNSUPPORTED_TOOL_HISTORY` under every policy. Tool-free requests avoid capability work entirely.

For `llama_cpp` profiles with `capability_profile.tools: true`, the router forwards validated OpenAI function definitions and complete tool history to llama.cpp, includes tool schemas when applying the chat template for context accounting, and translates structured calls for native Ollama and Responses clients in both streaming and non-streaming modes. The deployed llama.cpp server and chat template must themselves support tool calling (normally with llama.cpp's Jinja template support enabled). A profile must remain `tools: false` when that backend/template combination has not been verified.

For `llama_cpp` profiles with `capability_profile.vision: true`, the router preserves inline base64 images across native Ollama chat, Chat Completions, and Responses. Image-bearing Responses function outputs are retained as the associated text tool result followed by a user image turn, which keeps the call/result relationship intact while using llama.cpp's supported multimodal message role. The marker is authoritative: text-only profiles reject image history before template application or inference. Enable `vision` only after the exact deployed llama.cpp process reports `modalities.vision: true` from `/props`; normally this requires a matching multimodal projector loaded with `--mmproj`. Remote image URLs and backend filesystem paths are not accepted through the router.

Native `/api/chat` and `/api/generate` requests may set `think` to a boolean or a reasoning effort string. Responses requests use `reasoning.effort` or the `reasoning_effort` compatibility alias. `none` always maps to `false`; with profile metadata, every enabled string effort is mapped explicitly, so the same incoming `max` can become boolean `true` at night and remain the string `"max"` during the day. Without profile metadata, enabled efforts use the binary fallback described below. Explicit request values win over defaults. If omitted, an active marker's `default_think` wins over `DEFAULT_THINK`. When neither default is configured, native Ollama requests omit `think`, while the Responses adapter retains its existing `think: false` default. Set `DEFAULT_THINK=model-default` to omit the field across both protocols.

Ollama's advertised `thinking` capability remains the binary enabled/disabled check; the profile metadata supplies the missing list of valid string levels. Without that metadata, the router degrades enabled string efforts to boolean `true`, forwards it only when `/api/show` advertises `thinking`, and otherwise removes `think` so non-thinking models can still serve the request. If the capability lookup itself is unavailable, the fallback is removed conservatively. Invalid or incomplete explicit metadata still rejects generation before Ollama is called. No model names are used to infer support.

## Codex CLI through the Responses API

The Responses adapter always calls only Ollama `/api/chat` with the active marker model and `FORCE_KEEP_ALIVE`; it contains no pull, switch, fallback, or direct-upstream path. With `REWRITE_REQUESTED_MODEL_TO_ACTIVE=true`, an omitted model or any non-empty client identifier is replaced with the marker model. With the flag set to `false`, an omitted model, the exact public alias, or the exact active model is accepted; other mismatches receive HTTP 400 `MODEL_NOT_ACTIVE`. `MODEL_POLICY_MODE` and `ALLOWED_MODELS` do not broaden this boundary. Codex/Responses requests omit Ollama's nonstandard `shift` field by default; set `RESPONSES_CONTEXT_SHIFT=true` only to opt into silent context shifting. For `stream: true`, the router sends the downstream SSE headers plus `response.created` and `response.in_progress` before waiting for Ollama response headers; an upstream failure after that point is reported as `response.failed` within the SSE stream.

Responses reasoning items round-trip through Ollama assistant `thinking`. Qwen `message.thinking` is returned as raw Responses `reasoning_text` (never a fabricated summary), including the matching streaming reasoning events, and is reattached to the prior assistant message when Codex submits tool results. Ollama's aggregate `prompt_eval_count` and `eval_count` map exactly to Responses input, output, and total usage so Codex can track context and compact long reasoning sessions. Ollama does not expose the split between reasoning and visible output; when thinking is present, the adapter conservatively attributes all aggregate output tokens to `reasoning_tokens` without changing the exact output or total counts. A thinking-only, whitespace-only, or otherwise blank result with no function call fails as `EMPTY_UPSTREAM_RESPONSE` instead of succeeding with an empty assistant message.

Upstream routes use Node's native HTTP transport with explicit JSON `Content-Length`. `OLLAMA_UPSTREAM_TIMEOUT_MS` bounds legacy Ollama calls and primary metadata/control operations. Primary llama.cpp services have independent, cancellable FIFO queues and no total generation deadline; streaming requests receive keepalives while waiting. See [Primary admission and timeout policy](docs/PRIMARY_INTEGRATION.md).

Codex CLI 0.144.3 can be configured with:

```toml
model_provider = "local_ollama_router"
model = "local-active"
model_reasoning_effort = "none"
web_search = "disabled"

[model_providers.local_ollama_router]
name = "Local Ollama Router"
base_url = "http://192.168.1.21:11434/v1"
wire_api = "responses"
requires_openai_auth = false
```

The exact stable identifier works whether broad requested-model rewriting is enabled or disabled; day/night marker changes require no Codex configuration change. `web_search` must be disabled because this adapter accepts client-executed function tools only (including Codex namespace groups containing functions). It rejects provider-executed tools instead of silently removing them. `/v1/models` and native `/api/tags` publish canonical entries and all registered aliases in resident catalog mode, including stable service IDs `daytime`, `nighttime` and the compatible `local-active`. Every alias carries its target's actual capabilities and limits; `/api/ps` and admin resident counts remain canonical-only. See [stable service identifiers](docs/STABLE_SERVICES.md). Legacy single-marker mode continues to publish its stable alias.

Codex `model_reasoning_effort = "xhigh"` is accepted by the adapter and translated according to the active profile—for example, `think: true` for the nighttime profile and `think: "max"` for the daytime profile above.

The endpoint is stateless: omit `store` or send `store: false`, resend prior response items for tool follow-ups, and do not send `previous_response_id`. See `docs/API.md` for supported fields, item types, curl examples, and error behavior.

## Admin portal

The admin portal is served by its own listener:

```env
ADMIN_ENABLED=true
ADMIN_BIND_HOST=0.0.0.0
ADMIN_PORT=11435
```

It shows:

- router API/admin listener status and uptime
- raw Ollama upstream health
- active model marker, profile, source, and marker keep-alive
- loaded model state from upstream `/api/ps`
- model context hints when present in the active marker or loaded-model data
- forced keep-alive status
- router policy mode and model rewrite status
- request counts, keep-alive rewrite counts, rejections, and upstream errors
- recent reject/error information
- request history and activity timeline
- optional GPU telemetry

Control actions are available directly from the portal without a token:

- prewarm active model
- run test chat against the active model
- reload active marker
- toggle maintenance mode

Because the portal is unauthenticated by design, expose `11435` only on trusted local/LAN interfaces. Do not publish it to the public internet.

## Smoke test

```bash
ROUTER_URL=http://192.168.1.21:11434 \
ADMIN_URL=http://192.168.1.21:11435 \
./scripts/curl-smoke-test.sh 'model-a:test'
```

Run the Responses text-and-tool-cycle smoke test without changing the active model:

```bash
ROUTER_URL=http://192.168.1.21:11434 \
ADMIN_URL=http://192.168.1.21:11435 \
REQUESTED_MODEL=local-active \
./scripts/responses-smoke-test.sh
```

After each request, verify raw Ollama still reports the active model as `Forever`:

```bash
docker exec local-ai-llm-legacy-ollama ollama ps
```

## Final cutover shape

After Open WebUI, ComfyUI, the voice assistant, and local apps are verified through the router:

1. Remove raw Ollama's LAN `ports` mapping.
2. Keep raw Ollama reachable only on an internal Docker network.
3. Publish the router API on `192.168.1.21:11434`.
4. Publish the router admin portal on `192.168.1.21:11435`.
5. Confirm `http://192.168.1.21:11434/api/version` is the router-backed endpoint.
6. Confirm `http://192.168.1.21:11435/` opens the no-token dashboard.
7. Confirm no clients resolve `ollama` to raw Ollama unless that is deliberate.

See `docs/DEPLOYMENT_HANDOFF.md` for the full phased migration plan.

## Repository layout

```text
src/                 Router, policy, proxy, telemetry, metrics, storage
public/              Admin portal UI served on the admin listener
docs/                Architecture, deployment, API, test, and security notes
docs/source/         Original uploaded topology handoff
runtime/             Active model marker location
data/                Runtime JSONL logs, gitignored
scripts/             Smoke tests and utility helpers
test/                Node built-in test suite
compose.yml          Compose file exposing API 11434 and admin portal 11435
compose.final-example.yml  Example final cutover compose shape
Dockerfile           Node.js 22 runtime image
```

## Local development

```bash
npm test
npm run lint:syntax
npm start
```

The application has no runtime package dependencies. Tests use the Node.js built-in test runner.
