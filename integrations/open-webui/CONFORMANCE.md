# How Open WebUI upholds the LLM Router client contract

Contract: [docs/CLIENT_CONTRACT.md](../../docs/CLIENT_CONTRACT.md), version 1.1. It lives in this repository, so this project links to it instead of keeping a copy. This map covers the Open WebUI deployment on 192.168.1.20: upstream Open WebUI 0.11.4 plus the [router overlay](v0.11.4/), and the [model-list sync](model-sync/).

## Conformance checklist (contract §13)

| Item | How it is met | Evidence |
|---|---|---|
| Service IDs only; no canonical IDs as configuration; `X-Client-Name` | Presets use the service IDs `daytime` and `nighttime` as base models. Canonical rows are hidden, managed by the sync, and follow the router. Every request to the router carries `X-Client-Name: open-webui`, and the sync's carry `open-webui-model-sync`. | `v0.11.4/merged/open_webui/routers/ollama.py` (`send_request`, `send_get_request`); `model-sync/open-webui-model-sync.py` (`request`, `follow_events`); `tests/test_router_overlay.py` |
| Reads the capabilities document without failing when the router or a model is unavailable | The sync reads `/v1/router/capabilities` and writes nothing when the router is unreachable or serves no models. Open WebUI itself keeps running and lists what `/api/tags` serves. | `model-sync/test_model_sync.py` (`test_never_writes_without_a_usable_document`) |
| Long-running: subscribes and polls while disconnected | `open-webui-model-sync-watch.service` follows `/v1/router/events`. While disconnected it polls every 30 s with `If-None-Match` and reconnects with backoff; the 15-minute timer is a backstop. | `model-sync/open-webui-model-sync.py` (`watch`); live check 2026-10-07 |
| Chooses the model per request, with configurable fallback or none | People choose a preset per chat. **Fallback is disabled on purpose** (permitted by §5): a preset named Nighttime is never answered by Daytime. Instead, presets for a service in `offline_services` are hidden, with the reason recorded, and restored when it returns. | `model-sync/test_model_sync.py` (`test_solo_configuration_hides_nighttime_presets_and_restores_them`) |
| Waits, without switching, while the router drains | The native bridge retries 503 `BACKEND_DRAINING` and `MAINTENANCE_MODE` received before any output, with 2→30 s backoff for up to 10 minutes. It shows a status line in the chat, and resolves nothing else. | `routers/ollama.py`, `utils/router_completion.py`; `tests/test_router_overlay.py` |
| Classifies errors by `error.code`; `SERVICE_OFFLINE` costs no retries | The wait decision uses `error.code`. `SERVICE_OFFLINE` and other codes are shown immediately, without retries. The router's message, for example "… is offline in runtime configuration …", reaches the chat through the overlay's error-detail patch. | `tests/test_router_overlay.py` (`test_an_offline_service_fails_at_once`) |
| Sets `stream` explicitly; handles keepalives and errors inside streams; never treats incomplete as complete | Open WebUI's native bridge streams. The router's empty keepalive frames are valid Ollama frames. `router_completion.py` classifies every terminal or error frame from `x_router` and `done_reason`, never from model IDs, and marks incomplete results. | `utils/router_completion.py` (`terminal_metadata`, `guarded_native_stream`); `tests/test_router_overlay.py` |
| Context, reserve, slots and features from the serving model | Presets carry no context or output overrides. The router enforces context. The compaction trigger is capped at the serving model's context window minus the 1024-token reserve and an answer allowance. Preset labels show the live context. | `utils/context_compaction.py` (`_cap_to_model_context`); `model-sync` (labels) |
| Read timeouts allow for queueing, or stream | Open WebUI streams chats. The router sends keepalives while a request is queued. | — |
| Logs model changes; surfaces fallback refusals | The sync logs every change with its reason to journald and records the configuration in its state file. There is no fallback, so no fallback refusals arise. | `model-sync/README.md` (operations) |
| Keeps the contract, a conformance map and an agent rule | This file, the rule in [README.md](README.md), and the contract in the same repository. | — |

## Permitted deviations

- **No fallback (§5).** Hiding an offline model's presets, and telling the user why, replaces substitution.
