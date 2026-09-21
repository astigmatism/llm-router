# Security Notes

The deployed primary catalog uses unrestricted output, unrestricted thinking and template-default effort. Its current policy, context recovery, durable archives and client behavior are defined in [Primary integration](PRIMARY_INTEGRATION.md). Legacy singleton-marker examples below are not primary production defaults.

Primary generation archives always retain full request/output content, including reasoning and image data, separately from `PROMPT_LOGGING` metadata logs. They require protected persistent storage; retrieval always requires administrator authentication. See the primary storage policy before operating this profile.

## Network boundary

This router is intended for a trusted local network. The human admin portal is intentionally unauthenticated and listens on a separate port, defaulting to `11435`. Anyone who can reach that port can view runtime state and trigger admin actions such as prewarm, test chat, active-marker reload, and maintenance-mode toggle.

Keep the admin port bound only to trusted local/LAN interfaces. Do not publish it to the public internet, a shared VPN, or an untrusted reverse proxy.

## API/admin port split

Default published ports:

```text
11434 = Ollama-compatible router API
11435 = unauthenticated human admin portal
```

The Ollama-compatible API remains separate from the browser portal. Requests to `/api/*` on the admin port return a router error instead of proxying to Ollama.

The API listener also exposes the stateless `/v1/responses` compatibility endpoint and `/responses` alias. These routes always target the active marker model through Ollama `/api/chat` and provide no model-management operation or arbitrary upstream path. The exact `ROUTER_MODEL_ALIAS` always resolves to active. When `REWRITE_REQUESTED_MODEL_TO_ACTIVE=true`, any other non-empty requested identifier is advisory and is replaced with the marker model; when false, other mismatches are rejected. Neither mode lets the client select or load another installed model.

The Responses `prompt_cache_key` compatibility field is accepted only when it is a string and is discarded during Responses translation, before backend-adapter validation or response construction. The raw value is never forwarded, logged, persisted, copied into errors or admin history, used for authorization/model/slot selection, or treated as a semantic response-cache key. Metadata may state only that the field was present and accepted-but-ignored. This does not claim OpenAI prompt-cache-key semantics for the local backend.

`GET /v1/models` and `GET /v1/models/{alias}` use the same API-listener trust/authentication boundary as Responses. They expose one stable alias plus the current physical `upstream_model` already visible in router health. Discovery calls only Ollama `/api/ps` and `/api/show`; it does not enumerate `/api/tags`, generate, prewarm, load, pull, or manage models. Discovery warnings never include upstream response bodies, filesystem paths, credentials, prompts, or environment values.

## Prompt logging

Default prompt behavior:

```env
PROMPT_LOGGING=metadata
```

This records lengths and counts, not full prompt text. Safer options:

Malformed streamed llama.cpp tool arguments add value-free failure diagnostics to the request and event logs even in metadata mode. These diagnostics contain structural delta types, byte length, SHA-256, parser category/offset, termination metadata, and the tool name, but never the argument text or tool schema.

```env
PROMPT_LOGGING=off
```

Avoid this except during explicit debugging:

```env
PROMPT_LOGGING=full
```

Full prompt logging will persist prompts to `data/requests.jsonl`.

Request and event metadata logs retain at most 500 records and 5 MiB each by default, using private atomic snapshots. Independently of `PROMPT_LOGGING`, catalog generation journals contain full conversation content and outputs. Closed journals are automatically removed after seven days or earlier to meet a 1 GiB budget; active journals are protected. These archives are available only through the authenticated generation-record endpoint while retained. See [persistence settings](CONFIGURATION.md#persistence) for limits, startup cleanup and operator-backup exclusions.

## Model-management endpoints

Model-management endpoints are disabled by default:

```env
ALLOW_MODEL_MANAGEMENT=false
```

When enabled, they require legacy admin authorization on the Ollama-compatible API listener if `ADMIN_TOKEN` is set. Keep them disabled unless you intentionally want the router to perform pull/create/copy/push/delete.

## Fail-closed behavior

The router defaults to `MODEL_POLICY_MODE=active-only`. If no active model marker exists, model-body generation requests fail closed with `NO_ACTIVE_MODEL`. `REWRITE_REQUESTED_MODEL_TO_ACTIVE` defaults to `false`; enabling it makes client-supplied model names advisory while preserving the marker as the only forwarded model. Responses cannot write `active-model.json`, and the public Responses path has no pull, load, create, copy, push, delete, fallback, or switch operation. Keep `ALLOW_MODEL_MANAGEMENT=false` in production and remove direct LAN access to raw Ollama so clients cannot bypass these controls.

## Raw Ollama exposure

The final target state is that raw Ollama has no LAN `ports` mapping. Publishing raw Ollama alongside the router preserves the bypass path that this router is meant to eliminate.

## Legacy admin token handling

`ADMIN_TOKEN` is retained for compatibility with same-port `/admin/api/*` calls and model-management authorization on the API listener. The token is never returned by `/admin/api/config` or `/admin/api/summary`. The browser admin portal on `ADMIN_PORT` does not ask for or store a token.
