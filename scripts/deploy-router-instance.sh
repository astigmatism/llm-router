#!/usr/bin/env bash
# First install of the router on a machine that routes but runs no models.
#
# Run it ON the target machine:  BIND_IP=192.168.1.23 bash scripts/deploy-router-instance.sh
#
# It is idempotent: re-run it after editing the credentials file and it rebuilds
# and replaces the router, leaving the catalog store and request history where
# they are. Nothing here needs a model directory, a GPU, or a Docker network
# shared with anything else.
set -euo pipefail

BIND_IP="${BIND_IP:-192.168.1.23}"
ROUTER_HOSTS="${ROUTER_HOSTS:-rosalina,daisy}"
DEFAULT_HOST="${ROUTER_DEFAULT_HOST:-rosalina}"
BASE="${BASE:-$HOME/deployments/llm-router}"
SOURCE="$BASE/source"
ENV_FILE="${ENV_FILE:-$HOME/credentials/llm-router/router.env}"
REPO_URL="${REPO_URL:-https://github.com/astigmatism/llm-router.git}"
REV="${REV:-main}"
# The machines that publish catalogs are not on this machine's Docker network, so
# the router needs no external network. The host list is the fleet's truth and so
# it lives here rather than in whoever's shell ran this script last: a machine
# declared here and never heard from is an unpublished host forever, and one
# missing is a catalog refused with HOST_NOT_DECLARED. `local` is deliberately
# not listed — this machine routes and runs no models, so it has no active-model
# marker to hand over, and a router that declares a host it can never publish is a
# router that reports itself degraded forever. Add it back the day a model runs here.
COMPOSE_FILE="${COMPOSE_FILE:-$SOURCE/compose.vm-example.yml}"

umask 077
say() { printf '%s\n' "$*"; }

# The hash of the script this process started reading, taken before the checkout
# is updated. Bash reads a script as it runs, so once the file changes underneath
# it every later line comes from the copy it already read.
STARTED_SHA256="$(sha256sum "$(readlink -f "${BASH_SOURCE[0]}")" | cut -d" " -f1)"

# 1. Source. Public repository, so no credential is needed to fetch it. A
#    deployment checkout stays on a branch and is never edited in place.
if [[ -d $SOURCE/.git ]]; then
  git -C "$SOURCE" fetch --quiet origin "$REV"
  git -C "$SOURCE" checkout --quiet "$REV"
  git -C "$SOURCE" reset --hard --quiet "origin/$REV"
else
  install -d -m 0755 "$BASE"
  git clone --quiet "$REPO_URL" "$SOURCE"
fi
say "source  $(git -C "$SOURCE" rev-parse --short HEAD) $(git -C "$SOURCE" status --porcelain | wc -l | tr -d ' ') dirty"

# Re-run the revision that is now on disk rather than deploying a version of
# itself that no longer exists, which is how a fix lands in the middle of a
# deployment and quietly does nothing.
FRESH="$SOURCE/scripts/deploy-router-instance.sh"
if [[ ${ROUTER_INSTANCE_SELF:-0} != 1 && -f $FRESH && $(sha256sum "$FRESH" | cut -d" " -f1) != "$STARTED_SHA256" ]]; then
  say "re-running the installer from the updated checkout at $(git -C "$SOURCE" rev-parse --short HEAD)"
  ROUTER_INSTANCE_SELF=1 BIND_IP="$BIND_IP" ROUTER_HOSTS="$ROUTER_HOSTS" ROUTER_DEFAULT_HOST="$DEFAULT_HOST" \
  BASE="$BASE" ENV_FILE="$ENV_FILE" REPO_URL="$REPO_URL" REV="$REV" COMPOSE_FILE="$COMPOSE_FILE" \
    exec bash "$FRESH"
fi

# 2. Secrets. Generated once and then never printed; the file is the record.
install -d -m 0700 "$(dirname "$ENV_FILE")"
if [[ ! -f $ENV_FILE ]]; then
  umask 077
  cat > "$ENV_FILE" <<ENV
# LLM Router instance secrets. Generated $(date -u +%FT%TZ).
# Publishes a catalog to this router (AI Runtime on each model machine).
CATALOG_PUSH_TOKEN=$(openssl rand -hex 24)
# Runtime control: drain and state. The admin portal itself stays unauthenticated.
ADMIN_TOKEN=$(openssl rand -hex 24)
ENV
  say "secrets created at $ENV_FILE"
else
  say "secrets kept at $ENV_FILE"
fi
# Compose reads ROUTER_* from the environment; only the secrets live in the file.
grep -q '^CATALOG_PUSH_TOKEN=.' "$ENV_FILE" || { say "$ENV_FILE has no CATALOG_PUSH_TOKEN"; exit 1; }

# 3. Writable directories. The container runs unprivileged on a read-only root
#    filesystem, so anything it writes has to be mounted and owned by uid 1000:
#    data/ holds history and the catalog store, runtime/ holds the drain control
#    file a release depends on. They sit beside the checkout, never inside it:
#    an update replaces the source tree, and state written into it goes with it.
install -d -m 0755 "$BASE/data" "$BASE/data/history" "$BASE/runtime"
chown -R 1000:1000 "$BASE/data" "$BASE/runtime"
# An early version of this script let Compose resolve the mounts against the
# checkout, which wrote state next to the tracked files in ./data and ./runtime.
# Move exactly those paths and nothing else: both directories belong to the
# repository, and sweeping one of them takes the Dockerfile's `COPY runtime` with
# it, which is a deployment that fails for a reason unrelated to routing.
if [[ -d $SOURCE/data/catalogs ]]; then
  mv -n "$SOURCE/data/catalogs" "$BASE/data/" && say "moved the catalog store out of the checkout"
fi
if [[ -f $SOURCE/runtime/router-control.json ]]; then
  mv -n "$SOURCE/runtime/router-control.json" "$BASE/runtime/" && say "moved the drain control file out of the checkout"
fi

# 4. Start. Compose builds from the checkout it lives in; the image is never
#    pulled, so what is running is what is committed.
cd "$SOURCE"
# Exported so Compose resolves the state directories to absolute paths whatever
# directory it is invoked from.
export ROUTER_BIND_IP="$BIND_IP" ROUTER_ENV_FILE="$ENV_FILE" ROUTER_HOSTS="$ROUTER_HOSTS" ROUTER_DEFAULT_HOST="$DEFAULT_HOST" \
  ROUTER_DATA_HOST_DIR="$BASE/data" ROUTER_RUNTIME_HOST_DIR="$BASE/runtime"
docker compose -p llm-router -f "$COMPOSE_FILE" build
docker compose -p llm-router -f "$COMPOSE_FILE" up -d --pull never --no-build

# 5. Report. With no machine publishing yet, the router is degraded and answers:
#    that is the correct state, not a failed install.
sleep 4
say "api     http://$BIND_IP:11434  portal  http://$BIND_IP:11435"
curl -s --max-time 5 "http://$BIND_IP:11434/health" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("health ", d.get("ok"), "degraded", d.get("degraded"), [(h["id"], h.get("error") or "ok") for h in d.get("hosts", [])])' \
  || say "health  not answering yet; docker compose -p llm-router -f $COMPOSE_FILE logs"
say "publish a catalog:  curl -X PUT http://$BIND_IP:11435/admin/api/hosts/<host>/catalog -H \"authorization: Bearer \$(grep -m1 ^CATALOG_PUSH_TOKEN= $ENV_FILE | cut -d= -f2)\" --header content-type:application/json --data-binary @catalog.json"
