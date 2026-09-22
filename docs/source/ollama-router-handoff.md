# Ollama Router Handoff: Current Topology, Findings, and Target Direction

Generated: 2026-06-29

## 1. Purpose

This document captures the current local AI/Ollama topology, the keep-alive behavior discovered during troubleshooting, and the proposed direction for creating a dedicated Ollama-compatible router in front of the real Ollama service.

The core goal is to stop individual clients from being able to accidentally or intentionally change Ollama model residency behavior. In particular, the currently deployed/prewarmed model should remain loaded with `keep_alive: -1` unless an explicit admin/deployment action changes that state.

The future architecture should centralize policy enforcement, telemetry, and routing in a new internal AI router instead of relying on every client integration to behave correctly.

---

## 2. Current Problem Statement

The current system is configured to keep the deployed Ollama model loaded indefinitely:

```env
PREWARM_DEFAULT_MODEL_ON_START=true
PREWARM_TIMEOUT_MS=900000
PREWARM_KEEP_ALIVE=-1
OLLAMA_KEEP_ALIVE=-1
OLLAMA_CONTEXT_LENGTH=131072
OLLAMA_NUM_PARALLEL=2
OLLAMA_MAX_LOADED_MODELS=1
```

However, live testing showed that the server/container-level `OLLAMA_KEEP_ALIVE=-1` is not sufficient to guarantee that the model remains marked as `Forever` after later client requests.

Observed behavior:

1. The live Ollama container had `OLLAMA_KEEP_ALIVE=-1`.
2. `ollama ps` still showed a finite unload countdown, for example `29 minutes from now`.
3. A direct `/api/chat` request without request-level `keep_alive` did not change the countdown back to `Forever`.
4. A direct `/api/chat` request with explicit request-level `"keep_alive": -1` changed the model state to `Forever`.

Conclusion:

```text
Any client that can call raw Ollama directly can potentially change the model's residency timer by omitting, overriding, or sending a finite keep_alive value.
```

Therefore, the durable fix is not to patch OpenWebUI, ComfyUI, or the voice assistant one at a time. The durable fix is to put a policy-enforcing router/proxy in front of Ollama and make raw Ollama private.

---

## 3. Current Runtime Topology

### 3.1 Host and LAN Bindings

Current exposed services from `docker ps --format 'table {{.Names}}\t{{.Ports}}'`:

```text
NAMES                        PORTS
local-ai-llm-legacy          192.168.1.4:8001->8000/tcp
local-ai-llm-legacy-ollama   192.168.1.4:11434->11434/tcp
local-ai-comfyui             192.168.1.4:8188->8188/tcp
portainer                    8000/tcp, 9000/tcp, 192.168.1.4:9443->9443/tcp
open-webui                   192.168.1.4:3000->8080/tcp
```

Important current exposure:

```text
local-ai-llm-legacy-ollama   192.168.1.4:11434->11434/tcp
```

This means raw Ollama is directly reachable from the LAN at:

```text
http://192.168.1.4:11434
```

Any LAN client can bypass `local-ai-llm-legacy` and call Ollama directly.

### 3.2 Docker Network Topology

Observed Docker network aliases:

```text
/local-ai-llm-legacy-ollama local-ai-llm-legacy_default ip=172.23.0.3 aliases=[local-ai-llm-legacy-ollama ollama]
/open-webui local-ai-llm-legacy_default ip=172.23.0.2 aliases=[open-webui open-webui]
/local-ai-comfyui local-ai-comfyui_default ip=172.21.0.2 aliases=[local-ai-comfyui comfyui]
/local-ai-llm-legacy local-ai-llm-legacy_default ip=172.23.0.4 aliases=[local-ai-llm-legacy app]
```

Important current Docker DNS exposure:

```text
ollama -> local-ai-llm-legacy-ollama
```

OpenWebUI is on the same Docker network as raw Ollama and currently resolves `ollama` directly to the raw Ollama container.

Observed from inside OpenWebUI:

```text
getent hosts ollama
172.23.0.3      ollama
```

That IP belongs to:

```text
/local-ai-llm-legacy-ollama 172.23.0.3
```

So OpenWebUI is currently bypassing `local-ai-llm-legacy` and talking directly to Ollama.

---

## 4. Current Deployment/Configuration System

### 4.1 Top-Level Profile Orchestrator

The local AI configuration system is driven by:

