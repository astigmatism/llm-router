# Open WebUI v0.12.3 carrying the ai-router integration layer.
# Ported on 2026-10-25 from local/open-webui:v0.11.4-router-v2 (integrations/open-webui/v0.11.4/).
#
# Port method: each modified overlay file was 3-way merged (upstream v0.11.4 -> our patch)
# onto the v0.12.3 source; five conflicts resolved by hand (see PROVENANCE.md). The two
# new modules are carried unchanged. No env or dependency changes.
#
# Base pinned by digest (= ghcr.io/open-webui/open-webui:0.12.3).
FROM ghcr.io/open-webui/open-webui@sha256:a537bbe1e6b428820f52ed4a029d7fff97062e24d5cf32c365fba36fd0542def

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.source="https://github.com/astigmatism/llm-router/tree/main/integrations/open-webui/v0.12.3" \
      base.version="v0.12.3" \
      base.revision="91ea4e3421d1d8069f13d4a463fcb5986d94ea60" \
      patch="preserve-router-error-details" \
      router-policy="unrestricted-terminal-v1" \
      router-contract="1.1" \
      image.version="0.12.3" \
      ported-from="local/open-webui:v0.11.4-router-v2"

# --- 2 NEW modules (clean adds) ---
COPY merged/open_webui/utils/router_completion.py   /app/backend/open_webui/utils/router_completion.py
COPY merged/open_webui/utils/web_fetch_window.py    /app/backend/open_webui/utils/web_fetch_window.py

# --- 8 modified files (3-way merged onto v0.12.3) ---
COPY merged/open_webui/utils/response.py            /app/backend/open_webui/utils/response.py
COPY merged/open_webui/utils/context_compaction.py  /app/backend/open_webui/utils/context_compaction.py
COPY merged/open_webui/routers/tasks.py             /app/backend/open_webui/routers/tasks.py
COPY merged/open_webui/routers/ollama.py            /app/backend/open_webui/routers/ollama.py
COPY merged/open_webui/retrieval/web/duckduckgo.py  /app/backend/open_webui/retrieval/web/duckduckgo.py
COPY merged/open_webui/utils/tools.py               /app/backend/open_webui/utils/tools.py
COPY merged/open_webui/tools/builtin.py             /app/backend/open_webui/tools/builtin.py
COPY merged/open_webui/utils/middleware.py          /app/backend/open_webui/utils/middleware.py
