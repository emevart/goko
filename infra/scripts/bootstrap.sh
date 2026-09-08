#!/usr/bin/env bash
# Первичная настройка VPS Гоко: Docker, ufw, каталог /opt/goko. Идемпотентен.
set -euo pipefail
trap 'echo "[X] bootstrap: ошибка на строке $LINENO" >&2' ERR

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

apt-get update -qq
apt-get install -y -qq ufw rsync >/dev/null
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 3478/udp
ufw allow 30000:40000/udp   # relay-аллокации TURN (turn.relay_range_start/end в livekit.yaml)
ufw allow 50000:60000/udp
ufw --force enable

mkdir -p /opt/goko/web /opt/goko/src /opt/goko/data
if [ ! -f /opt/goko/.env ]; then
  # заготовка с пустыми значениями: примерные домены из .env.example сюда не копируем,
  # иначе файл выглядит заполненным и деплой уедет на чужой домен
  cat > /opt/goko/.env <<'ENV'
# Заготовка. Заполни значения, образец и комментарии — в infra/.env.example.
WEB_HOST=
LK_HOST=
ACME_EMAIL=
LIVEKIT_IMAGE=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_URL=
OPENAI_API_KEY=
APP_KEY=
ENGINE_KEY=
API_UPSTREAM=127.0.0.1:8787
AGENT_NAME=goko
ENV
  chmod 600 /opt/goko/.env
  echo "[!] /opt/goko/.env создан пустой заготовкой: заполни значения и запусти deploy.sh"
fi
echo "[OK] bootstrap: docker $(docker version --format '{{.Server.Version}}'), ufw включён, /opt/goko готов"
