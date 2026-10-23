# Security Notes

The deployed primary catalog uses unrestricted output, unrestricted thinking and template-default effort. Its current policy, context recovery, durable archives and client behavior are defined in [Primary integration](PRIMARY_INTEGRATION.md). Legacy singleton-marker examples below are not primary production defaults.

Primary generation archives always retain full request/output content, including reasoning and image data, separately from `PROMPT_LOGGING` metadata logs. They require protected persistent storage; retrieval always requires administrator authentication. See the primary storage policy before operating this profile.

## Network boundary

This router is intended for a trusted local network. The human admin portal is intentionally unauthenticated and listens on a separate port, defaulting to `11435`. Anyone who can reach that port can view runtime state, read the archived prompt payload of any request the router has served, and trigger admin actions such as prewarm, test chat, active-marker reload, runtime drain, and maintenance-mode toggle. Payload reads and runtime control answer without a token on `11435` because the page that shows a release in progress has to be able to drain the router; on the API listener the same routes still require `ADMIN_TOKEN`. Treat the payload view as what it is: prompt text, tool arguments and outputs, kept for `GENERATION_RETENTION_DAYS`, readable by anyone on the trusted network.

Keep the admin port bound only to trusted local/LAN interfaces. Do not publish it to the public internet, a shared VPN, or an untrusted reverse proxy.

## API/admin port split

Default published ports:

```text
11434 = Ollama-compatible router API
11435 = unauthenticated human admin portal
```

The Ollama-compatible API remains separate from the browser portal. Requests to `/api/*` on the admin port return a router error instead of proxying to Ollama.

The API listener also exposes the stateless `/v1/responses` compatibility endpoint and `/responses` alias. In legacy single-marker mode these routes target the active marker model through Ollama `/api/chat`; in resident catalog mode they target the published catalog entry the request names. Either way they provide no model-management operation or arbitrary upstream path. The exact `ROUTER_MODEL_ALIAS` is admitted for the active slot — unconditionally in single-marker mode, and in catalog mode only where the configuration's default entry declares it, so a configuration that does not name it answers `404 MODEL_NOT_FOUND`. When `REWRITE_REQUESTED_MODEL_TO_ACTIVE=true`, any other non-empty requested identifier is advisory and is replaced with the marker model; when false, other mismatches are rejected. Neither mode lets the client select or load a model the operator did not publish.

The Responses `prompt_cache_key` compatibility field is accepted only when it is a string and is discarded during Responses translation, before backend-adapter validation or response construction. The raw value is never forwarded, logged, persisted, copied into errors or admin history, used for authorization/model/slot selection, or treated as a semantic response-cache key. Metadata may state only that the field was present and accepted-but-ignored. This does not claim OpenAI prompt-cache-key semantics for the local backend.

`GET /v1/models` and `GET /v1/models/{alias}` use the same API-listener trust/authentication boundary as Responses. They expose one stable alias plus the current physical `upstream_model` already visible in router health. Discovery calls only Ollama `/api/ps` and `/api/show`; it does not enumerate `/api/tags`, generate, prewarm, load, pull, or manage models. Discovery warnings never include upstream response bodies, filesystem paths, credentials, prompts, or environment values.

## Catalog publication

A machine that runs models but not this router hands them over with `PUT /admin/api/hosts/<host>/catalog`, authenticated with `CATALOG_PUSH_TOKEN`. That token is a write credential for exactly one thing: the catalog of a declared host. It reads nothing — not requests, not prompts, not records — and it cannot change drain or maintenance state. Prefer it over `ADMIN_TOKEN` for a runtime so a compromised publisher cannot drive the router. With neither token configured the endpoint refuses with 503 rather than accepting an unauthenticated write.

Because publication rides the admin listener, which is unauthenticated by design, a catalog can be pushed by anything that can reach that port: keep it on the trusted network, as above. Stored catalogs are `0640` under a `0750` directory. They are not secrets, but they are one machine's account of its hardware, and they are what a compromised publisher could use to point the router at a backend of its choosing — which is why the router never publishes a published `backend_url` back to clients.

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

Request and event metadata logs retain at most 5000 request records (32 MiB) and 2000 event records (5 MiB) by default, using private atomic snapshots. Independently of `PROMPT_LOGGING`, catalog generation journals contain full conversation content and outputs. Closed journals are automatically removed after seven days or earlier to meet a 1 GiB budget; active journals are protected. While retained they are readable through the generation-record endpoint (token on the API listener, none on the admin listener) and through the portal payload view, which parses a bounded prefix rather than the whole file. See [persistence settings](CONFIGURATION.md#persistence) for limits, startup cleanup and operator-backup exclusions.

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
