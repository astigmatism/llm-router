# Portal API (v2)

The browser portal (`http://<router>:11435/`) reads only these routes. They are served by the
**admin listener without a token** (unchanged posture: `11435` is LAN-only and deliberately
unauthenticated) and by the **API listener with the admin token**. The one posture change in this
release: payload reads (`generation-record`, `requests/:id/journal`) and runtime control
(`runtime-state`, `runtime-drain`) no longer demand the admin token **on the admin port**, which is
what makes the request-detail view and the drain buttons work in a browser at all. On the API port
they still require `ADMIN_TOKEN`. Consequence: anyone who can reach `11435` can read archived prompt
text. Keep the port bound to the LAN (`ROUTER_BIND_IP`), never to `0.0.0.0` on an untrusted network.

All responses are `application/json; charset=utf-8` with `cache-control: no-store`, except the two
streaming routes. Errors use the router's usual envelope: `{"error":{"code","message","details?"}}`.
Unknown query parameters are ignored, unknown routes answer `404 ADMIN_ROUTE_NOT_FOUND`.

---

## 1. `GET /admin/api/portal/state?window=1h`

One call that paints the header, the state strip, the configurations section and the models table.

```jsonc
{
  "generatedAt": "2026-10-22T22:10:00.000Z",
  "window": { "requested": "1h", "seconds": 3600, "from": "…", "to": "…" },
  "router": {                       // same keys as /admin/api/summary.router, plus:
    "portal": { "schema": 2, "endpoints": ["state","requests","journal","stats","series","events","capabilities","stream"] }
  },
  "state": {
    "admission": "accepting",       // accepting | draining | maintenance
    "draining": false,
    "maintenanceMode": false,
    "inFlight": { "active": 0, "queued": 0, "byHost": { "rosalina": 0, "daisy": 0 } },
    "listeners": { "api": { "host": "0.0.0.0", "port": 11434 },
                    "admin": { "host": "0.0.0.0", "port": 11435, "authRequired": false } },
    "retention": { "requestHistoryLimit": 5000, "requestLogMaxBytes": 33554432,
                    "eventHistoryLimit": 2000, "promptLogging": "metadata",
                    "generationRetentionDays": 7, "generationMaxBytes": 1073741824,
                    "archives": { "activeFiles": 1, "closedFiles": 258, "closedBytes": 118111232,
                                    "lastRunAt": "…", "lastError": null } },
    "fleet": { "hosts": ["rosalina","daisy"], "defaultHost": "rosalina", "catalogMaxAgeMs": 0 },
    "capabilities": { "revision": "…", "observedAt": "…", "complete": true, "warnings": [] }
  },
  "hosts": [ /* /admin/api/hosts.hosts, unchanged keys, plus: */
    { "id": "rosalina", "display_name": "rosalina", "default": true, "resident": true,
      "published": true, "online": true, "draining": false, "drain_reason": null,
      "active": 0, "queued": 0, "model_ids": ["qwen3.8-flash-next-ud-iq4_xs"],
      "configuration": { "id": "flash-next-strata-solo-thinking-recovery-cache", "exclusive": true,
                          "runtime_revision": "103f90c8…", "published_at": "…", "host": "rosalina" },
      "revision": "6083e8a1…", "accepted_at": "…", "file": "/app/data/catalogs/rosalina.json",
      "loaded_from": "pushed", "warnings": [], "error": null,
      "window": { "requests": 141, "successRate": 99.3, "p50Ms": 6100, "p95Ms": 29200,
                   "tokensOut": 41230, "lastTs": "…" } }
  ],
  "models": [ /* catalog + live facts + window statistics, one entry per selectable model */
    { "id": "qwen3.8-flash-next-ud-iq4_xs", "service": "daytime", "aliases": ["daytime","local-active"],
      "display_name": "Qwen3.8 Flash-Next (256K)", "display_name_qualified": "Qwen3.8 Flash-Next (256K)",
      "host": "rosalina", "available": true, "complete": true, "capability_score": 96,
      "slots": 1, "active_request_limit": 1, "context_window": 262144, "model_context_window": 262144,
      "capabilities": ["completion","thinking","tools","vision"], "input_modalities": ["text","image"],
      "backend_kind": "strata", "quantization": "UD-IQ4_XS", "parameter_size": "…", "family": "…",
      "placement": { "gpu_count": 4, "gpus": ["RTX 4090 …"], "exclusive": true },
      "runtime_revision": "103f90c8…", "profile": { "id": "…", "version": 1 },
      "qualification_notes": ["…"], "health": { "available": true, "checked_at": "…" },
      "window": { "requests": 99, "successRate": 96.0, "p50Ms": 7923, "p95Ms": 29195,
                   "tokensIn": 6289085, "tokensOut": 61558, "cancelled": 4, "rejected": 0, "lastTs": "…" } }
  ],
  "offlineServices": [ { "model": "…", "host": "…", "reason": "…", "role": "…", "errorCode": "SERVICE_OFFLINE" } ],
  "metrics": { /* /admin/api/metrics snapshot, unchanged, plus ttftMs/queueWaitMs/tokenRate blocks */ },
  "warnings": [ "…" ]        // router-level advisories the UI shows once, never per row
}
```

