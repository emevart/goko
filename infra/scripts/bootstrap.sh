#!/usr/bin/env bash
# Первичная настройка VPS Гоко: Docker, ufw, каталог /opt/goko. Идемпотентен.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

apt-get install -y -qq ufw rsync >/dev/null
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 3478/udp
ufw allow 50000:60000/udp
ufw --force enable

mkdir -p /opt/goko/web /opt/goko/src /opt/goko/data
if [ ! -f /opt/goko/.env ]; then
  cp /opt/goko/src/infra/.env.example /opt/goko/.env 2>/dev/null || echo "# заполни по infra/.env.example" > /opt/goko/.env
  chmod 600 /opt/goko/.env
  echo "[!] /opt/goko/.env создан пустым: заполни значения и запусти deploy.sh"
fi
echo "[OK] bootstrap: docker $(docker --version | cut -d' ' -f3), ufw включён, /opt/goko готов"
