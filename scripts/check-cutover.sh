#!/usr/bin/env bash
set -euo pipefail

ROUTER_URL="${ROUTER_URL:-http://192.168.1.4:11434}"
ADMIN_URL="${ADMIN_URL:-http://192.168.1.4:11435}"
RAW_URL="${RAW_URL:-}"

echo "Router API version:"
curl -fsS "$ROUTER_URL/api/version" || true
printf '\n\nUnauthenticated admin portal summary:\n'
curl -fsS "$ADMIN_URL/admin/api/summary" | jq '{activeModel, activeLoadedState, upstream, metrics}' || true
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
