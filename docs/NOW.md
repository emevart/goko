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
  (LiveKit), A-записи в Yandex Cloud DNS зоны `sdamex.com`, TTL 300;
  правятся с ПК founder'а через `yc dns zone list-records / add-records`.
  В `.env` это `WEB_HOST` и `LK_HOST`.
- Развёрнуто 08.09: Docker, ufw (в том числе relay-порты TURN 30000-40000/udp),
  `/opt/goko` с `.env` режима 600, Caddy и LiveKit `v1.13.6` в compose,
  сертификаты Let's Encrypt до 07.12.2026. Оба контейнера `Up (healthy)`,
  `https://<LK_HOST>/` отдаёт `OK`. Статики ещё нет: на `<WEB_HOST>` заглушка.
- Ключи LiveKit сгенерированы на сервере, ключ OpenAI вписан в `/opt/goko/.env`.
- Репозиторий `github.com/emevart/goko`, публичный, лицензия MIT.
- KataGo на ПК: бинарь OpenCL v1.18.1 и обе сети скачаны, `KATAGO_BIN` в `.env`.

## Открытые вопросы founder'у `[TODO founder]`

1. **Почта для Let's Encrypt.** `ACME_EMAIL` в `/opt/goko/.env` пуст, письма о
   скором истечении сертификата уходят в никуда. Назвать ящик — впишем.
2. **Проверка с телефона**: звонок к LiveKit на VPS из сотовой сети и из дома
   без VPN. Провайдеры РФ могут душить поток к зарубежному IP после
   рукопожатия, RU→RU не режут. Если аудио душат — RU-релей (TCP-форвард 443
   на VPS) или LiveKit на RU-VPS; см. раздел 11 спеки.
3. **Прогон 30 фраз голосом** (`spike/phrases.md`): это единственная проверка
   стадии 0, которую агент выполнить не может.
4. **Tailscale** нужен только для dev-режима стадии 1 (Caddy на VPS →
   game-server на ПК). Когда дойдёт: агент выполнит `tailscale up` на VPS и
   пришлёт ссылку для входа, founder откроет её и подтвердит узел.
5. **Подтвердить правки спеки 07.09:** отдельный VPS вместо LiveKit Cloud на
   стадии 0; личный VPN-сервер не используем; запасной конвейер STT → LLM →
   TTS; раздел 18 про AI-first; коды ошибок и причины `state.updated`.

## Следующий шаг

Идёт исполнение плана стадии 0 силами субагентов; ветка `stage0`, роли и
правила — `process/orchestration.md`, ход — `journal/2026-09-08-stage0.md`.
Задача 1 (каркас монорепы и `doctor`) закрыта, задача 2 (`infra/`) в работе.
Дальше: образ движка и замер KataGo, спайк агента, текстовый канал,
`research/stage0-results.md`; затем план ядра стадии 1 и план голоса и веба.

## Сделано

- 2026-09-07: brainstorming, спека v1, правки по инфраструктуре и речи,
  `CLAUDE.md`, `AGENTS.md`, `README.md`, карта документации.
- 2026-09-07: планы реализации стадии 0 и стадии 1 (ядро; голос и веб);
  в спеке уточнены коды ошибок и причины `state.updated`.
- 2026-09-08: организация работы через субагентов (`process/orchestration.md`),
  каркас монорепы и `doctor` (задача 1), внешняя верификация планов до кода.
- 2026-09-08: VPS `goko` (cx23) и A-записи `goko.`/`goko-lk.` в `sdamex.com`;
  LICENSE MIT, публикация репозитория; в планах и спеке `WEB_HOST`/`LK_HOST`
  вместо `DOMAIN`, cx23/cx33 вместо CX22/CX32, риск троттлинга и запасной
  RU-релей в разделе 11.
