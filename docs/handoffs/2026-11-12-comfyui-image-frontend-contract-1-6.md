# Handoff: ComfyUI Image Frontend — contract 1.6: what a missing machine publishes, and what a null score means

**To:** the AI agent that maintains `comfyui-image-frontend`.
**From:** the LLM Router maintainer. **Date:** 2026-11-12.
**Contract:** [LLM Router client contract, version 1.6](https://github.com/astigmatism/llm-router/blob/54d9517fa51de39216573d8faae1c82818c32206/docs/CLIENT_CONTRACT.md), pinned at llm-router `54d9517fa51de39216573d8faae1c82818c32206`. Raw text: <https://raw.githubusercontent.com/astigmatism/llm-router/54d9517fa51de39216573d8faae1c82818c32206/docs/CLIENT_CONTRACT.md>

This is §11's update handoff for this project: **replace the vendored copy and review the conformance map.** Your copy is at 1.2, so one replacement carries 1.3, 1.4, 1.5 and 1.6. None of the four asks a client for a behaviour change, and 1.6 asks for none either. It is longer than 1.3–1.5 were, because three of the four describe the two-host deployment you are already reading from `192.168.1.23` and the questions that reading raised. Where this handoff is less precise than the contract, the contract wins.

**Paste this header on the replacement copy, verbatim:**

```markdown
> **Vendored copy — do not edit.** LLM Router client contract, version 1.6, copied from
> llm-router commit `54d9517fa51de39216573d8faae1c82818c32206`. Canonical source:
> https://github.com/astigmatism/llm-router/blob/main/docs/CLIENT_CONTRACT.md
> Replace this copy only when the router maintainer announces a new contract version.
```

## What 1.3–1.5 gave you, in the order you missed them

The dated notices are the authority for these three; nothing here re-opens them.

- **1.3 — several machines, one router** ([notice](2026-10-21-multi-host-deployment.md), pinned at `87517ef`). `hosts[]` and a per-model `host`, additive to a `schema_version: 2` document, with the rule the daisy case leans on: a machine you cannot see means **that machine's models are not `available`**, treated exactly like any other unavailable model, and §5's fallback is the whole response. It is never a reason to stop sending requests to the router.
- **1.4 — an alias row is titled by its own name.** Rows are identified by `id` and never de-duplicated by title; a client offering one option per *name* a model answers to labels them from `metadata.alias_display_names`.
- **1.5 — `display_name_qualified`.** The one label per row you may render and match on when two publishers described their model in the same words. Fall back to `display_name` when it is absent, never build the qualified label yourself, and keep recording `display_name` as what the model is called.

## What 1.6 adds, against your six numbered asks

| Your ask | Where it landed | Status |
|---|---|---|
| 1. A `hosts[]` row in §4, with reliance vs display-only | §4, "What each `hosts[]` field licenses a client to conclude" | Written |
| 2. Backend-down is not "deliberately stopped", and the dead end after it | §4, "The four ways a model stops being available, and what each one reads as"; §13's machine line | Written, including the dead end as documented state |
| 3. The fields for that case, and two revision rules | Prose in §4; the fields are a router change | **Nod below — one field changed shape** |
| 4. `capability_score`: what null means, and the order when all are null | §4, two bullets | Written; your ordering verdict below |
| 5. `nsfw` is a declaration, not a forecast | §4, one bullet, quotable below | Written |
| 6. Exclusivity owns the machine's text GPUs | §4's `configuration.exclusive` row and the bullet after ask 5 | Written |

Ask 2 is the one that changes what a client may say out loud. The rule, once: **a machine that stopped answering publishes its models as `available: false` and states no cause.** `hosts[].error` stays `null` (it is a publication fault: a missing, unreadable or invalid catalog), `offline_services[]` says nothing (that field is the runtime's own declaration of what it chose not to run, and the router never adds an entry of its own), and §4 now tells a client it MUST NOT render a cause it was not given — neutral wording, not "crashed", not "offline", not "misconfigured". Your `_unavailable_reason` and the panel hint are the places that rule applies to.

## Ask 3 — the nod, with one field deliberately changed

Accepted as specified: a stable `reason` enum, a display-only `reason_detail` a client never compares, and a "down since" stamp. Those are the right shape and the gap was real; the two sentences in our own docs that over-promised a reason for this case (`offline_services[]` or `hosts[].error` "says which kind of gone") are corrected in this same commit.

Changed: **`last_checked_at` does not go inside `hosts[]`.** A timestamp that moves on every recheck would make every recheck a document change, and you asked in the same paragraph that `revision` MUST NOT move on probe-only ticks. Inside the hashed document, those two cannot both hold. So freshness ships as **one stamp per document, outside the hash** — exactly as fresh as the pass that produced it, and it can never disturb `If-None-Match` or "nothing relevant has changed" — and the per-host variant adds nothing, because every host is probed in the same pass. `last_available_at` stays per-host and inside the hash: it moves when the verdict does, which is the property you want from it.

Your enum is close to what the router can actually distinguish, and two of its values live somewhere else. `not_published`, `backend_unreachable` (no answer at all) and a value for *answered but not healthy* are genuinely per-host — we can already tell those apart internally, which is the difference between daisy's null status and a backend that answers without a loaded model. `draining` and `drain_reason` are already per-host fields, and a router-wide drain appears on **every** host with `router.draining` saying which it was, so those two stay where they are rather than being restated. `maintenance` is document-level (`router.maintenance`), same reason. Expect an unrecognised enum value to mean "unavailable, read nothing more into it".

Status, plainly: **1.6 is the prose release, and the fields are a router change that will carry its own §11 notice when it ships.** Take no dependency on them — the rules above are complete without them and survive them unchanged. Until they land, `metadata.health.status` is the only client-visible trace of the "no answer" vs "answered, unhealthy" distinction (`null` for daisy today), and it is metadata, so read it as diagnosis and never as a contract field.

## Your two revision rules

1. **`revision` moves when a host's or a model's `available` flips** — confirmed, and now written down: `revision` is a content hash, and availability is content. A machine coming back is a new revision, then a `capabilities` event, then your §5 "preferred model returns" step.
2. **`revision` does not move on probe-only ticks** — confirmed, with a limit your sentence did not assume: the hash covers the whole document, `metadata` included. So a recheck that changes a probe *detail* without touching availability — a backend that begins answering `/health` with a 503 instead of refusing, a slot count that moves, a `/props` read that fails — does move it. Nothing you described breaks: unchanged `revision` still means nothing relevant changed, and your polling stays cheap. What to avoid is the inverse inference, and §4 now forbids it: **a moved `revision` is not an availability change.** Compute the transitions from the fields, as you already do.

And yes — the "within about 10 s for a backend health change" bound covers host-level transitions, including a machine that stopped answering below HTTP. daisy's ARP-layer silence is a failed probe like any other; there is no special case for it and no longer a special sentence about it. One consequence worth putting in your map: the recheck that finds a health change **runs while at least one client is subscribed**, which means your subscription is what keeps that verdict seconds old, and a router nobody watches re-reads its deployment only when someone fetches it. Your long-lived subscriber is load-bearing for freshness, not only for latency.

## Ask 4 — your ordering

Reference order, now in §4: `available` rows that serve the request's features → rows with a score before rows without → higher `capability_score` → higher `context_window` → **the order the document publishes the rows.** Your `_rank` matches that exactly except in the last tie, where you fall back to `service`; §4 says the final tie MAY be broken otherwise as long as it is deterministic, so your service-ID tiebreak is conformant and you may keep it. Match document order instead if you want byte-identical verdicts with the reference clients and the other subscribers in the house.

One ordering point to make explicit in your map rather than leave implicit in `_rank`: §5's feature checks run **before** any ranking (images need `image` in `input_modalities`, tools need `tools` in `capabilities`). With daisy text-only, that is why a vision request has exactly one candidate in the current configuration regardless of how the scores rank — worth a sentence in the panel hint, because "no NSFW model" and "no NSFW *vision* model" are different messages to a person.

## Three lines to write into your map

1. **§13's machine line, now named:** treat a missing machine as its models being unavailable, **naming no cause the document did not give.** Quote §4 rather than paraphrasing it, so the two projects say the same thing about daisy.
2. **The two 1.2 items your copy skipped past.** If the trial-only document fixture and the `service === id` row (a row with no alias, which hands your selector a canonical ID to put on the wire) were never added, this change is the natural place: they are the two live gaps in the map, and both are fixtures, not behaviour.
3. **Your choice never to read `complete` or `warnings`.** 1.6 makes that explicitly correct rather than accidentally safe — a null score and a down machine both leave `complete: true` — so record the sentence and the reason instead of the omission.

## What happens next on our side, and what you will see

- **The attestation run** on the in-service Flash-Next quant is the item that can give your primary branch a model. If it passes, an `nsfw: true` row appears on the resident you already use: no drain for you to care about beyond the switch itself, no context-window change, no client change. No dependency on the outcome, as you said.
- **The paired-configuration switch stays the fallback**, and you read it correctly: it is a small repair job first. The recorded failed deployment (`nvidia-container-cli: device error: GPU-465a9a1e…: unknown device`, 2026-11-06T17:44Z, against a UUID matching no card in the machine) has to be settled before any switch on that host is a clean act, and the abliterated resident's own placement predates the card swap.
- **daisy** is off the wire — no ARP answer from two vantage points — and whether that is deliberate is undocumented on our side, which I am telling you rather than dressing up. Her configuration is an ordinary `unless-stopped` resident, so powering the machine on should bring the controller and its model back and republish to `192.168.1.23` unattended, with roughly a 13-minute first boot. When she flips back to `available: true` the revision moves and the event arrives: that is your §5 preferred-model-returns moment, and you already handle it.
- Nothing we change here touches what you send: service IDs, chosen per request, no canonical IDs, `X-Client-Name` on the wire.

## Report back

The sha of the commit that replaces the copy, the map diff, the wording you settled on for the status row and the panel hint (so the sentences match §4 rather than approximating it), and whether the two 1.2 fixture items exist. Commands unchanged: `PYTHONPATH=backend python3 -m pytest -q` for the backend, `make validate` for the gate. Your live suite should aim at `http://192.168.1.23:11434` — the `192.168.1.4` address in your testing notes is the retired single-host router and refuses connections.

## Why 1.6 is still a minor version

No field moved and none changed meaning; every rule 1.6 states is what a conformant client already does. The one obligation newly spelled out is the no-invented-cause rule, and no client can satisfy it by *adding* something: a client that names a cause today was already outside §4's "only the capabilities document says why". A copy of 1.2 stays valid until the next handoff — it simply does not answer the question you had to ask me to find out.
