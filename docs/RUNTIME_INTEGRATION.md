# Runtime integration: publishing models to the router

Whoever runs models on a machine is a producer. This is the contract for that side of the
boundary. [The client contract](CLIENT_CONTRACT.md) is for consumers; the two documents are meant
to be read apart from each other, because the two sides never talk.

## The boundary in three sentences

A runtime owns model loading, the qualification of what it loaded, and the catalog that describes
it. It publishes that catalog to the router and serves no clients. The router owns the merge of
every machine's catalog, the names clients send, admission and drain, and what consumers are told
exists; it never loads a model, never asks a runtime for anything, and therefore never needs a
credential that would let it reconfigure a machine.

Publication is one-way. A runtime needs exactly three facts and can be written without knowing
anything else about the deployment:

| Fact | Example | Held as |
|---|---|---|
| Where the router is | `http://192.168.1.23:11435` | a definition distributed with the deployment |
| Which machine I am speaking for | `rosalina` | the same definition; the ID must appear in the router's `ROUTER_HOSTS` |
| The publisher credential | a bearer token | an environment variable named by that definition, never the value |

```json
{
  "schema_version": 1,
  "router_url": "http://192.168.1.23:11435",
  "host": "rosalina",
  "token_env": "CATALOG_PUSH_TOKEN"
}
```

`runtime/router-target.example.json` is that definition. Its shape belongs to the runtime — the
router sees only the resulting HTTP call — so a runtime is free to hold the same three facts in
its launch definition, its portal form, or its environment. What the router relies on is only that
the address is a router, the ID is declared, and the credential is the publisher's.
`scripts/primary/primary.py` reads them as `ROUTER_PUSH_URL`, `ROUTER_HOST_ID` and
`CATALOG_PUSH_TOKEN`; with `ROUTER_PUSH_URL` unset it keeps the historical shared-directory handoff
on the machine it runs on.

## When to publish

Publish after the model is real, not before. The router validates what it is handed with the same
reader that will later serve it — including the `runtime_output_policy` attestation that the
running backend's own argv says output and thinking are uncapped — so a catalog written from
intention rather than from the process that is up gets refused, which is the outcome wanted while
the runtime still holds the payload and can fix it.

Concretely:

- **when a configuration is applied** — profile switch, model swap, a context or limit change, a
  change to which service IDs are offered. The deployment changing is the trigger; a timer is not
  required.
- **at startup, after the backends verify** — the router keeps the last catalog you sent across its
  own restarts, so this is confirmation rather than rescue: the response repeats a revision, and
  comparing it proves the model clients are being offered is the one this machine is running.
- **before touching a serving backend** — drain this host, wait for its work to finish, stop or
  replace the backend, then publish what is true afterwards.
- **when a machine stops serving models** — retire the catalog, rather than leaving clients pointed
  at a model nobody answers for.

Publishing the same bytes twice changes nothing and costs one request: an accepted catalog produces
the same revision. Re-publishing on a schedule is harmless and not required.

## What to send

The whole catalog, exactly as a local runtime would write it to its marker file: `schema_version`
3, `default_model`, `models[]`, the runtime `configuration` object, and the root projection of the
default entry, which must agree with that entry. One model or ten, in one document.

Two fields are where a machine two hosts away differs from a process next door:

- **`backend_url` must be an address the router can reach.** A Docker DNS name is correct on the
  machine that resolves it and wrong everywhere else, and it fails as an unexplained
  `BACKEND_UNAVAILABLE`. Publish the backend's port on the LAN and name that address. A router
  running with `ROUTER_EXPECT_ROUTABLE_BACKEND_URLS=true` reports a loopback address as
  `BACKEND_URL_NOT_ROUTABLE` at publication; a foreign DNS name is not caught there, because it can
  be entirely correct.
- **`updated_at` and `revision` should say when the machine last verified the description**, so a
  reader can tell a current claim from a leftover one. The router reports a catalog older than
  `CATALOG_MAX_AGE_MS` as `CATALOG_STALE:<host>`.

## What the answer means