```text
~/local-ai-config.sh
~/local-ai-configs.json
```

The orchestrator supports commands such as `validate`, `plan`, and `apply`.

It reads profile definitions from `~/local-ai-configs.json`, validates GPU UUID assignments and service paths, then deploys assigned services.

The LLM service is defined as:

```json
{
  "display_name": "local-ai-llm-legacy",
  "type": "llm",
  "app_dir": "/home/astigmatism/apps/local-ai-llm-legacy",
  "deploy_script": "./deploy-runtime.sh",
  "min_gpu_slots": 1,
  "max_gpu_slots": 4
}
```

The orchestrator calls the deploy script with GPU and model arguments similar to:

```bash
bash "$script_path" "$action" --gpu-device-ids "$gpu_csv" --model "$model"
```

### 4.2 Known LLM Profiles

Known LLM profile model assignments:

| Profile | GPU count observed/intended | Model |
|---|---:|---|
| `daytime` | 3 GPUs | `qwen3.6:35b-a3b-q8_0` |
| `nighttime` | 2 GPUs | `hauhau-qwen3.6-35b-a3b-aggressive-q4-k-m:qwen35-parser` |
| `brains` | 3 GPUs | `qwen3.6:27b-bf16` |

The future router should not invent its own model selection. The deployment/profile system should remain the source of truth for the active/prewarmed model.

Recommended future behavior:

```text
local-ai-config.sh / deploy-runtime.sh writes an active-model marker
AI router reads active-model marker
AI router enforces policy only for the active model unless explicitly configured otherwise
```

---

## 5. Current `local-ai-llm-legacy` App

### 5.1 Role Today

`local-ai-llm-legacy` is not currently a universal Ollama router. It is a custom app/portal that exposes its own routes and internally calls Ollama.

Currently exposed top-level routes include:

```text
GET  /
GET  /assets/app.css
GET  /assets/app.js
GET  /openapi.json
GET  /health
GET  /api/capabilities
POST /api/assistant/chat
POST /api/images/generate
GET  /gpu
GET  /gpus
GET  /models/running
GET  /models/installed
GET  /config
POST /config
POST /model/load
POST /model/prewarm
```

It does not currently expose Ollama-compatible passthrough endpoints such as:

```text
POST /api/chat
POST /api/generate
GET  /api/tags
POST /api/show
GET  /api/ps
GET  /api/version
```

### 5.2 Current Internal Ollama Client Behavior

The app has an internal `OllamaClient` that calls Ollama endpoints such as:

```text
/api/generate
/api/chat
```

The prewarm path is correct and explicitly sends keep-alive:

```json
{
  "model": "<model>",
  "stream": false,
  "keep_alive": -1
}
```

But normal app chat currently does not include `keep_alive` in the `/api/chat` body. That only affects traffic routed through this app; it does not protect OpenWebUI, ComfyUI, or other clients that directly call raw Ollama.

### 5.3 Deprecation Direction

`local-ai-llm-legacy` should eventually be deprecated or absorbed into the new router/admin portal.

Recommended phased approach:

1. Keep `local-ai-llm-legacy` running initially while the router is built and tested.
2. Build the router as a separate project/container, likely under:

   ```text
   /home/astigmatism/apps/local-ai-ollama-router
   ```

   or:

   ```text
   /home/astigmatism/apps/ai-router
   ```

3. Have the router talk to raw Ollama internally.
4. Repoint clients to the router.
5. Move useful `local-ai-llm-legacy` portal features into the router admin portal, including:
   - model prewarm
   - running model status
   - installed model status
   - GPU telemetry
   - active/default model display
   - image-generation capability display if still needed
6. Once the router has equivalent functionality, stop exposing `local-ai-llm-legacy` on the LAN.
7. Archive or remove the legacy app after verification.

The Ollama backend container may continue to exist, but it should become private infrastructure owned by the router/deployment stack rather than a directly consumed service.

---

## 6. Current Integrations That Must Be Repointed

The grep inventory found several raw Ollama references. These are the known consumers/configurations that will need to be changed to point at the router.

### 6.1 OpenWebUI

Current compose file:

```text
/home/astigmatism/apps/open-webui/compose.yml
```

Current relevant setting:

```yaml
OLLAMA_BASE_URL: "http://ollama:11434"
```

Current behavior:

```text
OpenWebUI -> Docker DNS alias ollama -> raw local-ai-llm-legacy-ollama
```

