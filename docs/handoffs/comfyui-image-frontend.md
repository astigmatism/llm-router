# Handoff: ComfyUI Image Frontend — uphold the LLM Router client contract

**To:** the AI agent that maintains `comfyui-image-frontend`.
**From:** the LLM Router maintainer. **Date:** 2026-10-07.
**Contract:** [LLM Router client contract, version 1](https://github.com/astigmatism/llm-router/blob/d5edba88089070e82bb72600e860fd204df88481/docs/CLIENT_CONTRACT.md), pinned at llm-router `d5edba8`. Raw text: <https://raw.githubusercontent.com/astigmatism/llm-router/d5edba88089070e82bb72600e860fd204df88481/docs/CLIENT_CONTRACT.md>

This is a plan to carry out in this repository. Read the contract in full first; it is authoritative wherever this handoff is less precise. File and line references are from `origin/main` at `03dcd4a`; check them before editing.

## Why

The router's models change by hand and without notice.

- **Paired configurations** run Daytime and Nighttime together.
- **Solo configurations** stop Nighttime completely.

Today the prompt assistant asks for `nighttime` by name and rejects its own requests whenever `nighttime` is missing from `/api/tags`, so a solo configuration disables it. The router now describes what is available and pushes changes:

- `GET /v1/router/capabilities` lists every usable model with:
  - `service`, the ID to send;
  - `available`;
  - `nsfw`, true for abliterated models;
  - `capability_score`, an automatic 0–100 ranking where higher is more capable;
  - `context_window`, `input_modalities`, `capabilities` and `metadata.reasoning.efforts`.
- `GET /v1/router/events` pushes the complete document on every change, as Server-Sent Events.

## Decision (fixed by the owner): the most capable NSFW model first, then the most capable model

For every prompt-assistant call, choose the model by capability, not by name:

1. Take the models that are `available` and have every feature the call needs. Vision checks need `image` in `input_modalities`. Thinking at a given effort needs that effort in `metadata.reasoning.efforts`.
2. If any of them has `nsfw: true`, use the one with the highest `capability_score`.
3. Otherwise use the highest-scoring model of any kind (`nsfw` false or null).
4. While `router.accepting_requests` is false (the router is switching configuration), **wait**; don't choose.

Send the chosen model's `service` ID (for example `nighttime`) as `model`. This is exactly `pick_service(doc, nsfw=True, require=[...], fallback_any=True)` in the reference client. Today it yields `nighttime` in a paired configuration and `daytime` in a solo one. When an NSFW model returns, the next call uses it again; never stay on the fallback.

Settings, using the existing `CIF_` prefix:

| Setting | Default | Meaning |
|---|---|---|
| `CIF_OLLAMA_SELECTION` | `capability` | `capability` applies the rule above. `named` uses `CIF_OLLAMA_MODEL` followed by `CIF_OLLAMA_FALLBACK_MODELS`. |
| `CIF_OLLAMA_NSFW` | `prefer` | `prefer`: the rule above. `require`: NSFW models only, otherwise unavailable. `avoid`: non-NSFW models only. `any`: ignore the flag. |
| `CIF_OLLAMA_MODEL`, `CIF_OLLAMA_FALLBACK_MODELS` | `nighttime`, `daytime` | Used only when `CIF_OLLAMA_SELECTION=named`. |

In reference-client terms, with `require` set to the call's features (`["vision"]` for image checks):

| `CIF_OLLAMA_NSFW` | Reference-client call |
|---|---|
| `prefer` | `pick_service(doc, nsfw=True, require=..., fallback_any=True)` |
| `require` | `pick_service(doc, nsfw=True, require=...)` |
| `avoid` | `pick_service(doc, nsfw=False, require=...)` |
| `any` | `pick_service(doc, require=...)` |

Check the thinking effort separately, against the chosen model's `metadata.reasoning.efforts` (step 2.3).

Document the precedence change: in `capability` mode, `CIF_OLLAMA_MODEL` no longer selects the model, and the default selection ignores an existing `CIF_OLLAMA_MODEL=nighttime` in production `.env` files. Make the startup log say which mode and preference are active.

**Content risk.** Nighttime is chosen on purpose: see `docs/audits/creative-direction-2026-09-12.md` and the `krea2-uncensored-v1` workflow. When the call has to use a non-NSFW model:

- Daytime may refuse, or return output that fails the JSON schema.
- Report that plainly to the user, for example "No NSFW model is available; Daytime declined this request", and don't retry it in a loop.
- Show on the status endpoint and in the UI that the assistant is running on a non-NSFW fallback.

## Step 1 — put the contract in this repository

1. **Copy:** create `docs/llm-router-contract.md` from the raw URL above, verbatim, under this header (contract §11):

   ```markdown
   > **Vendored copy — do not edit.** LLM Router client contract, version 1, copied from
   > llm-router commit `d5edba88089070e82bb72600e860fd204df88481`. Canonical source:
   > https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md
   > Replace this copy only when the router maintainer announces a new contract version.
   ```

2. **Conformance map:** after the copy, add `## How ComfyUI Image Frontend upholds this contract`, mapping every §13 checklist item to code and tests. Complete it before you finish.
3. **Agent rule:** this repository has no `AGENTS.md`, so create one with at least this rule: *"Router integration (prompt assistant and vision requests, model selection, discovery, retries) must uphold `docs/llm-router-contract.md`. Update its conformance map with any such change. Never edit the vendored contract text; replace it only when the LLM Router maintainer announces a new version."* Add pointers to `docs/testing.md`, `make validate` and `docs/production-deployment-agent.md`.
4. **Traceability:** update the router prose in `scripts/generate_traceability.py:143-174`, then regenerate `docs/traceability.md` (run it without `--check`).

## Step 2 — required changes

1. **Discovery.**
   - **Today:** each compose or evaluate call first fetches `/api/tags` and requires the configured name (`backend/app/services/ollama.py:165-172,245,534,1016-1021`). Capabilities are cached for 30 s (`queue_worker.py:64,3550-3577`).
   - **Read and subscribe:** read `GET /v1/router/capabilities` at startup, without failing to start if the router is unreachable. Subscribe to `GET /v1/router/events` from a lifespan background task beside `_health_loop` (`queue_worker.py:3478-3522`).
   - **Disconnected:** poll every 30 s with `If-None-Match`, and reconnect with 3 → 30 s backoff. 60 s without bytes means the stream is dead.
   - **Per call:** choose the model from the current document, with no per-call `/api/tags` request.
   - **Reference client:** start from [router_watch.py](https://raw.githubusercontent.com/astigmatism/llm-router/d5edba88089070e82bb72600e860fd204df88481/docs/clients/router_watch.py) (`pick_service`, `model_for`, `classify_error`, and the subscriber loop). Port the loop to `httpx.AsyncClient.stream`, or run the thread version.
2. **Errors, classified by `error.code` (contract §10).**
   - **Today:** the `error` field is ignored, only the status code is kept (`ollama.py:1080-1121`), and 503s are retried three times at 0.25 s × 2ⁿ (`:45-47,823-949`).
   - `SERVICE_OFFLINE`, `BACKEND_UNAVAILABLE`, `MODEL_NOT_FOUND`: choose again at once, excluding the failed service (`exclude=[...]`). This consumes no retries.
   - `BACKEND_DRAINING`, `MAINTENANCE_MODE`: wait with 2 → 30 s backoff for at least 10 minutes, then choose again.
   - Other 5xx and network errors: retry. Other 4xx: fail.
   - Error bodies are `{"error": {"code": ..., "message": ...}}`. Tolerate a string `error`, too.
3. **Request settings.**
   - **Thinking:** `think: "xhigh"` is hard-coded (`ollama.py:48-50`). Send it only when the chosen model lists `xhigh` in `metadata.reasoning.efforts`; otherwise use the closest supported effort, or `true`.
   - **Already correct:** the output-budget ladder (2048 → 4096 → 8192, then no thinking), `format` JSON schema, the seed, and `stream: false` (`:54,680-684,1237-1248`).
4. **Time.** The request may wait in the router's first-in, first-out queue behind long coding generations on Daytime, and the router has no queue deadline. Keep the read timeout (900 s, `ollama.py:123,147`) at least that long, or stream. Never abandon and resubmit a queued request.
5. **Identification.** Send `X-Client-Name: comfyui-image-frontend` on every router request.
6. **Status and logging.**
   - Log every change of chosen model, with its reason.
   - Expose on the status endpoint (`api/prompt_assistant.py:57-65`): the chosen service, `nsfw`, the router configuration ID, and whether the assistant is on a fallback.
7. **Housekeeping.**
   - `.env.example:123` and `README.md:323` still point at `192.168.1.21`. The router is `http://192.168.1.4:11434`, or `http://ai-router:11434` only on a host that joins Rosalina's `local-ai-ollama_default` network, which Samus does not.
   - Don't commit the stale untracked `frontend/.dist-stale-root*`, `.playwright-report-stale-root*` and `.test-results-stale-root*` directories.

## Step 3 — tests

- **Fake router:** extend `backend/tests/fake_services.py:79-111` with `/v1/router/capabilities`, `/v1/router/events`, the error codes, and switchable configurations.
- **Unit and integration tests:**
  - Selection:
    - paired → `nighttime`; solo → `daytime`; NSFW model unhealthy → `daytime`;
    - two NSFW models → the higher score; vision call where only a non-NSFW model has `image` → that model;
    - `CIF_OLLAMA_NSFW=require` with none available → unavailable; `named` mode;
    - draining → wait, no switch; NSFW model returns → used again.
  - Errors and requests: each error code and its action; `SERVICE_OFFLINE` costing no retries; the effort check; `X-Client-Name` sent; the router unreachable at startup.
- **Commands:** `PYTHONPATH=backend python3 -m pytest -q`, `make validate`, and `python3 scripts/generate_traceability.py --check`. The opt-in live suite (`backend/tests/live/test_ollama_integration.py`) may be run read-only against the router; never switch AI Runtime configurations to test.

## Boundaries and release

- **Workflow:** develop in this checkout, test, and push `main`. Production runs on Samus (192.168.1.5) and is updated by its documented process: `docs/production-deployment-agent.md`, `update_production`, or the Samus Service Portal "Update and restart". Deploy only when the owner asks.
- **Out of scope:** don't modify the router or AI Runtime.
- **Report back:** commit SHAs, test and validation results, the completed conformance map, and any contract ambiguity.
