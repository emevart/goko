#!/usr/bin/env bash
# Деплой на VPS: синхронизация репозитория, подстановка домена в livekit.yaml, compose up, статика.
# Использование: infra/scripts/deploy.sh [--host goko] [--web-dir apps/web/dist]
# Синхронизация идёт через rsync; если rsync нет (Git Bash на Windows) — через tar по ssh.
set -euo pipefail
trap 'echo "[X] deploy: ошибка на строке $LINENO" >&2' ERR
HOST=goko
WEB_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2;;
    --web-dir) WEB_DIR="$2"; shift 2;;
    *) echo "unknown arg $1"; exit 2;;
  esac
done
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# .env живёт только на VPS: без него деплой обрывался бы уже после синхронизации
if ! ssh "$HOST" test -r /opt/goko/.env; then
  echo "[X] deploy: на $HOST нет читаемого /opt/goko/.env — запусти bootstrap.sh и заполни файл" >&2
  exit 1
fi

if command -v rsync >/dev/null 2>&1; then
  SYNC=rsync
else
  SYNC=tar
  echo "[!] deploy: rsync не найден, синхронизация через tar+ssh; устаревшие файлы на VPS не удаляются"
fi

# репозиторий -> /opt/goko/src
if [ "$SYNC" = rsync ]; then
  rsync -az --delete \
    --exclude .git --exclude node_modules --exclude data --exclude '.env' --exclude '.env.*' \
    --exclude 'apps/go-engine/models' --exclude 'apps/web/dist' \
    "$ROOT/" "$HOST:/opt/goko/src/"
else
  tar -C "$ROOT" -czf - \
    --exclude .git --exclude node_modules --exclude data --exclude '.env' --exclude '.env.*' \
    --exclude 'apps/go-engine/models' --exclude 'apps/web/dist' \
    . | ssh "$HOST" 'mkdir -p /opt/goko/src && tar -xzf - -C /opt/goko/src'
fi

# статика -> /opt/goko/web
if [ -n "$WEB_DIR" ]; then
  if [ ! -d "$ROOT/$WEB_DIR" ]; then
    echo "[X] deploy: каталога $WEB_DIR нет — собери статику перед деплоем" >&2
    exit 1
  fi
  if [ "$SYNC" = rsync ]; then
    rsync -az --delete "$ROOT/$WEB_DIR/" "$HOST:/opt/goko/web/"
  else
    tar -C "$ROOT/$WEB_DIR" -czf - . | ssh "$HOST" 'mkdir -p /opt/goko/web && tar -xzf - -C /opt/goko/web'
  fi
fi

ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
trap 'echo "[X] deploy (VPS): ошибка на строке $LINENO" >&2' ERR
set -a; . /opt/goko/.env; set +a
if [ -z "${LK_HOST:-}" ]; then
  echo "[X] deploy: в /opt/goko/.env не задан LK_HOST" >&2
  exit 1
fi
if [ -z "${ACME_EMAIL:-}" ]; then
  echo "[!] deploy: ACME_EMAIL пуст — Let's Encrypt возьмёт фиктивный admin@WEB_HOST,"
  echo "[!]         письма об истечении сертификата уйдут в никуда. Впиши почту в /opt/goko/.env"
fi
sed "s/__TURN_DOMAIN__/${LK_HOST}/" /opt/goko/src/infra/livekit.yaml > /opt/goko/livekit.yaml
cd /opt/goko/src/infra
docker compose --env-file /opt/goko/.env up -d --build --remove-orphans
docker compose --env-file /opt/goko/.env ps
REMOTE
echo "[OK] deploy: страница https://<WEB_HOST>, LiveKit wss://<LK_HOST> (значения в /opt/goko/.env)"
