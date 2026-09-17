#!/usr/bin/env bash
set -euo pipefail

ROUTER_URL="${ROUTER_URL:-http://192.168.1.21:11434}"
ROUTER_URL="${ROUTER_URL%/}"
CODEX_BIN="${CODEX_BIN:-codex}"
REQUESTED_MODEL="${REQUESTED_MODEL:-${1:-local-active}}"

command -v "$CODEX_BIN" > /dev/null
BEFORE_ACTIVE="$(curl -fsS "$ROUTER_URL/health" | jq -er '.activeModel.model')"
BEFORE_LOADED="$(curl -fsS "$ROUTER_URL/api/ps" | jq -c '[.models[]? | (.name // .model)] | sort')"

SMOKE_OUTPUT="$(mktemp)"
cleanup() {
  rm -f "$SMOKE_OUTPUT"
}
trap cleanup EXIT

"$CODEX_BIN" exec \
  --ignore-user-config \
  --ephemeral \
  --skip-git-repo-check \
  --sandbox workspace-write \
  --disable multi_agent \
  --disable multi_agent_v2 \
  --disable apps \
  --disable plugins \
  --disable tool_suggest \
  --disable image_generation \
  --disable artifact \
  -c "model_provider=\"llm_router\"" \
  -c "model=\"$REQUESTED_MODEL\"" \
  -c 'model_reasoning_effort="none"' \
  -c 'web_search="disabled"' \
  -c 'model_providers.llm_router.name="LLM Router"' \
  -c "model_providers.llm_router.base_url=\"$ROUTER_URL/v1\"" \
  -c 'model_providers.llm_router.wire_api="responses"' \
  -c 'model_providers.llm_router.requires_openai_auth=false' \
  --json \
  "Use the shell tool exactly once to run: printf 'codex-router-tool-ok\\n'. Then return exactly codex-router-tool-ok." \
  | tee "$SMOKE_OUTPUT"

jq -e 'select(
  .type == "item.completed"
  and .item.type == "command_execution"
  and .item.exit_code == 0
  and (.item.aggregated_output | contains("codex-router-tool-ok"))
)' "$SMOKE_OUTPUT" > /dev/null
jq -e 'select(
  .type == "item.completed"
  and .item.type == "agent_message"
  and .item.text == "codex-router-tool-ok"
)' "$SMOKE_OUTPUT" > /dev/null
AFTER_ACTIVE="$(curl -fsS "$ROUTER_URL/health" | jq -er '.activeModel.model')"
AFTER_LOADED="$(curl -fsS "$ROUTER_URL/api/ps" | jq -c '[.models[]? | (.name // .model)] | sort')"
[[ "$AFTER_ACTIVE" == "$BEFORE_ACTIVE" ]]
[[ "$AFTER_LOADED" == "$BEFORE_LOADED" ]]

echo "Codex Responses smoke test passed."
echo "Requested model remained advisory: $REQUESTED_MODEL"
echo "Active model remained: $AFTER_ACTIVE"
