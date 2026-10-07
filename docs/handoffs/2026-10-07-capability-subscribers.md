# Handoff: follow LLM Router model changes, and fall back from Nighttime to Daytime

**To:** the AI agent that maintains a project which sends requests to the LLM Router.
**From:** the LLM Router maintainer. **Date:** 2026-10-07. **Router release:** `cfd7633` (deployed on Rosalina, 192.168.1.4).

The authoritative rules are in the **[LLM Router client contract](https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md)**, which ends with a conformance checklist your project must meet. Part 1 summarizes them; where they differ, the contract wins.

Read the contract, then Part 1, then only your project's section in Part 2. If your project is not listed, the contract and Part 1 apply.

---

## Part 1: what every project must do

### Why this is needed

AI Runtime changes the models behind the router by hand, and with no warning to clients:

- **Paired configurations** run **Daytime** and **Nighttime** side by side, each with one request slot.
- **Solo configurations** run Daytime alone on every GPU and **stop Nighttime completely**. A solo configuration may give Daytime one or two slots.
- Within either kind, the context size can change, and so can the model behind a name. Today the Nighttime model's full ID changed twice (`qwen3.8-27b-abliterated-q6_k` → `qwen3.8-27b-abliterated-q6_k-mtp3` → back), and its context went from 128K to 96K.

`daytime` (and its legacy alias `local-active`) exists in **every** configuration. `nighttime` exists only in paired configurations. The router never quietly substitutes one model for another. The owner's decision is: **a service that wants Nighttime must use Daytime instead whenever Nighttime is unavailable, and return to Nighttime when it comes back.**

### Router endpoints

The base address is `http://192.168.1.4:11434` on the LAN, or `http://ai-router:11434` from a container on Rosalina's `local-ai-ollama_default` network. Neither endpoint needs a token.

- **`GET /v1/router/capabilities`:** one JSON document describing what can be used right now.
  - Every usable model: `id`, `service` (the stable ID to send), `aliases`, `available`, `slots`, `context_window`, `input_modalities`, `capabilities`, and full `metadata` (for example `metadata.context_safety_reserve` and `metadata.reasoning.efforts`).
  - Each model also carries `nsfw` and `capability_score`:
    - `nsfw` is `true` for abliterated models (refusals removed). The runtime declares it per model; today Nighttime is `true` and Daytime `false`.
    - `capability_score` is an automatic 0–100 ranking from parameter count, quantization, context and features (higher is more capable). Today Daytime scores about 68.3 and Nighttime about 64.9.
  - `ids`, which maps every accepted ID to its current model.
  - `offline_services`: services the current configuration deliberately stopped, such as `nighttime` with reason `exclusive_configuration`.
  - `configuration`: the AI Runtime configuration ID.
  - `router.accepting_requests`: false while a switch is draining requests.
  - Send `If-None-Match` with the last `ETag` to get a 304 when nothing has changed. Add `?include=load` for active, queued and free slots per model.
- **`GET /v1/router/events`:** a Server-Sent Events stream.
  - Every connection starts with the full document as `event: capabilities` (with `id:` set to its `revision`), followed by `event: load`.
  - A new `capabilities` event arrives whenever anything changes: immediately for a runtime publication or drain, within about 5 s for a backend health change.
  - `load` events (slot occupancy) arrive at most once per second, and `: keepalive` comments every 15 s.
  - A switch arrives as three events: draining, the new configuration, accepting again. Every `capabilities` event is the complete document, so replace your copy whenever `revision` changes.
- **Full contract:** <https://github.com/astigmatism/llm-router/blob/main/docs/CAPABILITIES.md>, especially the section "Preferring Nighttime with a Daytime fallback".

### Required behavior