`window` also accepts `15m`, `6h`, `24h`, `all`. An unknown value falls back to `1h` and is reported
in `window.requested` plus a `warnings` entry.

## 2. `GET /admin/api/requests`

`requests` is always newest-first normalized records and `page` is always present, so a caller never
has to guess whether the response was filtered. The rows themselves are normalized (§3); the
pre-portal shape, with the router's internal field names, is still available with **`raw=1`** for any
consumer that parses stored records.

| parameter | meaning |
|---|---|
| `limit` | rows per page, default 50, max 500 |
| `offset` | rows skipped from the newest end |
| `since`, `until` | ISO timestamp, or relative (`30m`, `6h`, `24h`, `all`) |
| `model` | requested **or** served model id, or an alias |
| `host` | machine id the request was served by |
| `client` | client identity substring, or `ip:` prefix for the source address |
| `outcome` | `success` \| `cancelled` \| `rejected` \| `error` \| `pending` |
| `status` | exact status code, or a class (`2xx`, `4xx`, `5xx`) |
| `protocol` | `responses` \| `chat` \| `ollama-chat` \| `ollama-generate` \| `discovery` \| `other` |
| `streaming` | `true` \| `false` |
| `has_journal` | `true` \| `false` |
| `error_code` | exact error code, e.g. `CLIENT_CLOSED_REQUEST` |
| `q` | free text over id, client, model, endpoint, error code/message |

```jsonc
{ "requests": [ /* normalized records, see §3 */ ],
  "page": { "limit": 50, "offset": 0, "returned": 50, "total": 178, "hasMore": true },
  "filters": { /* the filters actually applied, with defaults resolved */ },
  "generatedAt": "…" }
```

## 3. The normalized request record

Every record in every response below carries these keys (nullable where a value may be unknown —
the UI never has to guess a key exists):

