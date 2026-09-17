# Stable service identifiers

Use `daytime` and `nighttime` in client configuration and Open WebUI preset `base_model_id` fields. These service IDs belong to the router catalog and do not encode a model family or context size. `local-active` remains a compatible Daytime ID. Existing canonical model IDs remain accepted while that model is in the catalog.

| Service | Current canonical target | Context | Capabilities |
|---|---|---|---|
| `daytime` | `qwen3.8-27b-q8_0` | 131072 | Text, images, tools, reasoning |
| `nighttime` | `qwen3.8-27b-abliterated-q6_k` | 131072 | Text, images, tools, reasoning |

The mapping lives in each resident's `aliases` in `runtime/primary-model-catalog.json`. A future qualified model replacement must carry the service alias onto its replacement catalog entry and update the primary projection/manifest through the normal release process. Client configuration keeps the same service ID. This release does not replace any inference model.

`GET /v1/models` and native `GET /api/tags` list both canonical IDs and every alias. The current catalog has five selectable IDs and two resident engines. Alias metadata is identical to its canonical target except `x_ollama_router.alias: true`; `upstream_model` identifies the actual model. `GET /v1/models/{id}` and native `POST /api/show` resolve service IDs. `/api/ps` and admin runtime/summary count canonical residents only. Consumers that render unique engines should group alias rows by `upstream_model`; clients must retain selectable alias IDs when resolving presets. Harness resolves configured IDs without provisioning a provider per discovery row.

Generation APIs accept these service IDs through the existing router connection. All aliases share the resolved backend's FIFO queue and single active slot. Daytime and Nighttime can run independently. An unavailable Nighttime request fails for Nighttime; it never redirects to Daytime. Capabilities and formatted-context checks follow the selected service.

Output remains unrestricted by default, with explicit finite caller allowances preserved. No total-generation deadline is introduced. Native chat uses `think:false` for reasoning off or `think:"max"` for the advertised xhigh effort. Open WebUI's deep-thinking preset parameters (`think:true`, `reasoning_effort:"max"`) must be verified through its actual native bridge. Router template-default effort remains `default`; a client's medium preference is explicit. Streaming wait frames, cancellation and incomplete terminal states are unchanged.

Open WebUI uses native `http://ai-router:11434`, so refreshing `/api/models` must recognize `daytime` and `nighttime` as Ollama bases before creating presets. The Open WebUI owner controls preset creation/migration and preserves user settings. `integrations/open-webui/align-primary.py` maps known canonical/compatibility bases toward stable service IDs from discovery metadata; it never replaces a stable base with a model-specific ID. Do not copy saved output limits or Daytime-only capabilities into new Nighttime presets.

Source coverage includes native/OpenAI alias discovery and selection, off/max reasoning, capabilities, omitted/explicit allowances, shared queues/cancellation, unavailable-service failure, two-resident counts, and replacing each fixture model without changing its client's service ID. The [reviewed router-only workflow](RELEASE.md) deploys committed source without restarting inference containers or modifying Open WebUI.
