# Гоко, стадия 0: спайк и `infra/` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** За один день получить ответы на четыре вопроса спеки (голосовая петля с телефона в РФ без VPN; скорость KataGo с человеческой сетью на CX22 и на ПК; распознавание координат по-русски; текстовый канал к агенту) и оставить в репозитории каркас монорепы и `infra/` (Caddy + LiveKit на VPS). Код агента-спайка удаляется в последней задаче.

**Architecture:** Один VPS (Hetzner CX22) с `docker compose`: `caddy` (host network, TLS сам) и `livekit` (host network). Всё остальное на стадии 0 крутится на ПК founder'а: воркер-спайк на `@livekit/agents` с `gpt-realtime` ходит в LiveKit на VPS и в OpenAI через VPN на ПК; страница-спайк отдаётся Caddy как статика. KataGo замеряется скриптом отдельно на ПК (OpenCL) и на VPS (образ с Eigen).

**Tech Stack:** Node 22.22 (нативный запуск `.ts` без сборки, `erasableSyntaxOnly`), npm workspaces, TypeScript 5.9, vitest 5, `@livekit/agents` 1.8 + `@livekit/agents-plugin-openai` 1.8, `livekit-server-sdk` 2.18, `livekit-client` 2.22, LiveKit server `v1.9`+ (образ `livekit/livekit-server:latest` на момент выполнения зафиксировать тегом), Caddy 2, KataGo v1.18.1 (последний релиз с eigen/opencl-сборками), человеческая сеть `b18c384nbt-humanv0.bin.gz`.

**Spec:** `docs/superpowers/specs/2026-09-07-goko-voice-go-opponent-design.md` — разделы 8 (движок), 9 (речь, промпт), 11 (инфраструктура), 12 (текстовый канал), 13 (стадия 0), 14 (риски).

## Global Constraints

- Node `>=22.18` (нативное удаление типов); импорты внутри пакетов с расширением `.ts`; в tsconfig `erasableSyntaxOnly: true` (никаких `enum`, `namespace`, parameter properties).
- Язык доков, комментариев, коммитов — русский; код и идентификаторы — английский; без эмодзи; маркеры `[OK] [!] [FIX] [X] [WIP] [TODO]`.
- Секреты только в `.env` (локально и `/opt/goko/.env` на VPS); в git — `infra/.env.example`. Значения переменных не печатать.
- Координаты: столбцы `A B C D E F G H J K L M N` (без `I`), строки `1–13` снизу.
- Русские названия столбцов для промпта: A «а», B «бэ», C «цэ», D «дэ», E «е», F «эф», G «гэ», H «аш», J «джей», K «ка», L «эль», M «эм», N «эн».
- Модель `gpt-realtime`, голос `marin`, серверный VAD с перебиванием.
- Действия на VPS, в DNS, Hetzner и аудио-тесты с телефона выполняет founder; агент готовит скрипты и команды и ждёт результата.
- Личная инфраструктура founder'а (VPN-сервер, релей, ПК) в файлах репозитория не упоминается адресами и хостнеймами.

---

## Файловая структура стадии 0

```
package.json                 корень: workspaces, скрипты doctor/check/test/typecheck
tsconfig.base.json           общие опции TS (nodenext, strict, erasableSyntaxOnly)
tsconfig.json                корневой typecheck для packages/apps/scripts/spike
vitest.config.ts             один конфиг на все workspace'ы
.editorconfig, .gitattributes (eol=lf), .nvmrc
scripts/doctor.mjs           проверка окружения, коды возврата
infra/docker-compose.yml     caddy + livekit (стадия 0), сервисы приложений добавит стадия 1
infra/Caddyfile              go.<домен>: статика + /api/* -> API_UPSTREAM; lk.<домен> -> 127.0.0.1:7880
infra/livekit.yaml           порты, TURN/UDP, auto_create=false; ключи — из env LIVEKIT_KEYS
infra/.env.example           имена всех переменных
infra/scripts/bootstrap.sh   один раз на VPS: docker, ufw, /opt/goko
infra/scripts/deploy.sh      rsync + docker compose up -d --build + статика
infra/README.md              что делает founder руками, порядок, проверка
apps/go-engine/Dockerfile    KataGo eigen + сети (нужен для замера на VPS, остаётся на стадию 1)
apps/go-engine/config/analysis.cfg
apps/go-engine/models/README.md   откуда скачать сети (сами файлы в .gitignore)
spike/                       ВРЕМЕННО, удаляется в Task 9:
  README.md                  как запускать спайк
  agent.ts                   воркер: gpt-realtime по-русски, инструмент play_move в лог
  token.mjs                  выпуск токена с диспетчеризацией агента
  public/index.html          страница: микрофон, транскрипт, поле текста -> lk.chat
  chat.mjs                   текстовый канал из консоли
  phrases.md                 30 фраз с координатами
  katago-bench.mjs           замер genmove/analyze/score
docs/research/stage0-results.md   результаты и решения стадии 0
```

---

