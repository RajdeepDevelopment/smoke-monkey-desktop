# build stage
FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --filter api-gateway --ignore-scripts=false
RUN pnpm --filter api-gateway build

# runtime stage
FROM node:20-alpine
WORKDIR /app/apps/api-gateway
ENV NODE_ENV=production

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/api-gateway/node_modules ./node_modules
COPY --from=builder /app/apps/api-gateway/dist ./dist

EXPOSE 3000
CMD ["node", "dist/main.js"]