Target behavior:

```text
OpenWebUI -> AI router -> raw Ollama
```

Possible future settings:

```yaml
OLLAMA_BASE_URL: "http://ai-router:11434"
```

or, if the router deliberately takes over the `ollama` alias for compatibility:

```yaml
OLLAMA_BASE_URL: "http://ollama:11434"
```

with `ollama` resolving to the router, not the raw Ollama container.

Important caution: OpenWebUI may persist some configuration in its database. After changing environment variables, verify that OpenWebUI actually calls the router and not a stored old URL.

### 6.2 ComfyUI

Current ComfyUI container:

```text
local-ai-comfyui 192.168.1.4:8188->8188/tcp
```

Current Docker network:

```text
local-ai-comfyui_default
```

This is separate from the OpenWebUI/Ollama network, so ComfyUI appears to reach Ollama over the LAN rather than Docker DNS.

Known raw Ollama references:

```text
/home/astigmatism/apps/local-ai-comfyui/custom_nodes/ComfyUI-OllamaPromptBridge/__init__.py
/home/astigmatism/apps/local-ai-comfyui/custom_nodes/ComfyUI-OllamaPromptBridge/__init__.py.bak
/home/astigmatism/apps/local-ai-comfyui/custom_nodes/ComfyUI-OllamaPromptBridge/__init__.py.flux-v1.bak
/home/astigmatism/apps/local-ai-comfyui/user/default/workflows/LTX 2.3 and 10S with Ollama.json
/home/astigmatism/apps/local-ai-comfyui/user/default/workflows/LTX 2.3 + 10S + Ollama + SNOFS.json
```

Known current hardcoded/default URL:

```text
http://192.168.1.4:11434
```

Target future URL should be the router's LAN endpoint, for example:

```text
http://192.168.1.4:11434
```

only after port `11434` is moved from raw Ollama to the router.

Alternative during transition:

```text
http://192.168.1.4:<temporary-router-port>
```

Recommended improvement:

```text
Do not hardcode raw Ollama URLs in workflow JSON or custom node source.
Expose a single configurable Ollama/router base URL for ComfyUI nodes.
```

### 6.3 `local-ai-images-legacy`

Known raw Ollama references:

```text
/home/astigmatism/apps/local-ai-images-legacy/.env.example
/home/astigmatism/apps/local-ai-images-legacy/src/config/env.ts
/home/astigmatism/apps/local-ai-images-legacy/tests/imageConfig.test.ts
/home/astigmatism/apps/local-ai-images-legacy/tests/startup.test.ts
```

Known defaults/examples include:

```text
OLLAMA_BASE_URL=
http://127.0.0.1:11434
```

This app should be inspected before migration to determine whether its live `.env` points to raw Ollama. If it does, point it to the router.

### 6.4 `local-ai-llm-legacy`

Known raw Ollama references:

```text
/home/astigmatism/apps/local-ai-llm-legacy/.env
/home/astigmatism/apps/local-ai-llm-legacy/.env.example
/home/astigmatism/apps/local-ai-llm-legacy/compose.yaml
/home/astigmatism/apps/local-ai-llm-legacy/deploy-runtime.sh
/home/astigmatism/apps/local-ai-llm-legacy/src/config/env.ts
/home/astigmatism/apps/local-ai-llm-legacy/Dockerfile
```

Current internal app setting:

```text
OLLAMA_BASE_URL=http://ollama:11434
```

The deploy script writes:

```text
OLLAMA_BASE_URL=http://ollama:11434
```

This is fine while `local-ai-llm-legacy` remains coupled to the raw Ollama container, but if the router becomes the central policy point, the legacy app should either:

1. Be repointed to the router, or
2. Be deprecated after its useful features are moved into the router.

### 6.5 Alexa-like / Voice Assistant Device

This device was not inspected directly in the troubleshooting session, but it is known to use Ollama on the home network.

Expected current behavior:

```text
voice assistant -> http://192.168.1.4:11434 -> raw Ollama
```

Target future behavior:

```text
voice assistant -> router -> raw Ollama
```

Important design rule from prior architecture preference:

```text
The voice assistant should not select, load, or swap Ollama models.
It should use the active/preloaded model through the router or fail closed if no usable loaded model is available.
```

---

## 7. Target Architecture

### 7.1 Desired High-Level Topology

Current topology:

