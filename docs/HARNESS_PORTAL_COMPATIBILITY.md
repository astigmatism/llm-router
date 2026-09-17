# Service Portal / Harness router compatibility

This is a historical compatibility review. Its captured 32K Nighttime capacity
and earlier capability observations describe the reviewed release, not the
current deployment. Daytime and Nighttime now both expose 128K and text, images,
tools and reasoning; see the [current integration contract](PRIMARY_INTEGRATION.md).

Prepared 2026-09-12. This release integrates stable OpenAI alias discovery with the resident catalog, unrestricted policy and verified per-backend FIFO queues. It does not by itself prove that the production Portal update passes. Harness at `77858bec19ec47fc2d88dde1c3fb21d4ef52dfdf` also needs the companion changes below.

## Reconfirmed evidence and provenance

Read-only `GET http://192.168.1.21:11434/v1/models` returned HTTP 200, two canonical entries, complete public schema-v2 metadata and no warnings. `local-active` appeared only in the primary entry's `aliases`; its detail endpoint already resolved the primary. No production generation, source write, configuration change, build or restart was performed for this investigation.

| Field | Primary / `local-active` target | Secondary |
|---|---|---|
| Canonical ID | `qwen3.8-27b-q8_0` | `qwen3.8-27b-abliterated-q6_k` |
| Context / active requests | 131072 / 1 | 32768 / 1 |
| Input | text, image | text |
| Capabilities | completion, thinking, tools, vision | completion, thinking |
| Output policy | unrestricted | unrestricted |
| Default / maximum output | null / null | null / null |
| Reasoning default / absolute maximum output | default / null | default / null |

Both expose explicit medium effort; neither calls the raw router default medium. Null under a complete unrestricted policy means no fixed output quota, not infinite context and not missing metadata. Explicit caller limits and actual formatted-context admission still apply.

Production router container: `local-ai-ollama-router:unrestricted-20260912`, image `sha256:bb7faf8f2235c5c79b8c758d9006c24b1df72c3dfb50892653c363980b6c86cd`. Its Compose project is `local-ai-ollama-stack`. The source checkout at `/home/astigmatism/apps/local-ai-ollama-stack/router` reports Git HEAD `3bad838d4d0ada309bfd786f1b846c18183be9fb` **with uncommitted modifications and added resident-router files**. That HEAD alone does not identify the running implementation.

The production source and the pre-fix Mac source match byte-for-byte for the relevant files:

| File | SHA-256 |
|---|---|
| `src/model-discovery.js` | `8d46b287500561f301adbbe0a0b80512cc5d66b20be36e2236183debfeb693d1` |
| `src/model-catalog.js` | `42815e8bbbb3f08d89b51f0e29cb90714ee7b7475b13872ddd2e93df0cb3ed7d` |
| `src/backend-adapters.js` | `fae91561c3ac30ea2ce1b4bec65ac980c2331a73e3316f267d43fcf0d6581eed` |

History separates the changes:

- `37644e1` introduced the stable discovery alias. `3b09f9a` added marker-driven multi-backend reasoning/capacity metadata; it derived these values from the marker rather than promising the historical Harness constants.
- The resident-catalog prerequisite, originally uncommitted, added `ModelCatalogDiscovery.document()` and `src/model-catalog.js`. Its list selected canonical entries only, removing the exact alias discovery row. Alias detail lookup and model selection remained supported. This is the backward-compatibility defect repaired here.
- The separate output-policy prerequisite changed `reasoningMetadata()` to advertise null absolute maxima for unrestricted reasoning policies, enforced unrestricted catalog values, and selected the template's `default` effort. The primary catalog specifies 128K/1 and 32K/1. These are current policy/capacity choices, not alias defects; they must not be rolled back to pass a historical client assertion.

The Mac router work starts at `27490f5`; published main is `3bad838`. An isolated local baseline snapshots the existing resident implementation so the compatibility delta can be reviewed without modifying the original dirty checkout. That baseline is not a reviewed release. Integration must also retain the intervening published main fixes, including safe Responses prompt-cache-key handling and prewarm behavior.

