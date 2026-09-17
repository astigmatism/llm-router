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

A repository rename does not rename or restart a running container. Preserve the existing Compose project name, bind mounts, external networks, runtime controller, and `ai-router` service/DNS alias. Moving a deployment directory without preserving its Compose project name and absolute data/runtime paths can create a second stack or select empty storage.

New Compose examples default to image and container `llm-router`. When reusing these examples in an installation with the old container name, set:

```dotenv
ROUTER_CONTAINER_NAME=local-ai-ollama-router
```

`ROUTER_IMAGE` can select the reviewed `llm-router:git-<revision>` image. The production publisher uses the server's existing Compose files and replaces only the `ai-router` service; it does not rename the production container, stack, directories, or model backends. Follow [reviewed publication](RELEASE.md) when ready to deploy. Do not run the legacy example Compose stack alongside production on the same ports.

Historical capacity qualification scripts still refer to the old production container name because they target that specific deployment. Historical source/handoff reports retain their original names and image references. Those references are not current project branding.

## Production identity verified on 2026-09-16

The container `local-ai-ollama-router` on `192.168.1.21` reported image and OCI revision `b9f61b8148b1eeddc58ecc3032213526f479a466`. SHA-256 checks of all 23 files under `src/`, `public/`, and `package.json` matched that Git revision exactly.

Its health response reported `backend_kind: llama_cpp`, and the resident servers `qwen38-daytime` and `qwen38-nighttime` ran the pinned llama.cpp image. The Compose project was `local-ai-ollama-stack`, service `ai-router`; API and admin ports were `11434` and `11435`.

The deployed capacity changes lived on `codex/primary-resident-catalog` and had not yet reached `main`. They were merged before this rename, preserving the Daytime 160K / Nighttime 128K catalog and the runtime controller ownership checks. Source in a fresh clone still requires environment-specific configuration, backend servers, model weights, and durable storage before deployment.
