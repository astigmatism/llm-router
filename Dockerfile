FROM node:22-bookworm-slim

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF \
    org.opencontainers.image.title="LLM Router" \
    org.opencontainers.image.source="https://github.com/astigmatism/llm-router"

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=11434 \
    ADMIN_ENABLED=true \
    ADMIN_BIND_HOST=0.0.0.0 \
    ADMIN_PORT=11435 \
    DATA_DIR=/app/data \
    ACTIVE_MODEL_FILE=/app/runtime/active-model.json

COPY package.json ./
COPY src ./src
COPY test ./test
COPY public ./public
COPY docs ./docs
COPY runtime ./runtime

RUN mkdir -p /app/data /app/runtime \
    && chown -R node:node /app

USER node
EXPOSE 11434 11435

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:11434/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
