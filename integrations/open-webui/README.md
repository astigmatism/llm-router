# Open WebUI integration

## Current deployment (192.168.1.20)

Open WebUI runs on its own host, 192.168.1.20 (container `open-webui`, port 3000, data in `/opt/open-webui/data`). It reaches the router through a native Ollama connection (`OLLAMA_BASE_URL=http://ai-router:11434`, with `extra_hosts` mapping `ai-router` to 192.168.1.4). Two parts of this directory run there:

| Directory | What it is |
|---|---|
| [v0.11.4/](v0.11.4/) | The router overlay on upstream Open WebUI 0.11.4. Its `Dockerfile` copies ten patched or added files over the pinned upstream image. [PROVENANCE.md](v0.11.4/PROVENANCE.md) records the deployed baseline, and `tests/` runs inside the built image. |
| [model-sync/](model-sync/) | The host-side enforcer that keeps Open WebUI's model list, labels, availability and access in step with the router. See [its README](model-sync/README.md). |

**Router contract.** Changes to the overlay or the model-list sync that touch router requests, model lists, availability, retries or limits must uphold the [LLM Router client contract](../../docs/CLIENT_CONTRACT.md). Keep [CONFORMANCE.md](CONFORMANCE.md) current with each such change. Open WebUI never falls back to another model (contract §5); offline models are hidden, with the reason recorded, instead.

**Build and test the overlay** on the Open WebUI host (the base image is pinned by digest and already present there):

```sh
cd integrations/open-webui/v0.11.4
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" -t local/open-webui:v0.11.4-router-v<N> .
docker run --rm --network none -e WEBUI_SECRET_KEY=isolated-test-only -v "$PWD/tests:/tests:ro" \
  --entrypoint python local/open-webui:v0.11.4-router-v<N> -m unittest discover -s /tests -v
tests/boot-smoke.sh local/open-webui:v0.11.4-router-v<N>    # required: the whole app must start
```

Never deploy an image that hasn't passed `boot-smoke.sh`. On 2026-10-07, an overlay that passed its unit tests failed at startup because `middleware.py` still imported a removed name. Open WebUI was down for about 6 minutes until rollback.

**Deploy:** recreate the container in place with the new image tag, following the header of `~/deployments/open-webui/compose.yml` on the host. Supply `WEBUI_SECRET_KEY` from the running container's environment; never print it. Keep the previous image for rollback. The host notes are in `~/docs/open-webui.md` on 192.168.1.20. Open WebUI is user data there: production changes need the owner's go-ahead.

## Historical 0.11.3 sources

The rest of this document and the remaining top-level files describe the earlier Open WebUI 0.11.3 deployment. They are kept for history; the 0.11.4 overlay above was ported from them.

These sources reproduce the terminal-state and unrestricted-output overlay for the qualified Open WebUI 0.11.3 image. They are separate from the router image and are not deployed by `scripts/primary/deploy-router-only.py`.

`Dockerfile.unrestricted` applies the strict source patch while building an image. `router_completion.py` preserves completed versus incomplete results, partial tools, Unicode output and reasoning through the native Ollama bridge. `align-primary.py` reconciles canonical/service display names and moves preset bases toward discovered stable `daytime`/`nighttime` IDs, preserving custom preset IDs, names, access grants and saved parameters. It must be invoked explicitly by the Open WebUI owner; router deployment never runs it. Its mapping checks run locally with `python3 integrations/open-webui/test-align-primary.py`.

The existing native connection `http://ai-router:11434` discovers service IDs through `/api/tags` and resolves metadata through `/api/show`. Presets should store these service IDs, so replacing the underlying catalog model does not require reconfiguring them. Do not add context overrides, output quotas or thinking budgets to new presets. Existing deliberate saved limits remain unchanged.

`test-unrestricted-policy.py` requires the patched Open WebUI Python environment and must run inside that image. It is not part of the standalone router's Node test suite. Operational acceptance chats, captured runtime state and historical deployment evidence stay local and are excluded from Git and Docker build context.

## Search reliability and nighttime tool parity

`Dockerfile.search-reliability` layers on the existing unrestricted image. The DDGS adapter serializes calls from both native tools and legacy retrieval, spaces their start times by `DDGS_MIN_REQUEST_INTERVAL` (2 seconds), and sets/restores the DDGS class-level worker limit. This prevents native tools from bypassing the per-batch search concurrency setting. The deployment selects `duckduckgo,yandex,brave` with one DDGS worker so DuckDuckGo can fall back to Yandex and then Brave without a concurrent provider burst. Live acceptance showed that both DuckDuckGo and Brave can reject requests in the same application process, requiring the third independent provider. External providers can still temporarily reject requests; failures remain visible.

Nighttime's native tool support was verified against the installed model. Its source catalog now advertises tools. `align-nighttime-tools.py` copies tool capabilities, tool selections, per-tool controls, and default features from each matching Daytime preset. It retains preset identities, icons, permissions, prompts and saved generation parameters. Vision follows backend discovery. The Nighttime vision migration loads its matching pinned projector on CPU before enabling vision in the catalog and both presets; see [the migration](../../docs/NIGHTTIME_VISION.md). No output limit is copied into its Deep Thinking preset.

After publishing the router release through `docs/RELEASE.md`, build and deploy the companion Open WebUI image from the same clean revision:

```sh
revision=$(git rev-parse HEAD)
image="local/open-webui:search-tools-git-$revision"
docker build --build-arg "VCS_REF=$revision" -f integrations/open-webui/Dockerfile.search-reliability -t "$image" integrations/open-webui
docker run --rm -i -e WEBUI_SECRET_KEY=isolated-search-adapter-test-only --entrypoint python "$image" - < integrations/open-webui/test-search-reliability.py
OPENWEBUI_PUBLICATION_IMAGE="$image" python3 integrations/open-webui/deploy-search-tools.py
```

The deployment requires no active Open WebUI tasks, saves a private snapshot, checks the Compose file, recreates only Open WebUI, applies the authorized settings through its admin API, and verifies parity plus identity/permission/parameter preservation. Router deployment never calls the Open WebUI step implicitly. Run `python3 integrations/open-webui/test-align-nighttime-tools.py` locally for the preset transformation checks.

For a provider-list-only release, deploy the published helper with `docker exec -i open-webui python - apply-search < integrations/open-webui/align-nighttime-tools.py`. This updates the persisted provider list through the admin API without rebuilding or restarting the unchanged image. The checked-in deployment script carries the same defaults for future recreation.
