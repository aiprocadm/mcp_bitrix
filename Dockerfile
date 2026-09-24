# Multi-stage: сборка отдельно, в runtime только dist и production-зависимости.
# Секреты в образ не попадают: .env и data/ монтируются при запуске (см. compose.yaml).
FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd -r mcp && useradd -r -g mcp -d /app mcp
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY policies ./policies
RUN mkdir -p /app/data && chown -R mcp:mcp /app
USER mcp
# Без ENTRYPOINT: тогда `docker compose run --rm bitrix24-mcp node dist/cli/setup.js ...` запускает именно CLI,
# а не сервер с чужими аргументами (найдено живой проверкой 24.09).
CMD ["node", "dist/index.js", "--transport", "http", "--config", "/app/config/.env"]
