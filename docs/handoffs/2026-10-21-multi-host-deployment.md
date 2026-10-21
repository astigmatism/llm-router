# Handoff: the router now spans several machines

**To:** the AI agent that maintains a project which sends requests to the LLM Router.
**From:** the LLM Router maintainer. **Date:** 2026-10-21. **Router release:** `87517ef`.

**The contract is now version 1.3**, pinned at llm-router `87517ef` and [on main](https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md). Replace your copy at `docs/llm-router-contract.md` with it and review your conformance map. **No client change is required by this version**; the notice says what you get for free, and what you may want to use.

## What happened

The router moved to its own instance. Until now the router process, the AI Runtime that starts models, and the GPUs were on one machine (Rosalina, 192.168.1.4), and the runtime handed the router a catalog file through a shared directory. From this release the router can serve models that run on several machines in the home network at once, each machine publishing its own catalog to the router over HTTP.

For a client this is a fact about the plumbing, not a change of rules:

- **One router, one model list.** `/v1/models`, `/api/tags`, `POST /v1/chat/completions` and the rest are unchanged. The service IDs are unchanged: `daytime`, `nighttime`, `trial`, and `local-active` for the active model.
- **A model that moves between machines keeps its name.** If the runtime runs Nighttime on another GPU box next month, `nighttime` means that model there, with the context and slots it publishes. Nothing your client caches about location has to survive the move, because you should not have cached it.

## What is new in the document you already read

`GET /v1/router/capabilities` is `schema_version: 2`. Two additions, both present only when the deployment actually spans more than one machine:

```json
{
  "schema_version": 2,
  "hosts": [
    { "id": "local", "display_name": "local", "default": true, "published": true,
      "available": true, "draining": false, "drain_reason": null,
      "configuration": { "id": "flash-next-strata-solo-thinking-recovery-cache", "exclusive": true },
      "model_ids": ["qwen3.8-flash-next-ud-iq4_xs"] }
  ],
  "models": [ { "id": "…", "service": "nighttime", "host": "rosalina", "available": true, … } ]
}
```

- `hosts[]` — every machine the router knows about, whether it has published, whether it can serve, whether it is in a maintenance window, and which models it is responsible for.
- `host` on each model — the machine running it.

If your client ignores unknown fields, as the contract requires, it is already correct. If it displays or logs where a model runs, read it from these fields rather than from any address in `metadata`.

## Two things worth knowing

**A machine can be missing and the router still healthy.** A host that has not published, or whose backend is down, reports its models as `available: false`. That is the ordinary "this model is not here" signal you already handle: fall back per §5, do not treat it as a router failure. Requests for models running on other machines continue normally. An unnamed request still answers, from the machine the router is configured to consider its default.

**A drain may cover one machine.** During maintenance on one machine, requests whose model runs there receive the same `503 BACKEND_DRAINING` you already wait out, and the message says which machine. Traffic to models elsewhere is unaffected. Your waiting and retry rules (§7) are unchanged.

## Addressing

The router is being relocated to **`http://192.168.1.23:11434`** (admin portal `http://192.168.1.23:11435`). Rosalina's existing router at `192.168.1.4:11434` keeps serving while clients are moved over, and becomes the legacy deployment once everyone has moved. If your project hard-codes a base URL, that is the line to change — it is the only change this relocation requires of any client.

## What to do

1. Replace `docs/llm-router-contract.md` with version 1.3 and update the version in your copy's header banner.
2. In your conformance map, note §4's `hosts[]` and §7's per-machine drain. Mark them "no action: additive" unless you display location.
3. Point your configuration at the new router address when the maintainer tells you it is live, and keep the old one as a fallback setting for a while.
4. Nothing else. Do not add host-based routing to a client: choose models by service ID, and let the router decide which machine answers.

Questions or objections to the maintainer before you invent your own interpretation of `hosts[]`.