```text
OpenWebUI -----------\
ComfyUI -------------+--> raw Ollama
voice assistant -----/
local-ai-llm-legacy -/
```

Target topology:

```text
OpenWebUI -----------\
ComfyUI -------------+--> AI router --> raw Ollama
voice assistant -----/
local-ai apps -------/
```

Raw Ollama should become private:

```text
clients ✗-> raw Ollama
clients --> AI router --> raw Ollama
```

### 7.2 Router Responsibilities

The router should be an Ollama-compatible reverse proxy. It should preserve enough of the Ollama API surface that OpenWebUI, ComfyUI, and other clients can use it as though it were Ollama.

Primary responsibilities:

1. Receive Ollama-compatible API requests.
2. Validate requested model against the active/deployed model policy.
3. Inject or overwrite `keep_alive` for protected model requests.
4. Forward sanitized requests to raw Ollama.
5. Stream responses correctly for streaming endpoints.
6. Record request history and telemetry.
7. Expose an admin portal/API for observability and control.
8. Prevent or reject requests that would load/swap unintended models unless explicitly allowed.

### 7.3 Protocol Compatibility Goal

The router should support these Ollama endpoints at minimum:

```text
GET  /api/tags
POST /api/show
POST /api/chat
POST /api/generate
GET  /api/ps
GET  /api/version
```

Strongly consider supporting these as well:

```text
POST /api/embed
POST /api/embeddings
POST /api/pull
POST /api/create
DELETE /api/delete
POST /api/copy
```

For potentially destructive or model-changing endpoints, the router should not blindly pass through by default. It should apply policy.

Recommended default policy:

| Endpoint type | Default behavior |
|---|---|
| Chat/generate against active model | Allow, force `keep_alive: -1` |
| Chat/generate against non-active model | Reject unless explicitly allowed |
| List/show/status/version | Allow |
| Pull/create/delete/copy | Admin-only or disabled by default |
| Embeddings | Allow only if model policy is clear |

---

## 8. Keep-Alive Enforcement Policy

### 8.1 Core Invariant

For the active deployed model:

```text
Every request that can load or refresh model state must be forwarded to Ollama with keep_alive = -1.
```

This applies especially to:

```text
POST /api/chat
POST /api/generate
```

and possibly to embeddings or other endpoints if testing shows they affect model residency.

### 8.2 Rewrite Behavior

Recommended behavior for protected active model:

| Incoming request body | Forwarded request body |
|---|---|
| no `keep_alive` | add `"keep_alive": -1` |
| `"keep_alive": "5m"` | overwrite with `"keep_alive": -1` |
| `"keep_alive": 1800` | overwrite with `"keep_alive": -1` |
| `"keep_alive": -1` | preserve |

Recommended logging:

```json
{
  "event": "keep_alive_normalized",
  "endpoint": "/api/chat",
  "model": "hauhau-qwen3.6-35b-a3b-aggressive-q4-k-m:qwen35-parser",
  "incomingKeepAlive": "5m",
  "forwardedKeepAlive": -1,
  "client": "open-webui"
}
```

### 8.3 Fail-Closed Model Policy

The router should not automatically cause Ollama to load or swap models. The active/preloaded model is managed elsewhere by the deployment/profile system.

Recommended behavior:

```text
if request.model != active_model:
  reject by default
```

Possible response:

```json
{
  "error": {
    "code": "MODEL_NOT_ACTIVE",
    "message": "Requested model is not the active deployed model for this router profile."
  }
}
```

Allow exceptions only through deliberate admin configuration, not silent fallback.

---

## 9. Admin Portal / Observability Requirements

The router should include an admin portal or dashboard. This can replace much of the current `local-ai-llm-legacy` portal over time.

### 9.1 Dashboard Summary

Display:

- Router health
- Raw Ollama health
- Active deployed model
- Whether active model is currently loaded
- Current `ollama ps` state
- Current `UNTIL` value, especially whether it is `Forever`
- GPU visibility and usage
- Context length / parallelism / max loaded models
- Upstream Ollama URL
- Router version/build timestamp

### 9.2 Request History

Persist and display recent requests:

- timestamp
- client identity
- source IP
- Docker/container identity if known
- endpoint
- method
- requested model
- active model at request time
- incoming `keep_alive`
- forwarded `keep_alive`
- whether request was allowed/rejected
- response status
- latency
- streaming vs non-streaming
- error summary