### Task 1: Каркас монорепы и `doctor`

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.editorconfig`, `.gitattributes`, `.nvmrc`, `scripts/doctor.mjs`, `scripts/doctor.test.ts`
- Modify: `.gitignore` (добавить `spike/log.jsonl`, `.agent-artifacts/`)

**Interfaces:**
- Produces: корневые скрипты `npm run doctor`, `npm test`, `npm run typecheck`, `npm run check`; функция `checkEnvNames(env, required)` в `scripts/doctor.mjs` (экспорт для теста).

- [ ] **Step 1: Файлы конфигурации**

`package.json`:

```json
{
  "name": "goko",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "doctor": "node scripts/doctor.mjs",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "check": "npm run typecheck && npm test"
  },
  "devDependencies": {
    "@types/node": "^22.19.0",
    "typescript": "^5.9.3",
    "vitest": "^5.0.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": false,
    "noEmit": true,
    "skipLibCheck": true,
    "allowJs": true,
    "types": ["node"]
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "include": ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts", "scripts/**/*.ts", "spike/**/*.ts", "vitest.config.ts"],
  "exclude": ["apps/web/**"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
```

`.editorconfig`:

```
root = true
[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
```

`.gitattributes`: `* text=auto eol=lf`. `.nvmrc`: `22`.

Добавить в `.gitignore` строки `spike/log.jsonl` и `.agent-artifacts/`.

- [ ] **Step 2: Тест на `doctor`**

`scripts/doctor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkEnvNames, checkNodeVersion } from './doctor.mjs';

describe('doctor', () => {
  it('finds missing env names without printing values', () => {
    const res = checkEnvNames({ APP_KEY: 'x' }, ['APP_KEY', 'ENGINE_KEY']);
    expect(res.missing).toEqual(['ENGINE_KEY']);
    expect(res.present).toEqual(['APP_KEY']);
  });

  it('accepts node >= 22.18 and rejects older', () => {
    expect(checkNodeVersion('v22.18.0').ok).toBe(true);
    expect(checkNodeVersion('v22.22.0').ok).toBe(true);
    expect(checkNodeVersion('v22.12.0').ok).toBe(false);
    expect(checkNodeVersion('v20.19.0').ok).toBe(false);
  });
});
```

- [ ] **Step 3: Запустить тест, убедиться, что падает**

Run: `npm install && npx vitest run scripts`
Expected: FAIL — `Cannot find module './doctor.mjs'`.

- [ ] **Step 4: Реализация `scripts/doctor.mjs`**

```js
#!/usr/bin/env node
// Проверка окружения для агентов и founder'а. Ничего не меняет, значения env не печатает.
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function checkNodeVersion(version) {
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return { ok: false, reason: `cannot parse ${version}` };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const ok = major > 22 || (major === 22 && minor >= 18);
  return { ok, reason: ok ? '' : `need >= 22.18, got ${version}` };
}

export function checkEnvNames(env, required) {
  const present = required.filter((k) => env[k] !== undefined && env[k] !== '');
  const missing = required.filter((k) => !present.includes(k));
  return { present, missing };
}

export function readDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function has(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let failed = false;
  const ok = (msg) => console.log(`[OK] ${msg}`);
  const warn = (msg) => console.log(`[!] ${msg}`);
  const fail = (msg) => {
    failed = true;
    console.log(`[X] ${msg}`);
  };

  const nv = checkNodeVersion(process.version);
  nv.ok ? ok(`node ${process.version}`) : fail(`node: ${nv.reason}`);
  has('npm --version') ? ok('npm') : fail('npm not found');
  has('docker --version') ? ok('docker (нужен только для образа движка)') : warn('docker не найден: образ движка не собрать, для dev не нужен');
  has('git --version') ? ok('git') : fail('git not found');

  const env = { ...readDotEnv(path.join(root, '.env')), ...process.env };
  const required = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'OPENAI_API_KEY', 'APP_KEY', 'ENGINE_KEY'];
  const res = checkEnvNames(env, required);
  res.present.length ? ok(`env: ${res.present.join(', ')}`) : warn('env: ни одной переменной из .env не задано');
  if (res.missing.length) warn(`env отсутствуют: ${res.missing.join(', ')} (см. infra/.env.example)`);

  const kb = env.KATAGO_BIN;
  if (!kb) warn('KATAGO_BIN не задан: движок будет недоступен, тесты движка пропускаются');
  else if (!existsSync(kb)) fail(`KATAGO_BIN указывает на несуществующий файл`);
  else ok('KATAGO_BIN найден');

  const models = path.join(root, 'apps/go-engine/models');
  if (existsSync(models)) {
    const need = ['b18c384nbt-humanv0.bin.gz'];
    for (const f of need) existsSync(path.join(models, f)) ? ok(`модель ${f}`) : warn(`нет модели ${f} (apps/go-engine/models/README.md)`);
  }

  console.log(failed ? '[X] doctor: есть блокирующие проблемы' : '[OK] doctor: можно работать');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 5: Тесты и typecheck зелёные**

Run: `npm run check`
Expected: typecheck без ошибок (в `include` пока только `scripts`), `2 passed`.

- [ ] **Step 6: `npm run doctor` печатает отчёт**

Run: `npm run doctor`
Expected: строки `[OK] node v22...`, предупреждения про env и `KATAGO_BIN`, выход с кодом 0 (или 1, если нет git/npm).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json tsconfig.json vitest.config.ts .editorconfig .gitattributes .nvmrc .gitignore scripts/doctor.mjs scripts/doctor.test.ts
git commit -m "scaffold: каркас монорепы, vitest, doctor"
```

---

### Task 2: `infra/` — compose, Caddy, LiveKit, скрипты VPS

**Files:**
- Create: `infra/docker-compose.yml`, `infra/Caddyfile`, `infra/livekit.yaml`, `infra/.env.example`, `infra/scripts/bootstrap.sh`, `infra/scripts/deploy.sh`, `infra/README.md`

**Interfaces:**
- Produces: переменные `.env`: `DOMAIN`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`, `APP_KEY`, `ENGINE_KEY`, `API_UPSTREAM` (по умолчанию `127.0.0.1:8787`), `LIVEKIT_IMAGE`; адреса `https://go.$DOMAIN` (статика из `/opt/goko/web`, `/api/*` → `API_UPSTREAM`) и `wss://lk.$DOMAIN` (LiveKit). Скрипт `deploy.sh [--web-dir DIR]`.

- [ ] **Step 1: `infra/.env.example`**

```
# Скопировать в /opt/goko/.env на VPS и в .env в корне репозитория на ПК. Значения не коммитить.
DOMAIN=example.org                 # записи go.DOMAIN и lk.DOMAIN -> адрес VPS
LIVEKIT_IMAGE=livekit/livekit-server:v1.9.11   # зафиксировать актуальный тег при выполнении
LIVEKIT_API_KEY=                   # openssl rand -hex 8
LIVEKIT_API_SECRET=                # openssl rand -hex 32
LIVEKIT_URL=wss://lk.example.org   # для воркера и game-server на ПК
OPENAI_API_KEY=                    # только voice-agent
APP_KEY=                           # заголовок X-App-Key для /api/*; openssl rand -hex 16
ENGINE_KEY=                        # заголовок X-Engine-Key между game-server и go-engine
API_UPSTREAM=127.0.0.1:8787        # prod: контейнер game-server; dev: <tailscale-ip-ПК>:8787
AGENT_NAME=goko                    # на ПК в dev-режиме: goko-dev
KATAGO_BIN=                        # только на ПК: путь к katago.exe (OpenCL-сборка)
```

- [ ] **Step 2: `infra/livekit.yaml`**

```yaml
# LiveKit на VPS Гоко. Ключи приходят из переменной окружения LIVEKIT_KEYS (compose), не отсюда.
port: 7880
bind_addresses:
  - ""
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
room:
  auto_create: false       # комнату создаёт только токен с roomConfig из game-server
  empty_timeout: 300
  max_participants: 4
turn:
  enabled: true
  domain: __TURN_DOMAIN__  # deploy.sh подставляет lk.$DOMAIN; TURN только UDP в v1
  udp_port: 3478
logging:
  level: info
  json: false
```

- [ ] **Step 3: `infra/Caddyfile`**

```
{
  email {$ACME_EMAIL}
}

go.{$DOMAIN} {
  encode zstd gzip
  handle /api/* {
    reverse_proxy {$API_UPSTREAM} {
      flush_interval -1
    }
  }
  handle {
    root * /srv/web
    try_files {path} /index.html
    file_server
  }
}

lk.{$DOMAIN} {
  reverse_proxy 127.0.0.1:7880
}
```

`flush_interval -1` обязателен: без него SSE копится в буфере прокси.

- [ ] **Step 4: `infra/docker-compose.yml`**

```yaml
name: goko
services:
  caddy:
    image: caddy:2
    network_mode: host
    restart: unless-stopped
    environment:
      DOMAIN: ${DOMAIN}
      ACME_EMAIL: ${ACME_EMAIL:-admin@${DOMAIN}}
      API_UPSTREAM: ${API_UPSTREAM:-127.0.0.1:8787}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - /opt/goko/web:/srv/web:ro
      - caddy_data:/data
      - caddy_config:/config

  livekit:
    image: ${LIVEKIT_IMAGE:-livekit/livekit-server:latest}
    network_mode: host
    restart: unless-stopped
    command: --config /etc/livekit.yaml
    environment:
      LIVEKIT_KEYS: "${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"
    volumes:
      - /opt/goko/livekit.yaml:/etc/livekit.yaml:ro

volumes:
  caddy_data:
  caddy_config:
```

- [ ] **Step 5: `infra/scripts/bootstrap.sh`** (founder запускает один раз под root на свежем Ubuntu 24.04)

```bash
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
```

- [ ] **Step 6: `infra/scripts/deploy.sh`** (с ПК; нужен алиас `goko` в `~/.ssh/config` founder'а)

```bash
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
sed "s/__TURN_DOMAIN__/lk.${DOMAIN}/" /opt/goko/src/infra/livekit.yaml > /opt/goko/livekit.yaml
cd /opt/goko/src/infra
docker compose --env-file /opt/goko/.env up -d --build --remove-orphans
docker compose --env-file /opt/goko/.env ps
REMOTE
echo "[OK] deploy: https://go.<DOMAIN> и wss://lk.<DOMAIN>"
```

- [ ] **Step 7: `infra/README.md`**

Содержание: (1) что делает founder: создать CX22 Ubuntu 24.04 в Хельсинки, добавить SSH-ключ, алиас `goko` в `~/.ssh/config`, DNS `go.` и `lk.` на адрес VPS; (2) `scp infra/scripts/bootstrap.sh goko:/root/ && ssh goko bash /root/bootstrap.sh`; (3) заполнить `/opt/goko/.env` (генерация ключей: `openssl rand -hex 8`, `openssl rand -hex 32`, `openssl rand -hex 16`); (4) `infra/scripts/deploy.sh`; (5) проверка: `curl -s https://lk.<домен>/` отдаёт `OK`, `curl -sI https://go.<домен>/` отдаёт 200; (6) порты и почему; (7) откат: `docker compose down`; (8) рескейл CX22 → CX32 в панели Hetzner без переезда (только CPU/RAM). Без адресов и личных данных.

- [ ] **Step 8: Проверка compose локально**

Run (на ПК, где есть Docker): `cd infra && DOMAIN=example.org LIVEKIT_API_KEY=k LIVEKIT_API_SECRET=s docker compose config >/dev/null && echo "[OK] compose"`
Expected: `[OK] compose`. `bash -n infra/scripts/bootstrap.sh infra/scripts/deploy.sh` без ошибок.

- [ ] **Step 9: Commit**

```bash
git add infra
git commit -m "infra: compose с caddy и livekit, скрипты bootstrap и deploy"
```

- [ ] **Step 10: Передать founder'у чек-лист** (VPS, DNS, `.env`, bootstrap, deploy) и дождаться: `curl -s https://lk.<домен>/` → `OK`. Пока founder делает это, продолжать Task 3–4 (они не зависят от VPS).

---

### Task 3: Образ движка и замер KataGo

**Files:**
- Create: `apps/go-engine/Dockerfile`, `apps/go-engine/config/analysis.cfg`, `apps/go-engine/models/README.md`, `apps/go-engine/package.json` (минимальный, только имя), `spike/katago-bench.mjs`, `spike/README.md`

**Interfaces:**
- Produces: `analysis.cfg` с `reportAnalysisWinratesAs = BLACK`; образ `goko-engine-base` с бинарём `/opt/katago/katago` и сетями `/opt/katago/models/{main.bin.gz,human.bin.gz}`; скрипт `node spike/katago-bench.mjs --bin <katago> --model <main> --human <human> [--config <cfg>]`, печатает таблицу мс.

- [ ] **Step 1: `apps/go-engine/models/README.md`**

```markdown
# Сети KataGo

Файлы в этой папке в git не попадают. Скачать в `apps/go-engine/models/`:

- Человеческая (обязательна): `b18c384nbt-humanv0.bin.gz`
  https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz
- Основная, кандидат 1 (быстрая): `kata1-b10c128-s1141046784-d204142634.bin.gz`
  https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.bin.gz
- Основная, кандидат 2 (сильнее): `kata1-b15c192-s1672170752-d466197061.bin.gz`
  https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b15c192-s1672170752-d466197061.bin.gz

Если ссылка на media.katagotraining.org отдаёт 404, взять файл с той же архитектурой
в разделе «older networks» на https://katagotraining.org/networks/ и записать имя сюда.

Бинарь на ПК: `katago-v1.18.1-opencl-windows-x64.zip` из
https://github.com/lightvector/KataGo/releases/tag/v1.18.1, распаковать в
`apps/go-engine/bin/` (в git не попадает), путь к `katago.exe` — в `KATAGO_BIN`.
Первый запуск OpenCL тюнит ядра 1–3 минуты; это нормально.
```

- [ ] **Step 2: `apps/go-engine/config/analysis.cfg`**

```
logDir = analysis_logs
logAllRequests = false
logAllResponses = false
logSearchInfo = false
reportAnalysisWinratesAs = BLACK
maxVisits = 400
numAnalysisThreads = 1
numSearchThreadsPerAnalysisThread = 2
nnMaxBatchSize = 8
nnCacheSizePowerOfTwo = 18
nnMutexPoolSizePowerOfTwo = 14
nnRandomize = true
# Eigen (CPU) на VPS: 2 потока; на GPU не используется
numEigenThreadsPerModel = 2
```

- [ ] **Step 3: `apps/go-engine/Dockerfile`** (пока только базовый образ; обёртку добавит стадия 1)

```dockerfile
FROM ubuntu:24.04 AS katago
ARG KATAGO_VERSION=v1.18.1
ARG KATAGO_ASSET=katago-v1.18.1-eigenavx2-linux-x64.zip
ARG MAIN_NET_URL=https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b10c128-s1141046784-d204142634.bin.gz
ARG HUMAN_NET_URL=https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates libzip4 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/katago
RUN curl -fsSL -o katago.zip https://github.com/lightvector/KataGo/releases/download/${KATAGO_VERSION}/${KATAGO_ASSET} \
 && unzip -q katago.zip && rm katago.zip && chmod +x katago
RUN mkdir models && curl -fsSL -o models/main.bin.gz "${MAIN_NET_URL}" && curl -fsSL -o models/human.bin.gz "${HUMAN_NET_URL}"
COPY config/analysis.cfg /opt/katago/analysis.cfg
# Стадия 1 добавит слой с Node и обёрткой; для замера стадии 0 достаточно этого образа.
CMD ["/opt/katago/katago", "version"]
```

Примечание для CX22 без AVX2 (проверить `grep -c avx2 /proc/cpuinfo` на VPS): собирать с `--build-arg KATAGO_ASSET=katago-v1.18.1-eigen-linux-x64.zip`.

- [ ] **Step 4: `spike/katago-bench.mjs`**

```js
#!/usr/bin/env node
// Замер KataGo analysis engine на 13x13: humanPolicy (1 visit), genmove (10), analyze (50), score (400).
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [])).filter((p) => p.length));
const bin = args.bin ?? process.env.KATAGO_BIN;
const model = args.model;
const human = args.human;
const config = args.config ?? 'apps/go-engine/config/analysis.cfg';
if (!bin || !model || !human) {
  console.error('usage: node spike/katago-bench.mjs --bin <katago> --model <main.bin.gz> --human <human.bin.gz> [--config cfg]');
  process.exit(2);
}

const proc = spawn(bin, ['analysis', '-config', config, '-model', model, '-human-model', human], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: proc.stdout });
const waiting = new Map();
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const w = waiting.get(msg.id);
  if (w && msg.isDuringSearch !== true) { waiting.delete(msg.id); w(msg); }
});

let n = 0;
function query(q) {
  const id = `q${++n}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ id, ...q }) + '\n');
  });
}

