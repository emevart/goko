#!/usr/bin/env bash
# Install script для Codex Cloud: без .env, KataGo, GPU, LiveKit и OpenAI.
set -euo pipefail

node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 18)) { console.error('[X] нужен Node 22.18+'); process.exit(1); } console.log('[OK] Node ' + process.versions.node)"
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npx playwright install --with-deps chromium
echo '[OK] cloud install: зависимости и Chromium готовы'
