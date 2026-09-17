# Legacy Ollama Deployment Handoff

This historical topology guide describes an Ollama-backed installation. Current production uses llama.cpp: start with [Primary integration](PRIMARY_INTEGRATION.md), [reviewed publication](RELEASE.md), and [rename/migration notes](RENAMING.md).

## Starting facts from the topology handoff

Current raw Ollama is exposed on the LAN at:

```text
http://192.168.1.21:11434
```

OpenWebUI currently uses Docker DNS `ollama:11434`, and that alias resolves to the raw Ollama container. ComfyUI and the voice assistant are expected to use the LAN endpoint. The migration objective is to make the router the only public Ollama-compatible endpoint.

## Port target

The desired target is a split listener setup:

```text
http://192.168.1.21:11434 = Ollama-compatible router API
http://192.168.1.21:11435 = unauthenticated human admin portal
```

If raw Ollama is still published on `11434`, move it behind the Docker network before binding the router API to `11434`, or temporarily set `ROUTER_PUBLIC_PORT` to another port only for migration testing.

## Phase 1: create project directory

```bash
mkdir -p /home/astigmatism/apps
cd /home/astigmatism/apps
unzip llm-router.zip
cd llm-router
cp .env.example .env
```

Edit `.env`:

```env
ROUTER_BIND_IP=192.168.1.21
ROUTER_PUBLIC_PORT=11434
ADMIN_ENABLED=true
ADMIN_BIND_HOST=0.0.0.0
ADMIN_PORT=11435
ADMIN_PUBLIC_PORT=11435
OLLAMA_UPSTREAM_URL=http://ollama:11434
UNIFIED_MODELS_DIR=<actual unified model directory>
ROUTER_MODEL_ALIAS=local-active
ROUTER_MODEL_METADATA_TTL_MS=5000
REWRITE_REQUESTED_MODEL_TO_ACTIVE=true
ALLOW_MODEL_MANAGEMENT=false
```

The exact `ROUTER_MODEL_ALIAS` is stable with either value of `REWRITE_REQUESTED_MODEL_TO_ACTIVE`. The broader `true` setting remains useful for compatibility clients that send other advisory names. Neither setting selects or loads the marker model; the deployment/profile system remains the sole writer of `active-model.json`.

## Phase 2: active model marker

The long-term owner should be `local-ai-config.sh` or `deploy-runtime.sh`. For the first test, write the marker manually:

```bash
./scripts/write-active-model.sh 'model-a:test' example-profile medium \
  runtime/reasoning-capabilities.night.example.json
```

The marker lands at:

```text
./runtime/active-model.json
```

Inside the container this is:

```text
/app/runtime/active-model.json
```

## Phase 3: start the router

```bash
docker compose --env-file .env up --build -d
docker logs -f llm-router
```

Confirm the router is reachable:

```bash
curl http://192.168.1.21:11434/
curl http://192.168.1.21:11434/api/version
```

Open admin portal, no token required:

```text
http://192.168.1.21:11435/
```

## Responses/Codex production handoff

Configure Codex with a stable client identifier:

```toml
model_provider = "llm_router"
model = "local-active"
model_reasoning_effort = "none"
web_search = "disabled"

[model_providers.llm_router]
name = "LLM Router"
base_url = "http://192.168.1.21:11434/v1"
wire_api = "responses"
requires_openai_auth = false
```

Before production cutover, run both smoke tests against the candidate deployment without changing the marker:

```bash
ROUTER_URL=http://192.168.1.21:11434 \
ADMIN_URL=http://192.168.1.21:11435 \
REQUESTED_MODEL=local-active \
./scripts/responses-smoke-test.sh

ROUTER_URL=http://192.168.1.21:11434 \
REQUESTED_MODEL=local-active \
./scripts/codex-responses-smoke-test.sh
```

Verify request history records `requestedModel: local-active`, `activeModel` and `forwardedModel` equal to the marker model, `modelRewritten: true`, and successful status/reasoning fields. Compare `ollama ps` before and after: only the active model should be resident and its lifetime should remain `Forever`. Also confirm no `/api/pull`, `/api/create`, `/api/copy`, `/api/push`, or `/api/delete` reached raw Ollama.

Strict-mode rollback is configuration-only: set `REWRITE_REQUESTED_MODEL_TO_ACTIVE=false` and restart the router. Codex can keep the exact stable alias; other mismatched IDs return `MODEL_NOT_ACTIVE`, while the alias, exact active model, and omitted Responses model remain accepted.

## Phase 4: keep-alive enforcement test

Run:

```bash
ROUTER_URL=http://192.168.1.21:11434 \
ADMIN_URL=http://192.168.1.21:11435 \
./scripts/curl-smoke-test.sh '<active-model>'
```

