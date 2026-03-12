FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
COPY apps/ingest ./apps/ingest
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared

RUN npm install

CMD ["npx", "tsx", "apps/ingest/src/index.ts", "run-once"]