1. **Send service IDs only.** Use `nighttime` and `daytime` (`local-active` still works for Daytime). Never configure, store or compare full model IDs such as `qwen3.8-27b-…`; they change between configurations. To record which model actually served a request, log the response's `model` field or `ids[service]`, and treat it as information only.
2. **Make the choice configurable.** Use whichever of these fits why you want Nighttime:
   - **By capability (preferred when you want Nighttime because it is uncensored):** choose the most capable usable model with `nsfw: true` that has the features you need, and fall back to the most capable usable model of any kind. The reference clients' `pick_service(doc, nsfw=True, require=[...], fallback_any=True)` (`pickService` in JavaScript) does exactly this. It returns the model's `service` ID to send, `WAIT`, or `UNAVAILABLE`. With today's models it gives `nighttime` in a paired configuration and `daytime` in a solo one.
   - **By name:** provide a preferred model (default `nighttime`) and an ordered fallback list (default `daytime`), using `resolve(doc, preferred, fallbacks)`.

   Make it settable from your normal configuration source, for example "NSFW required / preferred / not needed" or the preferred and fallback IDs. Fallback must be possible to disable.
3. **At startup, fetch the capabilities document and keep it.** Do not fail startup when the router is unreachable or Nighttime is offline. Start in a degraded state and recover.
4. **Subscribe for the life of the process.** Keep a background subscriber on `/v1/router/events` (a thread or task in your long-running process). When it disconnects, poll the capabilities endpoint every 30 s with `If-None-Match`, and reconnect with backoff starting at the stream's `retry:` value (3 s), up to 30 s. Treat 60 s without any bytes, keepalives included, as a dead connection.
5. **Pick the service from the current document before each request:**

   | Document state | Action |
   |---|---|
   | `router.accepting_requests` is false | **Wait** and retry later with the same preference. Do not fall back: the whole router is switching. A switch usually finishes in under a few minutes. |
   | The preferred service is listed and `available` | Use it. |
   | The preferred service is in `offline_services`, is listed with `available: false`, or is missing | Use the first fallback that is listed, `available`, and supports what the request needs (vision, tools, reasoning). By capability: the most capable such model, NSFW ones first. |
   | Nothing is usable | Report "temporarily unavailable" and retry later. |

6. **Also classify every failed response.** The document can be a few seconds behind. Read `error.code`:

   | HTTP status and `error.code` | Action |
   |---|---|
   | 503 `SERVICE_OFFLINE` | Fall back immediately (with `pick_service`, pass the failed service in `exclude`). This is not a failure: don't count it toward retry caps, budgets or circuit breakers. |
   | 503 `BACKEND_UNAVAILABLE` | Fall back if a fallback is available; otherwise retry with backoff. |
   | 404 `MODEL_NOT_FOUND` | Fall back if one is configured, and log a warning (it usually means a stale or misspelled ID). |
   | 503 `BACKEND_DRAINING` or `MAINTENANCE_MODE` | Wait (backoff from 2 s up to 30 s, for at least 10 minutes in total), then pick the service again from step 5. |
   | Other 5xx, 408, 429, or a network or timeout error | Retry the same service with backoff. |
   | Other 4xx | The request is wrong. Do not retry or fall back. |

   Error bodies look like this:

   ```json
   {"error": {"code": "SERVICE_OFFLINE", "message": "Qwen3.8 27B Abliterated Q6_K (128K) is offline in runtime configuration \"flash-next-solo-128k\" (exclusive_configuration). Select a runtime configuration that includes it, or use an available model."}}
   ```

   `/api/chat` and `/v1/chat/completions` return that shape. `/v1/responses` returns the OpenAI shape: `{"error": {"message": "…", "type": "server_error", "param": "model", "code": "SERVICE_OFFLINE"}}`. Both carry `error.code`. Ollama libraries that expect `error` to be a string must handle the object form.