The user identifies Harness and Portal on `192.168.1.5`. SSH with the available account was denied there, so DNS resolution and the latest Portal job were not independently reread on that host. Another Harness exists on `.21`; it was not substituted for `.5` in this analysis. Harness source analysis uses the supplied failing commit, which is also the local checkout's HEAD.

## Router contract and fix

`GET /v1/models` retains each actual model ID once and appends all declared aliases, including `local-active`, `daytime` and `nighttime`. The alias row is the primary canonical row with only `id` and `x_ollama_router.alias` changed. The detail endpoint returns the same representation. Canonical `aliases` metadata remains available to alias-aware clients, including clients talking to the pre-fix router. All registered aliases are discoverable through listing, metadata and detail lookup.

Inference through `/v1/responses`, `/responses`, `/v1/chat/completions`, `/api/chat` and `/api/generate` continues to resolve aliases to the same selected backend as actual IDs. Aliases and their targets share admission and failure behavior. An omitted model selects the configured default; an unknown ID is rejected. An unavailable primary does not redirect `local-active` to the secondary. No alias-specific context, output, reasoning or capability policy is introduced. Native embedding operations retain the selected backend's support restrictions.

Native `/api/tags` includes every selectable canonical/alias ID for Ollama clients. `/api/ps` and admin overview/runtime state retain canonical rows only. This preserves dashboard counts and the primary publisher's exact resident-set verification. OpenAI picker clients can hide an alias row only when its canonical `upstream_model` row is present; do not discard the sole row in legacy single-marker mode.

## Companion change request: dsh-container maintainer

Base: `77858bec19ec47fc2d88dde1c3fb21d4ef52dfdf`. Use one shared resolver/validator in the plugin and both verifiers so their acceptance rules cannot drift.

1. **Resolve configured IDs and registered aliases.** Replace the exact-only lookups in `scripts/verify.sh:349`, `scripts/verify-browser-readiness.sh:65`, and `seed/plugins/dsh-router-model-discovery.js:271`. Prefer an exact ID; otherwise accept exactly one canonical entry whose `x_ollama_router.aliases` contains the configured ID. Reject missing, duplicate or ambiguous identities. If both an alias row and its target are present, verify their target and metadata agree. Preserve the configured request ID; use `display_name` only for presentation. This permits old singleton, pre-fix canonical-only and repaired catalogs.
2. **Validate the contract, not historical deployments.** Replace the hard-coded capacity pairs at `verify.sh:354–359` with positive safe-integer context and concurrency, plus any explicit application minimum. Require schema 2, `complete === true`, an empty warnings array, and available health when provided. Reconcile the selected provider's usable context/concurrency with its actual metadata. Do not retain a synthetic 256K profile or schedule two requests against one advertised slot.
3. **Distinguish bounded and unrestricted output.** Remove `32768` equality assertions at `verify.sh:360–362,373` and unconditional finite-limit validation in `routerMetadataOf()`. For complete `output_policy === "unrestricted"`, require explicit null top-level default/maximum, reasoning absolute maximum, and per-effort default/maximum fields. Missing fields, unknown policy, partial metadata, or inconsistent positive/null mixtures are errors, not permission to disable limits. For legacy/bounded contracts retain positive finite validation, default ≤ effort maximum, and consistency with the advertised absolute ceiling. Keep warnings/health failures actionable. Do not substitute 32768, context size or an SDK default for an intentional null.
4. **Separate raw router default from client preference.** Remove `reasoning.default === "medium"` at `verify.sh:372` and the validator's demand that the raw default be a DSH selector value. Resolve the declared default through the advertised effort/alias maps and require a valid entry. `default` is a valid router effort; preserve it as template-default semantics. If Harness intends to default to medium, send `reasoning: {"effort":"medium"}` as a deliberate client setting and verify medium is advertised. Preserve explicit user/agent/request choices and do not rewrite router metadata to medium.
5. **Apply capabilities per selected model.** Remove the fixed profile overrides in `PROVIDER_PRESENTATION` / `capabilityOps()` (`contextWindow`, `maxConcurrency` and forced default). The primary may satisfy screenshot/tool readiness; the secondary is text/reasoning-only. Keep `verify-browser-readiness.sh:70–74` as application capability requirements on its selected browser-capable route. Do not require every catalog model to support vision/tools, or transfer primary modalities/tool support to the secondary. Tool-bearing agents must select a qualified route or fail clearly.
6. **Make null support durable through the installed SDK.** Review configuration schema, persisted settings migration, image build and the actual pi-ai Responses transport. Omitted output limits must stay omitted; deliberate positive limits must stay exact; negative llama.cpp sentinels must not become OpenAI maximum fields. Merely relaxing `verify.sh` leaves the plugin rejecting metadata and can leave the SDK injecting a hidden allowance. Test the built application request body, not only source fixtures. The pre-existing Mac changes in `scripts/patch-unrestricted-policy.mjs`, `scripts/migrate-resident-models.mjs`, the discovery plugin and Dockerfile are candidate work for review, not a published companion release. Preserve unrelated providers, credentials and explicit reasoning preferences.

