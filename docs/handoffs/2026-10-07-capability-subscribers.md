# Handoff: follow LLM Router model changes, and fall back from Nighttime to Daytime

**To:** the AI agent that maintains a project which sends requests to the LLM Router.
**From:** the LLM Router maintainer. **Date:** 2026-10-07. **Router release:** `cfd7633` (deployed on Rosalina, 192.168.1.4).

Read the whole of Part 1. Then read only your project's section in Part 2. If your project is not listed, Part 1 alone applies.

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
  - Every usable model: `id`, `aliases`, `available`, `slots`, `context_window`, `input_modalities`, `capabilities`, and full `metadata` (for example `metadata.context_safety_reserve` and `metadata.reasoning.efforts`).
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
2. **Make the fallback configurable.** Provide a preferred model (default `nighttime` where you use Nighttime today) and an ordered fallback list (default `daytime`), each settable from your normal configuration source. An empty fallback list disables fallback.
3. **At startup, fetch the capabilities document and keep it.** Do not fail startup when the router is unreachable or Nighttime is offline. Start in a degraded state and recover.
4. **Subscribe for the life of the process.** Keep a background subscriber on `/v1/router/events` (a thread or task in your long-running process). When it disconnects, poll the capabilities endpoint every 30 s with `If-None-Match`, and reconnect with backoff starting at the stream's `retry:` value (3 s), up to 30 s. Treat 60 s without any bytes, keepalives included, as a dead connection.
5. **Pick the service from the current document before each request:**

   | Document state | Action |
   |---|---|
   | `router.accepting_requests` is false | **Wait** and retry later with the same preference. Do not fall back: the whole router is switching. A switch usually finishes in under a few minutes. |
   | The preferred service is listed and `available` | Use it. |
   | The preferred service is in `offline_services`, is listed with `available: false`, or is missing | Use the first fallback that is listed, `available`, and supports what the request needs (vision, tools, reasoning). |
   | Nothing is usable | Report "temporarily unavailable" and retry later. |

6. **Also classify every failed response.** The document can be a few seconds behind. Read `error.code`:

   | HTTP status and `error.code` | Action |
   |---|---|
   | 503 `SERVICE_OFFLINE` | Fall back immediately. This is not a failure: don't count it toward retry caps, budgets or circuit breakers. |
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
  - `model_for(doc, service)` for the target model's limits;
  - `classify_error(status, body)`, which returns `FALLBACK`, `WAIT`, `RETRY` or `FAIL`.
- **JavaScript** (Node 18+ or browsers): <https://github.com/astigmatism/llm-router/blob/main/docs/clients/router-watch.mjs>. It provides the same functions as `watchRouter`, `resolveService`, `modelFor` and `classifyError`.
- **asyncio projects:** port the stream loop to `httpx.AsyncClient.stream("GET", …)`, or run the thread version. Keep the same decision functions.

### Acceptance tests (add to your own suite; no live router required)

- Paired document → `nighttime`. Solo document with `offline_services: [nighttime]` → `daytime`. Nighttime listed but `available: false` → `daytime`.
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

### DeepSeek Harness (`dsh-container`, dev clone `~/projects/dsh-container-dev`, surveyed at `ee91e90`): highest risk

- **Current state:**
  - Provider `local-everyday` ("Nighttime") is pinned to the **full model ID** `qwen3.8-27b-abliterated-q6_k` (`config/settings.yaml:52-81`). Provider `local-ollama` uses `local-active`.
  - The same IDs are hard-coded in `seed/plugins/dsh-router-model-discovery.js:9-27` and in the compaction `modelPolicies` (`seed/profile/managed/cordis.patch.yml:64-70`).
  - While the MTP3 variant was published earlier today, that ID did not exist. The plugin would have thrown `ROUTER_MODEL_NOT_FOUND`.
