---
status: living
area: process
updated: 2026-09-08
---

# NOW: где проект сейчас

Живой снимок: фокус, открытые вопросы, следующий шаг. Агент обновляет в конце
каждой сессии, founder — когда меняет курс.

## Фокус

Стадия 0 (спайк) не начата. Спека одобрена founder'ом «в целом» 07.09;
вечерние правки 07.09 (инфраструктура на отдельном VPS, речь, AI-first,
коды ошибок и причины `state.updated`) ждут подтверждения. Планы реализации
написаны и лежат в `docs/superpowers/plans/`:

- `2026-09-07-goko-stage0-spike.md` — стадия 0: `infra/`, стартовый агент,
  замеры KataGo, 30 фраз, текстовый канал, `docs/research/stage0-results.md`.
- `2026-09-07-goko-stage1-core.md` — стадия 1, ядро: `go-core`, `protocol`,
  `go-engine`, `game-server`, `smoke`, `dev` (13 задач).
- `2026-09-07-goko-stage1-voice-web.md` — стадия 1, голос и веб:
  `voice-agent`, `scripts/chat.mjs`, `web`, контейнеры, runbook (10 задач).

## Инфраструктура `[OK]` (08.09)

- VPS `goko`: Hetzner cx23 (2 vCPU, 4 ГБ, 40 ГБ, AVX2 есть), Хельсинки,
  Ubuntu 24.04, отдельный проект Hetzner `goko`; SSH-алиас `goko` на ПК
  founder'а. Токен API Hetzner — в `.env` на ПК как `HETZNER_API`, не в git.
- Домены: `goko.sdamex.com` (страница и `/api`) и `goko-lk.sdamex.com`
  (LiveKit), A-записи в Yandex Cloud DNS зоны `sdamex.com`, TTL 300.
  В `.env` это `WEB_HOST` и `LK_HOST`.
- Репозиторий `github.com/emevart/goko`, публичный, лицензия MIT.
- Ключ OpenAI — в `.env` на ПК. Bootstrap VPS (Docker, ufw, `/opt/goko`) и
  `/opt/goko/.env` — задача 2 плана стадии 0, ещё не выполнены.

## Открытые вопросы founder'у `[TODO founder]`

1. **Tailscale** нужен только для dev-режима стадии 1 (Caddy на VPS →
   game-server на ПК). Когда дойдёт: агент выполнит `tailscale up` на VPS и
   пришлёт ссылку для входа, founder откроет её и подтвердит узел; затем ACL
   «VPS → ПК только порт 8787». Сейчас делать ничего не нужно.
2. **Проверка с телефона** в стадии 0: звонок к LiveKit на VPS из сотовой сети
   и из дома без VPN. Провайдеры РФ могут душить поток к зарубежному IP после
   рукопожатия, RU→RU не режут. Если аудио душат — RU-релей (TCP-форвард 443
   на VPS) или LiveKit на RU-VPS; см. раздел 11 спеки.
3. **Подтвердить правки спеки 07.09:** отдельный VPS вместо LiveKit Cloud на
   стадии 0; личный VPN-сервер не используем; запасной конвейер STT → LLM →
   TTS; раздел 18 про AI-first; при написании планов — коды ошибок
   `bad_request`, `limit_reached`, `unauthorized`, `internal` с HTTP-статусами
   и причины `resign`, `new`, `sync` у события `state.updated` (раздел 5).
4. **Как исполнять планы:** subagent-driven (свежий субагент на задачу,
   ревью между задачами; рекомендуется) или inline в одной сессии.

## Следующий шаг

Исполнить план стадии 0 (`superpowers/plans/2026-09-07-goko-stage0-spike.md`):
сначала задачи на ПК (репозиторий, `infra/`, спайк агента, фразы), затем
по явной просьбе founder'а — VPS и замеры. После `docs/research/stage0-results.md`
— план ядра стадии 1, затем план голоса и веба.

## Сделано

- 2026-09-07: brainstorming, спека v1, правки по инфраструктуре и речи,
  `CLAUDE.md`, `AGENTS.md`, `README.md`, карта документации.
- 2026-09-07: планы реализации стадии 0 и стадии 1 (ядро; голос и веб);
  в спеке уточнены коды ошибок и причины `state.updated`.
- 2026-09-08: VPS `goko` (cx23) и A-записи `goko.`/`goko-lk.` в `sdamex.com`;
  LICENSE MIT, публикация репозитория; в планах и спеке `WEB_HOST`/`LK_HOST`
  вместо `DOMAIN`, cx23/cx33 вместо CX22/CX32, риск троттлинга и запасной
  RU-релей в разделе 11.
