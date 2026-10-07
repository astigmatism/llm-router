# Handoff: Playroom — model selection, and uphold the LLM Router client contract

**To:** the AI agent that maintains `playroom`.
**From:** the LLM Router maintainer. **Date:** 2026-10-07.
**Contract:** [LLM Router client contract, version 1](https://github.com/astigmatism/llm-router/blob/d5edba88089070e82bb72600e860fd204df88481/docs/CLIENT_CONTRACT.md), pinned at llm-router `d5edba8`. Raw text: <https://raw.githubusercontent.com/astigmatism/llm-router/d5edba88089070e82bb72600e860fd204df88481/docs/CLIENT_CONTRACT.md>

This is a plan to carry out in this repository. It has two parts: a feature (choose the model, per game, from what is available) and conformance with the router's client contract. Read the contract in full first; it is authoritative wherever this handoff is less precise. File and line references are from `origin/main` at `355b03c`; check them before editing.

## Why

- **The model is fixed today.** Playroom sends `LLM_MODEL`, default `nighttime` (`playroom/config.py:15`), on every request, for no particular reason. The UI only displays it (`playroom/service.py:75`, `frontend/src/main.tsx:86`).
- **The router's models change by hand and without notice.** Paired configurations run Daytime and Nighttime; solo configurations stop Nighttime completely. Contexts and the models behind each name change too.
- **A solo configuration breaks Playroom.** Every request then fails, the retry cap runs out, and the session pauses with "Model endpoint unavailable or incompatible".
- **The router now describes what is available and pushes changes:**
  - `GET /v1/router/capabilities` lists each model with its `service` ID, `display_name`, `available`, `slots`, `context_window`, `input_modalities`, `capabilities`, `nsfw` and `capability_score` (automatic, 0–100, higher is more capable), plus `offline_services` and `router.accepting_requests`.
  - `GET /v1/router/events` pushes the complete document on every change, as Server-Sent Events.

## Part A — feature: choose the model

### Behavior (decided by the owner)

1. **A per-game setting.** Each game's profile gains `model`. It is either `auto` (the default) or a service ID such as `daytime` or `nighttime`. New games start with the deployment default from `LLM_MODEL`, now default `auto`. Change it through the existing `PUT /api/profile` (`playroom/app.py:204-220`), which already pauses the session for review. Accept only `auto`, a service ID listed in the capabilities document, or one listed in `offline_services`.
2. **Requirements.** Playroom needs image input and function tools: it sends frames as images and uses `tool_choice: "required"` (`agent.py:33-39,54`). A model is **suitable** only when `input_modalities` includes `image`, `capabilities` includes `tools`, and it has passed Playroom's visual and tool check (`qualify_model`, `agent.py:76-91`).
3. **Automatic.** Before **each decision** (each iteration of `run_agent`, `agent.py:178`), choose the suitable, `available` model with the highest `capability_score`. In the reference client this is `pick_service(doc, require=["vision", "tools"], exclude=<failed>)`.
   - **Why per decision:** each decision already rebuilds its messages, so switching between decisions is safe, and a model that returns is used again at once.
   - **Fallback:** if the chosen model fails with `SERVICE_OFFLINE`, `BACKEND_UNAVAILABLE` or `MODEL_NOT_FOUND`, choose again excluding it, without consuming a retry.
4. **A specific model.** Use only that service. When it is offline or unavailable, **pause** the session with a clear reason, for example "Nighttime is offline in runtime configuration flash-next-solo-128k. Choose Automatic or another model to continue." Never substitute another model for an explicit choice. Resuming works once the model is back.
5. **Qualification per model.** Cache the result of `qualify_model` by service, canonical model ID (`ids[service]`) and model `revision`.
   - Run the check before a model's first use, and again whenever any part of that identity changes, for example when a new configuration changes the model behind `nighttime`.
   - A model that fails the check is unsuitable until its identity changes. Automatic skips it; a specific choice pauses with the reason.
   - Today the check runs once per agent start, against the fixed configured model (`agent.py:174`).
6. **Model picker in the UI.** Show the models from the capabilities document, filtered and labelled. Offer **Automatic** first, then each model with:
   - display name, context window, capability score, and an NSFW badge when `nsfw` is true;
   - its state: available / unavailable / offline (with the configuration ID) / unsuitable (with the reason, for example "needs image input and tools" or "failed the visual check").

   Only suitable, available models are selectable. Offline services from `offline_services` appear disabled with their reason. A saved choice that is no longer listed keeps showing as unavailable, so the user sees why play paused.
7. **What is serving.** Replace the `MODEL` tile's configured name (`main.tsx:86`) with the selection and the model actually serving, for example `Automatic → Daytime (Flash-Next, 128K)`. Show a notice when Automatic has changed model, or when a specific choice is unavailable. Extend `service.state()` (`service.py:75`) with `model: {selection, service, display_name, canonical, reason, available_models}`, so the existing `/api/live` websocket (`app.py:222`) carries it.
8. **Activity log.** Record `model_selected` and `model_changed` events, with the reason, in the store so they show in the activity panel. `model_qualified` must name the service that was qualified.

### Notes

- **Load.** Automatic picks the most capable model, which today is usually Daytime. Daytime's slot is shared with the coding agents, so a long Playroom run on Automatic may wait in the router's queue behind them. Choosing `nighttime` explicitly keeps Playroom off Daytime. Mention this next to the picker.
- **Separate documents.** `docs/player-contract.md` is the agent's gameplay contract and stays separate from the router contract.

## Part B — uphold the router contract

1. **Discovery and subscription.**
   - Read `/v1/router/capabilities` at startup, without failing to start if the router is unreachable.
   - Subscribe to `/v1/router/events` in a lifespan task beside `monitor()` (`playroom/app.py:32-36`), using `httpx.AsyncClient.stream`.
   - While disconnected, poll every 30 s with `If-None-Match`, and reconnect with 3 → 30 s backoff. 60 s without bytes means the stream is dead.
   - Derive the router base from `LLM_BASE_URL` by removing a trailing `/v1`.
   - Port `pick_service`, `model_for` and `classify_error` from the reference client, [router_watch.py](https://raw.githubusercontent.com/astigmatism/llm-router/d5edba88089070e82bb72600e860fd204df88481/docs/clients/router_watch.py), which is tested against the router.
2. **Errors by `error.code` (contract §10), replacing the uniform `raise_for_status` path (`agent.py:55,67-73`).**
   - `SERVICE_OFFLINE`, `BACKEND_UNAVAILABLE`, `MODEL_NOT_FOUND`: Automatic chooses again (A.3); a specific choice pauses (A.4). These consume no retries and no `infra_retries`.
   - `BACKEND_DRAINING`, `MAINTENANCE_MODE`: the router is switching configuration. Don't pause and don't count retries. Show status "waiting: router switching configuration" and back off from 2 s up to 30 s, for at least 10 minutes, then choose again. Pause only if it lasts longer.
   - Other 5xx and network errors: the existing bounded retry. Other 4xx: fail the decision.
3. **Fix the budget.** `reserve()` charges `LLM_CONTEXT_TOKENS + LLM_MAX_OUTPUT_TOKENS` (133,120). A failed request settles with `actual=None` and keeps the full reservation (`store.py:76-89`, `agent.py:68`), so about three router errors use up the 500,000-token session limit.
   - **Router rejections:** when the router answers with an HTTP error before generating anything, settle with `actual=0`.
   - **Uncertain outcomes:** keep the conservative reservation only for timeouts and transport errors, where usage is unknown.
   - **Reservation size:** base it on the serving model's `context_window` (capped by `LLM_CONTEXT_TOKENS` only if the operator set one), not the fixed 131072 (`config.py:19`).
4. **Limits from the serving model.**
   - Budget each request against the chosen model's `context_window` and `metadata.context_safety_reserve`, and recompute when the model changes.
   - Keep the 32,768-character text guard (`agent.py:44,189`) as Playroom's own limit.
   - Don't send more concurrent requests to a model than its `slots`.
5. **Time.**
   - `LLM_TIMEOUT=90` (`config.py:17`) is shorter than a realistic wait in the router's queue, and the router has no queue deadline. A timeout also cancels the queued request, so a retry joins the back of the queue.
   - Raise the default to at least 600 s, or stream with `stream: true` and treat queue keepalives (`: waiting for inference slot`) as activity.
   - Keep `stream` explicit in every request.
6. **Requests.**
   - Send `X-Client-Name: playroom` on every router request, including discovery.
   - Keep `reasoning_effort: "none"`, `temperature: 0` and the explicit `max_tokens` (`agent.py:54`); every current model accepts them.
   - Check the chosen model's features before sending (A.2).
7. **Configuration and documentation.**
   - `LLM_MODEL` becomes the default selection for new games: `auto` or a service ID, default `auto`.
   - `LLM_CONTEXT_TOKENS` becomes an optional cap, unset by default.
   - Update `.env.example` (lines 12-16 set `LLM_MODEL=nighttime`, `LLM_TIMEOUT=90`, `LLM_CONTEXT_TOKENS=131072`), `README.md` and `docs/operations.md:21`.
   - **Deployment setting:** the live deployment's `~/deployments/playroom/.env` sets `LLM_MODEL=nighttime`. After this change that would make every game without a saved choice an explicit Nighttime selection, which pauses during solo configurations. Don't edit the deployment file. Tell the owner, in your report, to change it to `LLM_MODEL=auto` (or remove it) before deploying.

## Step 1 — put the contract in this repository

1. **Copy:** create `docs/llm-router-contract.md` from the raw URL above, verbatim, under this header (contract §11):

   ```markdown
   > **Vendored copy — do not edit.** LLM Router client contract, version 1, copied from
   > llm-router commit `d5edba88089070e82bb72600e860fd204df88481`. Canonical source:
   > https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md
   > Replace this copy only when the router maintainer announces a new contract version.
   ```

2. **Conformance map:** after the copy, add `## How Playroom upholds this contract`, mapping every §13 checklist item to code and tests. Record the permitted deviation (contract §5): a specific model choice never falls back. Complete it before you finish.
3. **Agent rule:** add to `AGENTS.md`: *"Router integration (model requests, model selection, discovery, retries, budgets) must uphold `docs/llm-router-contract.md`. Update its conformance map with any such change. Never edit the vendored contract text; replace it only when the LLM Router maintainer announces a new version. The router contract is separate from `docs/player-contract.md`."*

## Step 2 — tests

- **Seam:** keep the `playroom.agent.httpx.AsyncClient` test seam (`tests/test_core.py:167-191`). Add a fake router serving the capabilities document, the event stream, and the error bodies.
- **Unit tests:**
  - Automatic: picks the highest-scoring suitable model; skips models without image or tools; skips a model that failed qualification; switches on `SERVICE_OFFLINE` without spending retries; uses a returning model again on the next decision.
  - Specific choice: pauses with a reason when offline, and never substitutes.
  - Router state: draining waits without pausing or counting retries; the router unreachable at startup.
  - Qualification: re-runs when `ids[service]` or `revision` changes.
  - Budget: a router rejection settles at 0; the reservation follows `context_window`.
  - Requests: `X-Client-Name` is sent; the profile accepts and validates `model`.
- **UI:** the picker renders all states (`npm run build`; extend `tests/browser.mjs` if it covers the profile panel).
- **Commands:** `.venv/bin/python -m pytest -q` and `cd frontend && npm ci && npm run build` (`README.md:45-52`, `AGENTS.md`). The opt-in `tests/qualify_agent.py` may be run read-only against the live router; never switch AI Runtime configurations to test.

## Boundaries and release

- **Repository rules:** follow `AGENTS.md`. Preserve the single RetroArch frame scheduler, never source commercial ROMs, and commit no credentials or user data.
- **Workflow:** `~/projects/playroom` is both the development workspace and the source that the Service Portal updater builds from. Commit and push to `main`, and leave the checkout clean on `main`, or the updater refuses to run. Deploy only when the owner asks, using Service Portal on 192.168.1.7 ("Update and restart") or `~/deployments/playroom/update-and-restart.sh`.
- **Out of scope:** don't modify the router or AI Runtime.
- **Report back:** commit SHAs, test results, screenshots or a description of the picker states, the completed conformance map, any deployment `.env` notes, and any contract ambiguity.