const moves = [['B', 'D4'], ['W', 'K10'], ['B', 'K4'], ['W', 'D10'], ['B', 'G7'], ['W', 'C3'], ['B', 'D3'], ['W', 'C4'], ['B', 'C5'], ['W', 'B5']];
const base = { rules: 'chinese', komi: 7.5, boardXSize: 13, boardYSize: 13, moves };

async function timed(label, q) {
  const t0 = performance.now();
  const r = await query(q);
  const ms = Math.round(performance.now() - t0);
  const root = r.rootInfo ?? {};
  console.log(`${label.padEnd(22)} ${String(ms).padStart(6)} ms  visits=${root.visits ?? '-'} winrateB=${root.winrate?.toFixed(3) ?? '-'} lead=${root.scoreLead?.toFixed(1) ?? '-'} human=${Array.isArray(r.humanPolicy) ? 'yes' : 'NO'}`);
  return r;
}

console.log('warmup...');
await timed('warmup', { ...base, maxVisits: 2 });
for (const rank of ['rank_20k', 'rank_10k', 'rank_1d']) {
  const r = await timed(`humanPolicy ${rank}`, { ...base, maxVisits: 1, includePolicy: true, overrideSettings: { humanSLProfile: rank } });
  const hp = r.humanPolicy ?? [];
  const top = hp.map((p, i) => [p, i]).filter(([p]) => p > 0).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([p, i]) => `${i}:${p.toFixed(3)}`);
  console.log(`   top humanPolicy idx: ${top.join(' ')} (pass idx=${hp.length - 1})`);
}
await timed('genmove 10 visits', { ...base, maxVisits: 10, includePolicy: true, overrideSettings: { humanSLProfile: 'rank_10k' } });
await timed('analyze 50 visits', { ...base, maxVisits: 50, includeOwnership: true });
await timed('score 400 visits', { ...base, maxVisits: 400, includeOwnership: true });
proc.stdin.end();
proc.kill();
```

- [ ] **Step 5: Замер на ПК** (founder скачал бинарь и сети по README)

Run: `node spike/katago-bench.mjs --bin apps/go-engine/bin/katago.exe --model apps/go-engine/models/kata1-b10c128-s1141046784-d204142634.bin.gz --human apps/go-engine/models/b18c384nbt-humanv0.bin.gz`
Expected: все строки с `human=yes`; на RTX 3060 `humanPolicy` < 300 мс, `analyze 50` < 1 с. Если `human=NO` — в `-human-model` подан не тот файл или KataGo старше 1.15.

- [ ] **Step 6: Замер на VPS** (после Task 2 Step 10; founder выполняет команды с ПК)

```bash
infra/scripts/deploy.sh
ssh goko 'cd /opt/goko/src/apps/go-engine && grep -c avx2 /proc/cpuinfo && docker build -t goko-engine-base .'
ssh goko 'docker run --rm -v /opt/goko/src/spike:/spike -v /opt/goko/src/apps/go-engine/config:/cfg goko-engine-base sh -c "apt-get install -y -qq nodejs >/dev/null 2>&1; node /spike/katago-bench.mjs --bin /opt/katago/katago --model /opt/katago/models/main.bin.gz --human /opt/katago/models/human.bin.gz --config /cfg/analysis.cfg"'
```

Если `nodejs` в образе нет (ubuntu 24.04 даёт Node 18 — для скрипта достаточно), альтернатива: `docker run ... --entrypoint /opt/katago/katago goko-engine-base analysis -config ... ` и вручную вставить одну строку запроса из скрипта. Записать числа для `b10c128`; повторить сборку с `--build-arg MAIN_NET_URL=<b15c192>` и записать.

Expected (цели раздела 8): genmove < 2 с, analyze < 4 с, score < 10 с. Не уложились с b10 → решение о рескейле до CX32 (перезамерить).

- [ ] **Step 7: Commit**

```bash
git add apps/go-engine/Dockerfile apps/go-engine/config/analysis.cfg apps/go-engine/models/README.md apps/go-engine/package.json spike/katago-bench.mjs spike/README.md
git commit -m "engine: образ KataGo с сетями, конфиг анализа, скрипт замера"
```

`apps/go-engine/package.json` на этой стадии: `{ "name": "@goko/go-engine", "private": true, "type": "module", "version": "0.0.0" }`.

---

### Task 4: Агент-спайк, токен, страница

**Files:**
- Create: `spike/package.json`, `spike/agent.ts`, `spike/token.mjs`, `spike/public/index.html`, `spike/phrases.md`
- Modify: `package.json` (добавить `"spike"` в workspaces на время стадии 0)

**Interfaces:**
- Produces: воркер с `agentName` из `AGENT_NAME` (по умолчанию `goko`); токен с диспетчеризацией того же имени; страница читает `#token=...&url=...` из хэша.

