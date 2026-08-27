# deps
FROM node:20-alpine AS deps
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --filter web --ignore-scripts

# builder
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps

ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN pnpm --filter web build

# runner
FROM node:20-alpine AS runner
WORKDIR /app/apps/web

ENV NODE_ENV=production
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/web/node_modules ./node_modules
COPY --from=builder /app/apps/web/.next ./.next
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/package.json ./package.json
COPY --from=builder /app/apps/web/next.config.mjs ./next.config.mjs

USER nextjs
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
