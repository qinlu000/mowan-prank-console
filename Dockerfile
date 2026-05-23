FROM node:22.19.0-alpine AS deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.2.2 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:22.19.0-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    DATABASE_URL=file:/data/mowan.sqlite \
    SESSION_RETENTION_DAYS=7

RUN corepack enable && corepack prepare pnpm@11.2.2 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml server.js ./
COPY public ./public
COPY scripts/sqlite-backup.js ./scripts/sqlite-backup.js

EXPOSE 5173

CMD ["node", "server.js"]
