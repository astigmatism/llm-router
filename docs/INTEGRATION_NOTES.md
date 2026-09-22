# Integration Notes

The deployed primary catalog uses unrestricted output, unrestricted thinking and template-default effort. Its current policy, context recovery, durable archives and client behavior are defined in [Primary integration](PRIMARY_INTEGRATION.md). Legacy singleton-marker examples below are not primary production defaults.

## OpenWebUI

Current known setting:

```yaml
OLLAMA_BASE_URL: "http://ollama:11434"
```

Preferred transition target when Docker DNS is available:

```yaml
OLLAMA_BASE_URL: "http://ai-router:11434"
```

LAN API target:

```yaml
OLLAMA_BASE_URL: "http://192.168.1.4:11434"
```

The separate browser admin portal is `http://192.168.1.4:11435/`; do not configure clients to use the admin port.

After changing environment variables, verify OpenWebUI did not keep a database-stored Ollama URL by checking router request history while sending a chat.

For Open WebUI workflow/custom model compatibility, prefer protecting behavior at the router rather than modifying Open WebUI source. Set `REWRITE_REQUESTED_MODEL_TO_ACTIVE=true` for the router when Open WebUI should be allowed to send any configured base-model name while the router forwards the request to the deployed active Ollama model. The router preserves non-model request parameters such as `options`, `format`, messages, and streaming settings, and still normalizes `keep_alive` to the configured forced value. Boolean `think` controls are preserved; string controls are mapped through the active marker's `supported_think_levels` and `reasoning_effort_map`. Enabled thinking is then dropped if `/api/show` does not advertise `thinking`.

If Open WebUI sends native tools to a deployed profile whose active marker has `capability_profile.tools: false`, set `UNSUPPORTED_TOOLS_POLICY=drop`. Capability selection follows the rewritten active marker, not Open WebUI's stored model name or a backend/model-name heuristic. New ordinary turns then continue without tool controls; conversations that already contain assistant tool calls or tool-result messages receive the explicit `UNSUPPORTED_TOOL_HISTORY` error and must use a tool-capable active profile or start fresh.

A `llama_cpp` profile may set `capability_profile.tools: true` only after its server flags and chat template have been probed successfully for structured function calls. The router then exposes `tools` in `x_ollama_router.capabilities`, forwards definitions and history through Chat Completions, and translates calls for Ollama-native and Responses clients. Switching profiles changes this behavior entirely through the marker; no router model-name list is involved.

A `llama_cpp` profile may set `capability_profile.vision: true` only after the matching projector is loaded and the running server's `/props` response reports `modalities.vision: true`. Include both `text` and `image` in the marker's `input_modalities`. The router then exposes `vision`, preserves native/Chat/Responses inline images, and bridges image-bearing Responses tool outputs into a text tool result plus a user image turn. Keep `vision: false` and advertise only `text` for any profile that omits the projector or cannot satisfy its GPU-memory budget.

## Codex

Configure Codex's custom Responses provider with the exact `ROUTER_MODEL_ALIAS`, normally `model = "local-active"`. Codex may retain that identifier across profile changes: request history records it as `requestedModel`, while `activeModel` and `forwardedModel` show the marker model that Ollama actually received. The alias works in strict mode; `REWRITE_REQUESTED_MODEL_TO_ACTIVE=true` is needed only if other arbitrary names should also be advisory.

Codex may send the documented Responses `prompt_cache_key` optimization hint. The router accepts string values for API compatibility and intentionally ignores them for local inference. It does not forward the value or provide key-partitioned response caching; llama.cpp's ordinary prompt-prefix/KV reuse remains the only local prompt-cache behavior. The raw key is excluded from request history and events.

## DeepSeek Harness

The router now publishes the active alias and dynamic capabilities through `GET /v1/models/{alias}`, but it does not automatically reconfigure DeepSeek Harness. Harness requires a separate consumer-side enhancement.

That consumer should configure only the stable alias, fetch its entry at startup and at the beginning of a new request or session, and use ETag revalidation. It should apply `context_window`, `context_safety_reserve`, `max_output_tokens`, `input_modalities`, and reasoning metadata when available, retain last-safe limits or fall back conservatively when metadata is incomplete, and refresh safely after active-model changes. The reserve is an additive router-admission term, not model context or output capacity. It must not persist `upstream_model` as its configured model ID. See [Stable Active-Model Discovery](MODEL_DISCOVERY.md) for the complete contract.

## ComfyUI

Search for hardcoded raw URLs:

```bash
grep -R "192.168.1.4:11434\|127.0.0.1:11434\|ollama:11434" \
  /home/astigmatism/apps/local-ai-comfyui
```

Use the Ollama-compatible router API URL:

```text
http://192.168.1.4:11434
```

The admin portal is on `11435` and is not an Ollama API endpoint.

Recommended improvement: refactor the custom node to read one base URL environment variable rather than embedding raw Ollama URLs in Python source or workflow JSON.

## Voice assistant

Configure the device to call the router endpoint and to use the active model. The default router policy rejects missing or non-active models, which is intentional to prevent voice-assistant model swaps.

## local-ai-images-legacy

Inspect live `.env` before changing code. If it points to raw Ollama, move it to the router endpoint.

## local-ai-llm-legacy

Keep the legacy app running during initial tests. Once the router admin viewport covers the useful portal features, repoint or retire the legacy app.