- [ ] **Step 1: `spike/package.json`**

```json
{
  "name": "goko-spike",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "scripts": {
    "agent": "node --env-file-if-exists=../.env agent.ts dev",
    "token": "node --env-file-if-exists=../.env token.mjs",
    "chat": "node --env-file-if-exists=../.env chat.mjs"
  },
  "dependencies": {
    "@livekit/agents": "^1.8.0",
    "@livekit/agents-plugin-openai": "^1.8.0",
    "@livekit/protocol": "^1.50.4",
    "@livekit/rtc-node": "^0.13.34",
    "livekit-server-sdk": "^2.18.0",
    "zod": "^4.5.4"
  }
}
```

Затем `npm install` в корне (workspace `spike` добавлен).

- [ ] **Step 2: `spike/agent.ts`**

```ts
// Спайк: Гоко без движка. Проверяем голосовую петлю, русский, распознавание координат, текстовый канал.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type JobContext, ServerOptions, cli, defineAgent, llm, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { z } from 'zod';

const LOG = new URL('./log.jsonl', import.meta.url);
function log(entry: Record<string, unknown>) {
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

const INSTRUCTIONS = `Ты Гоко, соперник по го. Говоришь по-русски, коротко, как живой игрок за доской.
Когда человек называет ход (буква столбца и номер строки), сразу вызывай play_move с координатой латиницей, например "D4",
и повтори ход вслух. Столбцы произносятся: A «а», B «бэ», C «цэ», D «дэ», E «е», F «эф», G «гэ», H «аш», J «джей»,
K «ка», L «эль», M «эм», N «эн»; буквы I на доске нет. Реплики до двух предложений.
Свой ответный ход возьми из результата инструмента и назови его.`;

let counter = 0;
const REPLIES = ['K10', 'D10', 'K4', 'G7', 'C3', 'J9', 'E11'];

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    log({ event: 'job', room: ctx.room.name, metadata: ctx.job.metadata });

    const play_move = llm.tool({
      description: 'Применить ход человека. coord — латиницей, буква A–N без I и число 1–13, например D4.',
      parameters: z.object({ coord: z.string().describe('Например D4') }),
      execute: async ({ coord }) => {
        const reply = REPLIES[counter++ % REPLIES.length]!;
        log({ event: 'tool', name: 'play_move', coord, reply });
        return { ok: true, yourMove: coord, myMove: reply };
      },
    });

    const agent = new voice.Agent({ instructions: INSTRUCTIONS, tools: { play_move } });
    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: 'gpt-realtime',
        voice: 'marin',
        turnDetection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        inputAudioTranscription: { model: 'gpt-4o-mini-transcribe', language: 'ru' },
      }),
    });

    session.on('user_input_transcribed', (ev) => {
      if (ev.isFinal) log({ event: 'user', text: ev.transcript });
    });
    session.on('conversation_item_added', (ev) => {
      if (ev.item.role === 'assistant') log({ event: 'agent', text: ev.item.textContent });
    });

    await session.start({ agent, room: ctx.room });
    await session.generateReply({ instructions: 'Поздоровайся одной фразой и предложи назвать ход.' });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME ?? 'goko' }));
```