| Response | Catalog on the router | What the runtime should do |
|---|---|---|
| `200` with `revision`, `models`, `offline_services`, `warnings` | replaced | compare `revision`; treat `warnings` as things to fix in the catalog, not as errors (`BACKEND_URL_NOT_ROUTABLE`, `CATALOG_STALE`) |
| `400 INVALID_MODEL_CATALOG` | unchanged | the catalog breaks its own contract: context and slot budget, reasoning policy, a root projection that disagrees with its entry. Fix and re-publish |
| `400 HOST_CATALOG_INCOMPATIBLE` | unchanged | a bare model marker was sent. Publish the catalog: the marker is what sits inside `models[]` |
| `400 LOCAL_HOST_IS_FILE_BACKED` | unchanged | the ID `local` belongs to the router's own machine and is published by a file. Use this machine's own ID |
| `401 CATALOG_PUBLISH_AUTH_REQUIRED` | unchanged | no or wrong token |
| `404 HOST_NOT_DECLARED` | unchanged | this machine is not in the router's `ROUTER_HOSTS`: the operator adds it, or the ID in the definition is wrong |
| `409 CATALOG_ID_CONFLICT` | unchanged | another machine already publishes one of these names; the response lists up to 25. Names are unique across the deployment so that a client sending `nighttime` cannot land on hardware nobody meant it to reach |
| `503 CATALOG_PUSH_UNAVAILABLE` | unchanged | the router has no publisher credential configured |
| no answer at all | unchanged | see the next section |

The stored copy survives a router restart, so a refusal is never what leaves clients without a
model; a refusal is a deployment that has not been applied.

## When the router cannot be reached

Publication fails, the previous catalog stays in force, and the router keeps offering the last thing
it accepted from this machine. That is deliberately the outcome: a router restart, a switch blip, or
a router mid-release must not empty the model list of every client in the house. Say so in the
runtime's own status — running here, not published there — and retry.

Do not use the router's opinion of your health as your own. The router polls your `backend_url` and
marks the model unavailable when it cannot reach it, which is the router reporting on its network,
not on your GPU.

## Draining one machine

`POST /admin/api/runtime-drain` with `{"enabled": true, "reason": "…", "host": "<your id>"}` admits
no new work whose model runs on this machine and leaves every other machine serving; the refusal a
client receives names the machine and the reason. `GET /admin/api/runtime-state` reports this
machine's accepted and queued work, and `DELETE /admin/api/hosts/<host>/catalog` retires the catalog
when the machine is not coming back with those models. Omit `host` only when releasing the router
itself, which is the whole-deployment switch it has always been. See [multi-host
deployments](MULTI_HOST.md).

## Hosts are declared, not discovered

A runtime cannot enrol itself: a push from an ID that is not in `ROUTER_HOSTS` is refused. That is a
choice, not an omission. Client-facing names have to be unique across the deployment, and two
machines claiming `nighttime` must resolve to the same answer every time, which needs a stated
precedence order and a stated default host — and precedence is a list the operator wrote, not
something a first-arrival race can decide. Adding a machine is therefore two edits, one on each
side: the ID in the router's `ROUTER_HOSTS`, and the router's address in the machine's definition.

## What consumers are told

Nothing polls the runtime. When a publication is accepted the router's capabilities document gains a
revision, every client subscribed to `GET /v1/router/events` receives an `event: capabilities`
carrying the new document — the model, its `host`, the machine roster, and any new warning — and a
client that only ever reads `GET /v1/router/capabilities` sees the same revision on its next poll. A
catalog that has not changed does not produce an event. Retirement and a host drain announce
themselves the same way. See [deployment capabilities](CAPABILITIES.md).

## A new machine, checked

1. `GET <router>/admin/api/hosts` — is my ID in the list, and what is it publishing today?
2. Publish, and check the response repeats my model IDs and my default model.
3. `GET <router>/v1/router/capabilities` — my model appears with `"host": "<my id>"`,
   `available: true`, and the capabilities and limits I claimed.
4. One real request through the router by service ID, streaming and non-streaming.
5. Drain my host; confirm a request for my model is refused by name while another machine's model
   still answers; undrain.
6. Stop my backend, confirm the router reports `available: false` for my model and still serves
   every other machine, then bring it back and re-publish.
