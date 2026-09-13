# Primary resident router integration

The primary runtime has two resident services with independent admission. This document defines the source-controlled catalog, output policy, queue behavior and deployment contract. Private runtime evidence and historical incident reports are retained separately from published source.

## Effective policy

| Property | Coding | Everyday |
|---|---|---|
| Display name | Daytime (144K) | Nighttime (128K) |
| Model | `qwen3.8-27b-q8_0` | `qwen3.8-27b-abliterated-q6_k` |
| Backend URL | `http://qwen38-daytime:8080` | `http://qwen38-nighttime:8080` |
| Stable service ID | `daytime` (also `local-active`, or omitted model) | `nighttime` |
| Working context | 147456 | 131072 |
| Active generations | 1 | 1 |
| Context admission reserve | 1024 tokens | 1024 tokens |
| Default output / policy maximum | Unrestricted / none | Unrestricted / none |
| Default thinking | Enabled, unlimited budget, template-default effort | Enabled, unlimited budget, template-default effort |
| Explicit efforts | off, default, low, medium, xhigh | off, default, low, medium, xhigh |
| Qualified capabilities | Text, reasoning, tools, images | Text, reasoning, tools, images |

Daytime 144K passed direct and routed 133,906-token retrieval, native tool continuation, overflow rejection/recovery and MTP acceptance. Observed minimum free VRAM was 1770 MiB on the 3090 and 1329 MiB on the 4080 SUPER. The owner preferred 144K as the fallback: 160K loaded, but its 1005 MiB free on the 4080 SUPER missed the existing 1024 MiB reserve. This is capacity acceptance, not a matched performance benchmark or Harness compaction qualification. Nighttime remains at its separately accepted 128K configuration.

Container/DNS names use Daytime and Nighttime; Stable public service IDs `daytime` and `nighttime` resolve through the catalog; canonical API IDs and `local-active` remain compatible. See [Harness compatibility](HARNESS_PORTAL_COMPATIBILITY.md) for alias discovery and consumer validation.

Every effort has null output default and maximum. No request inherits the former 1024/4096/8192/32768 allowances or the former 2048 thinking budget. Boolean `true` selects template-default effort; boolean `false` disables thinking. Compatibility aliases are intentional: `none` → off, `minimal` → low, `high`/`max` → xhigh. Named enabled efforts keep unrestricted thinking unless a caller explicitly sets a thinking budget.

An omitted output allowance is represented internally by null. Public OpenAI interfaces accept positive explicit allowances, never the backend's negative sentinel. Native `options.num_predict: -1` explicitly selects unrestricted behavior. The pinned llama.cpp transport sends `n_predict: -1` and omits `max_tokens` for ordinary requests. A deliberate positive allowance is preserved exactly, including values above historical thresholds, subject to actual context admission. Explicit reasoning effort, thinking off/on and budget controls take precedence over catalog defaults.

The pinned engine resolves request `-1` through the server launch default. Both running backends and the original-Q6 fallback therefore use `--n-predict -1 --reasoning-budget -1 --reasoning-effort default`. The publisher inspects actual Docker argv and stamps a per-container attestation. A missing or capped attestation fails closed. `/props` is supplemental: the pinned build reported request defaults of `-1` even under the formerly capped launch.

## Context, storage and lifetime

Preflight calls the selected embedded chat template and tokenizer with history, tools and reasoning controls. Images on either service additionally undergo zero-generation prefill to count actual projector overhead. Finite requests require **formatted input + explicit output + 1024 ≤ context** and receive accurate overflow arithmetic without clipping. Unrestricted requests require space for input, the safety reserve and at least one generation token; available context is not sent as a reply quota.

