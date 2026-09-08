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
RUN curl -fsSL -o katago.zip https://github.com/lightvector/KataGo/releases/download/${KATAGO_VERSION}/${KATAGO_ASSET} \
 && echo "${KATAGO_SHA256}  katago.zip" | sha256sum -c - \
 && unzip -q katago.zip && rm katago.zip && chmod +x katago
RUN mkdir models \
 && curl -fsSL -o models/main.txt.gz "${MAIN_NET_URL}" \
 && echo "${MAIN_NET_SHA256}  models/main.txt.gz" | sha256sum -c - \
 && curl -fsSL -o models/human.bin.gz "${HUMAN_NET_URL}" \
 && echo "${HUMAN_NET_SHA256}  models/human.bin.gz" | sha256sum -c -
COPY config/analysis.cfg /opt/katago/analysis.cfg
# Стадия 1 добавит слой с Node и обёрткой; для замера стадии 0 достаточно этого образа.
CMD ["/opt/katago/katago", "version"]
