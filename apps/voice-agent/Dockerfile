# voice-agent: воркер LiveKit Agents. download-files кладёт модель Silero VAD (режим pipeline) в кэш образа.
# bookworm явно: плавающий node:22-slim переедет на следующий Debian, а сборка на VPS идёт позже проверки на ПК.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
# rtc-node (Rust FFI, rustls) берёт корневые сертификаты из системы; в slim-образе Node их нет — без пакета wss:// к LiveKit не откроется.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/go-core/package.json packages/go-core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/go-engine/package.json apps/go-engine/
COPY apps/game-server/package.json apps/game-server/
COPY apps/voice-agent/package.json apps/voice-agent/
COPY apps/web/package.json apps/web/
# ONNXRUNTIME_NODE_INSTALL=skip: postinstall onnxruntime-node не качает CUDA-провайдеры (~317 МБ) — Silero VAD
# работает на CPU-провайдере из пакета. Кэш npm (~180 МБ) чистится в том же слое: без cache mount, чтобы сборка
# не зависела от BuildKit.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev --workspace apps/voice-agent --include-workspace-root=false \
 && npm cache clean --force
COPY packages/go-core/src packages/go-core/src
COPY packages/protocol/src packages/protocol/src
COPY apps/voice-agent/src apps/voice-agent/src
# CLI может находиться в node_modules workspace после обновления SDK.
RUN npm run download-files --workspace apps/voice-agent
ENV VOICE_MODE=realtime API_BASE=http://game-server:8787
USER node
CMD ["node", "apps/voice-agent/src/main.ts", "start"]