Catalog requests and every received backend event are written to private `DATA_DIR/generations/<UUID>.jsonl` files and synchronized before delivery. This archive retains full original roles, history, reasoning, images, tools, output, transitions and terminal state independently of metadata logging and volatile model caches. Files use mode 0600 in a 0700 directory. Authenticated administrators can retrieve an archive through `/admin/api/generation-record?id=<UUID>`. There is no automatic retention deletion; operators must provision durable disk and deliberately manage retention. Disk failures end the response honestly and stop upstream work. Already committed output remains recoverable. A record without a terminal entry after a process crash is interrupted, never evidence of completion.

When an unrestricted conversation exceeds working context, the router retains original system/developer instructions and the latest user task, and fits a quoted excerpt of prior work using the real tokenizer. When generation reaches context, it continues from a fitted tail. The answer includes a visible transition notice; the complete original remains archived. This is lossy working-context recovery, not infinite lossless context. Tool-history shortening is refused when it cannot be done safely; DSH manages its durable tool history. Repeated/no-progress recovery, an unfit current task, partial structured output, malformed tool JSON, and reasoning without a visible answer end as incomplete/error with retained output.

Generation has no total-duration timer. A 10-second connection timeout and a default 120-second inactivity watchdog detect failures; actual slot prefill/decode progress and received bytes reset inactivity. Downstream backpressure is not treated as upstream inactivity. Caller cancellation remains immediate. `OLLAMA_UPSTREAM_TIMEOUT_MS=30000` bounds metadata/control operations only. Natural stop, explicit allowance exhaustion, context recovery, missing terminal events, stall and cancellation have distinct terminal states.

## Endpoint behavior

| Endpoint | Primary behavior |
|---|---|
| `/v1/models`, `/api/tags` | Canonical models and all declared aliases, with target-equivalent context/capabilities/health and unrestricted metadata |
| `/api/ps`, admin model lists | Canonical residents only: two engines, one slot each |
| `/api/show` | Canonical or stable service lookup with the resolved target’s capabilities and context |
| `/v1/chat/completions` | SSE by default; JSON for `stream:false`; preserves finish reasons |
| `/v1/responses`, `/responses` | JSON by default, SSE for `stream:true`; incomplete/error status preserved |
| `/api/chat` | NDJSON by default; JSON for `stream:false`; preserves `done_reason` |
| `/api/generate` | Supported text completion with explicit thinking off; enabled reasoning remains unsupported on this route |
| Embeddings / model management | Unavailable for these profiles |

Unknown models return 404; `daytime`, `local-active` and an omitted model select Daytime; `nighttime` selects Nighttime. Responses remains stateless: send full history; `previous_response_id` and `store:true` are rejected. Generation archives do not implement Responses ID chaining. Native generation's reasoning limitation is explicit; normal chat clients use `/api/chat`.

A busy service queues generation requests in arrival order by resolved backend URL. Aliases and all API routes share that queue; Daytime and Nighttime have independent queues and retain one active generation each. Disconnecting removes queued work. Drain rejects new requests with 503 and lets accepted active and queued requests finish. Runtime state exposes `queued_count`, `queued_by_model`, `queued_by_endpoint`, and `queue_policy: fifo-per-backend`. An unavailable selected service cannot fall through to coding. Both services accept tools and images according to their qualified catalog profiles. Partial tool arguments are retained but cannot execute as a completed call.

Queued streaming requests receive immediate SSE comments or empty, nonterminal Ollama JSON frames, repeated every 15 seconds until admission. These carry no generated content. Native heartbeats are valid JSON because Open WebUI parses every NDJSON line. Validation failures after streaming headers have opened are terminal protocol errors with `x_router.status: incomplete`, not completed replies. JSON requests keep headers pending so final HTTP error codes remain accurate; clients must allow their read/header deadline to cover queue wait plus generation. There is no router queue-wait deadline. Accepted queues are in memory and are not replayed after a crash; routine publication drains them before restart.

## Durable sources and deployment