```jsonc
{
  "schema": 2,
  "id": "6a00898d-…", "ts": "2026-10-22T21:47:34.773Z", "tsEpochMs": 1761165...
  "method": "POST", "endpoint": "/v1/responses", "query": "",
  "protocol": "responses", "protocolLabel": "OpenAI Responses",
  "kind": "prompt",                    // prompt | discovery | control
  "host": "rosalina", "hostDefault": true, "upstreamUrl": "http://192.168.1.12:8080",
  "requestedModel": "daytime", "servedModel": "qwen3.8-flash-next-ud-iq4_xs",
  "activeModel": "qwen3.8-flash-next-ud-iq4_xs", "modelRewritten": true, "alias": "daytime",
  "client": { "name": "deepseek-harness", "identity": "deepseek-harness/d7650bc22925",
               "ip": "192.168.1.7", "userAgent": "…" },
  "status": 200, "responseStatus": 200, "outcome": "success",   // success|cancelled|rejected|error|pending
  "allowed": true, "rejected": false, "errorCode": null, "errorMessage": null,
  "errorBodyExcerpt": null,             // bounded: 4 KiB of the error body that was returned
  "durationMs": 9581, "ttftMs": 803, "queueWaitMs": 0, "admissionWaitMs": 0,
  "streaming": true, "requestBytes": 1488932, "responseBytes": 183095,
  "tokens": { "input": 20054, "output": 336, "total": 20390 },
  "tokensPerSecond": 18.6, "ttftTokensPerSecond": 24.9,
  "usage": { … }, "finishReason": "stop", "completionState": "completed", "stopReason": null,
  "sampling": { "thinking": "medium", "reasoningEffort": "medium", "temperatureForwarded": false,
                 "seedForwarded": false, "outputLimitPolicy": "reject", "keepAlive": { "incoming": null, "forwarded": -1 } },
  "tools": { "present": true, "count": 62, "forwarded": 62, "dropped": 0, "unsupportedPolicy": "drop" },
  "promptCacheKey": { "present": false, "disposition": null },
  "contextTransitions": 0, "streamParseErrors": 0,
  "hostSource": "catalog",             // record | catalog | default — how `host` was established
  "journal": { "id": "843d5943-…", "available": true, "state": "archived" },
       // state: archived | not_archived (served, nothing written) | pre_admission (refused before
       // admission) | expired (id known, file gone) | not_applicable (no id in this record)
  "bodySummary": { … },                 // PROMPT_LOGGING projection, unchanged
  "backendKind": "strata", "attempts": 1
}
```

Derivation rules (so the UI can trust them):
- `protocol` from the endpoint; `kind` is `discovery` for `/api/tags`, `/api/ps`, `/v1/models`, `prompt`
  for generation routes, `control` for anything else that was logged.
- `host` is the machine of the served model. `hostSource` says how that was established: `record`
  (the request logged it), `catalog` (the accepted catalog of the model it was served by names the
  machine), or `default` (nothing attributed it, so it ran on the default machine — an inference, and
  shown as one). `upstreamUrl` is the backend base URL, never including a path or credentials.
- `outcome`: `success` = 2xx; `cancelled` = 499 or `CLIENT_CLOSED_REQUEST`; `rejected` = never admitted
  (gate/policy/maintenance/drain); `error` = admitted but failed (4xx/5xx after admission); `pending` =
  still in flight.
- `ttftMs` is measured on the response stream (first content delta); `queueWaitMs` is admission-queue
  wait, `admissionWaitMs` is time between request arrival and admission. Both are `null` for
  pre-admission rejects and for records written by an older build.
- `tokensPerSecond` = output tokens ÷ (duration − ttft); `null` when either is unknown. This is the
  router's own measurement, distinct from anything the backend reports.
- `journal.state` is `pre_admission` when the request was refused before a generation journal was
  opened, which is why it can never have a payload, and `not_archived` when it was served by a backend
  that does not write archives (a runtime serving an active-model marker rather than a published
  catalog). Only `archived` has a §5 document to read.

## 4. `GET /admin/api/requests/:id`

`{ "record": { /* §3 */ }, "events": [ /* persisted lifecycle events for this request, newest first */ ] }`
`404 REQUEST_NOT_FOUND` when the id is not in the retained window. Also `GET /admin/api/requests/:id/journal`.

## 5. `GET /admin/api/requests/:id/journal?events=40&promptBytes=24576`

The payload view, built from `DATA_DIR/generations/<recordId>.jsonl`. Bounded by
`GENERATION_JOURNAL_VIEW_BYTES` (default 4 MiB read) — `truncated` says so instead of hanging — and
the prompt text of each item by `PORTAL_PROMPT_VIEW_BYTES` (default 24 KiB), which leaves the elided
byte counts in the response rather than the bytes themselves.

`:id` resolves a request id or a journal id. `404` answers with the reason the payload cannot be
shown: `JOURNAL_NOT_FOUND` (no such archive and no retained request refers to one),
`JOURNAL_NEVER_OPENED` (the request exists but never had an archive, and why), `JOURNAL_EXPIRED`
(it had one and retention has removed it), `INVALID_RECORD_ID` (not a UUID).