Do not log full prompts by default. Provide an explicit redacted/debug mode if prompt logging is needed.

### 9.3 Metrics

Track:

- requests per client
- requests per endpoint
- requests per model
- rejected model mismatch count
- keep-alive normalization count
- upstream Ollama errors
- latency percentiles
- streaming duration
- tokens if available from Ollama response metadata
- current loaded models
- GPU utilization if available
- VRAM usage if available

### 9.4 Activity Timeline

Show operational events:

- router startup
- upstream Ollama unavailable/recovered
- active model marker changed
- prewarm triggered
- model changed from finite countdown to `Forever`
- request rejected due to model mismatch
- request normalized from finite keep-alive to `-1`
- admin config changes

### 9.5 Controls

Admin controls should include:

- view active model
- manually re-prewarm active model
- run `/api/ps` health check
- run a test chat through router
- toggle maintenance mode
- reload config
- set temporary allowlist for non-active model, if needed

Avoid giving the portal automatic authority to swap models unless that is explicitly added later as an admin-only operation.

---

## 10. Network and Compose Direction

### 10.1 Make Raw Ollama Private

The raw Ollama container should eventually stop publishing this LAN port:

```text
192.168.1.4:11434->11434/tcp
```

Instead, raw Ollama should be reachable only from the router on an internal Docker network.

Current raw Ollama exposure:

```yaml
ports:
  - "${OLLAMA_BIND_IP:-192.168.1.4}:${OLLAMA_PORT:-11434}:11434"
```

Target raw Ollama exposure:

```yaml
expose:
  - "11434"
```

or no public `ports` entry at all.

### 10.2 Router Should Own the Public Ollama-Compatible Port

For compatibility, the router can eventually publish:

```text
192.168.1.4:11434->11434/tcp
```

This allows clients and workflow JSON that currently point to `http://192.168.1.4:11434` to keep working after the cutover, but with the router enforcing policy.

Transition option:

1. Start router on a temporary port, for example `192.168.1.4:11435`.
2. Test all router behavior.
3. Repoint OpenWebUI/ComfyUI/voice assistant to `11435`.
4. Once stable, move raw Ollama off `11434` and move router onto `11434`.
5. Repoint any remaining clients that hardcoded the old port.

### 10.3 Docker DNS Alias Strategy

OpenWebUI currently uses:

```text
http://ollama:11434
```

and `ollama` currently resolves to raw Ollama.

Future options:

#### Option A: Explicit router hostname

```yaml
OLLAMA_BASE_URL: "http://ai-router:11434"
```

Pros:

- Clear and explicit
- Avoids ambiguity
- Easier to debug

Cons:

- Requires changing OpenWebUI config and possibly persistent DB config

#### Option B: Router takes over `ollama` alias

```text
ollama -> router
ollama-backend -> raw Ollama
```

Pros:

- Maximum compatibility with clients expecting `ollama`

Cons:

- Easier to confuse router vs backend
- Requires careful Docker Compose network alias management

Recommended long-term approach:

```text
Use explicit names internally: ai-router and ollama-backend.
Only preserve the ollama alias if compatibility requires it.
```

---

## 11. Migration Plan

### Phase 1: Build Router as a Sidecar

Create a new project under the user's home directory, for example:

```text
/home/astigmatism/apps/local-ai-ollama-router
```

Initial deployment:

```text
clients still use raw Ollama
router runs on temporary port
router forwards to raw Ollama internally
```

Router upstream:

```text
OLLAMA_UPSTREAM_URL=http://ollama:11434
```

Router public test port example:

```text
192.168.1.4:11435->11434/tcp
```

### Phase 2: Implement Ollama-Compatible Proxy Endpoints

Implement and test:

```text
GET  /api/tags
POST /api/show
POST /api/chat
POST /api/generate
GET  /api/ps
GET  /api/version
```

Streaming support is required for clients that use `stream: true`.

### Phase 3: Implement Active Model Policy

Router should read active model from one of:

1. File written by `deploy-runtime.sh`, for example:

   ```text
   /home/astigmatism/apps/local-ai-ollama-router/runtime/active-model.json
   ```

2. Shared config generated by `local-ai-config.sh`.
3. Router environment variable as a temporary fallback.

Example active model marker:

```json
{
  "profile": "nighttime",
  "model": "hauhau-qwen3.6-35b-a3b-aggressive-q4-k-m:qwen35-parser",
  "keep_alive": -1,
  "updated_at": "2026-06-29T00:00:00-07:00",
  "source": "local-ai-config.sh apply nighttime"
}
```

