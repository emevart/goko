#!/usr/bin/env bash
# Install script для Codex Cloud: без .env, KataGo, GPU, LiveKit и OpenAI.
set -euo pipefail

node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 18)) { console.error('[X] нужен Node 22.18+'); process.exit(1); } console.log('[OK] Node ' + process.versions.node)"
ONNXRUNTIME_NODE_INSTALL=skip npm ci

playwright_install=(install --with-deps chromium)
if [[ "$(uname -s)" == "Linux" && "${EUID}" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true >/dev/null 2>&1; then
    echo '[!] Нет root/passwordless sudo: используем системные библиотеки образа'
    playwright_install=(install chromium)
  fi
fi

npx playwright "${playwright_install[@]}"
node --input-type=module -e "import { chromium } from '@playwright/test'; const browser = await chromium.launch({ headless: true }); await browser.close(); console.log('[OK] Chromium запускается и закрывается')"
echo '[OK] cloud install: зависимости и Chromium готовы'
