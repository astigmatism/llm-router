# Handoff: the runtime publishes its catalog to the router

**To:** the AI agent that maintains the AI Runtime — the machine-side controller that starts
models, qualifies them, and publishes what is resident.
**From:** the LLM Router maintainer. **Date:** 2026-10-21. **Router release:** `ae88119`.
**Contract:** [runtime integration](../RUNTIME_INTEGRATION.md) · [multi-host
deployments](../MULTI_HOST.md) · [what is already implemented](../PRIMARY_INTEGRATION.md#publishing-to-a-router-on-another-machine)

The router no longer lives next to the models. It has its own instance, and it serves the merge of
one catalog per machine rather than one file on a shared filesystem. That moves the runtime from
*writing a file the router happens to read* to *publishing to a service*, which is a different
obligation even though the document it produces is identical.

## What changed on the router side

1. **The router is on `192.168.1.23`.** API `http://192.168.1.23:11434`, admin listener and
   publication endpoint `http://192.168.1.23:11435`. Rosalina's own router at `192.168.1.4` keeps
   running and becomes legacy once clients repoint; it is not this router's concern.
2. **Hosts are declared, not discovered.** The router today declares `ROUTER_HOSTS=local,rosalina`
   with `ROUTER_DEFAULT_HOST=rosalina`. A push from an ID that is not in that list is
   `404 HOST_NOT_DECLARED`; joining is one edit on each side, and the machine appears when the
   router next starts.
3. **`local` is reserved for the machine the router process runs on** and stays file-backed:
   `ACTIVE_MODEL_FILE`, then `POST /admin/api/reload-config`. Every other machine publishes over
   HTTP. A runtime on Rosalina can no longer reach *this* router through a directory.
4. **Publication is validated with the same reader that will serve the catalog**, including the
   `runtime_output_policy` attestation that the running backend's argv shows uncapped output and
   thinking. A catalog written from intention rather than from the live process is refused at the
   door, while the runtime still holds the payload. A refusal leaves the previously accepted catalog
   in force, so a failed publish is a deployment that did not happen, never an empty model list.
5. **A drain may name one machine.** `POST /admin/api/runtime-drain` with `"host": "rosalina"`
   stops admitting work whose model runs there and leaves every other machine serving; omitting
   `host` stays the whole-router switch a router release pulls.
6. **Consumers hear it from the router.** An accepted publication bumps the capabilities revision,
   and clients subscribed to `GET /v1/router/events` receive the new document with the model
   attributed to its machine. Nothing polls or calls back into a runtime.

## What the runtime is expected to do

Each of these is checkable against a running router; the checks are the acceptance criteria.

| # | Obligation | How to tell it worked |
|---|---|---|
| 1 | Hold a definition naming the router, this machine's host ID, and the environment variable carrying the credential ([example](../../runtime/router-target.example.json)). The three facts may live wherever a runtime keeps configuration; the router only sees the HTTP call. | Booting without a definition fails loudly and names what is missing, rather than starting a runtime that publishes nowhere. |
| 2 | Publish the **whole catalog** — `schema_version` 3, `default_model`, `models[]`, the `configuration` object, and the root projection agreeing with its entry — on applying a configuration, and at startup after the backends verify. Not a bare marker. | `GET /admin/api/hosts` shows your host `published: true` with the revision you were handed back, and `model_ids` matching what is resident. |
| 3 | Publish a `backend_url` **the router can reach**. A Docker DNS name is correct on the machine that resolves it and wrong from `192.168.1.23`; publish the backend's port on the LAN and name that address. | `GET /v1/router/capabilities` reports your model `available: true`. A loopback address is reported as `BACKEND_URL_NOT_ROUTABLE` in the publish response when the router asks for routability. |
| 4 | Claim no name another machine serves, and declare `local-active` only on your default entry. Canonical IDs, aliases and deliberately-stopped service names are unique across the deployment. | Publication returns 200 rather than `409 CATALOG_ID_CONFLICT`, which lists up to 25 clashes. |
| 5 | Drain **your host** before touching a serving backend, wait until that host's work is idle, then stop or replace the backend, then publish what is true afterwards. | `GET /admin/api/runtime-state` shows `active_by_host`/`queued_by_host` for your ID at zero while other machines keep their counts. |
| 6 | Retire the catalog (`DELETE /admin/api/hosts/<host>/catalog`) when the machine stops serving those models, rather than leaving a catalog whose backends nobody starts. | The model leaves `/v1/models` and the capabilities document, and your host reports `published: false`. |
| 7 | Compare the revision in the 200 response against what you intended to publish, and treat it as the receipt. | A publication that succeeded says so with a revision; nothing in the runtime has to re-read the router to be sure. |
| 8 | Show publication in your own status: last revision, when, and the last error if any. | An operator looking at the runtime can tell "models running here, published there" from "running here, publication failing since 09:14". |
| 9 | Do not treat the router's view of your health as your own. It reports `available: false` when *it* cannot reach your `backend_url`, which is a statement about its network. | Your status distinguishes the two rather than flipping to unhealthy because a router restart or a switch blip happened. |

## During the transition, publish twice

Rosalina is the machine that has both a legacy router on it and a new router to feed. Until clients
have repointed, the runtime there keeps writing the marker file the legacy router reads **and**
pushes the same document to `192.168.1.23`. Same document, two sinks, one publication path. That
window should end with the client repoint and the deletion of the file write, not drift into
permanence: two sinks is the one state where the two routers can disagree about what is resident.

## Rosalina specifics

- **Host ID:** `rosalina` (already declared on the router).
- **Credential:** the value of `CATALOG_PUSH_TOKEN` in `~/credentials/llm-router/router.env` on
  `192.168.1.23`, mode 0600. Hand it to the runtime's environment the way its other secrets get
  there; it never belongs in a repository. `ADMIN_TOKEN` on the router is accepted too, but prefer
  the publisher token: it can write a catalog and nothing else.
- **Backend reachability is not yet true.** `qwen38-daytime` publishes `127.0.0.1:18080`, so today
  the router on `.23` catalogues the model and honestly reports it unavailable. Either re-create the
  backend publishing `192.168.1.4:18080` (a model reload, so a maintenance window) or run a small
  container on `local-ai-ollama_default` forwarding `192.168.1.4:18080` to `qwen38-daytime:8080`
  (no reload, one command to undo). LAN exposure of runtime-owned ports is already precedented: the
  runtime's own API is published at `192.168.1.4:11436`.
- **There is a working implementation to copy.** `scripts/primary/primary.py` in the router
  repository already speaks the protocol when `ROUTER_PUSH_URL`, `ROUTER_HOST_ID` and
  `CATALOG_PUSH_TOKEN` are set: it sends the catalog, reads back the revision, scopes the drain and
  the idle wait to its own host, and verifies only the models that host is responsible for. With
  `ROUTER_PUSH_URL` unset it keeps the historical file handoff, which is what the transition wants
  from Rosalina. Reusing it, or lifting its sequence, beats re-deriving the edge cases.

## What does not change

The catalog document itself — no new required fields, `schema_version` stays 3. Model IDs and
service IDs, and what they promise. `local` semantics on a machine that runs its own router. The
runtime's ownership of model loading, qualification and configuration: the router never asks a
runtime to do anything, never reconfigures one, and needs no credential that could.

## Checking a machine end to end

```bash
ROUTER=http://192.168.1.23:11435
# Both credentials live on the router box at ~/credentials/llm-router/router.env; read them from
# wherever your runtime keeps its own secrets rather than copying the file around.
TOKEN=${CATALOG_PUSH_TOKEN:?publisher token}
ADMIN=${ADMIN_TOKEN:?router admin token}

curl -s $ROUTER/admin/api/hosts | jq '.hosts[] | {id, published, model_ids, revision}'
curl -s -X PUT $ROUTER/admin/api/hosts/rosalina/catalog \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data-binary @active-model.json | jq '{revision, default_model, models, warnings}'
curl -s http://192.168.1.23:11434/v1/router/capabilities \
  | jq '{hosts: [.hosts[] | {id, available, model_ids}], models: [.models[] | {id, host, available}]}'
curl -s http://192.168.1.23:11434/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"daytime","messages":[{"role":"user","content":"hi"}],"stream":false}' | jq .choices[0].message.content
curl -s -X POST http://192.168.1.23:11434/admin/api/runtime-drain \
  -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"enabled":true,"host":"rosalina","reason":"runtime maintenance"}' | jq .runtime.draining_hosts
curl -s -X POST http://192.168.1.23:11434/admin/api/runtime-drain \
  -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"enabled":false,"host":"rosalina"}' >/dev/null
```

Expect, in order: your host declared; your models published with no warnings; `available: true` on
your model with `"host": "rosalina"`; a real answer; your host in `draining_hosts` while another
machine's models keep serving.

## Order of work

1. Definition plus publication, deployed on Rosalina while its own router stays primary. Nothing a
   client sees changes.
2. Backend reachable on the LAN, catalog republished with that address, `available: true` on `.23`.
3. Clients repointed to `192.168.1.23` one at a time (each has its
   [own handoff](2026-10-21-multi-host-deployment.md)).
4. Legacy router retired; the runtime stops writing the marker file and publication is single-sink.
5. The next machine: its ID in `ROUTER_HOSTS`, a router restart, its runtime pointed at the same
   address with its own host ID. No client notices anything but a longer model list.

If a rule here does not fit how a runtime is built, change the contract and say why — the documents
above are the boundary, and a boundary quietly worked around in one implementation is worse than one
amended in the open.
