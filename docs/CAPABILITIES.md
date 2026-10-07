# Deployment capabilities and change events

Clients use two router endpoints to learn which models they can use right now, what each model can do, and when that changes:

- `GET /v1/router/capabilities` returns one document describing the whole deployment. Read it at startup.
- `GET /v1/router/events` is a [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html) stream. It pushes a new document when something changes.

Both endpoints are served on the API listener (`http://192.168.1.4:11434`, container `http://ai-router:11434`). They use the same access posture as `/v1/models`: no token and no CORS headers. They are intended for services on the trusted LAN and Docker network. Neither endpoint generates, loads or prewarms a model.

## Where the facts come from

| Source | What it supplies |
|---|---|
| AI Runtime catalog (`active-model.json`, written atomically and followed by `POST /admin/api/reload-config`) | Which models are resident, service aliases (`daytime`, `nighttime`, `local-active`), display names, qualified tools/vision/reasoning, slot count and context, output/reasoning policy, GPU placement, the selected configuration, and services that configuration deliberately stops |
| Running llama.cpp processes | Health (`/health`), actual slots and per-slot context (`/slots`), GGUF facts (`/v1/models` `meta`: native context, parameter count, size), vision support and build (`/props`) |
| The router | Drain and maintenance state, and active/queued generations per model |

llama.cpp cannot report service identity, aliases, policy or qualification. It also cannot report a service that is not running: in an exclusive configuration Nighttime has no process to ask. The runtime catalog is therefore authoritative for what is offered. llama.cpp verifies it. When the running process contradicts the catalog, the router flags that model; it never silently trusts either source.

## `GET /v1/router/capabilities`

The response is always HTTP 200 with a truthful document, including when no model is usable. It includes `Cache-Control: no-cache` and an `ETag`; send `If-None-Match` to receive 304 while nothing has changed. Add `?include=load` for current slot occupancy.

```jsonc
{
  "object": "router.capabilities",
  "schema_version": 1,
  "revision": "q8Zk…",                  // content hash; equals the plain ETag and the event id
  "observed_at": "2026-10-07T02:13:28.004Z", // when this router first saw this revision
  "complete": true,
  "warnings": [],
  "router": {
    "name": "llm-router", "version": "0.1.0",
    "accepting_requests": true,         // false while draining or in maintenance
    "draining": false, "drain_reason": null, "maintenance": false
  },
  "configuration": {                     // null when the runtime publishes none
    "id": "qwen27b-q6k-with-nighttime", "exclusive": false,
    "runtime_revision": "cc83b68…", "published_at": "2026-10-07T02:13:27.697Z"
  },
  "default_model": "qwen3.8-27b-ud-q6_k_xl-tensor-next",   // used when a request omits model
  "models": [{
    "id": "qwen3.8-27b-ud-q6_k_xl-tensor-next",
    "display_name": "Qwen3.8 27B Q6_K (160K)",
    "aliases": ["local-active", "daytime"],
    "available": true,                   // backend healthy and router accepting requests
    "slots": 1,                          // concurrent generations the router admits
    "context_window": 163840,            // per request; every slot has the full window
    "input_modalities": ["text", "image"],
    "capabilities": ["completion", "thinking", "tools", "vision"],
    "metadata": { /* identical to this model's x_ollama_router in /v1/models */ }
  }],
  "offline_services": [],                // see below
  "ids": {                               // every ID accepted for inference -> canonical model
    "qwen3.8-27b-ud-q6_k_xl-tensor-next": "qwen3.8-27b-ud-q6_k_xl-tensor-next",
    "local-active": "qwen3.8-27b-ud-q6_k_xl-tensor-next",
    "daytime": "qwen3.8-27b-ud-q6_k_xl-tensor-next",
    "qwen3.8-27b-abliterated-q6_k": "qwen3.8-27b-abliterated-q6_k",
    "nighttime": "qwen3.8-27b-abliterated-q6_k"
  },
  "load": {                              // only with ?include=load
    "qwen3.8-27b-ud-q6_k_xl-tensor-next": { "active": 1, "queued": 0, "free_slots": 0 }
  }
}
```

`models` lists canonical residents once each; aliases appear in `aliases` and `ids`. The shapes this covers include:

- two independent services, each with one slot (paired Daytime + Nighttime);
- one exclusive service on every GPU with one slot, or with two slots (`slots: 2`, each at the full `context_window`).

`metadata` includes everything in [model discovery](MODEL_DISCOVERY.md), plus these resident fields:

| Field | Meaning |
|---|---|
| `capability_profile` | Qualified flags from the runtime: `text`, `streaming`, `vision`, `tools`, `reasoning`, `speculative`, and the profile `name` |
| `placement` | `gpu_count`, `gpus` (text GPU card names, in the runtime's text GPU order), `vision_encoder` (`gpu`/`cpu`), `vision_gpu`, `vision_gpu_shared`, `exclusive`. GPU UUIDs, paths and URLs are never published. |
| `live` | What the running process reports: `slots`, `slot_context_window`, `vision`, `model_context_window` (GGUF training context), `parameters`, `size_bytes`, `build`. Null when the backend cannot be reached. |
| `parameter_size`, `family` | `parameter_size` is formatted from the live parameter count (for example `27.3B`); `family` comes only from the catalog. Each is null when unknown, never guessed. |
| `qualification_notes` | The runtime's deployment notes for this configuration, such as unqualified-experiment warnings |
| `sources.backend_props` | Whether `/props` answered |

`model_context_window` is now the model's native training context when llama.cpp reports it. `context_window` remains the per-request limit to budget against.

### Offline services

An exclusive configuration stops Nighttime to give Daytime every GPU. The runtime then publishes Nighttime under `offline_services`:

```json
"offline_services": [{
  "model": "qwen3.8-27b-abliterated-q6_k",
  "aliases": ["nighttime"],
  "display_name": "Qwen3.8 27B Abliterated Q6_K (128K)",
  "role": "everyday",
  "reason": "exclusive_configuration"
}]
```

Inference requests for an offline ID return **HTTP 503 `SERVICE_OFFLINE`**, and so does `GET /v1/models/<id>`. An unknown ID still returns 404 `MODEL_NOT_FOUND`. `/v1/models` and `/api/tags` continue to list only selectable models. Treat `SERVICE_OFFLINE` as "retry after the configuration changes", not as a configuration error. The router never redirects an offline service to another model.

### Warnings and completeness

`complete` is true only when the document has no warnings, at least one model exists, and every model's metadata is complete.

- **Catalog-level warnings** never block inference with an otherwise valid catalog. Their invalid values are dropped:
  - `INVALID_RUNTIME_CONFIGURATION`
  - `INVALID_OFFLINE_SERVICES`
  - `OFFLINE_SERVICE_CONFLICT`: an offline declaration names a running ID; the running model wins.
- **Discovery failures** appear as their code, such as `INVALID_MODEL_CATALOG` or `NO_ACTIVE_MODEL`. In that case `models` is empty.
- **Per-model warnings** (in `metadata.warnings`) report a running process that contradicts the catalog. Each makes that model incomplete:
  - `BACKEND_SLOT_COUNT_MISMATCH`
  - `BACKEND_SLOT_CONTEXT_MISMATCH`
  - `BACKEND_VISION_MISMATCH`: vision is advertised but `/props` reports none.

  AI Runtime verifies these before publishing, so they indicate a real fault. An unavailable `/props` is not a contradiction: it sets `sources.backend_props: false` and leaves `live.vision` and `live.build` null.

## `GET /v1/router/events`

```text
retry: 3000

event: capabilities
id: q8Zk…
data: {"object":"router.capabilities", … complete document without load …}

event: load
data: {"revision":"q8Zk…","load":{"qwen3.8-27b-ud-q6_k_xl-tensor-next":{"active":0,"queued":0,"free_slots":1}}}

: keepalive
```

- Every connection starts with the full current `capabilities` document and `load`. A reconnecting client needs nothing else; `Last-Event-ID` is not replayed.
- A `capabilities` event is sent whenever the revision changes:
  - **Immediately** after a runtime publication (`reload-config`), drain begin/end, or maintenance change.
  - **Within `ROUTER_CAPABILITY_POLL_MS`** (default 5 s) after a backend health change, or after a marker edit that skipped the reload notification. This poll runs only while someone is subscribed.
- The same revision is never sent twice in a row. A state that returns (for example, drain then undrain) reuses its earlier revision.
- `load` events are coalesced to at most one per second and sent only when occupancy changes. Load never changes `revision`.
- A comment heartbeat is sent every `ROUTER_EVENTS_HEARTBEAT_MS` (default 15 s).
- Past `ROUTER_EVENTS_MAX_SUBSCRIBERS` (default 64), the stream returns 503 `TOO_MANY_SUBSCRIBERS`. A subscriber that stops reading and accumulates more than 1 MiB is disconnected. Router shutdown ends all streams.

During an AI Runtime configuration switch, a subscriber sees this sequence:

1. `router.draining: true` (`accepting_requests: false`; every model `available: false`).
2. The new catalog: new `configuration`, models, aliases and `offline_services`.
3. `draining: false`.

## Client pattern

1. On start, `GET /v1/router/capabilities`. Choose models from `models` and `ids`. Budget prompts with `context_window` and `metadata.context_safety_reserve`. Schedule at most `slots` concurrent requests per model.
2. Open `/v1/router/events`. On each `capabilities` event, replace your state if the `id` differs from your current revision.
3. If the stream drops, reconnect after `retry`. Meanwhile poll the capabilities endpoint every 30 seconds with `If-None-Match`.
4. Store stable service IDs (`daytime`, `nighttime`), never `upstream_model`. Retain your last safe limits when a model becomes incomplete or unavailable.
5. Treat `available: false` and `SERVICE_OFFLINE` as temporary. Treat a disappeared ID with no offline entry as a configuration change.

```bash
curl -s http://192.168.1.4:11434/v1/router/capabilities?include=load
curl -N http://192.168.1.4:11434/v1/router/events
```