Если тип `turnDetection` в установленной версии плагина не принимает эти поля — оставить `turnDetection` по умолчанию (`semantic_vad`) и записать в результаты, какой вариант перебивает лучше.

- [ ] **Step 3: `spike/token.mjs`**

```js
// Выпуск токена участника с диспетчеризацией агента. Печатает URL страницы спайка.
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { AccessToken } from 'livekit-server-sdk';

const room = process.argv[2] ?? `spike-${Date.now().toString(36)}`;
const agentName = process.env.AGENT_NAME ?? 'goko';
const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: 'phone', ttl: '2h' });
// roomCreate обязателен: в livekit.yaml auto_create=false, комнату создаёт первый вход с этим правом и roomConfig.
at.addGrant({ roomJoin: true, roomCreate: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
at.roomConfig = new RoomConfiguration({
  agents: [new RoomAgentDispatch({ agentName, metadata: JSON.stringify({ sessionId: room }) })],
});
const token = await at.toJwt();
const url = process.env.LIVEKIT_URL;
const domain = process.env.DOMAIN;
console.log(`room: ${room}`);
console.log(`https://go.${domain}/#url=${encodeURIComponent(url)}&token=${token}`);
```

- [ ] **Step 4: `spike/public/index.html`** (одна страница без сборки; livekit-client с CDN)

```html
<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Гоко: спайк</title>
<style>
body{font-family:system-ui;margin:0;padding:12px;background:#111;color:#eee}
button{font-size:18px;padding:12px 16px;margin:4px}
#log{white-space:pre-wrap;font-size:16px;line-height:1.4;max-height:60vh;overflow:auto;border:1px solid #444;padding:8px}
input{font-size:16px;padding:8px;width:70%}
</style></head><body>
<button id="mic">Микрофон</button><span id="status">не подключено</span>
<div id="log"></div>
<input id="text" placeholder="текст в lk.chat"><button id="send">Отправить</button>
<script src="https://cdn.jsdelivr.net/npm/livekit-client@2.22.3/dist/livekit-client.umd.min.js"></script>
<script>
const { Room, RoomEvent } = LivekitClient;
const params = new URLSearchParams(location.hash.slice(1));
const logEl = document.getElementById('log');
const show = (who, text) => { logEl.textContent += `${who}: ${text}\n`; logEl.scrollTop = logEl.scrollHeight; };
const room = new Room();
room.on(RoomEvent.TrackSubscribed, (track) => { if (track.kind === 'audio') document.body.appendChild(track.attach()); });
room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
  let text = '';
  for await (const chunk of reader) text += chunk;
  const final = reader.info.attributes?.['lk.transcription_final'];
  if (final === 'false') return;
  show(participant?.identity ?? '?', text);
});
document.getElementById('mic').onclick = async () => {
  await room.connect(params.get('url'), params.get('token'));
  await room.startAudio();
  await room.localParticipant.setMicrophoneEnabled(true);
  document.getElementById('status').textContent = 'в комнате ' + room.name;
};
document.getElementById('send').onclick = async () => {
  const t = document.getElementById('text').value;
  await room.localParticipant.sendText(t, { topic: 'lk.chat' });
  show('я (текст)', t);
};
</script></body></html>
```

- [ ] **Step 5: `spike/phrases.md`** — 30 фраз, каждая с ожидаемой координатой; по 2–3 на трудные буквы:

```
| № | Фраза | Ожидаем |
| 1 | дэ четыре | D4 |
| 2 | ка десять | K10 |
| 3 | цэ три | C3 |
| 4 | е одиннадцать | E11 |
| 5 | джей девять | J9 |
| 6 | аш семь | H7 |
| 7 | эф пять | F5 |
| 8 | гэ восемь | G8 |
| 9 | бэ два | B2 |
| 10 | а один | A1 |
| 11 | эль двенадцать | L12 |
| 12 | эм тринадцать | M13 |
| 13 | эн шесть | N6 |
| 14 | ход дэ десять | D10 |
| 15 | ставлю на е три | E3 |
| 16 | цэ одиннадцать, пожалуйста | C11 |
| 17 | ка четыре | K4 |
| 18 | бэ восемь | B8 |
| 19 | гэ семь | G7 |
| 20 | джей три | J3 |
| 21 | аш десять | H10 |
| 22 | эф двенадцать | F12 |
| 23 | а тринадцать | A13 |
| 24 | эн один | N1 |
| 25 | эль пять | L5 |
| 26 | эм девять | M9 |
| 27 | дэ дэ... нет, е четыре | E4 |
| 28 | ка десять, точнее ка одиннадцать | K11 |
| 29 | пас | (без play_move) |
| 30 | сдаюсь | (без play_move) |
```

- [ ] **Step 6: Typecheck и запуск воркера**

Run: `npm run typecheck && npm run agent -w spike`
Expected: воркер регистрируется (`registered worker` в логе) с `agentName goko`. Требует `.env` в корне с `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`, `DOMAIN`.

- [ ] **Step 7: Деплой страницы и проверка founder'ом**

```bash
infra/scripts/deploy.sh --web-dir spike/public
npm run token -w spike
```

Founder открывает напечатанный URL на телефоне (Wi-Fi, затем LTE), нажимает «Микрофон», ведёт диалог; произносит 30 фраз из `phrases.md`, отмечает в таблице, что распознано. Агент-разработчик после каждого прогона считает по `spike/log.jsonl`: доля `tool.coord == ожидаемое`.

Expected: приветствие слышно до ~2 с после входа; ответ на фразу до ~1,5 с; перебивание останавливает речь; 90 %+ координат совпало. Если звук не идёт на LTE, но идёт на Wi-Fi — записать; это ветка «TURN/TLS 443» из раздела 14 спеки.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json spike/package.json spike/agent.ts spike/token.mjs spike/public/index.html spike/phrases.md
git commit -m "spike: агент gpt-realtime, токен, страница, фразы для проверки координат"
```

