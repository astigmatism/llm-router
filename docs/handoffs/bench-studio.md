# Handoff: Bench Studio — uphold the LLM Router client contract, without ever falling back

**To:** the AI agent that maintains Bench Studio (`bench-studio`, developed in `~/projects/bench-studio-dev`).
**From:** the LLM Router maintainer. **Date:** 2026-10-07.
**Contract:** [LLM Router client contract, version 1.1](https://github.com/astigmatism/llm-router/blob/1ecc04758ad4d0a6954713defad4d02ff3e8f351/docs/CLIENT_CONTRACT.md), pinned at llm-router `1ecc047`. Raw text: <https://raw.githubusercontent.com/astigmatism/llm-router/1ecc04758ad4d0a6954713defad4d02ff3e8f351/docs/CLIENT_CONTRACT.md>

This is a plan to carry out in the development clone. Read the contract in full first; it is authoritative wherever this handoff is less precise. Version 1.1 adds the benchmark exception in §3 specifically for Bench Studio. File and line references are from `origin/main` at `b8e586c`; check them before editing. Never edit the deployment checkout `~/projects/bench-studio`.

## Why

AI Runtime switches the router's models by hand and without notice.

- **Paired configurations** run Daytime and Nighttime.
- **Solo configurations** stop Nighttime completely.
- **Within either kind,** context sizes and the model behind each service ID change. Today the Nighttime model's ID changed twice, as an MTP3 variant came and went.

The router now describes the live deployment and pushes changes:

- `GET /v1/router/capabilities` gives, for every model:
  - its `service` ID, `available`, `slots`, `context_window`, `nsfw`, `capability_score`;
  - full `metadata`, which is the same `x_ollama_router` object you read from `/models` today.

  It also gives `offline_services` (services the configuration deliberately stopped, with the reason), `configuration.id`, `router.accepting_requests`, and, with `?include=load`, per-model active and queued counts.
- `GET /v1/router/events` pushes the complete document on every change, as Server-Sent Events.

## Decisions (fixed by the owner)

1. **Never fall back.** A benchmark's identity is its model. Bench Studio must never substitute Daytime, or any other model, for a target; its existing rule ("an absent alias never falls back", `tests/test_integration.py:116-118`) stays. This is the deviation contract §5 requires of benchmarks.
2. **Keep pinning canonical IDs per run.** Requests already send the canonical model ID resolved at launch (`worker.py:38`, `studio/quality_worker.py:62`, `studio/session_core.py:328`), so a mid-run configuration change can never send a run's requests to another model. Contract 1.1 §3 now permits exactly this. Keep it, record the canonical ID with the model `revision` (as `identity()` already does, `common.py:122-135`), and start every new run from a service ID.
3. **Offline is not a configuration change.** When a target is offline because of the configuration, report it as unavailable and let the run wait. Don't mark it invalid.

## Current behavior to change

- **An offline target counts as a configuration change.** A solo configuration removes Nighttime from discovery and from runtime `services[]`, so `resolve` raises `ModelConfigurationChanged` (`common.py:89-92,106-107`). Running runs become **invalid** (`studio/runner.py:423-428`, `worker.py:377`), and queued runs **blocked** (`runner.py:464-474`).
- **Drains look like health failures.** A configuration switch takes roughly 1.5 to 2 minutes, but is handled as `RuntimeUnavailable`. That gets a 90 s grace in `runner.check_current` (`runner.py:287-320`) and none in the speed worker, which requires a healthy model every 10 s (`worker.py:165-184`).
- **Discovery is polled:** every 3 s in the runner (`runner.py:551`), and every 15 s for the UI's model list (`frontend/src/main.tsx:357-372`). Neither uses `/v1/router/*`.
- **No client identification header** on any request.

## Step 1 — put the contract in this repository

1. **Copy:** create `docs/llm-router-contract.md` from the raw URL above, verbatim, under this header (contract §11):

   ```markdown
   > **Vendored copy — do not edit.** LLM Router client contract, version 1.1, copied from
   > llm-router commit `1ecc04758ad4d0a6954713defad4d02ff3e8f351`. Canonical source:
   > https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md
   > Replace this copy only when the router maintainer announces a new contract version.
   ```

2. **Conformance map:** after the copy, add `## How Bench Studio upholds this contract`. Map every §13 checklist item to code and tests, and record the two benchmark provisions: canonical pinning per run (§3) and no fallback (§5). Complete it before you finish.
3. **Agent rule:** add to `AGENTS.md`, beside the existing deployment rules (`AGENTS.md:3-22`): *"Router integration (benchmark requests, model discovery, run identity, availability and retries) must uphold `docs/llm-router-contract.md`. Update its conformance map with any such change. Benchmarks never fall back to another model. Never edit the vendored contract text; replace it only when the LLM Router maintainer announces a new version."*

## Step 2 — required changes

1. **Separate "offline" and "draining" from "changed".**
   - **`ModelOffline`:** add it as a subclass of `RuntimeUnavailable` in `common.py`. `resolve` raises it when the target, a service ID or the pinned canonical ID, is listed in `offline_services`. The message includes the reason and configuration, for example "nighttime is offline in runtime configuration flash-next-solo-128k". In that case it skips the missing runtime service check (`common.py:106-107`), because no service is expected.
   - **`RouterSwitching`:** add it, also a subclass of `RuntimeUnavailable`, for `router.accepting_requests: false`.
   - **`ModelConfigurationChanged`:** keep it only for a real identity change. That covers a different canonical model or `revision` behind the target, changed context, metadata or container identity (`check_drift`, `common.py:165-172`), a pinned canonical ID that returns 404 `MODEL_NOT_FOUND`, and a target absent with **no** `offline_services` entry.
2. **Lifecycle rules.**
   - **Queued run, target offline:** stay queued, with progress text such as "waiting: nighttime offline in flash-next-solo-128k". Start automatically when the target is available again with the **same** identity. If it returns with a different identity, `blocked` as today.
   - **Running run, target goes offline:** end as **failed** with the reason `model offline (<configuration>)`, not invalid, because the run's identity didn't change. The user reruns it.
   - **Router switching:** pause between requests and wait for at least 10 minutes in the runner, the speed worker, and before each request (`common.wait_for_runtime`, `common.py:175-189`). Then resolve again; any identity change follows the rules above. Don't count switching time in measurements; exclude any phase that overlaps a drain.
3. **Discovery from the capabilities document, plus the event stream.**
   - **Snapshot:** have `snapshot` (`common.py:54-59`) read `GET /v1/router/capabilities?include=load` instead of `GET {endpoint}/models`. `models[].metadata` is the same object, so `resolve` and `identity` keep their fields. Keep reading AI Runtime `/api/status`: the router does not publish container IDs, image IDs or restart counts, which `check_drift` needs.
   - **Subscriber:** run a subscriber thread in the long-running runner (`studio/runner.py:534-557`), using the reference client [router_watch.py](https://raw.githubusercontent.com/astigmatism/llm-router/1ecc04758ad4d0a6954713defad4d02ff3e8f351/docs/clients/router_watch.py) directly (`RouterWatch.run_forever`).
     - On each new `revision`, re-check active and queued runs at once, and write an event to the SQLite events table, so the UI's existing `/api/events` stream (`studio/api.py:536-571`) shows it.
     - Keep a slower poll as the fallback while disconnected.
   - **Startup:** the reports server and the runner must start even when the router is unreachable.
4. **Classify request errors by `error.code`** in every request path. Those paths are `worker.py`, `studio/quality_worker.py`, `studio/session_core.py`, `studio/agent_job.py`, and the vendored `vendor/betterbench/client.py:359` (keep vendor changes minimal and tested by `vendor/tests`).
   - `SERVICE_OFFLINE` → `ModelOffline`.
   - `MODEL_NOT_FOUND` for a pinned canonical ID → `ModelConfigurationChanged`.
   - `BACKEND_DRAINING`, `MAINTENANCE_MODE` → `RouterSwitching`.
   - `BACKEND_UNAVAILABLE` → `RuntimeUnavailable`.
   - `context_length_exceeded` → a benchmark item error.
   - Error bodies are `{"error": {"code": …}}`, or `x_router.stop_reason` inside streams (contract §9).
5. **Identification.** Send `X-Client-Name: bench-studio/<run id>` on benchmark requests and `bench-studio` on discovery, so the router's request history ties traffic to runs.
6. **Requests.**
   - Keep `stream` explicit everywhere: `worker.py:43` and `vendor/betterbench/client.py:316` send `true`. Verify `studio/session_core.py:328` (where it comes from `parameters`) and `studio/agent_job.py`.
   - Take context limits from `context_window` and `metadata.context_safety_reserve`, as `resolve` already does.
7. **What the UI shows.** For each model, show its configuration ID, service ID, availability, `capability_score` and an NSFW badge. List `offline_services` with their reason, and show "router switching configuration" while draining. Record `capability_score`, `nsfw` and `configuration.id` in each run's metadata for reports, but **not** in `model_fingerprint`. The score is computed from facts the fingerprint already covers.

## Step 3 — tests

- **Fixture router:** extend the integration tests (`tests/test_integration.py`, `tests/test_repairs.py`) with a capabilities document fixture that has `offline_services`, `router.accepting_requests` and error bodies.
- **Cases:**
  - Offline Nighttime: a queued run waits and then starts; a running run fails with the offline reason, not invalid.
  - Returning model: back with a new canonical ID or `revision` → blocked or invalid.
  - Router switching: waits beyond 90 s without failing, and drain overlap is excluded from timings.
  - Pinned canonical ID: a 404 is treated as a configuration change.
  - Never falls back: the existing `test_absent_alias_never_falls_back` still passes.
  - Event stream: a new revision triggers an immediate re-check; the runner starts with the router unreachable.
  - Requests: the `X-Client-Name` values are sent.
- **Commands:** `PYTHONPATH=.:vendor .venv/bin/pytest tests vendor/tests` (`README.md:82-85`), and `cd frontend && npm ci && npm run build && npx playwright test`. Never switch AI Runtime configurations to test.

## Boundaries and release

- **Workflow:** follow `AGENTS.md`. Edit only `~/projects/bench-studio-dev`, commit and push `main`, and leave both checkouts clean.
- **Deploy:** only when the owner asks, using Service Portal "Update and restart" on 192.168.1.7. The updater refuses to run while benchmarks are active.
- **Out of scope:** don't modify the router or AI Runtime.
- **Report back:** commit SHAs, test results, the completed conformance map, and any contract ambiguity.
