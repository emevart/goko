---
status: living
area: process
updated: 2026-10-05
---

# Разработка агентами

Как агент (Claude Code, Codex и другие) работает в этом репозитории. Правила
и границы — в `CLAUDE.md`; здесь практика.

## Сессия

1. Прочитать `CLAUDE.md`, `docs/NOW.md`, нужный раздел спеки и план текущей
   стадии в `docs/superpowers/plans/`.
2. `npm run doctor` — окружение готово? Не готово — починить или написать
   founder'у, что нужно от него (ключ, VPS, KataGo).
3. Работать по плану: тест → код → `npm run check`. Для game-server и движка
   — `npm run smoke`. Для веб — `npm run build:web` и `npm run test:browser`.
   Для настоящего диалога — `node scripts/chat.mjs` с разрешённым окружением.
4. Коммит `<область>: <что сделано>`. Секреты и `data/` в git не попадают.
5. В конце — обновить `docs/NOW.md`: сделано, открыто, следующий шаг.

## Что агент видит и чего не видит

Агент не слышит голос и не видит экран телефона. Его глаза:

| Слой | Как проверить |
| --- | --- |
| Правила го | unit-тесты `packages/go-core` |
| Партия и протокол | `npm run smoke`: сценарная партия по HTTP, `GET /api/games/:id/ascii` |
| Движок | контрактный тест с настоящим KataGo при `KATAGO_BIN` |
| Диалог | `scripts/chat.mjs`: текст в комнату через `lk.chat`, ответы и вызовы инструментов в консоль |
| Веб | unit на координаты тапа, `npm run test:browser`: настоящий HTTP/SSE и mock LiveKit; реальный телефон — founder |
| Голос, задержка, перебивание | только founder с телефоном у доски |

Аудио-тесты через Realtime/GPT-Live стоят денег: агент запускает их только по
явному разрешению founder'а в текущей сессии и в согласованном бюджете.

Для Codex Cloud — [настройка и бесплатный preview](cloud-codex.md).
Он не требует секретов, VPS или KataGo. Mock voice UI не подтверждает STT,
прерывания и качество голоса; Chromium для автоматических проверок использует
синтетическое устройство. Ручной браузер может запросить настоящий микрофон.

## Окружение на ПК founder'а

- Node 22, npm. Зависимости — `npm ci` в корне (workspaces).
- KataGo: OpenCL-сборка для Windows + основная сеть + человеческая сеть
  `b18c384nbt-humanv0` в `apps/go-engine/models/` (в git не попадают, см.
  `apps/go-engine/README.md` `[WIP]`). Путь к бинарю — `KATAGO_BIN`.
- `.env` в корне по образцу `infra/.env.example`: `LIVEKIT_URL` на VPS,
  ключи LiveKit, `OPENAI_API_KEY` (voice-agent ходит в OpenAI через VPN на
  ПК), `AGENT_NAME=goko-dev`.
- Docker на ПК не нужен: всё запускается процессами через `npm run dev`.

## Деплой и инфраструктура

`infra/scripts/deploy.sh` (rsync + `docker compose up -d --build`) и любые
действия в Hetzner, DNS, tailnet — по явной просьбе founder'а в текущей
сессии. Runbook эксплуатации появится на стадии 1 в `docs/runbooks/`.