---

### Task 5: Текстовый канал из консоли

**Files:**
- Create: `spike/chat.mjs`

**Interfaces:**
- Produces: `node spike/chat.mjs <room>`: входит в комнату участником `dev-chat`, шлёт строки stdin в `lk.chat`, печатает всё из `lk.transcription`. Прототип `scripts/chat.mjs` стадии 1.

- [ ] **Step 1: `spike/chat.mjs`**

```js
// Текстовый канал к агенту без микрофона: stdin -> lk.chat, lk.transcription -> stdout.
import readline from 'node:readline';
import { Room, RoomEvent } from '@livekit/rtc-node';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { AccessToken } from 'livekit-server-sdk';

const roomName = process.argv[2] ?? `chat-${Date.now().toString(36)}`;
const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: 'dev-chat', ttl: '1h' });
at.addGrant({ roomJoin: true, roomCreate: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
at.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: process.env.AGENT_NAME ?? 'goko', metadata: JSON.stringify({ sessionId: roomName }) })] });
const token = await at.toJwt();

const room = new Room();
room.registerTextStreamHandler('lk.transcription', async (reader, participantInfo) => {
  let text = '';
  for await (const chunk of reader) text += chunk;
  if (reader.info.attributes?.['lk.transcription_final'] === 'false') return;
  console.log(`[${participantInfo.identity}] ${text}`);
});
room.on(RoomEvent.Disconnected, () => process.exit(0));
await room.connect(process.env.LIVEKIT_URL, token, { autoSubscribe: true, dynacast: false });
console.log(`[OK] в комнате ${roomName}; пиши фразы, Ctrl+C — выход`);

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  await room.localParticipant.sendText(line, { topic: 'lk.chat' });
}
```

