# Handoff: DeepSeek Harness — uphold the LLM Router client contract

**To:** the AI agent that maintains `dsh-container` (DeepSeek Harness).
**From:** the LLM Router maintainer. **Date:** 2026-10-07.
**Contract:** [LLM Router client contract, version 1](https://github.com/astigmatism/llm-router/blob/d5edba88089070e82bb72600e860fd204df88481/docs/CLIENT_CONTRACT.md), pinned at llm-router `d5edba8`. Raw text: <https://raw.githubusercontent.com/astigmatism/llm-router/d5edba88089070e82bb72600e860fd204df88481/docs/CLIENT_CONTRACT.md>

This is a plan to carry out in `dsh-container`. Read the contract in full first; it is authoritative wherever this handoff is less precise. File and line references below are from `origin/main` at `e82ce7d` (2026-10-07); check them before editing.

## Why

AI Runtime switches the router's models by hand and without notice:

- **Paired configurations** run Daytime and Nighttime together.
- **Solo configurations** stop Nighttime and give Daytime every GPU.
- **Within either kind,** the context window and the canonical model ID behind a service can change. Today alone the Nighttime ID changed twice (an MTP3 variant), and its window went 128K → 96K.

The router now describes the live deployment and pushes changes:

- `GET /v1/router/capabilities`: one document with every usable model, its limits, NSFW flag and capability score, the configuration, offline services, and admission state.
- `GET /v1/router/events`: Server-Sent Events carrying the complete document on every change.

## What Harness already does well (keep it)

- **Missing Nighttime:** it no longer stops startup. The provider is kept with `residentUnavailable` (`seed/plugins/dsh-router-model-discovery.js:140-148,434-441`), and `docs/optional-residents.md` describes this.
- **Picker and dispatch:** the picker shows "Nighttime — unavailable", blocks selecting it, and dispatch throws a non-retried `MODEL_UNAVAILABLE` (`scripts/patch-dsh-resident-availability.mjs`).
- **Streaming and incomplete results:** it always streams; incomplete results are errors; partial tool JSON is never executed (`scripts/patch-unrestricted-policy.mjs:72-86`). There is no total deadline.
- **Deployment verifier:** it waits through router drains (`scripts/verification-inference.mjs`).

## Decisions (fixed by the owner)

1. **No automatic fallback.** A Harness session is a long conversation; quietly switching models mid-session would change its context window, compaction and refusal behavior. This is the deviation contract §5 permits ("MAY disable fallback"). Nighttime stays a separate choice:
   - **When it can't serve,** the picker shows exactly one state: **available**, **offline** (with the configuration ID, from `offline_services`), **unavailable** (backend unhealthy), **router switching configuration** (draining or maintenance), or **incomplete metadata**.
   - **Requests to it** fail immediately with a clear message and consume no retries. The user switches the session to Daytime.
   - **When it returns,** it becomes selectable again with no action.
2. **Daytime and Nighttime are independent.** One model's state never blocks updates to the other.
3. **The contract lives in this repository** (step 1 below), so every future change here is checked against it.

## Step 1 — put the contract in this repository

1. **Copy:** create `docs/llm-router-contract.md` from the raw URL above, verbatim, under this header (contract §11):

   ```markdown
   > **Vendored copy — do not edit.** LLM Router client contract, version 1, copied from
   > llm-router commit `d5edba88089070e82bb72600e860fd204df88481`. Canonical source:
   > https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md
   > Replace this copy only when the router maintainer announces a new contract version.
   ```

2. **Conformance map:** after the copy, add `## How DeepSeek Harness upholds this contract`. Map every §13 checklist item to the code and tests that meet it. Record the §5 deviation (fallback disabled, with the reason above). Fill it in as you complete step 2; it must be complete before you finish.
3. **Agent rule:** add to `AGENTS.md`: *"Router integration (provider requests, model discovery, availability, retries, limits) must uphold `docs/llm-router-contract.md`. Update its conformance map with any such change. Never edit the vendored contract text; replace it only when the LLM Router maintainer announces a new version."*
4. **Existing doc:** update `docs/optional-residents.md` to the behavior below, and link it to the contract.

## Step 2 — required changes, in priority order

1. **Startup and availability never depend on router state.**
   - **Today:** a listed but unhealthy, incomplete or warning-bearing Nighttime makes the whole sync throw, freezing Daytime too (`discovery.js:60-62`, and `:419-477`). The startup migration exits 22 on router HTTP errors or an unhealthy model (`scripts/migrate-resident-models.mjs:39-45,88-91`; `entrypoint.sh:40-43` runs under `set -eu`).
   - **Change:** evaluate each model on its own and record its state. Startup may exit non-zero only for invalid **local** settings. If the router is unreachable, start with stored or seeded settings, mark both models unavailable, and recover automatically.
2. **Send service IDs and identify yourself.**
   - **Today:** `local-ollama` sends `local-active` and `local-everyday` sends the canonical `qwen3.8-27b-abliterated-q6_k` (`config/settings.yaml:39,69`; plugin `:10-13`; compaction policies in `seed/profile/managed/cordis.patch.yml:64-70`). The plugin also rewrites a saved `daytime` back to `local-active` (`:463-465`).
   - **IDs:** keep the provider IDs, but send `daytime` and `nighttime` as model names. Migrate stored settings, existing session routes and compaction policies, accepting the old IDs during migration. Remove the rewrite.
   - **Acceptance:** a Nighttime with a new canonical ID (such as the MTP3 variant) must stay available.
   - **Header:** send `X-Client-Name: deepseek-harness/<instance>` on every provider request and every discovery fetch, using the pi-ai provider `headers` support. Take the instance from a setting or environment variable, defaulting to the hostname, so router history can tell the Harnesses on 192.168.1.5, .4, .7 and .20 apart. The one on .20 runs from a self-contained operational bundle with no persistent source checkout.
3. **Discover from the capabilities document and follow the event stream.**
   - **Today:** a 30 s poll of `GET /v1/models` with no ETag (`discovery.js:194-203`, `:28`), and a separate 30 s client re-read for the picker (`patch-dsh-resident-availability.mjs:67`).
   - **Read and subscribe:** read `/v1/router/capabilities` at startup and subscribe to `/v1/router/events`.
   - **Disconnected:** poll every 30 s with `If-None-Match`, and reconnect with 3 → 30 s backoff. 60 s without bytes means the stream is dead.
   - **On each new `revision`:** re-sync immediately and push the states to the picker.
   - **Reference client:** adapt `watchRouter`, `resolveService` and `classifyError` from [router-watch.mjs](https://raw.githubusercontent.com/astigmatism/llm-router/d5edba88089070e82bb72600e860fd204df88481/docs/clients/router-watch.mjs), which is tested against the router.
   - **Metadata:** `models[].metadata` is the same `x_ollama_router` object you validate today, so keep the schema checks, but apply them per model.
4. **Classify request errors by `error.code`, not by HTTP status.**
   - **Today:** a 503 becomes a generic server error and is retried twice at 0.5–10 s (pi-ai `openai-responses`; `dsh-llm` retry). The code only appears in the message text (`patch-dsh-llm-pi-ai.mjs:157-162`).
   - **Change:** follow contract §10:
     - `SERVICE_OFFLINE` or `MODEL_NOT_FOUND`: end at once with no retry cost, mark the model offline, and trigger a re-sync.
     - `BACKEND_UNAVAILABLE`: bounded backoff, then mark the model unavailable.
     - `BACKEND_DRAINING` or `MAINTENANCE_MODE`: wait with 2 → 30 s backoff for at least 10 minutes, showing "router switching configuration", then resolve the model again.
     - Other 5xx and network errors: retry. Other 4xx: fail.
   - **Error shapes:** errors may arrive inside an open stream (§9); the code is in `error.code`, or in `x_router.stop_reason` for Ollama-style frames.
5. **Take limits from the serving model, every time.**
   - **Use:** `context_window` and `metadata.context_safety_reserve` (1024) for budgets and compaction thresholds, and `slots` for `maxConcurrency`.
   - **Recompute** on every change. `131072` in `settings.yaml:41,71` may remain only as a placeholder before the first successful discovery.
   - **While a model is unavailable,** mark its limits stale and don't act on them.
6. **Make timeouts queue-safe.**
   - **Risk:** `streamIdleTimeoutMs: 900000` (`settings.yaml:27,57`) can abort a Responses request that waits in the router's queue longer than that. While queued, the router sends only `response.created`, `response.in_progress`, then a `: waiting for inference slot` comment every 15 s.
   - **Check** whether the installed SDK's idle timer resets on SSE comment frames. If not, exempt the queued phase or count comments as activity.
7. **Log changes.** Log every availability transition and served-model change with its reason, for example `nighttime: available → offline (flash-next-solo-128k)`.
8. **Optional:** show an NSFW badge from `models[].nsfw`; it is `true` for Nighttime.

## Step 3 — verification and tests

- **Verifiers:**
  - `scripts/verify-router-contract.mjs:18-53`: accept a Nighttime that is listed in `offline_services`, or listed with `available: false`, as valid.
  - `scripts/verify-resident-client.mjs` and `scripts/verify.sh:256-270,389`: skip offline or unavailable models with a clear notice; never fail an update because of the router's current configuration.
  - `verify-local-model-profiles.mjs` and `verify-dsh-context-compaction.mjs`: use the service IDs.
- **Tests:** update `tests/router-provider-remote.test.mjs` (`:144-164`, `:266-278` encode the old all-or-nothing rule) and add synthetic fixtures for:
  - paired; solo with `offline_services`; Nighttime unhealthy; Nighttime incomplete; router draining; router unreachable at startup;
  - Nighttime canonical ID changing between revisions; event stream disconnect and reconnect; a request that waits in the queue past the idle timeout;
  - each error code in contract §10; the `X-Client-Name` header; limits recomputed after a context change.
- **Acceptance:**
  - `./scripts/check.sh --host` passes, and CI `./scripts/check.sh --build` is green.
  - The conformance map covers every §13 item.
  - Nothing persisted refers to a canonical model ID.

## Boundaries and release

- **Workflow:** follow this repository's `AGENTS.md`. Develop locally, test, and push `main`. Do not deploy unless the owner asks.
- **Hosts:** never edit, patch or develop on 192.168.1.5 or 192.168.1.4.
- **Restarts:** 192.168.1.7 also runs a Harness, which hosts the router maintainer's own session. Coordinate with the owner before updating it, and never restart a Harness from a session running inside it.
- **Out of scope:** don't modify the router or AI Runtime, and never switch AI Runtime configurations to test; use synthetic fixtures.
- **Report back:** commit SHAs, test and CI results, the completed conformance map, and any place where the contract was ambiguous or hard to meet.
