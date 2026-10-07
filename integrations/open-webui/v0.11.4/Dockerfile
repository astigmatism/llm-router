# Open WebUI v0.11.4 carrying the ai-router integration layer
# (ported from the custom local/open-webui:error-details-git-b790384... v0.11.3 build).
#
# Rationale: the stock v0.11.4 base already provides every non-compose env var the
# custom image had (verified: name+value delta is only the cosmetic WEBUI_BUILD_VERSION).
# So only the ~370-line source layer is overlaid; no env or dependency changes are needed.
#
# Base pinned by digest (= ghcr.io/open-webui/open-webui:0.11.4).
FROM ghcr.io/open-webui/open-webui@sha256:9591b13f13843c7721c2b8eaf7382846c81b3ffe126526d1888d1fed50c6a33f

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.source="https://github.com/astigmatism/llm-router/tree/main/integrations/open-webui/v0.11.4" \
      base.version="v0.11.4" \
      base.revision="8bd8b4fac5e059578ac0c74b3c18d11139f88b7d" \
      patch="preserve-router-error-details" \
      router-policy="unrestricted-terminal-v1" \
      router-contract="1.1" \
      image.version="0.11.4" \
      ported-from="local/open-webui:error-details-git-b790384bc31d587c75be2dc82bd9fcf04cd70054 (v0.11.3)"

# --- 2 NEW modules (clean adds) ---
COPY merged/open_webui/utils/router_completion.py   /app/backend/open_webui/utils/router_completion.py
COPY merged/open_webui/utils/web_fetch_window.py    /app/backend/open_webui/utils/web_fetch_window.py

# --- 8 modified files (3-way merged onto v0.11.4; response/context_compaction/tasks are clean copies) ---
COPY merged/open_webui/utils/response.py            /app/backend/open_webui/utils/response.py
COPY merged/open_webui/utils/context_compaction.py  /app/backend/open_webui/utils/context_compaction.py
COPY merged/open_webui/routers/tasks.py             /app/backend/open_webui/routers/tasks.py
COPY merged/open_webui/routers/ollama.py            /app/backend/open_webui/routers/ollama.py
COPY merged/open_webui/retrieval/web/duckduckgo.py  /app/backend/open_webui/retrieval/web/duckduckgo.py
COPY merged/open_webui/utils/tools.py               /app/backend/open_webui/utils/tools.py
COPY merged/open_webui/tools/builtin.py             /app/backend/open_webui/tools/builtin.py
COPY merged/open_webui/utils/middleware.py          /app/backend/open_webui/utils/middleware.py