- [ ] **Step 2: Прогон**

Run (воркер из Task 4 запущен): `npm run chat -w spike` → ввести `давай партию`, `дэ четыре`, `кто впереди`.
Expected: печатаются реплики агента с identity агента; в `spike/log.jsonl` появляется `tool play_move coord D4`. Если `sendText` в `@livekit/rtc-node` установленной версии отсутствует — использовать `room.localParticipant.publishData(new TextEncoder().encode(line), { topic: 'lk.chat', reliable: true })` и записать в результаты, что текстовый вход требует data-канала.

- [ ] **Step 3: Commit**

```bash
git add spike/chat.mjs
git commit -m "spike: текстовый канал lk.chat из консоли"
```

---

### Task 6: Замер стоимости и запасной конвейер (только если голос Realtime не устроил)

**Files:**
- Modify: `spike/agent.ts` (переменная `VOICE_MODE`)

- [ ] **Step 1: Ветка `pipeline` в `spike/agent.ts`** — заменить конструктор сессии на:

```ts
const mode = process.env.VOICE_MODE ?? 'realtime';
const session = mode === 'pipeline'
  ? new voice.AgentSession({
      stt: new openai.STT({ model: 'gpt-4o-transcribe', language: 'ru' }),
      llm: new openai.LLM({ model: 'gpt-4.1-mini' }),
      tts: new openai.TTS({ model: 'gpt-4o-mini-tts', voice: 'marin', instructions: 'Говори по-русски спокойно, как игрок за доской.' }),
      vad: await silero.VAD.load(),
    })
  : new voice.AgentSession({ llm: new openai.realtime.RealtimeModel({ /* как выше */ }) });
```

