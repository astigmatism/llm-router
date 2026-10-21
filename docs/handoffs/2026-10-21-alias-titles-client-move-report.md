# Report: the router's half of the picker collision is shipped; one line is still the client's

**To:** the session orchestrating the router move (stages 0–5).
**From:** the `llm-router` session. **Date:** 2026-10-21. **Router release:** `bcece16`, deployed and running on `192.168.1.23`.
**Reads with:** [the alias handoff that started this](2026-10-21-multi-host-deployment.md) and [runtime integration](../RUNTIME_INTEGRATION.md).

Single driver of Rosalina noted; I have not restarted, republished from, or reconfigured anything on her beyond what is written here.

## Status in one line

The household router is serving and Docker-healthy with everything below deployed; the voice box still cannot boot, and the remaining cause is a **label in DSH**, not a field the router still owes.

## What I changed in `llm-router` — all deployed to `192.168.1.23`

| Commit | Change |
|---|---|
| `c61a713` | An alias row in `/v1/models` and `/api/tags` is titled by the alias, not by its model's title. A publisher may state a title for a name in the catalog as `alias_display_names`; a title for a name the entry no longer declares is dropped, not refused. Contract **1.4**: identify a listing row by `id`, never de-duplicate rows by title. |
| `0c059c1` | My own instance file had set `CATALOG_MAX_AGE_MS=3600000` while the documented default is off. The router was warning `CATALOG_STALE:rosalina` on a machine that had published correctly hours earlier; because a warning makes the document incomplete, that was one client verdict away from talking the house out of a working model. Off by default, documented as the heartbeat contract it is. |
| `ba8ebcd` | The capabilities document publishes `metadata.alias_display_names` — a title for every declared name — which is the half that reaches a service-keyed picker. |
| `bcece16` | `scripts/check-client-gate.mjs`: read a router through the client's own plugin. |

**298 tests pass**, including that no two published rows share a title, that the listing and the document derive the same titles, and that the announcement loop still works. `main` is `bcece16`; the checkout on `.23` is at that revision and clean.

## What your handoff could not have seen

Your reproduction was right and the fix you asked for is shipped, but it was not the whole cause. After pointing the voice box at `.23` its gate still failed, so I ran the verifier and read the output:

```
locator.waitFor: Error: strict mode violation: getByRole('menuitemradio', { name: 'Qwen3.8 Flash-Next (256K)', exact: true }) resolved to 2 elements
```

**Two** options, not four. That picker offers one option per **service** and labels it from the capabilities document — where a model appears once — so `daytime` and `nighttime` answering to one model produced two identical labels. It never reads the alias rows. The router cannot fix that alone, because one model legitimately answers two names; what it can do, and now does, is publish the title of each name.

## The one line that is DSH's

Where the option for a service is built, label it with the title of **that name** — `residentCapabilities` does not receive the service, so read it where the service is in scope (a call site using `model.service` gets the wrong name for a second service on the same model):

```js
const title = metadata.alias_display_names?.[service];   // { daytime: 'daytime', nighttime: 'nighttime', … }
const displayName = nonEmptyString(title) ? title
  : nonEmptyString(metadata.display_name) ? metadata.display_name
  : nonEmptyString(model.display_name) ? model.display_name : undefined;
```

`serviceLabel(service)` in the same plugin is the alternative if you would rather the client own the label. Live evidence that the fact is there to be read:

```
daytime    available  ok   "Qwen3.8 Flash-Next (256K)" ctx=261120 slots=1 label-for-service="daytime"
nighttime  available  ok   "Qwen3.8 Flash-Next (256K)" ctx=261120 slots=1 label-for-service="nighttime"
listing: qwen3.8-flash-next-ud-iq4_xs="Qwen3.8 Flash-Next (256K)"  local-active="local-active"  daytime="daytime"  nighttime="nighttime"
duplicate labels a picker would collide on: none
```

Against Rosalina's legacy router the same command still reports three duplicate labels — a correct reading of a router running the old build.

```
node scripts/check-client-gate.mjs --base http://192.168.1.23:11434 \
  --plugin <box>:…/data/dsh/.dsh-plugins/dsh-router-model-discovery.js    # exit 0 = a client can act on it
```

## Evidence the router is stable, taken at 23:0x UTC

- Container `llm-router`: `Up (healthy)`, `RestartCount=0`, started `2026-10-21T22:27:12Z`, health probe `/health` every 30 s, failing streak 0.
- `GET /health` → `ok: true`, `degraded: true` — degraded because Daisy is declared and powered off, which is the deployment being honest, not a fault.
- Real generations, not metadata: `daytime` → `household ok` in 0.67 s; `nighttime` → `stage 4 ready`.
- Capabilities: `complete: false` with `["HOST_CATALOG_UNPUBLISHED:daisy"]` only; `hosts: rosalina,published; daisy,not_published`; no drain held.

## State of the boxes

- **Voice box `192.168.1.22` — pointed at `.23`, still down, and it was down before I touched it** (boot verification failing at 21:37 UTC against `192.168.1.4`). `.env:40` is `REMOTE_OLLAMA_HOST=192.168.1.23`; that line alone did nothing, because the container is created from a **rendered** `data/deployment/compose.json` that still carried `ai-router=192.168.1.4`, so I patched that mapping and recreated the harness: inside the container `ai-router` now resolves `192.168.1.23` and `/health` answers `ok: true`. Their update path re-renders that file, so re-run `scripts/update-and-restart.sh` after the label change lands rather than trusting my patch. Backups: `/tmp/dsh-env.before-router-move`, `/tmp/compose.json.before-router-move`. Its client repo is at `daf7b47`, which does not yet read `alias_display_names`.
- **Pauline `192.168.1.7` — untouched.** Its move is one `extra_hosts` line plus a restart that interrupts the session doing it; I would rather schedule that than spring it.
- **Rosalina `192.168.1.4`** — her router still runs the pre-multi-host build, so it will keep reporting duplicate labels until stage 5 stops it. Her publication is current, no drain, no warnings.
- **Daisy** — declared and off, which is the topology you described. Worth an explicit decision from you: her absence makes the document `complete: false`, and any client that gates on `complete` will read a switched-off machine as an untrustworthy deployment. Keeping the warning is honest; whether it should clear `complete` is a contract question, not a bug.

## Suggested order from here

1. DSH label line; then the voice box's `verify-resident-client.mjs` passes on `.23` and its boot unit stops looping. I can verify with the command above before touching that box again.
2. Their `update-and-restart.sh` on the voice box, so the rendered compose comes from their renderer rather than my patch.
3. Pauline, at a time you choose.
4. Stage 5 tomorrow: drop `router_state_dir` from Rosalina's `host.json` and stop her router. Agreed that `runtime retire` is not part of it — retiring a runtime is not retiring a router.

If any of the above disagrees with what you observe, the router's side is reproducible: `scripts/check-client-gate.mjs` against `192.168.1.23` prints exactly what a client would conclude, plugin included.
