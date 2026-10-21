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
ROUTER_HOSTS="${ROUTER_HOSTS:-local,rosalina}"
DEFAULT_HOST="${ROUTER_DEFAULT_HOST:-rosalina}"
BASE="${BASE:-$HOME/deployments/llm-router}"
SOURCE="$BASE/source"
ENV_FILE="${ENV_FILE:-$HOME/credentials/llm-router/router.env}"
REPO_URL="${REPO_URL:-https://github.com/astigmatism/llm-router.git}"
REV="${REV:-main}"
# The machines that publish catalogs are not on this machine's Docker network, so
# the router needs no external network; `local` keeps the file handoff in case a
# runtime is ever installed here too.
COMPOSE_FILE="${COMPOSE_FILE:-$SOURCE/compose.vm-example.yml}"

umask 077
say() { printf '%s\n' "$*"; }

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
#    ./data holds history and the catalog store, ./runtime holds the drain
#    control file a release depends on.
install -d -m 0755 "$BASE/data" "$BASE/data/history" "$BASE/runtime"
sudo -n chown -R 1000:1000 "$BASE/data" "$BASE/runtime" 2>/dev/null || chown -R 1000:1000 "$BASE/data" "$BASE/runtime"

# 4. Start. Compose builds from the checkout it lives in; the image is never
#    pulled, so what is running is what is committed.
cd "$SOURCE"
ROUTER_BIND_IP="$BIND_IP" ROUTER_ENV_FILE="$ENV_FILE" \
ROUTER_HOSTS="$ROUTER_HOSTS" ROUTER_DEFAULT_HOST="$DEFAULT_HOST" \
  docker compose -p llm-router -f "$COMPOSE_FILE" build
ROUTER_BIND_IP="$BIND_IP" ROUTER_ENV_FILE="$ENV_FILE" \
ROUTER_HOSTS="$ROUTER_HOSTS" ROUTER_DEFAULT_HOST="$DEFAULT_HOST" \
  docker compose -p llm-router -f "$COMPOSE_FILE" up -d --pull never --no-build

# 5. Report. With no machine publishing yet, the router is degraded and answers:
#    that is the correct state, not a failed install.
sleep 4
say "api     http://$BIND_IP:11434  portal  http://$BIND_IP:11435"
curl -s --max-time 5 "http://$BIND_IP:11434/health" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("health ", d.get("ok"), "degraded", d.get("degraded"), [(h["id"], h.get("error") or "ok") for h in d.get("hosts", [])])' \
  || say "health  not answering yet; docker compose -p llm-router -f $COMPOSE_FILE logs"
say "publish a catalog:  curl -X PUT http://$BIND_IP:11435/admin/api/hosts/<host>/catalog -H \"authorization: Bearer \$(grep -m1 ^CATALOG_PUSH_TOKEN= $ENV_FILE | cut -d= -f2)\" --header content-type:application/json --data-binary @catalog.json"