Добавить `@livekit/agents-plugin-silero` в `spike/package.json` и `import * as silero from '@livekit/agents-plugin-silero'`.

- [ ] **Step 2: Прогон 10 фраз в обоих режимах**, записать задержку (по ощущению и по логу `speech_created`), качество голоса по-русски и стоимость из биллинга OpenAI за оба прогона.

---

### Task 7: Результаты стадии 0 и решения

**Files:**
- Create: `docs/research/stage0-results.md`
- Modify: `docs/NOW.md`, спека (раздел 8 — выбранная сеть; раздел 11 — CX22/CX32; раздел 9 — realtime/pipeline)

- [ ] **Step 1: `docs/research/stage0-results.md`** по шаблону:

```markdown
---
status: done
area: research
updated: <дата>
---

# Стадия 0: результаты

## Голосовая петля (телефон в РФ, без VPN)
| Сеть | Соединение (UDP/TURN) | Приветствие, с | Ответ, с | Перебивание |
| Wi-Fi дома | | | | |
| LTE, оператор <без названия> | | | | |

## Координаты: N из 30 распознано (список промахов и что сказал транскрипт)

## KataGo 13x13
| Где | Сеть | humanPolicy, мс | genmove 10, мс | analyze 50, мс | score 400, мс |
| ПК OpenCL | b10 | | | | |
| VPS CX22 | b10 | | | | |
| VPS CX22 | b15 | | | | |

## Текстовый канал: работает / что понадобилось

## Стоимость: $ за минуту realtime; pipeline (если мерили)

## Решения
- VPS: остаёмся на CX22 / рескейл до CX32
- Основная сеть: b10c128 / b15c192
- Речь: realtime / pipeline; turnDetection: server_vad / semantic_vad
- Мобильные сети: нужна ли развязка TURN/TLS 443 уже на стадии 1
```

- [ ] **Step 2: Внести решения в спеку** (разделы 8, 9, 11), обновить `docs/NOW.md` (сделано, следующий шаг — план стадии 1 ядро).

- [ ] **Step 3: Commit**

```bash
git add docs/research/stage0-results.md docs/NOW.md docs/superpowers/specs/2026-09-07-goko-voice-go-opponent-design.md
git commit -m "docs: результаты стадии 0 и решения по сети, VPS и речи"
```

---

### Task 8: Удалить спайк

- [ ] **Step 1:** `git rm -r spike`, убрать `"spike"` из `workspaces` в `package.json`, `npm install`, `npm run check` зелёный.
- [ ] **Step 2:** Commit: `git commit -m "spike: удалён, выводы в docs/research/stage0-results.md"`.

---

## Самопроверка плана

- Покрытие раздела 13 (стадия 0): VPS + Caddy + LiveKit — Task 2; стартовый агент по-русски с телефона — Task 4; KataGo на VPS и ПК — Task 3; 30 фраз — Task 4 Step 5, 7; текстовый канал — Task 5; решение realtime/pipeline — Task 6–7; «код агента выбрасывается, `infra/` остаётся» — Task 8.
- Заглушек нет: все файлы с содержимым; единственные «если» — задокументированные ветки на случай расхождения версий библиотек, с конкретной альтернативой.
- Типы: `AGENT_NAME` читается одинаково в `agent.ts`, `token.mjs`, `chat.mjs`; `lk.chat` / `lk.transcription` совпадают между страницей, консолью и RoomIO по умолчанию.