7. **Go back to Nighttime as soon as it is available again.** Don't stay on the fallback. Requests already running are never moved or cut: the router finishes accepted work before a switch.
8. **Take limits from the model that will actually answer.** Before each request, use that model's `context_window`, `metadata.context_safety_reserve` (1024) and `slots`. Budget so that formatted input + requested output + reserve ≤ `context_window`, and trim or summarize history when the service changes. Either model can have the larger window. Don't hard-code 128K, 131072, or any other context size. Don't send more concurrent requests to a model than its `slots`.
9. **Respect Daytime's behavior and capacity.**
   - Daytime is **not** the abliterated model, so it may refuse prompts that Nighttime answers. Surface a refusal or an unusable answer clearly, and don't retry it in a loop.
   - Daytime's slots (usually one) are shared with the coding agents, so fallback requests can wait in its queue for a long time. The router has no queue deadline. Use read timeouts long enough for queueing plus generation, or stream.
10. **Show what is happening.** Log every switch with its reason (for example `nighttime → daytime: SERVICE_OFFLINE in flash-next-solo-128k`). If your project has a status page or UI, show the service in use and whether it is a fallback.

### Reference code

These are tested against the router, including production. Copy one of them, or port it.

- **Python** (standard library, 3.9+): <https://github.com/astigmatism/llm-router/blob/main/docs/clients/router_watch.py>. It provides:
  - `RouterWatch(base).fetch()` for the startup document;
  - `RouterWatch.run_forever(stop)`, to run in a daemon thread;
  - `resolve(doc, "nighttime", ["daytime"])`, which returns a service ID, `WAIT`, or `UNAVAILABLE`;
  - `pick_service(doc, nsfw=True, require=["vision"], exclude=(), fallback_any=True)`, the capability-based equivalent;
  - `model_for(doc, service)` for the target model's limits;
  - `classify_error(status, body)`, which returns `FALLBACK`, `WAIT`, `RETRY` or `FAIL`.
- **JavaScript** (Node 18+ or browsers): <https://github.com/astigmatism/llm-router/blob/main/docs/clients/router-watch.mjs>. It provides the same functions as `watchRouter`, `resolveService`, `pickService`, `modelFor` and `classifyError`.
- **asyncio projects:** port the stream loop to `httpx.AsyncClient.stream("GET", …)`, or run the thread version. Keep the same decision functions.

### Acceptance tests (add to your own suite; no live router required)

- Paired document → `nighttime`. Solo document with `offline_services: [nighttime]` → `daytime`. Nighttime listed but `available: false` → `daytime`. With selection by capability, the same three documents give the same answers.
- `accepting_requests: false` → wait, with no switch. Fallback list empty and Nighttime offline → unavailable, not an exception.
- Nighttime offline → available again: the next request uses `nighttime`.
- Each error code in the table, with the exact body shapes above, produces the stated action. `SERVICE_OFFLINE` does not consume retry or budget allowances.
- Limits switch with the model. For example, a 96K Nighttime and a 160K Daytime produce different history budgets.
- Startup with the router unreachable doesn't crash, and the subscriber recovers after the stream drops.
- No full model ID is persisted in configuration or settings.
- **Optional live check (read-only):** `curl -s http://192.168.1.4:11434/v1/router/capabilities | python3 -m json.tool`. Never switch AI Runtime configurations to test; that is the owner's operation.

### Boundaries

Change only your own project. Don't modify the router, AI Runtime, or production containers or checkouts. Release through your project's normal workflow: commit, push, then the owner's Portal "Update and restart". Don't deploy unless you've been asked to.

---

## Part 2: project-specific findings (from a read-only survey on 2026-10-07)

Line numbers are from the surveyed commits; confirm them before editing.

### DeepSeek Harness (`dsh-container`)

Superseded by the targeted handoff [deepseek-harness.md](deepseek-harness.md). It is based on `origin/main` at `e82ce7d`, which already supports an optional Nighttime. The owner decided Harness does **not** fall back automatically: Nighttime is shown as offline or unavailable, and the user switches the session.

### ComfyUI Image Frontend (`~/projects/comfyui-image-frontend`)

Superseded by the targeted handoff [comfyui-image-frontend.md](comfyui-image-frontend.md). The owner's rule: use the most capable NSFW model, and the most capable non-NSFW model when no NSFW model is usable.

