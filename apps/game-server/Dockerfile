# game-server: Node 22 запускает TypeScript напрямую (type stripping), сборка не нужна.
# npm ci по workspace'у ставит только его зависимости; package.json workspace'ов нужны для lock-файла
# (spike/ исключён .dockerignore — если npm ci на это ругается, см. шаг 8).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/go-core/package.json packages/go-core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/go-engine/package.json apps/go-engine/
COPY apps/game-server/package.json apps/game-server/
COPY apps/voice-agent/package.json apps/voice-agent/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/game-server --include-workspace-root=false
COPY packages/go-core/src packages/go-core/src
COPY packages/protocol/src packages/protocol/src
COPY apps/game-server/src apps/game-server/src
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data/games
EXPOSE 8787
USER node
CMD ["node", "apps/game-server/src/main.ts"]
