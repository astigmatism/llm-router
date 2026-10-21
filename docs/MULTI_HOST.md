# Multi-host deployments

The router was written to sit beside the models it serves: one machine, one GPU,
one runtime process writing one catalog file into a directory the router had
mounted. That arrangement is still the default and nothing in this repository
assumes otherwise. It is also no longer the only one.

This document describes what changes when the models live on other machines —
how a catalog arrives from another host, what a client sees, what fails alone
and what fails together, and how a machine is taken in for maintenance without
interrupting the rest.

## 1. What actually changes when the models move

Nothing about inference changes. A backend URL is already a URL, and the router
was always willing to follow it to another address. What changes is everything
that used to be guaranteed by proximity:

- **The catalog is not on this filesystem.** The runtime that starts a model
  cannot write into the router's `data/runtime` directory, so the catalog has to
  be handed over deliberately, and the handover needs a credential, a validation
  step, and a place to live in between.
- **A model has a location that the client cannot see.** `http://localhost:8080`
  means two different things on two machines. Whoever publishes a catalog states
  where its service is reachable from, and the router reports when that claim
  looks wrong.
- **A machine can be missing.** With one host, "no catalog" means the runtime is
  broken. With three it can mean a machine is switched off, and the other two are
  still serving models a client can name. That distinction has to be reported
  rather than averaged.
- **Maintenance is per machine.** One GPU box going into a service window is not
  a reason to stop traffic to a model that is running somewhere else.

Everything below follows from those four.

## 2. Hosts

A *host* is one machine that publishes the models resident on it. Hosts are
declared, not discovered: `ROUTER_HOSTS` is the list, in order of precedence,
and `ROUTER_DEFAULT_HOST` names the one that answers an unnamed request.

```
ROUTER_HOSTS=local,rosalina
ROUTER_DEFAULT_HOST=local
```

Joining is therefore two edits, one on each side: the ID in the router's list, and
the router's address in the machine's definition. The list is read at startup, so a
new machine appears when the router next starts — about a second, once per machine,
against the guarantee that no machine can rename what clients are already sending.
A deployment that grows on its own, with machines enrolling by first appearance,
would need precedence and a default host decided by arrival order; this one decides
them by writing them down. The publisher's view of the same rule, including what an
undeclared ID is told, is in [runtime integration](RUNTIME_INTEGRATION.md).

`local` is a reserved ID meaning *the machine this router process runs on*. It
keeps the handoff exactly as it has always worked: the runtime writes
`ACTIVE_MODEL_FILE` (falling back to the `ACTIVE_MODEL` environment value), then
calls `POST /admin/api/reload-config`. `local` cannot be published over HTTP —
one file with two writers is the ambiguity this split exists to remove — and a
deployment that declares no `ROUTER_HOSTS` at all is `local` alone, which is
every deployment that existed before this one.

Other IDs are names for machines: `rosalina`, `daisy`, `voice-box`. They must be
lowercase, at most 64 characters, and made of letters, digits, `.`/`_`/`-`. They
are operational identifiers, not protocol ones: a client never sends one to pick
a model. The ID appears in the capabilities document so a client *can* show
where a model runs, and in the admin surface so an operator knows which machine
to go and look at — but nothing a client does changes meaning when a model moves
between hosts.

The default host is a deployment-level statement of what "the active model"
means. It is the model `local-active` resolves to, the one an unnamed request
receives, the one `/health` reports, and the machine whose runtime configuration
is published as *the* configuration. It must be one of `ROUTER_HOSTS`.

## 3. Publishing a catalog

A deployment with only one **remote** publisher still reports that host's identity
and honours its scoped drain. Only the historical `local`-only deployment omits
host fields. Runtime control reads the default host's published catalog, just as
health and client routing do; it does not require a local marker file.

From here the endpoint is the interesting part; the *when*, the exact contents, and what each refusal obliges the publishing machine to do are the producer's contract, in [runtime integration](RUNTIME_INTEGRATION.md).

```
PUT /admin/api/hosts/<host>/catalog
Authorization: Bearer <CATALOG_PUSH_TOKEN>
```

The body is the same schema-version-3 model catalog the runtime already writes
for the local machine, root projection and all. `POST` is accepted as a synonym.

```
DELETE /admin/api/hosts/<host>/catalog
```

retires it: the host stays declared, reports `published: false`, and its models
leave the deployment. `GET /admin/api/hosts` returns the roster with each
machine's models, catalog revision, publication time and drain state.

The publisher authenticates with `CATALOG_PUSH_TOKEN`, or with `ADMIN_TOKEN`
where a deployment has only one credential. Publication is admitted on the
router port as well as the admin port, since a relocated router may hold nothing
but the publisher token, and the check is in the handler: the portal port is
unauthenticated by design, and a catalog is not a page. With neither token set
the endpoint answers `503 CATALOG_PUSH_UNAVAILABLE` rather than accepting
unauthenticated writes.