After each router-mediated request, check raw Ollama:

```bash
docker exec local-ai-llm-legacy-ollama ollama ps
```

Expected:

```text
UNTIL Forever
```

Also check the admin request history at `http://192.168.1.21:11435/`. The two smoke-test chat requests should show:

```text
forwardedKeepAlive: -1
```

The finite `5m` request should produce a `keep_alive_normalized` event.

## Phase 5: repoint OpenWebUI

In `/home/astigmatism/apps/open-webui/compose.yml`, change:

```yaml
OLLAMA_BASE_URL: "http://ollama:11434"
```

To one of these:

```yaml
OLLAMA_BASE_URL: "http://ai-router:11434"
```

or during transition:

```yaml
OLLAMA_BASE_URL: "http://192.168.1.21:11434"
```

Prefer `http://ai-router:11434` if OpenWebUI is attached to the same Docker network and can resolve the router service. Verify:

```bash
docker exec open-webui getent hosts ai-router
```

After restart, test a chat in OpenWebUI. Confirm router history shows OpenWebUI traffic and raw Ollama still reports `Forever`.

Caution: OpenWebUI may persist connection settings in its database. If traffic does not show in router history, inspect OpenWebUI settings and database-backed Ollama URLs.

## Phase 6: repoint ComfyUI

Search current ComfyUI app files and workflow JSON for:

```text
http://192.168.1.21:11434
```

Use the router API URL:

```text
http://192.168.1.21:11434
```

If raw Ollama is still occupying `11434` during a temporary migration, use the temporary `ROUTER_PUBLIC_PORT` value, then return clients to `11434` after cutover.

Recommended improvement: make the ComfyUI Ollama prompt bridge read a single environment variable for the router base URL instead of hardcoding it in source/workflows.

## Phase 7: repoint voice assistant and other LAN clients

Set the voice assistant Ollama base URL to:

```text
http://192.168.1.21:11434
```

The voice assistant should not select or swap models. It should call the active model only. If it cannot supply a model, either configure it to send the active model or deliberately set `USE_ACTIVE_MODEL_WHEN_MISSING=true` after accepting the behavior.

## Phase 8: remove raw Ollama LAN exposure

Only do this after all clients are verified through router history.

Change raw Ollama compose from a public `ports` mapping to internal-only `expose` or no public port:

```yaml
expose:
  - "11434"
```

Then publish the router API/admin split, or use `compose.final-example.yml` as a guide:

```env
ROUTER_PUBLIC_PORT=11434
ADMIN_PORT=11435
ADMIN_PUBLIC_PORT=11435
```

Verify direct raw endpoint is no longer reachable from the LAN:

```bash
ROUTER_URL=http://192.168.1.21:11434 ADMIN_URL=http://192.168.1.21:11435 RAW_URL=http://old-raw-ollama-host:11434 ./scripts/check-cutover.sh
```

After the final port move, omit `RAW_URL` when there is no suspected raw LAN address, or set it to the old raw Ollama address to confirm that bypass path is gone.

## Phase 9: deprecate local-ai-llm-legacy

Once the router admin UI covers the needed portal features, stop publishing `local-ai-llm-legacy` on `192.168.1.21:8001`. Keep it temporarily available for comparison only if needed, then archive it.

## Acceptance checklist

- OpenWebUI lists models through the router.
- OpenWebUI chats through the router.
- ComfyUI prompt bridge calls the router.
- Voice assistant calls the router.
- Streaming and non-streaming responses work.
- With Responses rewriting enabled, `local-active`, arbitrary non-empty identifiers, and an omitted model all forward only the active marker model.
- With Responses rewriting disabled, mismatched identifiers return `MODEL_NOT_ACTIVE`; the stable alias, exact active model, and omitted models still work.
- `/v1/models` returns only the stable alias and revalidates dynamic metadata with ETags.
- Active model requests without `keep_alive` are forwarded with `-1`.
- Active model requests with finite `keep_alive` are forwarded with `-1`.
- Non-active model requests are rejected by default.
- Request history shows client identity, endpoint, model, keep-alive rewrite, status, and latency.
- Responses history distinguishes requested, active, and forwarded model names and records `modelRewritten` plus reasoning telemetry.
- `ollama ps` contains only the active model after advisory-name tests, and no model-management operation reaches Ollama.
- Admin dashboard is reachable without a token on `http://192.168.1.21:11435/` and shows upstream health and active loaded state.
- Raw Ollama is not published directly to the LAN.

## Independent nighttime CUDA vision OOM

The CUDA vision OOM is not addressed by this router release. Correct the nighttime VRAM configuration as a separate deployment change and validate it independently; do not attribute that failure to Responses model rewriting.