### Phase 4: Implement Keep-Alive Rewriting

For active model requests:

```text
incoming keep_alive missing/finite -> forwarded keep_alive -1
```

Verify with direct tests:

1. Prewarm model through router.
2. Run `ollama ps`; confirm `Forever`.
3. Send `/api/chat` through router without `keep_alive`.
4. Run `ollama ps`; confirm still `Forever`.
5. Send `/api/chat` through router with `keep_alive: "5m"`.
6. Run `ollama ps`; confirm still `Forever`.

### Phase 5: Repoint OpenWebUI

Change OpenWebUI from:

```yaml
OLLAMA_BASE_URL: "http://ollama:11434"
```

to:

```yaml
OLLAMA_BASE_URL: "http://ai-router:11434"
```

or another router URL.

Verify:

```bash
docker exec open-webui getent hosts ai-router
```

Then send a chat via OpenWebUI and confirm:

```bash
docker exec local-ai-llm-legacy-ollama ollama ps
```

Expected:

```text
UNTIL Forever
```

Also verify the router request history shows OpenWebUI traffic.

### Phase 6: Repoint ComfyUI

Update ComfyUI custom node defaults and user workflow JSON references away from raw Ollama.

Current known URL:

```text
http://192.168.1.4:11434
```

During transition, use:

```text
http://192.168.1.4:11435
```

or final router port:

```text
http://192.168.1.4:11434
```

After running a ComfyUI workflow that uses Ollama, verify:

1. Router request history shows the request.
2. Raw Ollama `ollama ps` remains `Forever`.
3. No direct raw Ollama request appears from ComfyUI.

### Phase 7: Repoint Voice Assistant and Other LAN Clients

Update the Alexa-like device and any other clients to use router endpoint.

Recommended behavior:

```text
voice assistant -> router active model -> raw Ollama
```

The voice assistant should not send arbitrary model names or trigger model swaps.

### Phase 8: Remove Raw Ollama LAN Exposure

Once all clients are verified through the router:

1. Remove raw Ollama `ports` mapping.
2. Keep raw Ollama reachable only on an internal Docker network.
3. Publish the router on the compatibility port, likely `192.168.1.4:11434`.
4. Verify raw Ollama is not reachable from LAN:

   ```bash
   curl http://192.168.1.4:<raw-ollama-port>/api/version
   ```

   should fail if raw port is no longer published.

5. Verify router is reachable:

   ```bash
   curl http://192.168.1.4:11434/api/version
   ```

### Phase 9: Deprecate `local-ai-llm-legacy`

Move remaining useful functionality to router/admin portal:

- `/health`
- `/models/running`
- `/models/installed`
- `/model/prewarm`
- GPU telemetry
- default/active model display
- portal UI

Then:

1. Stop publishing `local-ai-llm-legacy` on `192.168.1.4:8001`.
2. Keep it available only temporarily if needed for comparison.
3. Archive the project once the router fully replaces it.

---

## 12. Acceptance Criteria for Router Project

The router is acceptable when all of the following are true:

### Compatibility

- OpenWebUI can list models through the router.
- OpenWebUI can chat through the router.
- ComfyUI Ollama prompt nodes can call the router.
- Voice assistant can call the router.
- Streaming and non-streaming responses work.

### Keep-Alive Enforcement

- Request to active model without `keep_alive` is forwarded with `keep_alive: -1`.
- Request to active model with finite `keep_alive` is forwarded with `keep_alive: -1`.
- `ollama ps` remains `Forever` after router-mediated OpenWebUI traffic.
- `ollama ps` remains `Forever` after router-mediated ComfyUI traffic.
- `ollama ps` remains `Forever` after router-mediated voice assistant traffic.

### Model Safety

- Request for non-active model is rejected by default.
- Router does not silently load/swap models.
- Any admin override is explicit and logged.

### Network Safety

- Raw Ollama is not published directly to the LAN.
- Docker clients do not resolve `ollama` to raw Ollama unless intentionally allowed.
- Router is the only public Ollama-compatible endpoint.

### Observability

- Admin portal shows request history.
- Admin portal shows keep-alive rewrites.
- Admin portal shows active model and loaded state.
- Admin portal shows upstream health.
- Admin portal shows error/rejection counts.

### Deprecation

