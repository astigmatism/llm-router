# LLM Router rename and migration

The project is now **LLM Router**, repository and package `llm-router`:

```sh
git clone https://github.com/astigmatism/llm-router.git
cd llm-router
```

It was previously `local-ai-ollama-router`. The name describes its role without tying it to an inference engine or deployment location. Production uses llama.cpp. Ollama remains a supported backend and compatibility protocol.

## API compatibility

| Surface | Routes |
|---|---|
| OpenAI-compatible inference | `POST /v1/chat/completions`, `POST /v1/responses`, `POST /responses` |
| OpenAI-compatible discovery | `GET /v1/models`, `GET /v1/models/{id}` |
| Ollama-compatible inference | `POST /api/chat`, `POST /api/generate`; embedding routes depend on backend support |
| Ollama-compatible discovery/status | `/api/tags`, `/api/show`, `/api/ps`, `/api/version` |
| Operations | `/health`, separate admin portal and `/admin/api/*` |

OpenAI compatibility covers these implemented routes, not the entire OpenAI platform. Streaming, tools, images, and reasoning depend on the selected model's capabilities.

The rename changes package/image names, dashboard branding, `router.appName`, discovery `owned_by`, and the router identity value in response headers. It preserves endpoint paths, ports, model IDs and aliases, environment variable names, the `x_ollama_router` metadata key, and the `x-ollama-router` header name. Existing clients can keep their configuration, including `local-active` and any existing client-side provider ID. New configuration examples use `llm_router`.

## Existing Git checkout

After the GitHub repository rename, update the remote explicitly:

```sh
git remote set-url origin https://github.com/astigmatism/llm-router.git
git fetch origin
```

Preserve uncommitted work and check the current branch before pulling. A fresh clone is the simplest way to get the current `main` alongside an older working checkout. Directory names are independent of repository names; existing checkouts and linked worktrees do not need to move.

## Existing deployment

A repository rename does not rename or restart a running container. The next reviewed router-only publication renames the router container to **`llm-router`**. It preserves the existing Compose project name, bind mounts, external networks, runtime controller, and `ai-router` service/DNS alias. Moving a deployment directory without preserving its Compose project name and absolute data/runtime paths can create a second stack or select empty storage.

New Compose examples default to image and container `llm-router`. The production publisher sets `ROUTER_CONTAINER_NAME=llm-router` and writes `compose.router-identity.json` alongside the server's existing Compose files. This small override pins the existing project name and changes only the `ai-router` container name and network aliases. It retains `local-ai-ollama-router`, `ai-router`, any previous container hostname, and configured aliases on each router network. Existing runtime controllers can therefore continue using `http://local-ai-ollama-router:11435`.

The publisher automatically includes the override on every release, refuses an unrelated container already named `llm-router`, and verifies that the renamed container runs the reviewed image before reopening admission. Backups include any previous identity override; the deployment receipt records the new name, project and override hash. Network modes without Compose DNS aliases are rejected before draining.

`ROUTER_IMAGE` selects the reviewed `llm-router:git-<revision>` image. Follow [reviewed publication](RELEASE.md) when ready to deploy. For manual Compose operations after migration, include all three files from the existing stack directory:

```sh
docker compose -f compose.yaml -f compose.runtime.yaml -f compose.router-identity.json ps
```

Keep the identity override in subsequent Compose commands; omitting it can restore a hard-coded old container name or drop controller aliases. To restore pre-migration configuration, restore the backed-up `.env` and Compose files and remove the generated override if none existed before, while following the release's drain/recovery procedure. Do not run the legacy example Compose stack alongside production on the same ports.

The stack, checkout directories and model backend names stay unchanged. Historical capacity qualification scripts still refer to the old production container name; a DNS alias does not make old `docker inspect` or `docker restart` commands work. Use `llm-router` for current direct Docker commands. Historical source/handoff reports retain their original names and image references. Those references are not current project branding.

## Production identity verified on 2026-09-16

The container `local-ai-ollama-router` on `192.168.1.21` reported image and OCI revision `b9f61b8148b1eeddc58ecc3032213526f479a466`. SHA-256 checks of all 23 files under `src/`, `public/`, and `package.json` matched that Git revision exactly.

Its health response reported `backend_kind: llama_cpp`, and the resident servers `qwen38-daytime` and `qwen38-nighttime` ran the pinned llama.cpp image. The Compose project was `local-ai-ollama-stack`, service `ai-router`; API and admin ports were `11434` and `11435`.

The deployed capacity changes lived on `codex/primary-resident-catalog` and had not yet reached `main`. They were merged before this rename, preserving the Daytime 160K / Nighttime 128K catalog and the runtime controller ownership checks. Source in a fresh clone still requires environment-specific configuration, backend servers, model weights, and durable storage before deployment.
