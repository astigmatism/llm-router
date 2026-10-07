# Handoff: Open WebUI — uphold the LLM Router client contract

**To:** the agent that maintains the Open WebUI deployment on 192.168.1.20.
**From:** the LLM Router maintainer. **Date:** 2026-10-07.
**Contract:** [LLM Router client contract, version 1.1](https://github.com/astigmatism/llm-router/blob/1ecc04758ad4d0a6954713defad4d02ff3e8f351/docs/CLIENT_CONTRACT.md), pinned at llm-router `1ecc047`.

Open WebUI is unlike the other clients. It is third-party software; the router-specific behavior lives in two places, and neither is under version control today:

- an image overlay of patched Open WebUI source files;
- a host-side job that edits its database.

This handoff explains how the pieces fit, then plans the changes. Read the contract first; it is authoritative wherever this handoff is less precise. All facts below were observed read-only on 2026-10-07.

## How it works today

| Piece | Where | What it does |
|---|---|---|
| **Open WebUI** | Container `open-webui`, image `local/open-webui:v0.11.4-router-v1` (upstream 0.11.4 by digest, plus a router overlay). Port 3000; data in `/opt/open-webui/data` (`webui.db`, SQLite). | The chat UI used by three people. It reaches the router as a native **Ollama** connection, `OLLAMA_BASE_URL=http://ai-router:11434`, where `extra_hosts` maps `ai-router` to 192.168.1.4. The OpenAI connection is disabled and the base-model cache is off, so each model-list request reads the router's `/api/tags`. |
| **Router overlay** | Built from `~/deployments/open-webui/build/` (`Dockerfile` and `merged/open_webui/…`); the cut-over Compose file is `~/deployments/open-webui/compose.yml`. | About 370 lines of patched files: `routers/ollama.py`, `utils/middleware.py`, `utils/response.py`, `utils/context_compaction.py`, `utils/tools.py`, `tools/builtin.py`, `routers/tasks.py`, `retrieval/web/duckduckgo.py`, plus two new modules, `utils/router_completion.py` (preserves completed versus incomplete router results and error details) and `utils/web_fetch_window.py`. It was ported from the 0.11.3 image whose sources are in llm-router `integrations/open-webui/`. **The 0.11.4 port is not in any repository.** |
| **Model-list enforcer** | `/usr/local/bin/open-webui-model-sync.py` (root, 374 lines). Units: `open-webui-model-sync.service` and `.timer` (every 15 min). Notes: `/opt/open-webui/MODEL-SYNC.md`. State: `/var/lib/open-webui-model-sync/state.json`. | Reads `/api/tags` and writes `webui.db` directly. Its four passes: routine rows (`Daytime (NNK)`, `Nighttime (NNK)`), alias rows, access grants, and soft retirement of models no longer published. **Policy:** Daytime is open to everyone; Nighttime is granted to everyone except Lili. If a whole profile disappears, nothing is retired. **Not in any repository.** |
| **What users pick** | Presets in the `model` table. | `Daytime (160K)` and `Daytime (Deep Thinking, 160K)` (based on `daytime`), and `Nighttime (128K)` and `Nighttime (Deep Thinking, 128K)` (based on `nighttime`). Their names hard-code a context size, and none is current: Daytime is 128K now, and Nighttime has been 96K. |
| **Context compaction** | Environment variables: `CONTEXT_COMPACTION_MODEL=bear-castle-ai` (the Daytime preset), threshold and cap `80000` tokens. | Fixed numbers, independent of the serving model. |
| **Backups** | `open-webui-backup.timer`, nightly SQLite snapshots (14 kept). | — |

Host rules (`~/AGENTS.md`, `~/README.md`): Open WebUI is pre-existing user data — **do not modify, restart, or remove it without the owner's explicit go-ahead for that specific step**. The owner has asked for this work, but each production step below that restarts the container or changes its database or host units needs that confirmation. `sudo` is passwordless; use it only for the enforcer's root-owned files and units.

## What goes wrong today

The router is currently in a solo configuration (`flash-next-solo-128k`); Nighttime is stopped and listed in `offline_services`.

1. **Nighttime presets stay in everyone's picker.** Open WebUI keeps a preset even when its base model is missing from `/api/tags` (`utils/models.py:218-228`). Selecting one fails: either the request reaches the router and gets 503 `SERVICE_OFFLINE`, or Open WebUI rejects it because the base model is missing. Confirm which in testing. There is no fallback.
2. **The model list is updated only every 15 minutes, from `/api/tags`.** That endpoint has no notion of "offline by configuration". The enforcer only logs a warning (`state.json`: `"nighttime": null`).
3. **Labels lie.** Preset names keep the context they were created with ("160K", "128K").
4. **A configuration switch shows errors.** Requests made during the 1–2 minute drain get 503 `BACKEND_DRAINING`, shown as a failure instead of a wait.
5. **The overlay's terminal-state helper hard-codes stale model IDs.** `ROUTER_MODELS = {'local-active', 'qwen3.8-27b-q8_0', 'qwen3.8-27b-abliterated-q6_k'}` in `utils/router_completion.py`. It works only because the router also sends `x_router` metadata.
6. **Compaction thresholds are fixed numbers** (80000), not derived from the serving model's context window.
7. **No `X-Client-Name` header.** Router history shows Open WebUI as an aiohttp user agent.
8. **Nothing is under version control,** so no contract rule can live next to the code.

## Decisions (made by the router maintainer, delegated by the owner)

1. **No silent model substitution.** People choose presets by name; a preset called "Nighttime" must never be answered by Daytime. This is the same choice as for DeepSeek Harness, and the deviation contract §5 permits ("MAY disable fallback").
2. **Show only what works, and say why.** When Nighttime is offline or unavailable, the enforcer deactivates (`is_active = 0`, reversible) the Nighttime routine rows and the presets based on `nighttime`, so they leave the picker. They come back automatically when Nighttime returns. Ownership, grants, prompts and parameters are untouched. The description of each routine row says why, for example "Offline in runtime configuration flash-next-solo-128k".
3. **Access follows the NSFW flag, not the alias name.**
   - **Who:** the policy becomes "models with `nsfw: true` → everyone except Lili; other models → everyone". Today that matches the current policy exactly (only Nighttime is NSFW), and it keeps applying if models are renamed or swapped.
   - **Unknown flag:** a model whose `nsfw` is `null` is treated as NSFW for access purposes, so it fails closed.
4. **Labels follow live facts.** The enforcer keeps the context suffix of the routine presets' names (for example `(Deep Thinking, 128K)`) equal to the serving model's `context_window`, and changes only that suffix.
5. **Event-driven, with polling as a safety net.**
   - **Watcher:** the enforcer gains a long-running watch mode. It follows `GET /v1/router/events` and reconciles within seconds of each new `revision`.
   - **Polling:** while disconnected it polls `GET /v1/router/capabilities` every 30 s with `If-None-Match`. The 15-minute timer stays as a backstop.
   - **Source:** both modes read the capabilities document, not `/api/tags`.
6. **Wait through switches.** The overlay's native bridge treats 503 `BACKEND_DRAINING` and `MAINTENANCE_MODE`, received before any output, as "wait". It retries with 2 → 30 s backoff for up to 10 minutes and shows a status line ("The model server is switching configuration; waiting…"). Every other error is shown as it is today.
7. **One version-controlled home.** llm-router's `integrations/open-webui/` becomes the source for both the 0.11.4 overlay and the enforcer. The contract lives in the same repository, so this project links to it instead of copying it.

## Plan

### Step 1 — put the sources under version control, unchanged (no production change)

1. **Copy the overlay:** in a clean clone of `https://github.com/astigmatism/llm-router` (on 192.168.1.20 use `~/projects/llm-router`, per `~/README.md`), add `integrations/open-webui/v0.11.4/` containing the build `Dockerfile` and the `merged/open_webui/…` sources exactly as deployed (no `__pycache__`).
2. **Copy the enforcer:** add `integrations/open-webui/model-sync/` containing the enforcer script and its two systemd units exactly as installed, plus `MODEL-SYNC.md`.
3. **Prove they match:** record SHA-256 sums of the deployed files and the copies, and keep the image's `org.opencontainers.image.revision` label. This commit must reproduce production exactly.
4. **Mark the old sources:** in `integrations/open-webui/README.md`, mark the 0.11.3 files as historical.

### Step 2 — the contract in this project

1. **Link and rule:** in `integrations/open-webui/README.md`, link [the contract](../../docs/CLIENT_CONTRACT.md) and add the rule: *"Changes to the overlay or the enforcer that touch router requests, model lists, availability or retries must uphold docs/CLIENT_CONTRACT.md. Keep CONFORMANCE.md current."*
2. **Conformance map:** create `integrations/open-webui/CONFORMANCE.md`, mapping each contract §13 item to the overlay, the enforcer or a test. Record the permitted deviation: no fallback (§5).
3. **Host notes:** write `~/docs/open-webui.md` on 192.168.1.20 (the host requires setup notes in `~/docs/`). It covers what runs, the router integration, the enforcer, backups, and how to update and roll back.

### Step 3 — enforcer changes (`model-sync/`)

1. **Source:** read `GET http://192.168.1.4:11434/v1/router/capabilities`. Use `models[]` (each with `service`, `aliases`, `available`, `context_window`, `nsfw`, `display_name`), `offline_services[]` and `configuration.id`.
2. **Availability:** apply decision 2. Treat a profile as offline when its service ID appears in `offline_services`, or when its model is listed but `available: false`. Never retire anything because of an offline profile. Reactivate as soon as the model is back.
3. **Access policy:** apply decision 3. Keep the per-user exception list in configuration, and keep the existing grant-reconciliation code path.
4. **Labels:** apply decision 4. Write the routine rows' descriptions from `display_name`, the configuration, and the NSFW status.
5. **Watch mode:** add `--watch`. Follow `GET /v1/router/events` (complete document per `capabilities` event; keepalives every 15 s; 60 s of silence means the connection is dead). Reconnect with 3 → 30 s backoff, and poll every 30 s while disconnected.
   - **Units:** run it from a new `open-webui-model-sync-watch.service` with `Restart=always`, beside the existing timer.
   - **Reference code:** the reference client [router_watch.py](https://raw.githubusercontent.com/astigmatism/llm-router/1ecc04758ad4d0a6954713defad4d02ff3e8f351/docs/clients/router_watch.py) (standard library) provides the subscriber.
   - **Identification:** send `X-Client-Name: open-webui-model-sync`.
6. **Safety:** keep the existing rails. Make no database writes when the router is unreachable or returns no models, commit atomically, and keep one bounded state file. Keep `--dry-run`, `--source-file`, `--db` and `--state-file` for testing on scratch copies.

### Step 4 — overlay changes (`v0.11.4/`)

1. **Terminal metadata:** in `utils/router_completion.py`, remove the hard-coded `ROUTER_MODELS` set and rely on the router's `x_router` metadata only. The router attaches it to catalog generations; confirm that against a live response before removing the set.
2. **Waiting through switches:** in the native request path (`routers/ollama.py`), apply decision 6 before any output. Use `error.code` from the JSON body. Never retry after output has started, and never retry other codes.
3. **Identification:** send `X-Client-Name: open-webui` on every request to the router.
4. **Compaction:** in `utils/context_compaction.py`, cap the effective compaction threshold at the compaction model's context window, from the model information Open WebUI already holds, minus the 1024-token safety reserve and the requested output. Keep the environment values as upper bounds.
5. **Build and test:** build a new image tagged `local/open-webui:v0.11.4-router-v2`. Run the existing overlay tests inside it, plus new tests for the drain wait and the terminal metadata.

### Step 5 — tests (before touching production)

- **Enforcer, on scratch copies of `webui.db`** (`sqlite3 .backup` into `~/tmp/<task>/`), using `--source-file` fixtures:
  - paired → all four presets active with correct labels;
  - solo → Nighttime presets and rows inactive, with an "offline in …" description;
  - Nighttime unhealthy → inactive;
  - Nighttime returns, including with a new canonical ID → reactivated, relabelled, grants unchanged;
  - NSFW-based grants → Lili never gains Nighttime;
  - router unreachable → no writes;
  - every scenario ends in a no-op second run.
- **Watch mode:** a fake event stream with revision changes and a dropped connection.
- **Overlay:**
  - drain → waits, then completes;
  - `SERVICE_OFFLINE` → shown immediately, not retried;
  - a mid-stream error is not retried;
  - the header is sent;
  - compaction is capped for a small-window model.

### Step 6 — production rollout (each step needs the owner's go-ahead)

1. **Snapshot:** take a fresh SQLite snapshot (the backup script, or `sqlite3 .backup`) and record the current image ID, the enforcer's SHA-256, and the unit files.
2. **Enforcer:**
   - Install the new script and the watch unit.
   - Run `--dry-run` against the live database and review the planned changes with the owner.
   - Then start the watch service, and confirm one reconciliation and a no-op second pass.
3. **Overlay:**
   - Pick a time with no active chats.
   - Recreate the container per the header of `~/deployments/open-webui/compose.yml`. Supply `WEBUI_SECRET_KEY` from the running container's environment, and never print or store it. Change only the image tag.
   - Check health on port 3000, sign in, list models, and run one chat each on Daytime and Nighttime (or confirm Nighttime is hidden while solo).
4. **Rollback:**
   - **Overlay:** recreate with `local/open-webui:v0.11.4-router-v1`.
   - **Enforcer:** reinstall the recorded script and units.
   - **Database:** restore the snapshot only if the database itself was damaged.

## Boundaries and reporting

- **Out of scope:** don't modify the router or AI Runtime, and never switch configurations to test.
- **Data:** don't touch other users' chats, settings or credentials. The leftover hidden rows from an older Ollama backend (`hauhau-…`, `qwen3.6:…`, `hf.co/…`) are out of scope; report them only.
- **Same host:** 192.168.1.20 also runs a DeepSeek Harness. Its changes come from the separate [Harness handoff](deepseek-harness.md), not this one.
- **Report back:** commit SHAs, the file-equality proof from step 1, test results, the dry-run diff, rollout results, and the completed `CONFORMANCE.md`.
