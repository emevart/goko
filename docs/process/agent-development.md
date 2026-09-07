---
status: living
area: process
updated: 2026-09-07
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
   — `npm run smoke`. Для диалога — `node scripts/chat.mjs`.
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
| Веб | unit на координаты тапа; остальное — founder на телефоне |
| Голос, задержка, перебивание | только founder с телефоном у доски |

Аудио-тесты через Realtime стоят денег и запускаются founder'ом.

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
