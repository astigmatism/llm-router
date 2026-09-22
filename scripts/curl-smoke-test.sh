#!/usr/bin/env bash
set -euo pipefail

ROUTER_URL="${ROUTER_URL:-http://192.168.1.4:11434}"
ADMIN_URL="${ADMIN_URL:-http://192.168.1.4:11435}"
MODEL="${1:-}"

if [[ -z "$MODEL" ]]; then
  if [[ -f ./runtime/active-model.json ]]; then
    MODEL="$(node -e "console.log(JSON.parse(require('fs').readFileSync('./runtime/active-model.json','utf8')).model)")"
  fi
fi

if [[ -z "$MODEL" ]]; then
  echo "usage: MODEL=<active-model> $0 or $0 <active-model>" >&2
  exit 2
fi

echo "Router API URL: $ROUTER_URL"
echo "Admin portal URL: $ADMIN_URL"
echo "Active model: $MODEL"

echo "1. Version through Ollama-compatible router API"
curl -fsS "$ROUTER_URL/api/version" | jq . || curl -fsS "$ROUTER_URL/api/version"

echo "2. Tags through Ollama-compatible router API"
curl -fsS "$ROUTER_URL/api/tags" >/tmp/router-tags.json
cat /tmp/router-tags.json | jq '.models | length' || cat /tmp/router-tags.json

echo "3. Unauthenticated admin portal summary on separate admin port"
curl -fsS "$ADMIN_URL/admin/api/summary" | jq '.activeModel, .activeLoadedState, .metrics'

echo "4. Chat without keep_alive; router should add keep_alive=-1"
curl -fsS "$ROUTER_URL/api/chat" \
  -H 'content-type: application/json' \
  -H 'x-client-name: smoke-test-no-keepalive' \
  -d "{\"model\":\"$MODEL\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with ok.\"}]}" | jq '.done, .eval_count, .eval_duration' || true

echo "5. Chat with finite keep_alive; router should overwrite to -1"
curl -fsS "$ROUTER_URL/api/chat" \
  -H 'content-type: application/json' \
  -H 'x-client-name: smoke-test-finite-keepalive' \
  -d "{\"model\":\"$MODEL\",\"stream\":false,\"keep_alive\":\"5m\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with ok.\"}]}" | jq '.done, .eval_count, .eval_duration' || true

echo "6. Recent requests should show forwardedKeepAlive=-1"
curl -fsS "$ADMIN_URL/admin/api/requests?limit=5" | jq '.requests[] | {ts, clientIdentity, endpoint, requestedModel, incomingKeepAlive, forwardedKeepAlive, responseStatus}'