```jsonc
{
  "recordId": "6a00898d-…", "journalId": "843d5943-…",
  "file": "…/generations/843d5943-….jsonl", "bytes": 700257, "lines": 791,
  "truncated": false, "state": "archived",
  "phases": [ { "name": "request", "label": "Received", "at": "…", "offsetMs": 0, "detail": "model=daytime stream=true items=142" },
              { "name": "admission", "label": "Admitted", "at": "…", "offsetMs": 2, "detail": "input=20054 slot_ctx=262144 reserve=1024" },
              { "name": "backend_request", "label": "Upstream request", "at": "…", "offsetMs": 3, "detail": "n_predict=-1 thinking={\"enable_thinking\":true}" },
              { "name": "first_event", "label": "First token", "at": "…", "offsetMs": 803, "detail": "delta=content" },
              { "name": "terminal", "label": "Complete", "at": "…", "offsetMs": 9581, "detail": "status=200 finish=stop total=20390" } ],
  "terminal": { "status": 200, "finishReason": "stop", "stopReason": null, "usage": { … },
                 "contextTransitions": 0, "recordId": "843d5943-…" },
  "prompt": {
    "model": "daytime", "itemCount": 142, "bytes": 1488932, "stream": true,
    "items": [ { "index": 0, "role": "developer", "kind": "text", "text": "…", "truncated": true, "bytes": 5401 },
                { "index": 1, "role": "user", "kind": "input_text", "text": "…", "truncated": false, "bytes": 2963 },
                { "index": 7, "kind": "input_image", "elided": true, "bytes": 141312 },
                { "index": 141, "kind": "more_items", "count": 138 } ],
    "tools": [ { "name": "bash", "description": "Execute a bash command…" } ],
    "toolsCount": 62, "toolsBytes": 318000, "imagesElided": 3, "elidedBytes": 423936,
    "bytesShown": 24576
  },
  "backendRequest": { "model": "qwen3.8-flash-next-ud-iq4_xs", "body": { /* bounded translation */ } },
  "events": { "total": 787, "byType": { "backend_event": 786, "terminal": 1 },
               "samples": [ { "at": "…", "type": "backend_event", "summary": "delta=content (+51 ch)" } ],
               "firstByteMs": 803, "lastByteMs": 9580, "omitted": 747 }
}
```

`?format=ndjson` streams the untouched file (this is the old `/admin/api/generation-record?id=` route,
which stays available and is what "Download payload" links to).

## 6. `GET /admin/api/stats?window=1h&bucket=1m`

Computed on demand from the retained request window, so it always agrees with `/admin/api/requests`
and never survives a restart on its own.

```jsonc
{
  "window": { "requested": "1h", "seconds": 3600, "from": "…", "to": "…" },
  "bucket": { "requested": "1m", "seconds": 60, "kept": 240 },
  "totals": { "requests": 178, "allowed": 176, "rejected": 2, "cancelled": 41, "upstreamErrors": 1,
               "successRate": 75.8, "pending": 0 },
  "byStatus": { "200": 135, "499": 41, "503": 2 },
  "latencyMs": { "avg": 9642.8, "p50": 6351, "p95": 28797, "p99": 60353, "max": 60353, "samples": 178 },
  "ttftMs": { "avg": 812.4, "p50": 803, "p95": 1900, "samples": 135 },
  "queueWaitMs": { "avg": 0, "p95": 0, "max": 0, "samples": 176 },
  "tokensPerSecond": { "avg": 18.4, "p50": 17.9, "p95": 26.1, "samples": 129 },
  "tokens": { "input": 6689551, "output": 62753 },
  "byModel":  [ { "key": "qwen3.8-flash-next-ud-iq4_xs", "host": "rosalina", "requests": 177, "successRate": 75.7, "p50Ms": 6300, "p95Ms": 29000, "ttftP50Ms": 800, "tokensIn": 6289085, "tokensOut": 61558, "lastTs": "…" } ],
  "byHost":   [ { "key": "rosalina", "default": true, "requests": 177, "successRate": 75.7, "p50Ms": 6300, "p95Ms": 29000, "tokensOut": 61558, "draining": false, "active": 0, "queued": 0, "lastTs": "…" } ],
  "byClient": [ { "key": "deepseek-harness/d7650bc22925", "ip": "192.168.1.7", "requests": 97, "successRate": 74.2, "p95Ms": 29195, "tokensOut": 30112, "lastTs": "…" } ],
  "byEndpoint": [ { "key": "POST /v1/responses", "protocol": "responses", "requests": 170, "successRate": 75.9, "p95Ms": 29000 } ],
  "byError":  [ { "code": "CLIENT_CLOSED_REQUEST", "count": 41, "lastTs": "…" } ],
  "series": { "bucketSeconds": 60, "from": "…", "to": "…",
               "buckets": [ { "t": "2026-10-22T21:40:00.000Z", "epochMs": 1761165..., "requests": 12,
                                "ok": 9, "cancelled": 3, "rejected": 0, "errors": 0,
                                "promptTokens": 120000, "outputTokens": 990,
                                "p50Ms": 6100, "p95Ms": 29000, "active": 1, "queued": 0 } ] },
  "sinceStart": { /* the same totals block for the whole retained window */ }
}
```

