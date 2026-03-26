FROM node:22-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates jq python3 python-is-python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
COPY apps/runtime ./apps/runtime
COPY packages ./packages

RUN npm ci --legacy-peer-deps

ENV PORT=8080
ENV RUNTIME_WORKSPACE_ROOT=/workspace
ENV RUNTIME_AGENT_COMMAND=/app/apps/runtime/bin/run-agent.mjs
ENV RUNTIME_AGENT_MODEL=gpt-5-codex
ENV PATH=/app/node_modules/.bin:$PATH
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

CMD ["npx", "tsx", "apps/runtime/src/server.ts"]