The catalog's `display_name` supplies the shared human-facing labels. Discovery exposes it as `x_ollama_router.display_name`; the router dashboard and DSH discovery use it directly. Open WebUI's explicitly invoked `align-primary.py` copies labels into canonical/service presentation records and migrates preset base IDs toward `daytime` or `nighttime` using discovery metadata. It preserves preset IDs, names, access grants, prompts and saved parameters, including deliberate finite limits. Router deployment does not run this helper or modify Open WebUI. New presets should store stable service IDs on the existing native Ollama connection `http://ai-router:11434`; see [stable services](STABLE_SERVICES.md).

After an approved Nighttime capacity change, run `align-nighttime-tools.py labels`
inside Open WebUI from a published release. This reads the live context, updates
the canonical/service names and both Nighttime workflow names, and replaces stale
context descriptions. It preserves preset IDs, prompts, parameters, tools and
access grants, verifies Daytime presets remain unchanged, and refreshes the model
listing without restarting Open WebUI.

API `http://192.168.1.21:11434`; admin `http://192.168.1.21:11435`; container API `http://ai-router:11434`.

- Router source: a clean checkout of a published Git revision. The image carries that exact revision in its OCI label; see [release workflow](RELEASE.md). Preserve the previous production checkout and images for recovery.
- Source policy: repository `runtime/primary-model-catalog.json` → `/home/astigmatism/apps/local-ai-primary/model-catalog.json` → publisher → `/home/astigmatism/apps/local-ai-ollama-stack/runtime/router/active-model.json`. The root coding projection and both entries are validated together.
- Publisher: repository `scripts/primary/primary.py` → `/home/astigmatism/apps/local-ai-primary/primary.py`. Server-owned manifests, Compose variants and qualification receipts are preserved.
- Router-only deployment: build the committed source image, then run `scripts/primary/deploy-router-only.py` from that clean checkout. It verifies source/image revision equality, runs the image test suite, backs up privately, drains, waits, replaces only `ai-router` with `--no-deps`, publishes/reloads and checks that both backend container IDs are unchanged.
- DSH: consumer source, medium client defaults, SDK behavior and update acceptance belong to the Harness repository. Its release must use truthful catalog capabilities and null unrestricted maxima; see [consumer companion requirements](HARNESS_PORTAL_COMPATIBILITY.md). Production Harness updates must use its normal published-source updater; do not patch its production code or writable settings as a shortcut.
- Open WebUI: `/home/astigmatism/apps/open-webui/router-policy-image`, image `local/open-webui:0.11.3-router-unrestricted-v1`, extending the installed folder-scoped knowledge image. `integrations/open-webui` contains reproducible patches, deployment and acceptance scripts. Ollama conversion, persistence and completion events retain incomplete states; partial tools cannot execute. Automatic title/compaction/emoji quotas and the inherited 256 tool-iteration ceiling are removed. Deliberate saved preset limits remain, including the deep-thinking preset's 16384/max choice.

The server owner separately qualified 8192 MiB host prompt cache per service, removed slot-save paths, and selected info logging. These were not causes of the incident. Catalog cache descriptions reflect the corrected server; volatile prompt caches remain separate from durable conversation archives.

## Recovery and historical evidence

`~/primary status` and `~/primary active-check` inspect the pair. The primary boot service and legacy-deploy guard remain enabled. No historical full-server deployment is used to publish router edits. Backend startup failure remains drained for supervised retry.

The original `/home/astigmatism/apps/local-ai-primary/rollback` snapshot is immutable historical evidence. Historical `primary deploy`, programmatic `apply(deploy=True)` and `primary rollback` are retired and reject before any side effect; they cannot overwrite the corrected integration. Ordinary qualified startup remains supported and fails drained. The controller installer enforces executable mode 0755 for wrapper and boot execution. The original-Q6 fallback in the corrected server manifest is separately uncapped and qualified. Never copy historical benchmark argv into production or describe historical capped throughput as unrestricted performance. Private backups may contain secrets and must remain on the server.
