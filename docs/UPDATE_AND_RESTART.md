# Update and restart (Service Portal)

`scripts/update-and-restart.sh` is the script the Service Portal runs for the
**Update and restart** button on the `llm-router` card, and for the update-check
badge next to it. This file documents the contract from both sides: what the
portal promises, what the script guarantees, and what an operator has to do once
on the router host.

Related: [DEPLOYMENT_HANDOFF.md](DEPLOYMENT_HANDOFF.md) for what the router is,
[MULTI_HOST.md](MULTI_HOST.md) for the fleet the router serves, and
`scripts/deploy-router-instance.sh` for the deploy path this script wraps.

## One-time prerequisite on the router host

The router image is `node:22-bookworm-slim` plus the app: no git, no Docker CLI,
so it cannot run its own update. The portal runs the script inside the image
named by `io.service-portal.update.image`, and that image has to exist locally
before the portal will run anything.

`service-portal:latest` (the portal's own image) is on the router host and
already carries git 2.47, the Docker CLI 26.1, Compose 2.26, openssh-client, wget,
`bash` and the CA certificates an anonymous HTTPS fetch needs — but no `python3`,
no `curl`, and **no Buildx**, which a Compose build wants. `Dockerfile.updater`
adds exactly that:

```sh
cd ~/deployments/llm-router/source
docker build -f Dockerfile.updater -t llm-router-updater:latest .
```

Build it once; it is never pulled. Then either export
`ROUTER_UPDATER_IMAGE=llm-router-updater:latest` where Compose is invoked (the
credentials env file is a fine place, since Compose reads it as `env_file`… but
**interpolation of the labels comes from the environment**, so put it in the
environment of whatever runs `docker compose`), or leave the label default and
let the update run in `service-portal:latest` without Buildx. Both work today:
Compose 2.26 against a recent engine builds through the daemon without a local
Buildx. With Buildx present the build is reproducible in the usual way and does
not depend on that fallback.

## Compose change to make (the block to paste)

Add this to `services.ai-router` in `compose.vm-example.yml`, replacing the
existing two-line `build:` mapping. It is **not** applied in this repository: the
labels take effect on the router host, where the checkout is deployment-only.

```yaml
    build:
      context: .
      args:
        # The Dockerfile records this as org.opencontainers.image.revision, which
        # is how an update check knows what is actually running. Exported by
        # scripts/update-and-restart.sh; `unknown` keeps the old behaviour for a
        # build started by hand.
        VCS_REF: "${SOURCE_REVISION:-unknown}"
    labels:
      io.service-portal.update.enabled: "true"
      io.service-portal.update.script: "scripts/update-and-restart.sh"
      io.service-portal.update.image: "${ROUTER_UPDATER_IMAGE:-service-portal:latest}"
      io.service-portal.update.user: "1000:1000"
      io.service-portal.update.check: "true"
      io.service-portal.url: "${ROUTER_PORTAL_URL:-http://192.168.1.23:11435}"
```

Notes for whoever pastes it:

* `build.args` is what makes the badge truthful. Without it the image label stays
  `unknown`, the portal sends an empty `SERVICE_PORTAL_DEPLOYED_REVISION`, and the
  check falls back to comparing against the checkout (it says so in a note).
* `io.service-portal.update.image` must name an image that already exists on that
  host, or the portal refuses the action. The default keeps the labels usable
  before `Dockerfile.updater` has been built.
* `io.service-portal.url` must be an absolute `http(s)` URL; it is the card's link
  to the admin portal.
* Optionally add `io.service-portal.lifecycle.services: "ai-router"` to the same
  block. That opts the project into the portal's start/stop controls as well; the
  update button works without it.
* The container has to be recreated once after the labels land
  (`bash scripts/deploy-router-instance.sh`, or this very script) before the
  portal sees the card at all.

## What the portal does

All of this is the portal's side of the contract
(`service-portal/server.js`: `updateCapability()`, `maintenanceRunnerSpec()`,
`parseUpdateCheckOutput()`):

* The capability exists because of the labels. The project has to be a Compose
  project (`com.docker.compose.project`, here `llm-router`) with an absolute
  working directory.
* For an update the portal creates a runner container with
  `Entrypoint = [<projectDir>/scripts/update-and-restart.sh]`, `Cmd = []`,
  `WorkingDir = <projectDir>`, `Init: true`, `User = 1000:1000` plus the socket
  group, and **exactly two binds**: the Compose project directory and
  `/var/run/docker.sock`. Environment includes `HOME=/tmp`,
  `SERVICE_PORTAL_UPDATE_DELEGATED=1` and `SERVICE_PORTAL_UPDATE_JOB_ID=<uuid>`.
* For a badge check the same container runs with `Cmd = ["check"]` and one more
  variable, `SERVICE_PORTAL_DEPLOYED_REVISION` — the running container's
  `org.opencontainers.image.revision`, or empty when it is absent or `unknown`.
* Exit code 0 is success. stdout and stderr are captured (last 128 KiB), and the
  one-line failure the UI shows is the first line matching
  `/error|fatal|failed|refusing/i` — which is why every failure path in the script
  prints a line starting with `Error: `.
* The portal never runs `docker compose` itself. The script builds and replaces.

For this deployment the Compose project directory **is** the checkout
(`~/deployments/llm-router/source`), and its `working_dir` is absolute, which is
what the portal requires.

## Two stages, because the runner cannot see the deployment

The runner mounts the checkout and the socket. It does not mount
`~/deployments/llm-router/{data,runtime}` (where Compose puts the catalog store
and the drain control file) and it does not mount
`~/credentials/llm-router/router.env`, which the Compose file reads as `env_file`.
So a bare update runs in two stages, the pattern already used by `playroom` and
`deepseek-harness` on this machine:

1. **Stage 1** — this script, inside the portal runner. It starts a sibling
   maintenance container with `docker run` (the daemon resolves the bind sources
   as *host* paths, which is why they are passed at their own absolute paths),
   binding the checkout, `~/deployments/llm-router`, `~/credentials/llm-router`
   read-only and the socket, as the same uid with the socket group, on the host
   network, labelled `io.service-portal.maintenance=true` and
   `io.service-portal.maintenance.job=$SERVICE_PORTAL_UPDATE_JOB_ID` so the
   portal can see it, and re-runs this same script with the same arguments and
   `LLM_ROUTER_MAINTENANCE_RUNNER=1`.
2. **Stage 2** — this script, inside that container: fast-forward, drain, build,
   replace, gate on health.

A `check` never needs stage 2 (git and one HTTPS fetch), and running the script
by hand on the router host needs neither stage. That is also why the script takes
its lock only after stage 1: stage 2 has to be able to take it.

## What an update does, in order

1. `mkdir .git/llm-router-update.lock`; `EXIT`/`HUP`/`INT`/`TERM` traps release
   it. A held lock reports `Error: another update is in progress` immediately —
   it never waits — and a lock older than `ROUTER_UPDATE_LOCK_STALE_AFTER`
   (default 3600 s) is treated as a crashed run and dropped.
2. Refuse unless: `HEAD` is on `main`, `branch.main.remote=origin`,
   `branch.main.merge=refs/heads/main`, the origin is one of the
   `astigmatism/llm-router` GitHub URLs (or `ROUTER_UPDATE_ALLOWED_ORIGIN`), and
   `git status --porcelain` is empty. A dirty checkout is refused; nothing is ever
   stashed, checked out or reset — this script never touches the tree, and the
   installer it calls does `git reset --hard origin/main`, so refusing an edit
   made on the deployment host is what keeps that edit from disappearing.
3. `git fetch --prune origin main` (HTTPS; a `git@` origin is rewritten to HTTPS
   with a one-off config because the router host has no SSH keys and the
   repository is public). `GIT_TERMINAL_PROMPT=0` turns a credential prompt into
   a fast failure instead of a hung check.
4. Only a fast-forward. `origin/main` behind `HEAD` is fine: this script deploys
   the committed local HEAD and says so. A rewritten history is
   `Error: refusing a divergent or rewritten origin/main history.` and exit 1.
   (This checkout is deployment-only, and the installer it calls does follow
   `origin/main`, so a local commit that was never pushed is not something an
   update is expected to preserve — it is a mistake to fix by pushing it.)
5. `SOURCE_REVISION=<deployed commit>` is exported, so `build.args` above records
   it in the new image.
6. The deployed configuration is read back from the **running container**:
   `ROUTER_HOSTS` and `ROUTER_DEFAULT_HOST` from its environment, and the
   published addresses from its port bindings (`ROUTER_BIND_IP` is a Compose
   mapping, not container environment).
   `compose.vm-example.yml` defaults `ROUTER_HOSTS` to `local,rosalina` while
   this router runs `rosalina,daisy`, so an update that let Compose fall back to
   the file would silently un-declare `daisy`, and its catalog pushes would start
   failing with `HOST_NOT_DECLARED`. The values are always passed through
   explicitly; the file's defaults are used only when nothing is running.
7. Drain, best effort: `POST http://<bind>:11435/admin/api/runtime-drain` with
   `{"enabled":true,"reason":"update"}` — the field the router validates is
   `enabled`, not `draining` — with `authorization: Bearer $ADMIN_TOKEN` from the
   env file, then poll `GET /admin/api/summary` until `runtime.active_count` and
   `queued_count` are 0, for at most `ROUTER_UPDATE_DRAIN_WAIT` (default 120 s).
   A router that will not answer, or a token that does not match, is a note and
   not a failure. In-flight generations are dropped when the container is
   replaced; DSH agent sessions on the LAN go through this router.
8. `docker compose -p llm-router -f compose.vm-example.yml config --quiet`, then
   `scripts/deploy-router-instance.sh` with `BIND_IP`, `BASE`, `ENV_FILE`,
   `COMPOSE_FILE`, `REV`, `ROUTER_HOSTS`, `ROUTER_DEFAULT_HOST` and
   `SOURCE_REVISION` all explicit (the installer's own defaults describe a first
   install, not this deployment). That path builds and runs
   `up -d --pull never --no-build`, so what runs is what is committed.
9. Health gate: `up -d --wait --wait-timeout <ROUTER_UPDATE_HEALTH_WAIT>`, then
   `GET http://<bind>:11434/health` with wget until it answers. The container's
   own health check follows the *default host's* backend, so a machine that is
   down for other reasons must not fail this update: the authoritative gate is
   that the router itself answers, and an `"ok":false` answer is reported as a
   note. No answer at all within the window is `Error: the updated router is not
   answering …` and exit 1.
10. The drain is cleared — including on every failure path after step 7, so a
    failed update never leaves the router refusing traffic.
11. `docker compose ps`, then `Update complete: <old sha> -> <new sha>`.

Never `docker compose down`, never a prune, never a write inside `data/` or
`runtime/`.

## The update check (the badge)

`scripts/update-and-restart.sh check` is read-only apart from `git fetch` and the
lock, and finishes in seconds (the portal allows 120 s and runs a check at most
every ~15 minutes per project). stdout is the protocol; the last summary line
wins, which is why the summary is printed last:

```
service-portal-check-note: <text>
service-portal-check-commit: <sha> <ISO-8601 committer date> <subject>   # 0-10, newest first
service-portal-check: status=<current|available> behind=<n|unknown> deployed=<sha|unknown> target=<sha|unknown>
```

`status` must be `current` or `available`; anything else, a non-zero exit, no
summary line, or a timeout is a failed check. A `deployed` revision the checkout
does not contain reports `behind=unknown` with a note rather than guessing.
Because the deployed image currently records `unknown`, the check says

```
service-portal-check-note: The running image does not record its source revision; compared with the checkout HEAD.
```

and compares `origin/main` with the checkout — the same fallback `playroom` uses.
Add the `build.args` block above and the note goes away.

## Running it by hand, and the knobs

```sh
ssh local-ai-router
cd ~/deployments/llm-router/source
sh scripts/update-and-restart.sh check     # what the badge says
sh scripts/update-and-restart.sh           # the same update the button runs
```

On the host neither stage-1 handoff nor the delegated flag is involved: the
script does the work where it runs. `--pull never` semantics and the
`-p llm-router` project name are the same as the manual deploy command.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROUTER_DEPLOYMENT_BASE` | parent of the checkout | host directory holding `data/` and `runtime/` |
| `ROUTER_CREDENTIALS_DIR` | `<host home>/credentials/llm-router` | host directory holding `router.env` |
| `ROUTER_COMPOSE_FILE` | `<checkout>/compose.vm-example.yml` | compose file to deploy |
| `ROUTER_COMPOSE_PROJECT` | `llm-router` | compose project name |
| `ROUTER_CONTAINER_NAME` | `llm-router` | the running router container to inspect |
| `ROUTER_UPDATER_IMAGE` | `service-portal:latest` | image for the stage 2 container when the running container records none |
| `ROUTER_UPDATE_SOCKET` | `/var/run/docker.sock` | socket handed to the stage 2 container |
| `ROUTER_UPDATE_DRAIN_WAIT` | `120` | seconds to wait for in-flight work (`0` skips the drain) |
| `ROUTER_UPDATE_HEALTH_WAIT` | `120` | seconds to wait for the router to answer (`0` skips the gate) |
| `ROUTER_UPDATE_FETCH_TIMEOUT` | `45` | timeout for the single `git fetch` |
| `ROUTER_UPDATE_LOCK_STALE_AFTER` | `3600` | when a lock may be assumed to be from a dead run |
| `ROUTER_UPDATE_ALLOWED_ORIGIN` | — | accept one more origin URL, e.g. a mirror |

The first two are derived from the checkout path (`…/deployments/llm-router/source`
→ host home two levels above the deployment directory). A checkout anywhere else
needs them set explicitly, or the update runs against the wrong state directory.

## Tests

`test/update-check.test.js` drives the script as a child process against a
throwaway git repository with a local-path origin, with `docker`, `wget` and
`bash` replaced by PATH shims: no network, no Docker daemon. It covers the badge
protocol (`current`, `behind=2` with its commit lines, both fallback notes), the
refusals (dirty tree, divergent history, unknown arguments, a held lock and a
stale one), the fleet pass-through, `SOURCE_REVISION`, the drain request body and
its clearing on the failure path, and the stage 1 `docker run` spec (binds,
labels, image, host network).

```sh
node --test test/update-check.test.js
```