- `local-ai-llm-legacy` is no longer required for normal client traffic.
- Any remaining useful portal features are migrated or intentionally dropped.

---

## 13. Suggested Implementation Prompt for Larger AI Model

Use this as the starting request for a larger implementation model:

```text
You are helping implement a local Ollama-compatible router for an existing Docker-based local AI stack.

Goal:
Create a new router project under /home/astigmatism/apps/local-ai-ollama-router that sits between all local AI clients and the real Ollama container. The router must expose an Ollama-compatible API surface so OpenWebUI, ComfyUI custom nodes/workflows, a voice assistant device, and local AI apps can use it instead of calling raw Ollama directly.

Current topology:
- Raw Ollama container: local-ai-llm-legacy-ollama
- Raw Ollama is currently published at 192.168.1.4:11434->11434/tcp
- local-ai-llm-legacy app is published at 192.168.1.4:8001->8000/tcp
- OpenWebUI is published at 192.168.1.4:3000->8080/tcp
- ComfyUI is published at 192.168.1.4:8188->8188/tcp
- OpenWebUI currently uses OLLAMA_BASE_URL=http://ollama:11434
- Docker alias ollama currently resolves to raw local-ai-llm-legacy-ollama
- ComfyUI custom nodes/workflows currently reference http://192.168.1.4:11434

Core policy:
The profile/deployment system is the source of truth for the active/prewarmed model. The router must not auto-select, auto-load, or auto-swap models. For the active model only, every request to /api/chat and /api/generate must be forwarded to Ollama with keep_alive=-1, regardless of whether the client omitted keep_alive or sent a finite value. Requests for non-active models should fail closed by default unless explicitly allowed by admin configuration.

Required initial endpoints:
- GET /api/tags
- POST /api/show
- POST /api/chat
- POST /api/generate
- GET /api/ps
- GET /api/version

Admin portal requirements:
- show active model
- show raw Ollama health
- show loaded/running models and whether active model is Forever
- show request history
- show client/source, endpoint, model, incoming keep_alive, forwarded keep_alive, latency, status, errors
- show keep-alive normalization events
- provide manual prewarm for active model
- provide safe config/status view

Migration goals:
- build router first on a temporary port
- prove keep_alive enforcement with direct curl tests and ollama ps
- repoint OpenWebUI to the router
- repoint ComfyUI custom nodes/workflows to the router
- repoint voice assistant and other LAN clients
- remove raw Ollama LAN port exposure
- eventually publish router on 192.168.1.4:11434 for compatibility
- deprecate local-ai-llm-legacy after router/admin portal replaces its useful features

Important implementation constraints:
- Do not hardcode final real profile definitions beyond reading the existing deployment source of truth.
- Do not silently remove existing behavior from current projects.
- Work from full current source files before modifying anything.
- Avoid TypeScript any unless there is no derivable safe type and you explicitly stop to ask.
- Return modified files as a convenient zip package containing full replacement files.
```

---

## 14. Open Questions for Implementation

1. Should the router be implemented in TypeScript/Node.js to match the existing local apps, or in another stack?
2. Should the router own the Ollama backend container lifecycle, or only proxy to the existing `local-ai-llm-legacy-ollama` service initially?
3. What exact file or API should be the active-model source of truth?
4. Should non-active model requests always be rejected, or should there be a temporary admin allowlist?
5. Should the router take over the Docker DNS alias `ollama`, or should all clients be explicitly repointed to `ai-router`?
6. Should prompt bodies be logged never, redacted, sampled, or admin-toggleable?
7. Should the router include authentication for LAN clients, or rely on LAN-only network boundaries initially?
8. Should destructive/model-management endpoints such as pull/create/delete be disabled by default?
9. Should the router eventually replace the current `local-ai-llm-legacy` portal entirely?

---

## 15. Summary Direction

The current architecture exposes raw Ollama too broadly. Even though the deployment scripts correctly prewarm models with `keep_alive=-1`, later direct client calls can still cause Ollama to show a finite unload timer. OpenWebUI was discovered as one direct client, but ComfyUI, local image apps, and the voice assistant are also relevant.

The target solution is a dedicated Ollama-compatible router that becomes the only supported entry point for LLM traffic. The router should enforce active-model and keep-alive policy, collect request history and telemetry, expose an admin portal, and eventually replace/deprecate `local-ai-llm-legacy` as the operational UI.
