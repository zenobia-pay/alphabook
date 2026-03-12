FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
COPY apps/runtime ./apps/runtime
COPY packages/shared ./packages/shared

RUN npm install

ENV PORT=8080
ENV RUNTIME_WORKSPACE_ROOT=/workspace
ENV RUNTIME_AGENT_COMMAND=/app/apps/runtime/bin/run-agent.mjs
ENV RUNTIME_AGENT_MODEL=gpt-5-codex

CMD ["npx", "tsx", "apps/runtime/src/server.ts"]
