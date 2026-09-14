# voice-agent: воркер LiveKit Agents. download-files кладёт модель Silero VAD (режим pipeline) в кэш образа.
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
RUN npm ci --omit=dev --workspace apps/voice-agent --include-workspace-root=false
COPY packages/go-core/src packages/go-core/src
COPY packages/protocol/src packages/protocol/src
COPY apps/voice-agent/src apps/voice-agent/src
RUN npx livekit-agents download-files
ENV VOICE_MODE=realtime API_BASE=http://game-server:8787
USER node
CMD ["node", "apps/voice-agent/src/main.ts", "start"]