- **Validation is all-or-nothing.** `synchronizeResidentSettings` (`:375-417`) throws if either model is missing or unhealthy, so a solo configuration freezes every provider update.
- **Worst case, Harness won't start:** `entrypoint.sh:40-43` runs `scripts/migrate-resident-models.mjs --startup`. That script exits 22 when Nighttime is missing or unhealthy, and the container does not start.
- **Required changes:**
  - Move `local-everyday` to the service ID `nighttime`. `daytime` is clearer than `local-active` for the other provider. Migrate existing settings and compaction policies without losing user choices.
  - Daytime stays required. Nighttime becomes optional: when it is offline or unavailable, keep the provider but point its requests at `daytime`, using Daytime's limits (context window, `maxConcurrency`, inputs, reasoning). When Nighttime returns, restore it. Label the fallback in the provider's display name or status.
  - Also handle `SERVICE_OFFLINE` and `BACKEND_DRAINING` at request time (for example in `dsh-llm-retry`), so the gap before the next synchronization doesn't fail requests.
  - Subscribe to `/v1/router/events` and call `synchronize()` on each `capabilities` event. Keep the 30 s poll as the fallback.
  - The startup migration must succeed while Nighttime is offline.
- **Tests and verification that encode the old rule:**
  - `tests/router-provider-remote.test.mjs:149` and `:230` ("missing Nighttime leaves state unchanged").
  - `scripts/verify-router-contract.mjs:18-51` (exactly two healthy providers).
  - `scripts/verify.sh:255-266, :389`.
  - `scripts/verify-resident-client.mjs:100-138` (live request per model).
  - `verify-router-startup.mjs`, `verify-local-model-profiles.mjs`, `verify-dsh-context-compaction.mjs`.

  Today a Portal update would fail verification and roll back during a solo configuration. Accept Nighttime as "offline by design" when it appears in `offline_services`.
- **Release:** `./scripts/check.sh --host` locally, then CI with `--build`, then the Portal update. Production Harness is on 192.168.1.5; another Harness runs on 192.168.1.4. Don't edit either. The vendored `ollama-router/` is a stale router copy; don't use it as a model for this behavior.

### ComfyUI Image Frontend (`~/projects/comfyui-image-frontend`, surveyed at `03dcd4a`)

- **Current state:**
  - Ollama-native `httpx` client (`backend/app/services/ollama.py`).
  - `CIF_OLLAMA_MODEL` defaults to `nighttime` (`backend/app/config.py:240`).
  - Before every compose or evaluate call it reads `/api/tags`. It returns 503 when `nighttime` isn't listed by name, or when `health.available` is false (`ollama.py:165-172, 1016-1021`), so in a solo configuration the prompt assistant stops working.
- **Required changes:**
  - Add `CIF_OLLAMA_FALLBACK_MODELS` (default `daytime`).
  - Choose the model from the capabilities document instead of the `/api/tags` name check.
  - Run the subscriber as a lifespan task next to `_health_loop` (`queue_worker.py:3478-3522`), and report the model in use and whether it is a fallback on the status endpoint and in the UI.
- **Error handling.** Today `error` bodies are ignored and 503s are retried three times with 0.25 s backoff:
  - `SERVICE_OFFLINE` and `BACKEND_UNAVAILABLE`: switch to the fallback without those retries.
  - `BACKEND_DRAINING`: wait longer than 0.25–1 s.
  - Parse `error.code` from the object-form error body.
- **Model settings:**
  - `think: "xhigh"` is hard-coded (`ollama.py:48-50`). Check that the target model lists `xhigh` in `metadata.reasoning.efforts` before sending it.
  - Vision checks must confirm the target model has `image` in `input_modalities`.
- **Content risk.** Nighttime is chosen on purpose (`docs/audits/creative-direction-2026-09-12.md`, and the `krea2-uncensored-v1` workflow). Daytime may refuse or return output that fails the JSON schema. Report "Nighttime offline; Daytime declined" plainly instead of retrying in a loop.
- **Housekeeping:**
  - `.env.example:123` and `README.md:323` still say `192.168.1.21`; the router is `192.168.1.4`.
  - Compose doesn't join `local-ai-ollama_default`, so `ai-router` won't resolve.
- **Tests:**
  - Extend the fake router in `backend/tests/fake_services.py:79-111` with the capabilities and events endpoints and the error codes.
  - Run with `PYTHONPATH=backend python3 -m pytest -q` and `make validate`.
  - Update the router prose in `scripts/generate_traceability.py:143-174`, then regenerate `docs/traceability.md`.

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
