FROM ubuntu:24.04 AS katago
# Тег v1.18.1 менять нельзя: в v1.18.2 сборок eigen и opencl нет вовсе (проверено 08.09)
ARG KATAGO_VERSION=v1.18.1
ARG KATAGO_ASSET=katago-v1.18.1-eigenavx2-linux-x64.zip
# .bin.gz по этому пути отдаёт 403 (проверено 08.09); каталог раздаёт .txt.gz, KataGo читает оба формата
ARG MAIN_NET_URL=https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.txt.gz
ARG HUMAN_NET_URL=https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates libzip4 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/katago
RUN curl -fsSL -o katago.zip https://github.com/lightvector/KataGo/releases/download/${KATAGO_VERSION}/${KATAGO_ASSET} \
 && unzip -q katago.zip && rm katago.zip && chmod +x katago
RUN mkdir models && curl -fsSL -o models/main.txt.gz "${MAIN_NET_URL}" && curl -fsSL -o models/human.bin.gz "${HUMAN_NET_URL}"
COPY config/analysis.cfg /opt/katago/analysis.cfg
# Стадия 1 добавит слой с Node и обёрткой; для замера стадии 0 достаточно этого образа.
CMD ["/opt/katago/katago", "version"]