A publication is **validated before it is stored**, with the same reader that
will later serve it. That is the point: a runtime hears the real reason its
catalog was refused while it still has the payload in hand, instead of finding
out ten minutes later that requests fail. Validation covers the catalog contract
itself — schema version, the resident entry rules, context and slot budgets, the
reasoning policy, the root projection agreeing with its entry — and one thing
more:

**Names must be unique across the deployment.** A client sends `daytime` and must
not have to know which machine that lands on. A canonical ID, an alias, or the
name of a service another host has declared as deliberately stopped belongs to
that host; a publication repeating one is refused with `409 CATALOG_ID_CONFLICT`
and the clash named. The single exception is the reserved compatibility alias
(`local-active`), which names "whatever this router has marked active" rather
than a service: every machine may carry it, and only the default host publishes
it as a selectable name.

A stored catalog is a file under `CATALOG_STORE_DIR`, one per host, written
atomically. `GET /admin/api/hosts` and the capabilities document report its
revision (a digest of the bytes accepted) and when it was accepted, which is how
a publisher confirms that the copy being served is the copy it sent. A catalog
older than `CATALOG_MAX_AGE_MS` still serves — a machine that stopped publishing
is not a machine that stopped answering — but it carries
`CATALOG_STALE:<host>` so a forgotten runtime is visible instead of merely
stale.

## 4. What a client sees

The capabilities document is `schema_version: 2`. It adds two things, both
present only once a second host publishes:

- `hosts[]` — each machine: `id`, `display_name`, `default`, `published`,
  `available`, `draining`, `drain_reason`, its `configuration`, and `model_ids`.
- `host` on each model — the machine running it.

Everything else is what version 1 clients already read, with the same meaning,
and unknown fields are ignored, so a client written against 1.2 of the contract
keeps working untouched. `/v1/models`, `/api/tags`, `/api/ps` and every
generation route are unchanged: a multi-host deployment is one router with one
model list. `/health` gains `hosts` and `degraded`, and answers from the default
host alone (see §6).

A model's `host` is descriptive. To a client, `nighttime` is a service, and it is
the same service whether the runtime moves it to another machine or keeps it
where it is. That is what makes the split survivable: nothing a client caches has
to survive it.

## 5. Machines fail apart

Each host's catalog is read, validated and reported separately, and one host's
problem never propagates:

| Situation | What the deployment does |
|---|---|
| A host has never published | `published: false`, its models absent, other hosts unaffected. An unnamed request is unaffected. |
| A host's stored catalog is corrupt or unreadable | That host reports `HOST_CATALOG_INVALID`, contributes nothing, and the rest keep serving. |
| A host publishes something invalid at the door | The publication is refused; the previously accepted catalog keeps serving. |
| A host's backend stops answering | That model is `available: false`. The router is `degraded`, not down. |
| The default host stops publishing | `DEFAULT_HOST_UNAVAILABLE` is warned and the first declared host that *is* publishing answers the unnamed request. The router never invents an active model. |
| Every host is broken | `503 INVALID_MODEL_CATALOG`, naming the first publisher's complaint. Nothing is servable and the container is unhealthy. |

Because a client-facing name is never claimed twice, a model that disappears
leaves no ambiguity behind: it is either in `models[]` or it is gone, and
`offline_services[]` or `hosts[].error` says which kind of gone.

## 6. Maintenance, drain, and what "healthy" means

`POST /admin/api/runtime-drain` accepts an optional `host`:

```
{ "enabled": true, "host": "rosalina", "reason": "gpu replacement" }
```

A host drain stops admission for requests whose selected model runs on that
machine, with the same `503 BACKEND_DRAINING` a client already handles; requests
for models running elsewhere continue. `waitForIdle` scoped to a host waits for
that machine's generations only, so a runtime can stop a backend as soon as the
work it was holding finishes, without queueing behind traffic bound for another
machine. Omitting `host` is the whole-router switch it has always been, and is
what a router release of the router itself pulls. Releasing the router does not
release a machine somebody else drained: the two states are independent and
both are persisted, in schema version 2 of the control file, which is still read
by a router that has never heard of hosts.

`/health` stays bound to the default host. The container's health check asks one
question — can this router serve the traffic that arrives unnamed — and a second
machine being switched off is not an answer to it. So `ok` follows the default
host, `degraded` says another machine the deployment advertises is not
contributing, and `hosts[]` says which. `degraded` never turns a healthy
container into a restarting one; it is there so a supervisor and an operator
looking at the same endpoint see the same difference between "working" and
"working with one machine missing".

The health endpoint also stopped repeating the marker back to whoever asked:
upstream URL, model path, mmproj path and GPU identity are location facts about
one machine and they belong in the admin view, where they are actionable, not in
a response every client polls.

