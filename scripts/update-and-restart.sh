#!/bin/sh
# Service Portal "Update and restart" for the LLM router.
#
#   no argument  update the deployment checkout and restart the router
#   check         read-only update check that prints the Service Portal badge
#                 protocol (anything else is refused before any work is done)
#
# This script is the file named by `io.service-portal.update.script`, so the
# portal executes it inside a detached runner built from
# `io.service-portal.update.image`. That runner mounts exactly two things - the
# Compose project directory (which for this deployment IS the checkout,
# ~/deployments/llm-router/source) and the Docker socket - so it cannot see the
# deployment state directories or ~/credentials/llm-router/router.env, and the
# portal never runs `docker compose` itself. A bare update therefore runs in two
# stages, following the pattern used by the playroom and deepseek-harness
# deployments on this machine:
#
#   stage 1  this file, inside the portal runner: starts a sibling maintenance
#            container that binds the host paths stage 2 actually needs.
#   stage 2  this same file, inside that container (LLM_ROUTER_MAINTENANCE_RUNNER=1):
#            fast-forwards the checkout and runs the blessed deploy path,
#            scripts/deploy-router-instance.sh.
#
# A `check` never needs stage 2: it is git and one HTTPS fetch, and it runs
# where the portal started it. Running the script by hand on the router host
# also skips stage 1 - everything it needs is already there.
#
# What an update never does: `git checkout`/`reset --hard`/`stash` in the
# update path (a dirty or rewritten checkout is refused instead), `docker
# compose down`, any prune, and any write to the state directories beside the
# checkout. It also never lets the declared fleet shrink: ROUTER_HOSTS and
# ROUTER_DEFAULT_HOST are read back from the running container and passed
# through explicitly, because compose.vm-example.yml defaults them to
# `local,rosalina` while this router actually serves `rosalina,daisy`, and a
# machine that stops being declared refuses its catalog with HOST_NOT_DECLARED.
#
# Tunables (all optional, documented in docs/UPDATE_AND_RESTART.md):
#   ROUTER_DEPLOYMENT_BASE  host directory holding data/ and runtime/  (default: parent of the checkout)
#   ROUTER_CREDENTIALS_DIR  host directory with router.env             (default: <host home>/credentials/llm-router)
#   ROUTER_COMPOSE_FILE     compose file to deploy                     (default: <checkout>/compose.vm-example.yml)
#   ROUTER_COMPOSE_PROJECT  compose project name                       (default: llm-router)
#   ROUTER_CONTAINER_NAME   the running router container               (default: llm-router)
#   ROUTER_UPDATER_IMAGE    image for the stage 2 container            (default: service-portal:latest)
#   ROUTER_UPDATE_DRAIN_WAIT   seconds to wait for in-flight work to settle (default: 120, 0 skips the drain)
#   ROUTER_UPDATE_HEALTH_WAIT  seconds to wait for the router to answer     (default: 120, 0 skips the gate)
#   ROUTER_UPDATE_FETCH_TIMEOUT seconds for one `git fetch`                 (default: 45)
#   ROUTER_UPDATE_SOCKET        docker socket to hand the container         (default: /var/run/docker.sock)
#   ROUTER_UPDATE_ALLOWED_ORIGIN  extra origin URL accepted besides the GitHub ones
set -eu

mode=update
case "$#:${1:-}" in
  0:) ;;
  1:check) mode=check ;;
  *) printf '%s\n' 'Error: usage: update-and-restart.sh [check]' >&2; exit 2 ;;
esac

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
script_file=$source_dir/scripts/update-and-restart.sh
project_dir=$(pwd)
deployment_base=${ROUTER_DEPLOYMENT_BASE:-$(dirname -- "$source_dir")}
host_home=${ROUTER_HOST_HOME:-$(dirname -- "$(dirname -- "$deployment_base")")}
credentials_dir=${ROUTER_CREDENTIALS_DIR:-$host_home/credentials/llm-router}
env_file=${ROUTER_ENV_FILE:-$credentials_dir/router.env}
compose_file=${ROUTER_COMPOSE_FILE:-$source_dir/compose.vm-example.yml}
compose_project=${ROUTER_COMPOSE_PROJECT:-llm-router}
container_name=${ROUTER_CONTAINER_NAME:-llm-router}
deploy_script=$source_dir/scripts/deploy-router-instance.sh
updater_image=${ROUTER_UPDATER_IMAGE:-service-portal:latest}
socket=${ROUTER_UPDATE_SOCKET:-/var/run/docker.sock}
lock_dir=$source_dir/.git/llm-router-update.lock

