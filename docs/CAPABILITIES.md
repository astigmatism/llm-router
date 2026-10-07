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
    "service": "daytime",                // the stable ID to send for this model
    "display_name": "Qwen3.8 27B Q6_K (160K)",
    "aliases": ["local-active", "daytime"],
    "available": true,                   // backend healthy and router accepting requests
    "slots": 1,                          // concurrent generations the router admits
    "context_window": 163840,            // per request; every slot has the full window
    "input_modalities": ["text", "image"],
    "capabilities": ["completion", "thinking", "tools", "vision"],
    "nsfw": false,                       // declared by the runtime; true for abliterated models
    "capability_score": 68.3,            // higher is more capable; see "Capability score"
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
| `capability_profile` | Qualified flags from the runtime: `text`, `streaming`, `vision`, `tools`, `reasoning`, `speculative`, `nsfw`, and the profile `name` |
| `nsfw` | `true` when the runtime declares the model abliterated (refusals removed, suitable for NSFW content), `false` when it declares it not, `null` when the catalog does not say. Never inferred from a model's name. |
| `capability_score` | `{value, version, basis, components: {size, context, features}, inputs: {parameters, bits_per_weight, context_window, vision, tools, reasoning}}`; see below |
| `placement` | `gpu_count`, `gpus` (text GPU card names, in the runtime's text GPU order), `vision_encoder` (`gpu`/`cpu`), `vision_gpu`, `vision_gpu_shared`, `exclusive`. GPU UUIDs, paths and URLs are never published. |
| `live` | What the running process reports: `slots`, `slot_context_window`, `vision`, `model_context_window` (GGUF training context), `parameters`, `size_bytes`, `build`. Null when the backend cannot be reached. |
| `parameter_size`, `family` | `parameter_size` is formatted from the live parameter count (for example `27.3B`); `family` comes only from the catalog. Each is null when unknown, never guessed. |
| `qualification_notes` | The runtime's deployment notes for this configuration, such as unqualified-experiment warnings |
| `sources.backend_props` | Whether `/props` answered |

`model_context_window` is now the model's native training context when llama.cpp reports it. `context_window` remains the per-request limit to budget against.

### Capability score

`capability_score` ranks the models of this router, from 0 to 100, higher being more capable. It is computed automatically from published facts only. Availability, load and speed never change it, so it moves only when a model or its configuration changes.

| Component | Points | Source |
|---|---:|---|
| `size` | up to 55 | Parameter count on a log scale (1B = 0, 1T = 55), multiplied by quantization fidelity. Fidelity comes from the effective bits per weight (file size × 8 ÷ parameters): 1.0 at 8 bits or more, 0.97 at 6, 0.94 at 5, 0.88 at 4, 0.75 at 3, 0.5 at 2, linear between. Both counts come from the running llama.cpp process. |
| `context` | up to 25 | Per-request `context_window` on a log scale (4K = 0, 256K or more = 25) |
| `features` | up to 20 | Vision 7, tools 7, reasoning 6 |

On 2026-10-07 production scored Daytime (27B Q6_K_XL, 160K) **68.3** and Nighttime (27B abliterated Q6_K, 96K) **64.9**. Both are 27B models, so Daytime ranks higher on its larger context and higher precision. Parameter count and size are remembered for each model revision, so a briefly unreachable backend keeps its score. A model whose facts were never observed scores `null` with `basis: "incomplete"`. `version` changes if the formula changes.

The score cannot measure how well a model actually answers. It can't weigh a fine-tune or abliteration against its base model, or a mixture-of-experts model (counted by total parameters) against a dense one. Use measured benchmarks such as Bench Studio's for those decisions.

### Choosing by capability

To choose by what a model can do rather than by name, filter `models` and take the highest `capability_score`:

- **Most capable model:** keep every model with `available` true and the features the request needs, then pick the highest score.
- **Most capable NSFW model:** apply the same filter, keeping only models where `nsfw` is `true`.
- **NSFW first, then anything:** if no NSFW model is usable, choose the most capable usable model instead.

The reference clients provide this as `pick_service(doc, nsfw=True, require=["vision"], fallback_any=True)` (Python) and `pickService(doc, { nsfw: true, require: ['vision'], fallbackAny: true })` (JavaScript). Both return the model's `service` ID, `WAIT` while the router drains, or `UNAVAILABLE`. Send the returned `service` (for example `nighttime`) as the request's model.

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

## Preferring Nighttime with a Daytime fallback

The router never substitutes one service for another; a client that prefers `nighttime` decides when to use `daytime` instead. `daytime` (and `local-active`) exists in every AI Runtime configuration. `nighttime` exists only in paired configurations, and the model behind it can change between them; for example, an MTP3 variant has a different canonical ID. Send service IDs, never canonical IDs.

Before a request, resolve the service from the current document:

| Document state | Action |
|---|---|
| `router.accepting_requests` is false (draining for a switch, or maintenance) | **Wait** and retry the same choice later. A switch normally finishes within a few minutes, and the configuration may be different afterwards. Do not fall back: Daytime is draining too. |
| The preferred model is listed and `available` | Use the preferred service. |
| The preferred service is in `offline_services`, is listed with `available: false`, or is absent | Use the first listed, `available` fallback whose capabilities cover the request. |
| Nothing usable | Report it as temporarily unavailable and retry later. |

The document can lag a request by up to a poll interval, so classify each failed response too. Every router error body carries `error.code`:

| Response | Meaning | Action |
|---|---|---|
| 503 `SERVICE_OFFLINE` | The current configuration deliberately stops this service | Fall back immediately; do not count it as a failed attempt |
| 503 `BACKEND_UNAVAILABLE` | The service's backend is not healthy | Fall back if one is available; otherwise retry with backoff |
| 404 `MODEL_NOT_FOUND` | The ID is not offered at all | Fall back if configured, and log it: it usually means a stale or misspelled ID |
| 503 `BACKEND_DRAINING` or `MAINTENANCE_MODE` | Router is switching configuration or in maintenance | Wait and retry the same service; resolve again afterwards |
| Other 5xx, 408, 429, or a network error | Transient | Retry the same service with backoff |
| Other 4xx | The request is invalid | Fail; do not retry or fall back |

Native Ollama and Chat Completions errors use `{"error": {"code": "…", "message": "…"}}`. Responses errors use the OpenAI shape `{"error": {"message": "…", "type": "server_error", "param": "model", "code": "…"}}`. A client library that expects a string `error` must handle the object form.

Return to the preferred service as soon as it is available again; do not stay on the fallback. When the service changes, take limits from the model that will actually serve the request: `context_window`, `metadata.context_safety_reserve`, `slots`, `input_modalities` and `capabilities`. Daytime and Nighttime differ in context size, and either may be larger. Daytime is not the abliterated model and may refuse requests that Nighttime answers. Its single slot is shared with coding agents, so fallback requests can queue behind long generations; the router has no queue deadline.

The [client handoff](handoffs/2026-10-07-capability-subscribers.md) applies these rules to each consuming project. Choosing `pick_service(doc, nsfw=True, fallback_any=True)` expresses the same Nighttime-then-Daytime rule by capability instead of by name. It also keeps working if an NSFW model is ever served under another ID. Reference clients implement the subscriber, `resolve`, `pick_service` and the error classification: [Python](clients/router_watch.py) (standard library) and [JavaScript](clients/router-watch.mjs) (Node 18+, browsers). The router's test suite runs the JavaScript client against the router, and `python3 -m unittest discover -s docs/clients` tests the Python client.