## 7. Where the model actually is

A published `backend_url` must be reachable *from the router*, which is a
different requirement from being reachable from the machine running it.
`http://localhost:8080` and `http://127.0.0.1:8080` are the classic mistake:
correct on the publishing machine, wrong after one hop, and the failure surfaces
far from here as an unexplained 503.

Set `ROUTER_EXPECT_ROUTABLE_BACKEND_URLS=true` on a multi-host router and every
published entry whose backend is a loopback address is reported as
`BACKEND_URL_NOT_ROUTABLE:<host>:<address>` — in the publication response, so
the runtime sees it immediately, and in the capabilities warnings. It is reported
and not refused because the publisher may genuinely be running its backend in the
same network namespace as the router, and only the publisher knows which of the
two situations it is in.

The corollary is that a machine publishing models to a router it does not share a
network namespace with has to publish them on the LAN: llama.cpp's HTTP server on
an address the router can reach, with the container port published to that
address. A container-only address (`http://qwen38-daytime:8080`) is reachable
between containers on one host and from nowhere else.

Nothing about this is validated as a fact by the router — it cannot probe the
publisher's firewall — but everything about it is reported.

## 8. Security

The push token is a write credential for one thing: the catalog of one declared
host. It cannot read requests, prompts, or records, and it cannot change drain
state. It is delivered over the admin listener, which is unauthenticated by
convention and therefore must stay on a trusted network, and it is worth using
separately from `ADMIN_TOKEN` precisely so a runtime that is compromised cannot
drive the router.

That separation has a consequence for the producer, because a configuration
switch is not only a publication: the machine has to stop traffic in front of
itself before it reloads, and only the control credential can do that. A runtime
that switches behind this router therefore holds two secrets — the publisher
token for its catalog, and the control token for drain and state. A deployment
that means one trust says so by naming the same variable twice; a deployment
that cares what a compromised machine could do names two, and knows which one
its runtime lost.

Stored catalogs are `0640` in a `0750` directory, owned by the router user. They
are not secrets, but they are one machine's statement about its hardware.

Clients see a model's host name; they do not see its backend URL, its file
paths, or its GPU identity. Host IDs are operational names chosen by the
operator, and the same names appear in the portal and in the drain API, so
publishing them to LAN clients reveals no more than the operator's own naming
does.

## 9. Rolling this out, and back

A deployment with one host takes no new code paths that a single-host deployment
could distinguish: no `hosts` array, no `host` fields, no drain scoping, the same
catalog file read the same way, the same warning names. `CATALOG_STORE_DIR` is
created on first publication, not at startup, so a router that is never pushed to
needs no new directory and no new permissions.

That makes the migration incremental and the rollback a configuration change:

1. Deploy the router on its own instance with `local` as its only host and
   `ACTIVE_MODEL_FILE` pointed at a directory the old runtime can still write.
   Confirm it serves what the old router served.
2. Declare the second machine: `ROUTER_HOSTS=local,<host>`. Nothing else changes
   until that machine publishes.
3. Have the runtime publish its catalog, and watch `GET /admin/api/hosts` report
   it published with the revision it sent.
4. Move clients to the new address, one client at a time; both routers can serve
   the same models throughout.
5. Make the new instance the default (`ROUTER_DEFAULT_HOST`) when the old
   machine's models are only reachable over the network and that is what you
   want unnamed requests to mean.

Rollback is `ROUTER_HOSTS` unset and the old `ACTIVE_MODEL_FILE` handoff: the
catalog store is left alone, and the code that reads it is not reached.

Steps 3 and 4 are somebody else's repository, so each has a handoff written to be
read without this one: [the runtime publishes its catalog](handoffs/2026-10-21-ai-runtime-publisher.md)
for the machine that runs models, and [the router now spans several
machines](handoffs/2026-10-21-multi-host-deployment.md) for each client that sends requests.

## 10. Reference

- Configuration keys: `ROUTER_HOSTS`, `ROUTER_DEFAULT_HOST`, `CATALOG_STORE_DIR`,
  `CATALOG_PUSH_TOKEN`, `CATALOG_MAX_AGE_MS`,
  `ROUTER_EXPECT_ROUTABLE_BACKEND_URLS` — see [CONFIGURATION.md](CONFIGURATION.md).
- Endpoints and payloads: [API.md](API.md#hosts).
- The publisher's side — the definition a machine holds, when it publishes, what each
  answer obliges it to do: [RUNTIME_INTEGRATION.md](RUNTIME_INTEGRATION.md).
- Capabilities document fields: [CAPABILITIES.md](CAPABILITIES.md), and the
  client-facing rules in [CLIENT_CONTRACT.md](CLIENT_CONTRACT.md).
- How the pieces fit together: [ARCHITECTURE.md](ARCHITECTURE.md).
