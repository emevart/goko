#!/usr/bin/env bash
# Деплой на VPS: rsync репозитория, подстановка домена в livekit.yaml, compose up, статика.
# Использование: infra/scripts/deploy.sh [--host goko] [--web-dir apps/web/dist]
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

# .env живёт только на VPS: без него деплой обрывался бы уже после rsync
if ! ssh "$HOST" test -r /opt/goko/.env; then
  echo "[X] deploy: на $HOST нет читаемого /opt/goko/.env — запусти bootstrap.sh и заполни файл" >&2
  exit 1
fi

rsync -az --delete \
  --exclude .git --exclude node_modules --exclude data --exclude '.env' --exclude '.env.*' \
  --exclude 'apps/go-engine/models' --exclude 'apps/web/dist' \
  "$ROOT/" "$HOST:/opt/goko/src/"

if [ -n "$WEB_DIR" ]; then
  rsync -az --delete "$ROOT/$WEB_DIR/" "$HOST:/opt/goko/web/"
fi

ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
trap 'echo "[X] deploy (VPS): ошибка на строке $LINENO" >&2' ERR
set -a; . /opt/goko/.env; set +a
if [ -z "${LK_HOST:-}" ]; then
  echo "[X] deploy: в /opt/goko/.env не задан LK_HOST" >&2
  exit 1
fi
sed "s/__TURN_DOMAIN__/${LK_HOST}/" /opt/goko/src/infra/livekit.yaml > /opt/goko/livekit.yaml
cd /opt/goko/src/infra
docker compose --env-file /opt/goko/.env up -d --build --remove-orphans
docker compose --env-file /opt/goko/.env ps
REMOTE
echo "[OK] deploy: страница https://<WEB_HOST>, LiveKit wss://<LK_HOST> (значения в /opt/goko/.env)"
