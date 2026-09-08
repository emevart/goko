#!/usr/bin/env bash
# Деплой на VPS: rsync репозитория, подстановка домена в livekit.yaml, compose up, статика.
# Использование: infra/scripts/deploy.sh [--host goko] [--web-dir apps/web/dist]
set -euo pipefail
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

rsync -az --delete \
  --exclude .git --exclude node_modules --exclude data --exclude '.env' --exclude '.env.*' \
  --exclude 'apps/go-engine/models' --exclude 'apps/web/dist' \
  "$ROOT/" "$HOST:/opt/goko/src/"

if [ -n "$WEB_DIR" ]; then
  rsync -az --delete "$ROOT/$WEB_DIR/" "$HOST:/opt/goko/web/"
fi

ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
set -a; . /opt/goko/.env; set +a
sed "s/__TURN_DOMAIN__/${LK_HOST}/" /opt/goko/src/infra/livekit.yaml > /opt/goko/livekit.yaml
cd /opt/goko/src/infra
docker compose --env-file /opt/goko/.env up -d --build --remove-orphans
docker compose --env-file /opt/goko/.env ps
REMOTE
echo "[OK] deploy: страница https://<WEB_HOST>, LiveKit wss://<LK_HOST> (значения в /opt/goko/.env)"