Required Harness acceptance matrix:

| Scenario | Expected result |
|---|---|
| Legacy alias-only, bounded metadata | Resolve and keep truthful finite limits |
| Canonical-only catalog with alias metadata | Resolve `local-active` to primary |
| Repaired catalog with explicit alias row | Resolve alias and canonical IDs consistently; no duplicate provisioning |
| Complete unrestricted metadata | Preserve null capabilities; omit an unrequested wire limit |
| Explicit finite caller allowance | Preserve exact positive allowance through installed Responses SDK |
| Missing/partial/inconsistent metadata or ambiguous alias | Fail with a specific contract error |
| 128K/1 primary, 32K/1 secondary | Reflect actual context and concurrency |
| Secondary selected for browser/tool work | Reject unsuitable route clearly; do not advertise unsupported capabilities |
| Raw `default`, client medium, explicit off/low/xhigh | Preserve the distinction and request overrides across discovery refresh/migration |

Run Harness unit tests, built-image SDK wire checks and plugin boot checks, then the full local `scripts/verify.sh --remote-ollama` and browser readiness checks. The final Portal test must exercise its normal update process and report the completed provider-verification stage; an alias-row-only deployment cannot make the supplied Harness commit pass.

## Original compatibility review and release boundary

Local verification used Node **22.23.2** in a disposable Mac Docker container, with the isolated worktree mounted read-only and networking disabled except for the container's loopback test backends. `node --test test/*.test.js` passed **191/191 tests**; `npm run lint:syntax` and `git diff --check` passed. The new exact-alias regression was also run with the original `model-discovery.js` mounted in place: it failed specifically because no `local-active` list entry existed.

Coverage includes legacy singleton bounded cap/reject policies; canonical IDs and configured aliases with broad rewriting disabled; both Responses paths, Chat Completions and native chat/generate; omitted versus explicit finite output; alias/target metadata equality; primary/secondary capability enforcement; shared admission, unavailable primary without fallback, native/admin resident counts and ETag changes. These are controlled backend tests, not a production Portal run.

The compatibility commit is intended to be integrated after the resident-catalog/output-policy prerequisites have been reviewed and versioned, while retaining published main fixes. Do not cherry-pick its test-baseline commit as a shortcut release or copy source into either production server. Publish the reviewed router release through its normal workflow, then let its existing updater consume it. Any historical qualification script that asserts exactly two **OpenAI** list rows must count `alias: false` canonical entries; native/admin lists remain two residents.

Publish the Harness companion release and use Service Portal's existing Update and restart process on `.5`. Until then, the next failure after alias repair is the stale `131072:1` capacity check, followed by finite-output/default-effort assumptions and the plugin/SDK incompatibility. Both release identity and final Portal success remain to be verified after maintainer integration. This task does not authorize or perform a direct production deployment.

The integrated source is based on published main `3bad838` and applies only the delta from `ed8715d`, preserving the queue and the intervening prewarm/prompt-cache-key fixes. Its local sequential regression run passed 191 router tests plus 7 controller and 3 clean-source publication tests. The [release workflow](RELEASE.md) requires a clean committed checkout and matching image revision before any router-only rollout. Private operational receipts are retained outside Git.
