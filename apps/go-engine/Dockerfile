FROM ubuntu:24.04 AS katago
# Тег v1.18.1 менять нельзя: в v1.18.2 сборок eigen и opencl нет вовсе (проверено 08.09)
ARG KATAGO_VERSION=v1.18.1
ARG KATAGO_ASSET=katago-v1.18.1-eigenavx2-linux-x64.zip
# .bin.gz по этому пути отдаёт 403 (проверено 08.09); каталог раздаёт .txt.gz, KataGo читает оба формата
ARG MAIN_NET_URL=https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.txt.gz
ARG HUMAN_NET_URL=https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz
# Суммы сняты с фактически скачанных файлов 08.09. При смене KATAGO_ASSET или URL сети
# сумму надо передать через --build-arg, иначе сборка упадёт на sha256sum -c.
ARG KATAGO_SHA256=33e79780dbe3bf6ee859e16f64952cdfc90f7210c8f71ad978ffcba85ad20d79
ARG MAIN_NET_SHA256=3d8a24697ba25fe4da39af4c2b6bd405907b0ad8295322f5a550fa2d8fe4a2f4
ARG HUMAN_NET_SHA256=637746e44f0efe00ad1245a50aa9bbf0716efe364c43965ead97bd6835d84ab5
# libzip4t64, а не libzip4: в Ubuntu 24.04 (noble) после перехода на 64-битный time_t
# пакет переименован. libgomp1 нужен eigen-сборке KataGo (она собрана с OpenMP).
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates libzip4t64 libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/katago
# Релиз KataGo под Linux — AppImage: без FUSE (а в контейнере его нет) он не запускается.
# Распаковываем образ один раз при сборке, /opt/katago/katago оставляем обёрткой над AppRun.
RUN curl -fsSL -o katago.zip https://github.com/lightvector/KataGo/releases/download/${KATAGO_VERSION}/${KATAGO_ASSET} \
 && echo "${KATAGO_SHA256}  katago.zip" | sha256sum -c - \
 && unzip -q katago.zip && rm katago.zip && chmod +x katago \
 && ./katago --appimage-extract >/dev/null && rm katago \
 && printf '#!/bin/sh\nexec /opt/katago/squashfs-root/AppRun "$@"\n' > katago && chmod +x katago
RUN mkdir models \
 && curl -fsSL -o models/main.txt.gz "${MAIN_NET_URL}" \
 && echo "${MAIN_NET_SHA256}  models/main.txt.gz" | sha256sum -c - \
 && curl -fsSL -o models/human.bin.gz "${HUMAN_NET_URL}" \
 && echo "${HUMAN_NET_SHA256}  models/human.bin.gz" | sha256sum -c -
COPY apps/go-engine/config/analysis.cfg /opt/katago/analysis.cfg
# Сервис engine работает под node: бинарник, обёртка и сети должны читаться всеми,
# даже если релизный zip кладёт файлы с правами 600.
RUN chmod -R a+rX /opt/katago

# Стадия engine: Node 22 с обёрткой поверх бинарника и сетей из стадии katago.
FROM node:22-slim AS engine
ENV NODE_ENV=production
# libzip4 — имя пакета в Debian bookworm (в Ubuntu noble — libzip4t64); libgomp1 нужен eigen-сборке KataGo (OpenMP).
RUN apt-get update && apt-get install -y --no-install-recommends libzip4 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=katago /opt/katago /opt/katago
WORKDIR /app
# logDir = analysis_logs в analysis.cfg относительный: KataGo пишет в рабочий каталог /app/analysis_logs.
# Каталог принадлежит node, compose монтирует сюда том engine_logs (новый том наследует владельца).
RUN mkdir analysis_logs && chown node:node analysis_logs
COPY package.json package-lock.json ./
COPY packages/go-core/package.json packages/go-core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/go-engine/package.json apps/go-engine/
COPY apps/game-server/package.json apps/game-server/
COPY apps/voice-agent/package.json apps/voice-agent/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/go-engine --include-workspace-root=false
COPY packages/go-core/src packages/go-core/src
COPY packages/protocol/src packages/protocol/src
COPY apps/go-engine/src apps/go-engine/src
COPY apps/go-engine/config apps/go-engine/config
ENV KATAGO_BIN=/opt/katago/katago \
    KATAGO_MODEL=/opt/katago/models/main.txt.gz \
    KATAGO_HUMAN_MODEL=/opt/katago/models/human.bin.gz \
    KATAGO_CONFIG=/opt/katago/analysis.cfg \
    ENGINE_HOST=0.0.0.0 ENGINE_PORT=8788
EXPOSE 8788
USER node
CMD ["node", "apps/go-engine/src/main.ts"]