drain_wait=${ROUTER_UPDATE_DRAIN_WAIT:-120}
health_wait=${ROUTER_UPDATE_HEALTH_WAIT:-120}
fetch_timeout=${ROUTER_UPDATE_FETCH_TIMEOUT:-45}
# A checkout older than this has no live owner: an update is a handful of
# minutes, so a lock that old is a crashed run, and a lock must never mean
# "the button is broken until someone logs in".
lock_stale_after=${ROUTER_UPDATE_LOCK_STALE_AFTER:-3600}
# A typo in a knob must not turn into a comparison error in the middle of a
# release, let alone a `[ -gt ]` against an empty string.
case "$drain_wait" in '' | *[!0-9]*) drain_wait=120 ;; esac
case "$health_wait" in '' | *[!0-9]*) health_wait=120 ;; esac
case "$fetch_timeout" in '' | *[!0-9]*) fetch_timeout=45 ;; esac
case "$lock_stale_after" in '' | *[!0-9]*) lock_stale_after=3600 ;; esac

say() { printf '%s\n' "$*"; }
fail() { printf '%s\n' 'Error: '"$1" >&2; exit 1; }
note() { printf '%s\n' 'note: '"$1"; }

# ---------------------------------------------------------------------------
# Stage 1: hand the update to a container that can see the whole deployment.
# Deliberately before the lock - stage 2 takes it.
# ---------------------------------------------------------------------------
if [ "$mode" = update ] &&
   [ "${SERVICE_PORTAL_UPDATE_DELEGATED:-0}" = 1 ] &&
   [ "${LLM_ROUTER_MAINTENANCE_RUNNER:-0}" != 1 ]; then
  command -v docker >/dev/null 2>&1 || fail 'docker is not installed or is not on PATH.'
  [ -S "$socket" ] || fail "the Docker socket $socket is not mounted in the update runner."
  # The runner mounts only the checkout and the socket, so these two host paths
  # cannot be tested from here: the daemon resolves them when the sibling
  # container starts, and that is where a wrong one is reported.
  case "$deployment_base" in /*) ;; *) fail "ROUTER_DEPLOYMENT_BASE must be an absolute host path; got $deployment_base." ;; esac
  case "$credentials_dir" in /*) ;; *) fail "ROUTER_CREDENTIALS_DIR must be an absolute host path; got $credentials_dir." ;; esac
  # Prefer the image the running router records for updates; it is the one the
  # portal is configured with.
  image=$(docker inspect --format '{{index .Config.Labels "io.service-portal.update.image"}}' "$container_name" 2>/dev/null || true)
  case "$image" in '' | '<no value>' | *'{'*) image=$updater_image ;; esac
  job=${SERVICE_PORTAL_UPDATE_JOB_ID:-manual-$(date +%s)-$$}
  case "$job" in '' | *[!A-Za-z0-9_.-]*) fail 'invalid update job identifier.' ;; esac
  gid=$(stat -c '%g' "$socket" 2>/dev/null || printf '0')
  [ -n "$gid" ] || gid=0
  # `--network=host` so stage 2 can reach the published router ports: they are
  # bound to ROUTER_BIND_IP, not to the container's loopback, and the drain and
  # health endpoints below are how the update is gated.
  exec docker run --rm --init --sig-proxy=false --pull=never \
    --network=host \
    --name "llm-router-update-$job" \
    --label io.service-portal.maintenance=true \
    --label "io.service-portal.maintenance.job=$job" \
    --user "$(id -u):$(id -g)" --group-add "$gid" \
    --mount "type=bind,source=$source_dir,target=$source_dir" \
    --mount "type=bind,source=$deployment_base,target=$deployment_base" \
    --mount "type=bind,source=$credentials_dir,target=$credentials_dir,readonly" \
    --mount "type=bind,source=$socket,target=$socket" \
    --env HOME=/tmp --env DOCKER_CONFIG=/tmp/docker-config \
    --env SERVICE_PORTAL_UPDATE_DELEGATED=1 \
    --env LLM_ROUTER_MAINTENANCE_RUNNER=1 \
    --env "SERVICE_PORTAL_UPDATE_JOB_ID=$job" \
    --env "SERVICE_PORTAL_DEPLOYED_REVISION=${SERVICE_PORTAL_DEPLOYED_REVISION:-}" \
    --env "ROUTER_DEPLOYMENT_BASE=$deployment_base" \
    --env "ROUTER_CREDENTIALS_DIR=$credentials_dir" \
    --env "ROUTER_COMPOSE_FILE=$compose_file" \
    --env "ROUTER_COMPOSE_PROJECT=$compose_project" \
    --env "ROUTER_CONTAINER_NAME=$container_name" \
    --env "ROUTER_UPDATE_ALLOWED_ORIGIN=${ROUTER_UPDATE_ALLOWED_ORIGIN:-}" \
    --workdir "$source_dir" --entrypoint /bin/sh \
    "$image" "$script_file" "$@"
fi

# ---------------------------------------------------------------------------
# The checkout and its lock.
# ---------------------------------------------------------------------------
[ -d "$source_dir/.git" ] || fail 'the source checkout is not a git repository.'

cleanup() {
  rmdir "$lock_dir" 2>/dev/null || true
}
if ! mkdir "$lock_dir" 2>/dev/null; then
  # Never wait: report, unless the lock is provably from a run that died.
  created=$(stat -c '%Y' "$lock_dir" 2>/dev/null || printf '0')
  now=$(date +%s 2>/dev/null || printf '0')
  if [ "$created" != 0 ] && [ $((now - created)) -gt "$lock_stale_after" ]; then
    say 'Dropping an update lock older than '"$lock_stale_after"'s left by a run that did not finish.'
    rmdir "$lock_dir" 2>/dev/null || true
    mkdir "$lock_dir" 2>/dev/null ||
      fail 'another update is in progress.'
  else
    fail 'another update is in progress.'
  fi
fi
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

command -v git >/dev/null 2>&1 || fail 'git is not installed or is not on PATH.'

git_repo() {
  git -c "safe.directory=$source_dir" -C "$source_dir" "$@"
}

# ---------------------------------------------------------------------------
# Guard the history before touching anything.
# ---------------------------------------------------------------------------
branch=$(git_repo symbolic-ref --quiet --short HEAD 2>/dev/null || true)
[ "$branch" = main ] || fail "maintenance requires the main branch; found ${branch:-detached HEAD}."
remote=$(git_repo config --get branch.main.remote 2>/dev/null || true)
merge_ref=$(git_repo config --get branch.main.merge 2>/dev/null || true)
{ [ "$remote" = origin ] && [ "$merge_ref" = refs/heads/main ]; } ||
  fail 'main must track origin/main.'
origin_url=$(git_repo remote get-url origin 2>/dev/null || true)
origin_ok=0
case "$origin_url" in
  git@github.com:astigmatism/llm-router.git | \
  git@github.com:astigmatism/llm-router | \
  https://github.com/astigmatism/llm-router.git | \
  https://github.com/astigmatism/llm-router) origin_ok=1 ;;
esac
if [ "$origin_ok" != 1 ] && [ -n "${ROUTER_UPDATE_ALLOWED_ORIGIN:-}" ] &&
   [ "$origin_url" = "$ROUTER_UPDATE_ALLOWED_ORIGIN" ]; then
  origin_ok=1
fi
[ "$origin_ok" = 1 ] || fail "refusing unexpected origin ${origin_url:-none}."

dirty=$(git_repo status --porcelain)
if [ -n "$dirty" ]; then
  printf '%s\n' 'Error: refusing to update a checkout with uncommitted changes:' >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

before_commit=$(git_repo rev-parse HEAD)
say 'Fetching origin/main; the running router keeps serving...'
# No SSH credentials are configured on the router host and the repository is
# publicly readable, so an SSH origin is fetched over HTTPS. Exporting it as a
# one-off config keeps the rewrite on every git call, including the ones made
# by scripts/deploy-router-instance.sh. GIT_TERMINAL_PROMPT makes a credential
# prompt a fast failure instead of a hung 120-second check.
export GIT_TERMINAL_PROMPT=0
if [ -z "${GIT_SSH_COMMAND:-}" ]; then
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf'
  export GIT_CONFIG_VALUE_0='git@github.com:'
fi
if [ "$mode" = update ]; then
  say "checkout $before_commit"
fi
if command -v timeout >/dev/null 2>&1; then
  run_fetch() { timeout "$fetch_timeout" git -c "safe.directory=$source_dir" -C "$source_dir" fetch --prune origin main; }
else
  run_fetch() { git -c "safe.directory=$source_dir" -C "$source_dir" fetch --prune origin main; }
fi
run_fetch || fail 'could not fetch origin/main; the router keeps running on what it has.'
target_commit=$(git_repo rev-parse FETCH_HEAD)
# What an update would deploy: origin/main when it fast-forwards the checkout,
# or the committed local HEAD when the checkout is ahead of origin.
deploy_target=$before_commit
ahead=
if [ "$before_commit" = "$target_commit" ]; then
  :
elif git_repo merge-base --is-ancestor "$before_commit" "$target_commit"; then
  deploy_target=$target_commit
elif git_repo merge-base --is-ancestor "$target_commit" "$before_commit"; then
  ahead=1
else
  fail 'refusing a divergent or rewritten origin/main history.'
fi

# ---------------------------------------------------------------------------
# check: report and leave. Read-only apart from the fetch and the lock above.
# ---------------------------------------------------------------------------
if [ "$mode" = check ]; then
  [ -z "$ahead" ] ||
    say 'service-portal-check-note: Local main is ahead of origin/main; an update deploys the committed local HEAD.'
  deployed=${SERVICE_PORTAL_DEPLOYED_REVISION:-}
  if [ -z "$deployed" ]; then
    # The router image is built with VCS_REF=unknown until the compose file
    # passes SOURCE_REVISION, so compare against the checkout instead.
    say 'service-portal-check-note: The running image does not record its source revision; compared with the checkout HEAD.'
    deployed=$before_commit
  elif git_repo cat-file -e "$deployed^{commit}" 2>/dev/null; then
    deployed=$(git_repo rev-parse "$deployed^{commit}")
  else
    say 'service-portal-check-note: The running revision is not in this checkout.'
    printf 'service-portal-check: status=available behind=unknown deployed=unknown target=%s\n' "$deploy_target"
    exit 0
  fi
  if [ "$deployed" = "$deploy_target" ]; then
    printf 'service-portal-check: status=current behind=0 deployed=%s target=%s\n' "$deployed" "$deploy_target"
  elif git_repo merge-base --is-ancestor "$deployed" "$deploy_target"; then
    behind=$(git_repo rev-list --count "$deployed..$deploy_target")
    git_repo log -n 10 --format='service-portal-check-commit: %H %cI %s' "$deployed..$deploy_target"
    printf 'service-portal-check: status=available behind=%s deployed=%s target=%s\n' "$behind" "$deployed" "$deploy_target"
  else
    say 'service-portal-check-note: The running revision is not an ancestor of the update target.'
    printf 'service-portal-check: status=available behind=unknown deployed=%s target=%s\n' "$deployed" "$deploy_target"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# update: fast-forward the checkout.
# ---------------------------------------------------------------------------
if [ "$mode" = update ] && [ "${SERVICE_PORTAL_UPDATE_DELEGATED:-0}" = 1 ] &&
   [ "${LLM_ROUTER_MAINTENANCE_RUNNER:-0}" != 1 ]; then
  # Unreachable: stage 1 execs above. Guards against a future edit quietly
  # running compose inside the portal runner.
  fail 'the update did not hand off to the maintenance container.'
fi

command -v docker >/dev/null 2>&1 || fail 'docker is not installed or is not on PATH.'
docker compose version >/dev/null 2>&1 || fail 'the Docker Compose plugin is unavailable.'
[ -f "$deploy_script" ] || fail "$deploy_script was not found in the updated checkout."

deployed_commit=$before_commit
if [ "$deploy_target" != "$before_commit" ]; then
  say 'Fast-forwarding the deployment checkout to the update target...'
  git_repo merge --ff-only "$deploy_target"
  deployed_commit=$deploy_target
elif [ -n "$ahead" ]; then
  say 'Local main is ahead of origin/main; the deployment checkout follows origin/main.'
fi
# Recorded in the image as org.opencontainers.image.revision (the Dockerfile's
# ARG VCS_REF) so the next update check compares against what actually runs.
SOURCE_REVISION=$deployed_commit
export SOURCE_REVISION

# ---------------------------------------------------------------------------
# Read the deployed configuration back from the running container. Compose
# interpolates these, so an update that did not pass them through would deploy
# the file's defaults: a different fleet, and different host paths.
# ---------------------------------------------------------------------------
deployed_env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_name" 2>/dev/null || true)
read_out() {
  # $1 = environment variable name, $2 = fallback when it cannot be read.
  found=$(printf '%s\n' "$deployed_env" | sed -n "s|^$1=||p" | head -n 1)
  if [ -n "$found" ]; then
    printf '%s' "$found"
  else
    printf '%s' "$2"
  fi
}
router_hosts=$(read_out ROUTER_HOSTS "${ROUTER_HOSTS:-rosalina,daisy}")
router_default_host=$(read_out ROUTER_DEFAULT_HOST "${ROUTER_DEFAULT_HOST:-rosalina}")
[ -n "$router_hosts" ] || router_hosts=rosalina,daisy
[ -n "$router_default_host" ] || router_default_host=rosalina
if printf '%s\n' "$deployed_env" | grep -q '^ROUTER_HOSTS='; then
  say "keeping the deployed fleet: ROUTER_HOSTS=$router_hosts ROUTER_DEFAULT_HOST=$router_default_host"
else
  note "the running container did not report its fleet; deploying $router_hosts with default $router_default_host."
fi

# The published addresses: ROUTER_BIND_IP is a Compose port mapping, not
# container environment, and the ports are bound to it rather than to the
# loopback the container can reach.
api_binding=$(docker inspect --format '{{with (index .HostConfig.PortBindings "11434/tcp")}}{{with (index . 0)}}{{.HostIp}} {{.HostPort}}{{end}}{{end}}' "$container_name" 2>/dev/null || true)
admin_binding=$(docker inspect --format '{{with (index .HostConfig.PortBindings "11435/tcp")}}{{with (index . 0)}}{{.HostIp}} {{.HostPort}}{{end}}{{end}}' "$container_name" 2>/dev/null || true)
bind_ip=${api_binding%% *}
case "$bind_ip" in '' | 0.0.0.0 | '::' | '<no value>') bind_ip=${ROUTER_BIND_IP:-192.168.1.23} ;; esac
api_port=${api_binding##* }
case "$api_port" in '' | *[!0-9]*) api_port=11434 ;; esac
admin_ip=${admin_binding%% *}
case "$admin_ip" in '' | 0.0.0.0 | '::' | '<no value>') admin_ip=$bind_ip ;; esac
admin_port=${admin_binding##* }
case "$admin_port" in '' | *[!0-9]*) admin_port=11435 ;; esac
api_base=http://$bind_ip:$api_port
admin_base=http://$admin_ip:$admin_port
say "router api $api_base  portal $admin_base"

admin_token=''
if [ -r "$env_file" ]; then
  admin_token=$(sed -n 's|^ADMIN_TOKEN=||p' "$env_file" 2>/dev/null | head -n 1 | tr -d '\r"')
fi

# ---------------------------------------------------------------------------
# Drain. Every DSH agent session on the LAN routes through this process, so
# give in-flight generations a chance to finish. None of it is fatal: a router
# that will not answer, or an admin token that does not match, must not stop
# the release.
# ---------------------------------------------------------------------------
http_get() {
  wget -q -O- --timeout=10 --tries=1 "$1" 2>/dev/null || true
}
http_post_drain() {
  # $1 = true|false. The route is POST /admin/api/runtime-drain and the field
  # the router validates is `enabled` (src/server.js); `draining` is what the
  # response calls it.
  if [ -n "$admin_token" ]; then
    wget -q -O- --timeout=10 --tries=1 \
      --header='content-type: application/json' \
      --header="authorization: Bearer $admin_token" \
      --post-data="{\"enabled\":$1,\"reason\":\"update\"}" \
      "$admin_base/admin/api/runtime-drain" 2>/dev/null
  else
    wget -q -O- --timeout=10 --tries=1 \
      --header='content-type: application/json' \
      --post-data="{\"enabled\":$1,\"reason\":\"update\"}" \
      "$admin_base/admin/api/runtime-drain" 2>/dev/null
  fi
}

drained=0
clear_drain() {
  [ "$drained" = 1 ] || return 0
  drained=0
  if http_post_drain false >/dev/null 2>&1; then
    say 'Drain cleared; the router is accepting requests again.'
  else
    note 'the drain could not be cleared automatically: check the runtime panel and release it if requests start failing.'
  fi
}

if [ "$drain_wait" -gt 0 ]; then
  if http_post_drain true >/dev/null 2>&1; then
    drained=1
    say 'Draining: waiting for in-flight generations to finish (up to '"$drain_wait"'s)...'
    waited=0
    while [ "$waited" -lt "$drain_wait" ]; do
      summary=$(http_get "$admin_base/admin/api/summary")
      [ -n "$summary" ] || break
      active=$(printf '%s' "$summary" | sed -n 's/.*"active_count":\([0-9]*\).*/\1/p' | head -n 1)
      queued=$(printf '%s' "$summary" | sed -n 's/.*"queued_count":\([0-9]*\).*/\1/p' | head -n 1)
      if [ "${active:-1}" = 0 ] && [ "${queued:-1}" = 0 ]; then
        say 'Nothing in flight.'
        break
      fi
      sleep 5
      waited=$((waited + 5))
    done
    [ "$waited" -lt "$drain_wait" ] ||
      note 'in-flight work did not settle within '"$drain_wait"'s; recreating anyway and accepting that those requests fail.'
  else
    note 'the router would not accept the drain (not answering, or the admin token does not match); recreating without draining.'
  fi
