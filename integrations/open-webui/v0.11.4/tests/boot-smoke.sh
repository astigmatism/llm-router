#!/bin/sh
# Boot an overlay image in an isolated throwaway container (no network, empty data) and
# require /health to answer. Run before every deployment: unit tests import modules one
# at a time and cannot prove that the whole application starts.
#   integrations/open-webui/v0.11.4/tests/boot-smoke.sh local/open-webui:v0.11.4-router-v<N>
set -eu
image=${1:?usage: boot-smoke.sh IMAGE}
name=owui-boot-smoke-$$
docker run -d --rm --name "$name" --network none -e WEBUI_SECRET_KEY=isolated-test-only \
  -e OFFLINE_MODE=true -e OLLAMA_BASE_URL=http://127.0.0.1:9 "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
i=0
while [ "$i" -lt 60 ]; do
  if docker exec "$name" curl -sf -m 3 http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "boot smoke passed: $image answered /health"
    exit 0
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != true ]; then
    echo "boot smoke FAILED: $image exited during startup" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 5
done
echo "boot smoke FAILED: $image did not answer /health within 5 minutes" >&2
docker logs --tail 40 "$name" >&2 || true
exit 1