### Playroom (`~/projects/playroom`, surveyed at `355b03c`)

- **Current state:**
  - `httpx` Chat Completions (`playroom/agent.py:53-54`).
  - `LLM_MODEL` defaults to `nighttime` (`playroom/config.py:15`).
  - No discovery: a vision and tools "qualify" request runs when agent mode starts (`agent.py:76-91`).
  - `raise_for_status` treats every error the same. Three attempts and a session-wide cap of six retries, then the session pauses (`agent.py:67-73, 232-234`).
- **Required changes:**
  - Add `LLM_FALLBACK_MODELS` (default `daytime`).
  - Choose the model per request.
  - Classify errors: `SERVICE_OFFLINE` switches without using `infra_retries`; `BACKEND_DRAINING` waits, without pausing the session or using retries.
  - Run the qualify request against the model actually chosen, and run it again when the model behind the service changes.
  - Playroom requires `vision` and `tools`; check the target model has both.
  - Run the subscriber as an asyncio lifespan task next to `monitor()` (`playroom/app.py:32-36`). Show "nighttime" or "daytime (fallback)" where the UI shows the model (`service.py:75`).
- **Budget bug to fix.** Each request reserves `LLM_CONTEXT_TOKENS + LLM_MAX_OUTPUT_TOKENS` (133,120). A failed request settles with `actual=None` and keeps the full reservation (`store.py:72-89`), so about three router 503s use up the 500,000-token session limit. A request the router rejected before generating anything must release its reservation. Take the context size for budgeting from the model's `context_window`, not the fixed `131072`.
- **Timeout.** `LLM_TIMEOUT=90` s is short for a request queued behind Daytime coding work. Raise it, or treat a timeout as retry rather than pause.
- **Tests:** keep the `playroom.agent.httpx.AsyncClient` seam used by `tests/test_core.py:167-191`. Run `.venv/bin/python -m pytest -q`; the frontend builds with `npm run build`. The deployment checkout is Portal-managed: commit to `main` and let the owner update.

### Bench Studio (`~/projects/bench-studio-dev`; never edit `~/projects/bench-studio`): do **not** fall back

- **Benchmarks must never swap models.** A benchmark's identity is its model, so Bench Studio must **not** use the Daytime fallback. Its existing rule "an alias never falls back" (`tests/test_integration.py:116-118`) is correct and stays.
- **What to change is the classification.** When Nighttime is stopped by a solo configuration it vanishes from both router discovery and runtime `services[]`. `resolve` (`common.py:89-92, 106-107`) then raises `ModelConfigurationChanged`, and the run is marked **invalid**. Instead:
  - When the target appears in `offline_services`, report it as unavailable ("offline in configuration X"), so queued runs wait or block rather than fail.
  - When `router.accepting_requests` is false (draining), wait. The 90 s grace in `runner.check_current` (`runner.py:287-320`) may be too short for a solo switch.
- **Subscriber:** run it as a background thread in the long-running runner (`runner.py:534-557`) and write events to the database, so the UI's existing `/api/events` stream (`api.py:536-571`) picks them up. Show offline services and the configuration ID in the model list.
- **Data sources:** the capabilities document provides `placement.gpus` and slot `load`. Keep using AI Runtime `/api/status` for container identity drift; the router doesn't publish container IDs.
- **Tests:** `PYTHONPATH=.:vendor .venv/bin/pytest tests vendor/tests`. Deploy by pushing the dev clone's `main`, then the Portal update.

### Not affected

- **pokebot:** no LLM code yet. Apply Part 1 when it starts using the router.
- **Open WebUI:** uses the native connection and the router repo's `integrations/open-webui` helpers. It cannot fall back by itself, so presets based on `nighttime` show `SERVICE_OFFLINE` during a solo configuration. That's a router-side follow-up, not part of this handoff.
- **Any other consumer** (for example the Samus client that sets seeds): apply Part 1.