else
  say 'Drain skipped.'
fi

# ---------------------------------------------------------------------------
# Build and replace. scripts/deploy-router-instance.sh is the blessed path: it
# exports the state directory paths, builds, and runs
# `up -d --pull never --no-build`, so what runs is what is committed. Everything
# it reads is passed explicitly - its own defaults are written for a first
# install, not for this deployment.
# ---------------------------------------------------------------------------
export ROUTER_BIND_IP="$bind_ip"
export ROUTER_ENV_FILE="$env_file"
export ROUTER_HOSTS="$router_hosts"
export ROUTER_DEFAULT_HOST="$router_default_host"
export ROUTER_DATA_HOST_DIR="$deployment_base/data"
export ROUTER_RUNTIME_HOST_DIR="$deployment_base/runtime"

say 'Validating the updated Compose configuration...'
docker compose -p "$compose_project" -f "$compose_file" config --quiet || {
  clear_drain
  fail 'the updated Compose configuration is invalid.'
}

say 'Building and restarting the router (in-flight requests are dropped once it is replaced)...'
if ! (cd "$source_dir" &&
  env BIND_IP="$bind_ip" \
    BASE="$deployment_base" \
    ENV_FILE="$env_file" \
    COMPOSE_FILE="$compose_file" \
    REPO_URL="$origin_url" \
    REV="$branch" \
    ROUTER_HOSTS="$router_hosts" \
    ROUTER_DEFAULT_HOST="$router_default_host" \
    SOURCE_REVISION="$SOURCE_REVISION" \
    bash "$deploy_script"); then
  clear_drain
  fail 'the deployment failed; the previous container is still the one Compose last started.'
