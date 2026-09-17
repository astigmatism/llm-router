# Reviewed router publication

The project and new image name are `llm-router`. Existing production Compose project/container names and runtime ownership remain valid; see [rename and migration notes](RENAMING.md) before changing deployment paths or container identity.

Commit and push reviewed router source before production builds. Use a clean checkout of that published revision, retaining the previous production checkout and its uncommitted historical artifacts separately. Do not apply source patches inside a running production container.

This release preserves the two resident services, unrestricted output/reasoning policy, formatted-context admission and cancellable FIFO queues. OpenAI discovery and native `/api/tags` enumerate canonical IDs and every declared service alias. Native `/api/ps` and admin resident counts stay canonical-only. Harness must also publish its consumer companion; an alias row does not make historical capacity/default/finite-output assertions valid.

From a clean release checkout on the deployment host:

```sh
revision=$(git rev-parse HEAD)
image="llm-router:git-$revision"
docker build --build-arg "VCS_REF=$revision" -t "$image" .
ROUTER_PUBLICATION_IMAGE="$image" python3 scripts/primary/deploy-router-only.py
```

The publisher refuses a dirty checkout or an image whose `org.opencontainers.image.revision` label differs from the checkout. It runs all Node tests sequentially in the image, checks the installed controller against the reviewed source, and captures private backups. It drains accepted active and queued work before replacing only `ai-router` with `--no-deps`. It then republishes the canonical catalog and verifies both inference container IDs are unchanged before reopening admission. The receipt records source commit, image ID and configuration hashes.

Coordinate this step with the owner of any simultaneous service rename or Harness acceptance. Do not overwrite server-owned inference manifests, Compose variants, qualification receipts or running backend arguments. A drain timeout must not stop an inference process. If readiness fails, inspect the failed release while admission remains drained; do not restore historical backend profiles.

Validate `/v1/models` and native `/api/tags` alias/target metadata, `/api/show` service lookup, canonical `/api/ps` and admin counts, queue completion/cancellation and client acceptance after publication. The production Harness update and restart belongs to its existing updater and deployment owner. Keep private prompts, journals, runtime settings, raw logs and operational evidence outside Git; source tests use synthetic fixtures.

Local source checks:

```sh
node --test --test-concurrency=1 test/*.test.js
npm run lint:syntax
python3 scripts/primary/test_primary.py
python3 scripts/primary/test_deploy_router_only.py
python3 integrations/open-webui/test-align-primary.py
```

The separate `scripts/primary/deploy-nighttime-context.py` migration tests 64K
on the existing Nighttime image and weights. Run it from a clean published
checkout during an owner-approved Nighttime idle window. It changes only
Nighttime's two context arguments and matching capacity declarations, installs
the capacity-aware controller, and reloads Nighttime discovery metadata.
Daytime and router containers remain running; no global drain is used.
The migration refuses active or queued Nighttime work and records container
identity, long-context retrieval, tool continuation, overflow recovery and GPU
headroom. A failed acceptance restores the immediately preceding 32K
Nighttime configuration. This capacity trial does not qualify Harness compaction
recovery or constitute a matched throughput benchmark.

If a cancelled token-counting task remains stuck in a backend slot, the optional
`--recover-cancelled-slot TASK_ID` requires that exact task's cancellation in the
backend logs, zero generated tokens and no active or queued Nighttime router
request. Review the stale task before using this recovery exception.

```sh
python3 -B scripts/primary/test_nighttime_context.py
python3 -B scripts/primary/deploy-nighttime-context.py
```

An owner-approved ceiling experiment can run
`python3 -B scripts/primary/probe-nighttime-context.py` from a clean published
release. This starts from the qualified 64K configuration, probes allocation in
4K increments at the boundary, tests long-context retrieval, and retains the
largest tested setting with at least 1024 MiB free on both Nighttime GPUs.
It preserves Daytime and the router and restores the immediate 64K baseline if
final acceptance fails. Publish the resulting capacity in the source catalog
after the experiment; the backend and consumer metadata must agree.

The owner ended the ceiling search and selected Nighttime at 128K. The reviewed
`--accept-context 131072` option performs final long-context, router, tool and
overflow checks for that target and records the measured GPU headroom. This
explicit selection replaces the former 1024 MiB Nighttime reserve requirement;
Daytime's configuration and reserve contract stay unchanged.


Daytime capacity changes use `scripts/primary/deploy-daytime-context.py` from a
clean, published Git checkout. The current owner-authorized workflow is
`--accept-160`, starting from the qualified 144K baseline. It waits for a quiet
Daytime window, measures the same uncapped long prompt at 144K and 160K, then
checks retrieval near the new capacity, tools, overflow recovery, MTP acceptance
and GPU memory. A matched prefill or decode slowdown above 25% fails the trial.
The single matched sample is an operational comparison, not a repeated benchmark.

The former 1024 MiB Daytime reserve is informational under this explicit owner
selection. The manifest records that policy on Daytime only; memory allocation,
CUDA errors and functional/performance failures still restore the preceding
144K configuration. Nighttime remains at its independently accepted 128K.
The router must include the 144K/160K catalog validation change before this
trial; older images reject publication above 128K. Failed publication restores
valid discovery before querying router admission during rollback.

The original no-flag and `--retry-144` paths retain their historical 128K baseline
checks. They are not the workflow for accepting 160K from 144K.
After qualification, align source catalog defaults and use the OpenWebUI
helper's `daytime-labels` mode to update names through its API while preserving
preset settings and grants. Publish the Harness defaults and use its normal
update-and-restart workflow to install the new image; its existing settings
service synchronizes the live capacity from router discovery.