Buckets are emitted for every minute in the window, including empty ones (`requests: 0`), so the UI
draws a continuous axis. `bucket` accepts `10s`, `1m`, `5m`, `15m`, `1h`; the series never exceeds
600 buckets (the interval widens and the response says so).

## 7. `GET /admin/api/events?limit&offset&type&q`

Existing route, now with `offset`, `type` (repeatable or comma list) and `q`. Same envelope
`{ "events": [...], "page": { … } }`. Event types are unchanged, except
`model_catalog_published` additionally carries `"configuration": { "id", "exclusive", "runtime_revision" }`
so the configuration history is readable from the feed.

## 8. `GET /admin/api/capabilities?include=load`

Byte-identical document to `GET :11434/v1/router/capabilities` (same publisher, same `revision` and
`ETag`). Present so the portal page can read it same-origin; `?include=load` adds live load, exactly
like the API-port route. Conditional requests (`If-None-Match`) answer `304`.

## 9. `GET /admin/api/stream`

Server-Sent Events, same-origin, `retry: 2000`. One subscriber set as the API-port stream; the
heartbeat interval is `ROUTER_EVENTS_HEARTBEAT_MS`.

| event | data |
|---|---|
| `hello` | `{ "schema": 2, "at", "window", "revision" }` |
| `capabilities` | the capabilities document, identical to §8 (fired on change and on the heartbeat) |
| `request` | one normalized request record (§3), fired when a request is persisted |
| `event` | one persisted lifecycle event (§7) |
| `drain` | `{ "draining", "host", "reason", "at" }` |
| `heartbeat` | `{ "at", "active", "queued" }` |

The browser falls back to polling `portal/state` + `requests` when the stream drops (and the page
says so in the live chip: `live` / `reconnecting` / `polling`).

## 10. Control routes (unchanged bodies, now token-free on the admin port)

| route | body | notes |
|---|---|---|
| `POST /admin/api/runtime-drain` | `{"enabled":true,"reason":"update","host":"daisy"}` | `host` optional; omitting it drains the whole router |
| `POST /admin/api/maintenance` | `{"enabled":true}` | |
| `POST /admin/api/reload-config` | – | re-reads the active-model marker |
| `POST /admin/api/prewarm` | `{"model":"…"}` | |
| `GET /admin/api/runtime-state` | – | backend facts, drain state, supported kinds |
| `GET /admin/api/generation-record?id=<uuid>` | – | raw NDJSON archive (the "Download payload" link) |

## 11. Retention defaults changed in this release

| variable | old default | new default |
|---|---|---|
| `REQUEST_HISTORY_LIMIT` | 500 | 5000 |
| `REQUEST_LOG_MAX_BYTES` | 5 MiB | 32 MiB |
| `EVENT_HISTORY_LIMIT` | 500 | 2000 |
| `GENERATION_JOURNAL_VIEW_BYTES` | – | 4 MiB (new, bounds the §5 read) |
| `PORTAL_PROMPT_VIEW_BYTES` | – | 24 KiB (new, bounds the prompt text §5 returns) |

Requests are served newest-first from an in-memory ring; the file on disk is a bounded snapshot that
survives restarts. Nothing about the on-disk format changes.
