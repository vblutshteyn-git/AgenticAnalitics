# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Стадия 1: сборка
#
# TypeScript нужен только здесь. Разделение стадий позволяет собрать проект
# с полным набором зависимостей, а в финальный образ положить только
# продакшн-зависимости и результат компиляции.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Слой зависимостей кэшируется отдельно: пока package*.json не менялись,
# npm ci при пересборке не выполняется заново.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Проверяем сборку прямо в образе: сломанный артефакт не должен уехать
# в продакшн только потому, что тесты забыли прогнать в CI.
RUN npm test

# Отбрасываем devDependencies из node_modules, которые поедут дальше.
RUN npm prune --omit=dev


# ---------------------------------------------------------------------------
# Стадия 2: рантайм
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# tini как PID 1: Node не пожинает зомби-процессы и не всегда корректно
# получает сигналы, будучи первым процессом в контейнере.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    AGENTICS_DATA_DIR=/data

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Фронтенд собирать не нужно — он отдаётся как исходники.
COPY --from=build /app/src/web ./src/web

# Каталог данных принадлежит непривилегированному пользователю, под которым
# идёт работа. Образ node:alpine уже содержит пользователя `node` (uid 1000).
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 4173

# Проба использует /healthz — она намеренно не трогает хранилище и файловую
# систему, поэтому её можно опрашивать часто и безопасно.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/main.js"]
