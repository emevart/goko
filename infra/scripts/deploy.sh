#!/usr/bin/env bash
# Деплой на VPS: синхронизация репозитория, подстановка домена в livekit.yaml, compose up, статика.
# Использование: infra/scripts/deploy.sh [--host goko] [--web-dir apps/web/dist] [--build-web]
#   --build-web: собрать apps/web (npm run build:web) и выложить apps/web/dist как статику
# Синхронизация идёт через rsync; если rsync нет (Git Bash на Windows) — через tar по ssh.
set -euo pipefail
trap 'echo "[X] deploy: ошибка на строке $LINENO" >&2' ERR
HOST=goko
WEB_DIR=""
BUILD_WEB=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2;;
    --web-dir) WEB_DIR="$2"; shift 2;;
    --build-web) BUILD_WEB=1; shift;;
    *) echo "unknown arg $1"; exit 2;;
  esac
done
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "$BUILD_WEB" = 1 ]; then
  (cd "$ROOT" && npm run build:web)
  WEB_DIR="apps/web/dist"
fi

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

# Что не уезжает на VPS. Один список на обе ветки синхронизации: раньше он был
# скопирован дважды и разъезжался при первой же правке. Ни rsync, ни tar не читают
# .gitignore, поэтому игнорируемое в git приходится перечислять здесь заново.
# Шаблоны не привязаны к корню: 'dist' закрывает и apps/web/dist, и любой другой.
EXCLUDES=(
  .git                      # история репозитория, на VPS не нужна
  node_modules              # ставится на VPS сборкой образов
  data                      # состояние контейнеров
  '.env' '.env.*'           # секреты: .env живёт только в /opt/goko/.env
  'apps/go-engine/models'   # сети KataGo, сотни МБ, качаются в образ по sha256
  'apps/go-engine/bin'      # распакованная OpenCL-сборка KataGo для Windows
  dist build coverage       # артефакты сборки и покрытия
  '.superpowers'            # внутренние планы, брифы и журналы стадии
  'spike/log.jsonl'         # журнал спайка с расшифровками речи founder'а
  'spike/last-url.txt'      # ссылка с живым токеном
)
EXCLUDE_ARGS=()
for pattern in "${EXCLUDES[@]}"; do EXCLUDE_ARGS+=(--exclude "$pattern"); done

# репозиторий -> /opt/goko/src
if [ "$SYNC" = rsync ]; then
  rsync -az --delete "${EXCLUDE_ARGS[@]}" "$ROOT/" "$HOST:/opt/goko/src/"
else
  tar -C "$ROOT" -czf - "${EXCLUDE_ARGS[@]}" \
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
# Снапшоты партий пишет node (uid 1000) в контейнере game-server; bootstrap создал /opt/goko/data от root.
install -d -o 1000 -g 1000 /opt/goko/data/games
cd /opt/goko/src/infra
docker compose --env-file /opt/goko/.env up -d --build --remove-orphans
docker compose --env-file /opt/goko/.env ps
REMOTE
echo "[OK] deploy: страница https://<WEB_HOST>, LiveKit wss://<LK_HOST> (значения в /opt/goko/.env)"