fi

# ---------------------------------------------------------------------------
# Gate on health. The container's own health check follows the default host's
# backend, so a machine that is down for other reasons is not this update's
# failure: Compose is asked to wait, and the authoritative answer is whether the
# router itself is answering /health again.
# ---------------------------------------------------------------------------
if [ "$health_wait" -gt 0 ]; then
  docker compose -p "$compose_project" -f "$compose_file" up -d --wait --wait-timeout "$health_wait" ||
    note 'Compose did not report the deployment healthy within '"$health_wait"'s; checking the health endpoint directly.'

  say 'Waiting for the router to answer '"$api_base"'/health...'
  health_ok=0
  waited=0
  while [ "$waited" -lt "$health_wait" ]; do
    body=$(wget -q -O- --content-on-error --timeout=5 --tries=1 "$api_base/health" 2>/dev/null || true)
    case "$body" in *'"ok"'*) health_ok=1; break ;; esac
    sleep 5
    waited=$((waited + 5))
  done
  if [ "$health_ok" != 1 ]; then
    clear_drain
    docker compose -p "$compose_project" -f "$compose_file" ps || true
    fail 'the updated router is not answering '"$api_base"'/health after '"$health_wait"'s; see: docker compose -p '"$compose_project"' -f '"$compose_file"' logs'
  fi
  case "$body" in *'"ok":false'*) note 'the router is answering but reports a machine that is not serving; that is not caused by this restart.' ;; esac
else
  say 'Health gate skipped.'
fi

clear_drain
say 'Deployment status:'
docker compose -p "$compose_project" -f "$compose_file" ps || true
printf 'Update complete: %s -> %s\n' "$before_commit" "$deployed_commit"
