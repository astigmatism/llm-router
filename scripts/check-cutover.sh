#!/usr/bin/env bash
set -euo pipefail

ROUTER_URL="${ROUTER_URL:-http://192.168.1.4:11434}"
ADMIN_URL="${ADMIN_URL:-http://192.168.1.4:11435}"
RAW_URL="${RAW_URL:-}"

echo "Router API version:"
curl -fsS "$ROUTER_URL/api/version" || true
printf '\n\nUnauthenticated admin portal summary:\n'
curl -fsS "$ADMIN_URL/admin/api/summary" | jq '{activeModel, activeLoadedState, upstream, metrics}' || true
printf '\n\nDeployment hosts (a router that serves more than one machine):\n'
if hosts_json=$(curl -fsS --max-time 5 "$ADMIN_URL/admin/api/hosts"); then
  echo "$hosts_json" | jq -r '
    if (.hosts | length) <= 1 then "single-host deployment: nothing to check"
    else
      "default host: \(.default_host)",
      (.hosts[] | "  \(.id)\(if .default then " (default)" else "" end): published=\(.published) models=\(.model_ids | length) draining=\(.draining)\(if .error then " error=\(.error.code)" else "" end)"),
      (if ([.hosts[] | select(.published | not)] | length) > 0
       then "WARNING: a declared machine has published nothing; its models are not selectable" else "OK: every declared machine has published" end)
    end'
  printf '\nCapabilities report the same machines:\n'
  curl -fsS --max-time 5 "$ROUTER_URL/v1/router/capabilities" \
    | jq -r 'if .hosts then (.hosts[] | "  \(.id): available=\(.available) draining=\(.draining) models=\(.model_ids | length)") else "  single-host document (no hosts field)" end'
  printf '\nHealth answers from the default host and reports the rest as degraded:\n'
  curl -fsS --max-time 5 "$ROUTER_URL/health" | jq -r '{ok, degraded, hosts: [.hosts[]? | {id, default, available}]} // "single-host health"'
else
  echo "Router reports no host roster: it predates multi-host support, or the admin portal is unreachable."
fi

printf '\n\nRaw Ollama direct LAN exposure check:\n'
if [[ -z "$RAW_URL" ]]; then
  echo "RAW_URL is not set; skipping direct raw check. Set RAW_URL to any suspected raw Ollama LAN URL."
elif [[ "$RAW_URL" == "$ROUTER_URL" ]]; then
  echo "RAW_URL equals ROUTER_URL; skipping direct raw check to avoid checking the router itself."
elif curl -fsS --max-time 3 "$RAW_URL/api/version" >/tmp/raw-ollama-version.json; then
  echo "WARNING: an Ollama-compatible endpoint is reachable at $RAW_URL"
  cat /tmp/raw-ollama-version.json
else
  echo "OK: no direct raw endpoint reachable at $RAW_URL"
fi
