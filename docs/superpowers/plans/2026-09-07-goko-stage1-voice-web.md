# Гоко, стадия 1, голос и веб: `voice-agent`, `scripts/chat.mjs`, `web`, контейнеры и деплой — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поверх ядра стадии 1 (план `2026-09-07-goko-stage1-core.md`) — голосовой соперник целиком: воркер LiveKit Agents с инструментами и промптом Гоко, озвучивание событий партии, текстовый канал из консоли, страница для телефона (доска, лента, микрофон), контейнеры game-server / go-engine / voice-agent в compose, деплой статики и runbook VPS.

**Architecture:** `apps/voice-agent` — воркер `@livekit/agents` (`agentName` из `AGENT_NAME`): на каждую комнату читает `sessionId` из метаданных диспетчеризации, собирает `AgentSession` в режиме `realtime` (gpt-realtime, голос marin) или `pipeline` (STT → LLM → TTS, `VOICE_MODE`), даёт модели девять инструментов над `GokoClient` из `@goko/protocol` и слушает SSE сессии, превращая события (тап на экране, ход движка после таймаута, конец партии) в `generateReply`. Инструменты — чистые функции над клиентом (`createToolFns`), тестируются с фейковым клиентом без LLM; обёртки `llm.tool()` — тонкие. `apps/web` — Vite + React, одна страница: `useSession` (сессия, комната LiveKit, режим «Голос / Чат» атрибутом `goko.mode`, микрофон, чат, лента-диалог), `useGame` (SSE с «Повторить», действия тапами через тот же клиент), SVG-доска с геометрией в отдельном модуле с тестами; настройки (режим, цвет, ранг) — в `localStorage`. Режим агент читает из атрибута участника и в «Чате» выключает аудио сессии (D-0011). `scripts/chat.mjs` — участник комнаты из консоли в режиме `chat`: stdin → `lk.chat`, `lk.transcription` и события SSE → stdout. Инфраструктура: три Dockerfile (Node 22 запускает `.ts` напрямую, без сборки), сервисы в `infra/docker-compose.yml` на `127.0.0.1`, Caddy остаётся единственной точкой входа.

**Tech Stack:** Node 22.22 (нативный `.ts`), npm workspaces, TypeScript 5.9, vitest 5, zod 4.5, `@livekit/agents` 1.8 + `@livekit/agents-plugin-openai` 1.8 + `@livekit/agents-plugin-silero` 1.8, `@livekit/rtc-node` 0.13, `livekit-client` 2.22, Vite 8 + `@vitejs/plugin-react` 6, React 19, Docker Compose, Caddy 2.

**Spec:** `docs/superpowers/specs/2026-09-07-goko-voice-go-opponent-design.md` — разделы 3 (архитектура, поток хода), 5 (протокол и события), 9 (`voice-agent`: речь, инструменты, озвучивание событий, промпт), 10 (`web`), 11 (инфраструктура, два режима маршрутизации, локальная разработка), 12 (тестирование), 18 (AI-first). Предполагаются выполненные планы стадии 0 (`2026-09-07-goko-stage0-spike.md`: `infra/`, базовый образ движка, `docs/research/stage0-results.md` с параметрами VAD и решением realtime/pipeline) и ядра стадии 1 (`2026-09-07-goko-stage1-core.md`: `@goko/go-core`, `@goko/protocol` с `createClient`, `game-server`, `go-engine`, `scripts/dev.mjs`, `scripts/smoke.mjs`).

## Global Constraints

- Node `>=22.18`; импорты внутри пакетов с расширением `.ts`/`.tsx`; между пакетами — по имени `@goko/go-core`, `@goko/protocol`; `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (типы только через `import type`), `erasableSyntaxOnly` (никаких `enum`, `namespace`, parameter properties). `apps/web` имеет свой `tsconfig.json` (DOM, JSX, bundler) и исключён из корневого.
- Правила го, координаты и озвучивание координат (`speakCoord`) — только из `@goko/go-core`; веб рисует присланную строку `board`; агент не хранит позицию: каждая реплика о партии — из результата инструмента (правило 2 `CLAUDE.md`). В памяти агента только `sessionId`, `gameId`, цвет человека, ранг, коми и служебные флаги.
- Инструменты ровно по таблице раздела 9 спеки: `start_game`, `play_move`, `correct_last_move`, `pass`, `resign`, `undo`, `get_position`, `get_assessment`, `set_rank`; `get_assessment` — `analyze` с `maxVisits: 50`; тексты `note`/`reason` для модели — по-русски; координаты в аргументах и результатах — латиницей (`D4`), рядом произношение (`дэ четыре`).
- `[!]` Известная граница разбора координат на 19x19: русские названия букв «эр» и «эс» транскрипт отдаёт кириллицей `Р` и `С`, а карта двойников `go-core` переводит их в `P` и `C`, а не в `R` и `S`. На 13x13 не проявляется — столбцы `O P Q R S T` отсекаются размером доски. Когда дойдёт до 19x19: агент диктует и принимает столбцы латиницей либо переспрашивает; карту двойников не трогать, она права для латиницы.
- Речь: `VOICE_MODE=realtime` (по умолчанию) — `openai.realtime.RealtimeModel({ model: 'gpt-realtime', voice: 'marin' })`, серверный VAD с перебиванием, транскрипция входа `gpt-live-transcribe` с `language: 'ru'`; `VOICE_MODE=pipeline` — `silero.VAD` + `openai.STT` (`gpt-transcribe`, `ru`) + `openai.LLM` + `openai.TTS` (`gpt-4o-mini-tts` с инструкцией по тону). Приветствие — `generateReply` сразу после `session.start` и применения режима (D-0011), чтобы в «Чате» оно пришло только текстом; `GokoAgent` умеет здороваться и в `onEnter` (`greet`), воркер это выключает.
- Текстовые каналы LiveKit: вход `lk.chat` (стандартный `RoomIO`), выход `lk.transcription` (атрибуты `lk.segment_id`, `lk.transcription_final`, `lk.transcribed_track_id`). Признак финальности двусторонний (проверено на спайке 08.09, `@livekit/agents` 1.8.0): у транскрипта агента поток дельта-, атрибут `lk.transcription_final` навсегда `false`, финал — дочитанный поток; у транскрипта человека поток не дельта-, атрибут выставляется честно, но каждый промежуточный результат STT приходит отдельным уже закрытым потоком с тем же `lk.segment_id`. Отсюда общее правило обоих потребителей: единица реплики — `lk.segment_id`, а не поток; фильтровать по одному атрибуту нельзя. Консоль (`scripts/chat.mjs`) печатает сегмент один раз — сразу при `final="true"`, иначе по паузе без новых кусков. Веб (D-0011, лента — диалог без дублей): строку Гоко держит по `lk.segment_id` и переписывает её новым куском того же сегмента; реплику человека добавляет только при `lk.transcription_final === 'true'` и тоже по `lk.segment_id`, так что распознанная фраза появляется в ленте один раз. Свою строку чата веб добавляет в ленту сам: `lk.chat` отправителю не возвращается и в `lk.transcription` не попадает.
- Имена воркера: `AGENT_NAME=goko` на VPS, `goko-dev` на ПК. По D-0001 комнату с диспетчеризацией агента создаёт game-server в `POST /api/sessions` (`createRoom` с `agents: [{ agentName, metadata }]`, `AGENT_NAME` у него же); веб и `scripts/chat.mjs` комнат не создают и `roomConfig` не несут. Токен телефона — `roomJoin` на комнату сессии с правами публикации, подписки и данных и, по D-0011, `canUpdateOwnMetadata` для атрибута режима; без `roomCreate` и без `roomConfig`. Метаданные диспетчеризации — `{ "sessionId": "<id>" }`, комната — `goko-<sessionId>`. Агент приходит в комнату раньше телефона и открывает Realtime только после `ctx.waitForParticipant()`: пустая комната живёт до `emptyTimeout` 300 с, и без ожидания платная сессия шла бы вхолостую.
- Ошибки (D-0007): `message` ошибок и событий `error` — английский текст для разработчика, его не озвучивают и не показывают, он только для логов. Русский текст для человека и для модели — `humanText(code, details)` из `@goko/protocol`. `retries_exhausted` (D-0006) значит, что сервер больше не повторяет сам; серию заново запускает мутирующее действие человека или открытие потока сессии. Механизм в плане: voice-agent на первой реплике человека после `retries_exhausted` (голосом или в `lk.chat`) переоткрывает поток сессии (задача 3), веб показывает кнопку «Повторить», которая переоткрывает SSE (задачи 6–8), тап по доске — мутирующее действие. Признак `humanFallback` есть только в событии `state.updated` хода движка, в ответе `play` его нет: агент запоминает номер такого хода и говорит о нём по вопросу о позиции.
- Режимы (D-0011): переключатель «Голос / Чат», по умолчанию «Голос», выбор помнится в `localStorage` (чтение и запись в `try/catch`). Веб выставляет атрибут участника `goko.mode` = `voice` | `chat` через `localParticipant.setAttributes`; voice-agent читает его после `waitForParticipant()` и слушает `RoomEvent.ParticipantAttributesChanged`. В «Чате» агент выключает аудиовыход и аудиовход сессии (`session.output.setAudioEnabled(false)`, `session.input.setAudioEnabled(false)`, `@livekit/agents` 1.8), ответы идут только текстом в `lk.transcription`; запасной путь — веб в «Чате» отписывается от аудиотрека агента. Realtime при этом всё равно генерирует аудио (`modalities` задаётся только в конструкторе `RealtimeModel`), это известная цена D-0011. Тапы по доске работают в любом режиме; комментарий Гоко к ходу — в ленте всегда, вслух только в «Голосе». Человек против человека (D-0005) разрешён: агент в такой партии комментирует и выполняет команды за того, чей ход.
- Веб: одна страница, портретный телефон, SVG-доска, тап = ближайший пункт → `play` с `via: 'tap'` и `waitForReply: false`; не ход человека — сообщение «сейчас ход Гоко» без запроса; перед «Новой партией» — выбор цвета (чёрные / белые / случайно) и ранга Гоко тапом, только существующими полями `NewGameRequest` (`black`, `white`, `settings.boardSize` и `settings.komi` от текущей партии), форы в протоколе нет; цели касания ≥ 44 px; тёмная и светлая тема по `prefers-color-scheme`; без UI-библиотек; без агента в комнате страница играет тапами.
- Протокол и заголовки как в ядре: `X-App-Key` на `/api/*`; ключ в веб попадает на этапе сборки (`APP_KEY` из `.env` → `import.meta.env.VITE_APP_KEY`), в git не попадает. Значения переменных не печатать в логи и не вставлять в доки.
- Порты dev: game-server `8787`, go-engine `8788`, web `5173`; воркер портов не слушает. В compose порт публикует только game-server и только на `127.0.0.1` (порты Docker обходят ufw); `go-engine` портов не публикует, лимит `cpus`; game-server за Caddy с `TRUST_PROXY=1` (задача 10).
- Тесты: `voice-agent` — фейковый клиент протокола и замоканный сеанс для режима (бесплатно, всегда); evals через `AgentSession.run` — только при `RUN_AGENT_EVALS=1` и `OPENAI_API_KEY`, в один существующий файл `agent.eval.test.ts` (задача 4), отдельных eval-файлов план не добавляет; `web` — чистые модули (`geometry`, `transcript`, `stream`, `text`, `prefs`, `chat`) под vitest в `node`; экран телефона агент не видит — приёмка руками у founder'а. Помощники тестов из пакетов — только через `@goko/protocol/testing` и `@goko/go-core/testing`, не глубоким путём в `src/`.
- `[!]` Платные прогоны (решение founder'а): не больше 5 на весь план. Раскладка: eval задачи 4 — 1 (LLM-судья «без лучшего хода» — внутри этого же прогона); `scripts/chat.mjs` задачи 5 — 1 интерактивный и 1 сценарный; ручная проверка режимов задачи 8 — 1; запас — 1, только на повтор после исправления. Регистрация воркера без комнаты, проверки runbook без разговора, Ctrl+C `npm run dev`, все unit-тесты — бесплатны и в счёт не идут. Исполнитель ведёт счёт в отчёте задачи; шестой прогон — только с разрешения founder'а.
- Время жизни и бюджеты (D-0008, D-0010): токен LiveKit живёт TTL сессии от её создания и может истечь раньше продлённой сессии — переподключение к комнате тогда требует новой сессии; id сессий и партий — непрозрачные строки, план их формат не разбирает. Серверные бюджеты: ожидание ответа движка 8 с, `analyze` 10 с, автосчёт после двух пасов (`SCORE_BUDGET_MS`) 20 с. Клиентские потолки — `CLIENT_TIMEOUTS` из `@goko/protocol` (операции с ответом движка и `analyze` 15 с, `score` 25 с, чтения и `resign`/`undo`/`set_rank` 5 с); `FINISH_WAIT_MS` = 22 с (задача 2) — выше серверных 20 с и ниже клиентских 25 с.
- Клиент протокола (раздел 5 спеки): `CallOptions { signal }` последним аргументом каждого метода; агент передаёт долгоживущий сигнал сеанса, веб — сигнал размонтирования. Три класса отказа различаются явно: `ApiError` — ответ сервера по протоколу (текст `humanText(code, details)`, в том числе `bad_request` с `details.reason`); `ClientTimeoutError` (`code: 'client_timeout'`) — «сервер не отвечает»; `HttpError` и `TypeError` сети — «нет связи с сервером». Отмена внешним сигналом — не ошибка для человека, её не озвучивают. Таймаут клиента на `play`, `pass` или `correct` не значит, что ход не применён: ни агент, ни веб не повторяют действие вслепую. Сначала они перечитывают партию (`getGame`) и сверяют ревизию и последний ход; агент говорит по фактическому состоянию (задача 2), веб рисует его (`sendTapMove`, задачи 6 и 7).
- Лимиты (D-0012): `rate_limited` (429, `details.retryAfterSeconds`, заголовок `Retry-After`) — агент и веб не шлют запросы к game-server раньше этого срока (`AgentState.blockedUntil`, ref `blockedUntil` в `useGame`, пауза потока); `too_many_games` (429, `details.max`, у лимита на клиента `details.scope: 'client'`) — текст через `humanText`. Партии создаются только внутри сессии: `POST /api/sessions/:sid/games`; `POST /api/games` в prod выключен (задача 9), ни агент, ни веб, ни `scripts/chat.mjs` его не вызывают. Новая партия в сессии бросает прежнюю незавершённую: та не в лимитах и после рестарта без задачи, пока человек к ней не вернётся (задача 9), поэтому «Новая партия» подряд не упирается в лимит.
- События (раздел 5 спеки): `engine.thinking` и `error` несут `gameId`; поток сессии отдаёт события только текущей партии. Агент и веб игнорируют `engine.thinking` и `error` с чужим `gameId` (гонка при смене партии). Возврат к старой партии в стадии 1 не делается интерфейсом; если понадобится — это открытие её потока (`events({ gameId })`), а не ожидание событий в потоке сессии.
- Язык доков, комментариев, коммитов — русский; код и идентификаторы — английский; без эмодзи; маркеры `[OK] [!] [FIX] [X] [WIP] [TODO]`; коммиты `<область>: <что сделано>`.
- Деплой, Hetzner, DNS, tailnet и аудио-тесты с телефона — только по явной просьбе founder'а в текущей сессии (правило 5 `CLAUDE.md`); план описывает команды, исполнитель их не запускает сам.

---

## Файловая структура стадии 1 (голос и веб)

```
packages/protocol/src/game.ts         + seatColor(seats, controller), hasEngine, humanColorOf — одно правило мест у агента и веба (задача 1)
packages/protocol/src/retry.ts        RETRY_MS, STABLE_CONNECTION_MS, retryAfterMs(details) — паузы клиентов потока (задача 1; + retry.test.ts)
packages/protocol/src/index.ts        + экспорт retry.ts

apps/game-server/src/livekit.ts       + право canUpdateOwnMetadata в токене телефона (D-0011); livekit.test.ts, app.test.ts
packages/protocol/src/human-text.ts   + reason sessionless_disabled, текст too_many_games для scope client (задача 9)
apps/game-server/src/service.ts       + прежняя партия сессии брошена при смене; лимит незавершённых партий на клиента MAX_GAMES_PER_CLIENT = 3 (задача 9)
apps/game-server/src/store.ts         + отметки брошенных партий <id>.abandoned: loadAbandoned, markAbandoned, clearAbandoned (задача 9); test-helpers.ts: memoryMarks
apps/game-server/src/app.ts           + владелец сессии по адресу, ALLOW_SESSIONLESS_GAMES для POST /api/games (задача 9)
apps/game-server/src/start-server.ts  + env ALLOW_SESSIONLESS_GAMES, отметки брошенных партий в хранилище (задача 9)
scripts/smoke.mjs, scripts/dev.mjs    + ALLOW_SESSIONLESS_GAMES=1 в окружении game-server (задача 9)
docs/decisions/0012-limits-rate-games-retention.md, спека разделы 5 и 7   + брошенная сменой партия, лимит на клиента и флаг (задача 9)

apps/voice-agent/package.json         @goko/voice-agent: @livekit/agents, @livekit/rtc-node, плагины openai и silero, @goko/*, zod
apps/voice-agent/src/phrases.ts       parseRank, speakRank, speakMove, describeResult, formatPoints, colorName
apps/voice-agent/src/state.ts         AgentState: sessionId, gameId, humanColor, rank, komi, флаги озвучивания и повторов
apps/voice-agent/src/tools.ts         createToolFns(deps) — чистые функции; createTools(deps) — llm.tool() со схемами
apps/voice-agent/src/events.ts        handleEvent(ev, state) -> инструкция | null; watchSession(...) -> { done, humanSpoke } — цикл SSE с переподключением и переоткрытием после retries_exhausted
apps/voice-agent/src/mode.ts          режим goko.mode: modeOf, applyMode, followMode (D-0011)
apps/voice-agent/src/prompt.ts        INSTRUCTIONS, GREETING_INSTRUCTIONS
apps/voice-agent/src/voice.ts         parseVoiceMode, sessionOptions(mode) — realtime | pipeline
apps/voice-agent/src/agent.ts         class GokoAgent extends voice.Agent (onEnter — приветствие при greet; воркер его выключает)
apps/voice-agent/src/metadata.ts      sessionIdOf(metadata, roomName)
apps/voice-agent/src/main.ts          defineAgent + cli.runApp; env: APP_KEY, API_BASE, AGENT_NAME, VOICE_MODE, LIVEKIT_*, OPENAI_API_KEY
apps/voice-agent/src/testing/fake-client.ts   createFakeClient(): ToolClient со сценарием и журналом вызовов; fakeGame()
apps/voice-agent/src/*.test.ts        phrases, tools, events, mode, metadata, voice; agent.eval.test.ts — платный, по флагу
apps/voice-agent/Dockerfile

scripts/chat.mjs                      сессия через game-server, комната LiveKit, атрибут goko.mode=chat, stdin -> lk.chat, ответы и события -> stdout
scripts/chat.test.ts                  describeEvent, CHAT_ATTRIBUTES

apps/web/package.json                 @goko/web: react, react-dom, livekit-client, @goko/*; vite, @vitejs/plugin-react
apps/web/tsconfig.json                DOM, react-jsx, bundler
apps/web/vite.config.ts               proxy /api -> 127.0.0.1:8787; VITE_APP_KEY из APP_KEY корневого .env
apps/web/index.html
apps/web/src/vite-env.d.ts
apps/web/src/main.tsx                 заглушка проверки сборки (задача 6), страница (задача 8)
apps/web/src/App.tsx
apps/web/src/api.ts                   client = createClient({ baseUrl, appKey })
apps/web/src/geometry.ts              layout, x, y, pointAt, coordAt, hoshi, stones, indexOf  (+ geometry.test.ts)
apps/web/src/transcript.ts            Line, upsertLine, whoOf, acceptLine  (+ transcript.test.ts)
apps/web/src/stream.ts                streamEvents -> { done, reopen }: SSE с переподключением 1–15 с и паузой до Retry-After; needsRetry (+ stream.test.ts)
apps/web/src/text.ts                  describeError, retryDelayMs, sendTapMove (перечитывание после таймаута хода), resultText, statusText, capturesText, rankText (+ text.test.ts)
apps/web/src/prefs.ts                 режим, цвет, ранг в localStorage; newGameRequest, stepRank, modeAttributes (+ prefs.test.ts)
apps/web/src/chat.ts                  sendChat — форма ввода чата; agentReady (+ chat.test.ts)
apps/web/src/hooks/useSession.ts      сессия в sessionStorage, комната, режим, микрофон, чат, лента
apps/web/src/hooks/useGame.ts         состояние партии по SSE, действия тапами, «Повторить»
apps/web/src/components/Board.tsx
apps/web/src/components/Transcript.tsx
apps/web/src/components/StatusBar.tsx
apps/web/src/components/Controls.tsx  микрофон (в «Голосе»), «Пас», «Сдаться», «Отменить»
apps/web/src/components/ModeSwitch.tsx переключатель «Голос / Чат»
apps/web/src/components/NewGame.tsx   «Новая партия»: выбор цвета и ранга Гоко
apps/web/src/components/ChatInput.tsx поле ввода и «Отправить»
apps/web/src/styles.css

apps/game-server/Dockerfile
apps/go-engine/Dockerfile             + стадия engine (Node поверх стадии katago, каталог analysis_logs для тома); chmod a+rX /opt/katago; контекст сборки — корень
.dockerignore
infra/docker-compose.yml              + game-server, go-engine, voice-agent
infra/.env.example                    + VOICE_MODE, API_BASE (задача 4); ALLOW_SESSIONLESS_GAMES (задача 9); ENGINE_CPUS, KATAGO_ASSET, KATAGO_SHA256 (задача 10); комментарий SESSION_TTL_MS (задача 11)
infra/scripts/deploy.sh               + --build-web, каталог снапшотов на VPS (дифф к HEAD: исключения и ветка tar остаются)
docs/runbooks/vps.md
package.json                          + chat, typecheck web, devDependency @livekit/rtc-node
CLAUDE.md, README.md, docs/README.md, docs/NOW.md
```

---

### Task 1: `voice-agent` — пакет, фразы, разбор ранга; `protocol` — места и паузы клиентов

**Files:**
- Create: `apps/voice-agent/package.json`, `apps/voice-agent/src/phrases.ts`, `apps/voice-agent/src/state.ts`, `packages/protocol/src/retry.ts`
- Modify: `packages/protocol/src/game.ts` (добавить `seatColor`, `hasEngine`, `humanColorOf`), `packages/protocol/src/index.ts` (экспорт `retry.ts`)
- Test: `apps/voice-agent/src/phrases.test.ts`, `packages/protocol/src/seat.test.ts`, `packages/protocol/src/retry.test.ts`

**Interfaces:**
- Consumes: `speakCoord` из `@goko/go-core`; `Color`, `Rank`, `RANKS`, `Result`, `Seat`, `Controller` из `@goko/protocol`.
- Produces: `seatColor(seats: { B: Seat; W: Seat }, controller: Controller): Color | null` в `@goko/protocol` (первый цвет с таким контроллером, порядок B, W); `hasEngine(g: Pick<GameState, 'seats'>): boolean` и `humanColorOf(g: Pick<GameState, 'seats' | 'toPlay'>): Color` в `@goko/protocol` (место человека, по умолчанию чёрные; в партии без движка — цвет того, чей ход, D-0005); `RETRY_MS = [1000, 2000, 4000, 8000, 15000]`, `STABLE_CONNECTION_MS = 15000`, `retryAfterMs(details?: Record<string, unknown>): number` (секунды `details.retryAfterSeconds` в мс, без них или с мусором — 1000) в `@goko/protocol` (`retry.ts`) — одно правило пауз у voice-agent (задачи 2, 3) и веба (задача 6), своих копий они не заводят; `parseRank(text): Rank | null`; `speakRank(rank): string` («10 кю», «3 дан»); `speakMove(coord): string`; `colorName(c)` («чёрные»/«белые»), `colorNameInstrumental(c)` («чёрными»/«белыми»); `formatPoints(n): string` («1 очко», «5,5 очка», «12 очков»); `describeResult(result: Result, humanColor: Color | null): string` (`null` — партия двух людей, D-0005); `type AgentState` (`humanColor: Color | null`, `announceSync: string | null`, `retriesExhausted`, `fallbackMove`, `startingGame`, `awaitingFinish`, `finished`, `blockedUntil`), `newAgentState(sessionId): AgentState`.

- [ ] **Step 1: `apps/voice-agent/package.json`**

```json
{
  "name": "@goko/voice-agent",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "node src/main.ts dev",
    "start": "node src/main.ts start",
    "download-files": "livekit-agents download-files"
  },
  "dependencies": {
    "@goko/go-core": "*",
    "@goko/protocol": "*",
    "@livekit/agents": "^1.8.0",
    "@livekit/agents-plugin-openai": "^1.8.0",
    "@livekit/agents-plugin-silero": "^1.8.0",
    "@livekit/rtc-node": "^0.13.34",
    "zod": "^4.5.4"
  }
}
```

`npm install` в корне (workspace `apps/*` уже объявлен). Нужна сеть: `@livekit/agents-plugin-silero` в `package-lock.json` ещё нет. При `ETARGET` взять ближайшую опубликованную версию той же мажорной линии и записать её в отчёт задачи. `@livekit/agents` принимает zod `^3.25.76 || ^4.1.8`, конфликтов с zod 4.5 нет. `@livekit/rtc-node` — peer-зависимость `@livekit/agents` 1.8, и `main.ts` импортирует из него `RoomEvent` (задача 4), поэтому пакет объявлен прямой зависимостью воркера.

- [ ] **Step 2: Тесты `packages/protocol/src/seat.test.ts` и `retry.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { type Seat, hasEngine, humanColorOf, seatColor } from './game.ts';
import * as protocol from './index.ts';

describe('seatColor', () => {
  it('находит цвет по контроллеру', () => {
    const seats = { B: { controller: 'human' as const }, W: { controller: 'engine' as const, rank: '10k' as const } };
    expect(seatColor(seats, 'human')).toBe('B');
    expect(seatColor(seats, 'engine')).toBe('W');
    expect(seatColor(seats, 'external')).toBeNull();
  });
  it('при двух одинаковых берёт чёрных', () => {
    const seats = { B: { controller: 'engine' as const }, W: { controller: 'engine' as const } };
    expect(seatColor(seats, 'engine')).toBe('B');
  });
});

describe('hasEngine / humanColorOf', () => {
  const human: Seat = { controller: 'human' };
  const engine: Seat = { controller: 'engine', rank: '10k' };
  it('место человека, по умолчанию чёрные; Гоко в партии есть', () => {
    expect(humanColorOf({ seats: { B: human, W: engine }, toPlay: 'W' })).toBe('B');
    expect(humanColorOf({ seats: { B: engine, W: human }, toPlay: 'B' })).toBe('W');
    expect(humanColorOf({ seats: { B: engine, W: { controller: 'external' } }, toPlay: 'B' })).toBe('B');
    expect(hasEngine({ seats: { B: human, W: engine } })).toBe(true);
    expect(protocol.hasEngine).toBe(hasEngine);
    expect(protocol.humanColorOf).toBe(humanColorOf);
  });
  it('партия двух людей (D-0005): движка нет, «человек» — тот, чей ход', () => {
    const seats = { B: human, W: human };
    expect(hasEngine({ seats })).toBe(false);
    expect(humanColorOf({ seats, toPlay: 'W' })).toBe('W');
    expect(humanColorOf({ seats, toPlay: 'B' })).toBe('B');
  });
});
```

Тест `packages/protocol/src/retry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as protocol from './index.ts';
import { RETRY_MS, STABLE_CONNECTION_MS, retryAfterMs } from './retry.ts';

describe('паузы клиентов game-server', () => {
  it('retryAfterMs: секунды из details в мс; без них или с мусором — 1 с', () => {
    expect(retryAfterMs({ retryAfterSeconds: 42 })).toBe(42_000);
    expect(retryAfterMs(undefined)).toBe(1_000);
    expect(retryAfterMs({})).toBe(1_000);
    expect(retryAfterMs({ retryAfterSeconds: 'soon' })).toBe(1_000);
    expect(retryAfterMs({ retryAfterSeconds: 0 })).toBe(1_000);
    expect(retryAfterMs({ retryAfterSeconds: -5 })).toBe(1_000);
  });
  it('ступени переподключения 1, 2, 4, 8, 15 с; порог рабочего соединения — 15 с; всё экспортирует пакет', () => {
    expect(RETRY_MS).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
    expect(STABLE_CONNECTION_MS).toBe(15_000);
    expect(protocol.retryAfterMs).toBe(retryAfterMs);
    expect(protocol.RETRY_MS).toBe(RETRY_MS);
    expect(protocol.STABLE_CONNECTION_MS).toBe(STABLE_CONNECTION_MS);
  });
});
```

- [ ] **Step 3: Тест `apps/voice-agent/src/phrases.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { colorName, describeResult, formatPoints, parseRank, speakMove, speakRank } from './phrases.ts';

describe('parseRank', () => {
  it('понимает кю и дан по-русски и по-английски', () => {
    expect(parseRank('10 кю')).toBe('10k');
    expect(parseRank('10k')).toBe('10k');
    expect(parseRank('3 дан')).toBe('3d');
    expect(parseRank('3d')).toBe('3d');
    expect(parseRank('первый дан')).toBeNull();
    expect(parseRank('1-й дан')).toBe('1d');
    expect(parseRank(' 5 kyu ')).toBe('5k');
    expect(parseRank('поставь 3 кю пожалуйста')).toBe('3k');
  });
  it('отвергает ранги вне списка и мусор', () => {
    expect(parseRank('25 кю')).toBeNull();
    expect(parseRank('10 дан')).toBeNull();
    expect(parseRank('сильно')).toBeNull();
    expect(parseRank('')).toBeNull();
  });
});

describe('speakRank / speakMove / colorName', () => {
  it('произносит ранг, ход и цвет', () => {
    expect(speakRank('10k')).toBe('10 кю');
    expect(speakRank('2d')).toBe('2 дан');
    expect(speakMove('D4')).toBe('дэ четыре');
    expect(speakMove('pass')).toBe('пас');
    expect(colorName('B')).toBe('чёрные');
    expect(colorName('W')).toBe('белые');
  });
});

describe('formatPoints', () => {
  it('склоняет очки', () => {
    expect(formatPoints(1)).toBe('1 очко');
    expect(formatPoints(2)).toBe('2 очка');
    expect(formatPoints(5)).toBe('5 очков');
    expect(formatPoints(11)).toBe('11 очков');
    expect(formatPoints(21)).toBe('21 очко');
    expect(formatPoints(5.5)).toBe('5,5 очка');
    expect(formatPoints(0.5)).toBe('0,5 очка');
  });
});

describe('describeResult', () => {
  it('говорит от лица Гоко и без рода для человека', () => {
    expect(describeResult({ winner: 'B', reason: 'resign' }, 'B')).toBe('победа за тобой: я сдался');
    expect(describeResult({ winner: 'W', reason: 'resign' }, 'B')).toBe('победа за мной: партия сдана');
    expect(describeResult({ winner: 'W', margin: 5.5, reason: 'score' }, 'B')).toBe('победа за мной, разница 5,5 очка');
    expect(describeResult({ winner: 'B', margin: 12, reason: 'score' }, 'B')).toBe('победа за тобой, разница 12 очков');
  });
  it('в партии двух людей называет цвет победителя (D-0005)', () => {
    expect(describeResult({ winner: 'B', reason: 'resign' }, null)).toBe('победа чёрных: белые сдались');
    expect(describeResult({ winner: 'W', margin: 2.5, reason: 'score' }, null)).toBe('победа белых, разница 2,5 очка');
  });
});
```

- [ ] **Step 4: Запустить тесты, убедиться, что падают**

Run: `npx vitest run packages/protocol/src/seat.test.ts packages/protocol/src/retry.test.ts apps/voice-agent/src/phrases.test.ts`
Expected: FAIL — `seatColor`, `hasEngine`, `humanColorOf` не экспортируются из `./game.ts`; `Cannot find module './retry.ts'`; `Cannot find module './phrases.ts'`.

- [ ] **Step 5: `seatColor`, `hasEngine`, `humanColorOf` в `packages/protocol/src/game.ts`, паузы в `retry.ts`**

В конец `packages/protocol/src/game.ts` добавить:

```ts
// Цвет места с данным контроллером; при двух одинаковых — чёрные. null, если такого места нет.
export function seatColor(seats: { B: Seat; W: Seat }, controller: Controller): Color | null {
  if (seats.B.controller === controller) return 'B';
  if (seats.W.controller === controller) return 'W';
  return null;
}

// Есть ли в партии Гоко. Партия двух людей разрешена (D-0005): Гоко в ней только комментирует.
export function hasEngine(g: Pick<GameState, 'seats'>): boolean {
  return seatColor(g.seats, 'engine') !== null;
}

// Цвет «человека» для текстов и сдачи у voice-agent и веба. В партии без движка людей двое,
// и «ты» — тот, чей сейчас ход. Иначе место человека; без него — чёрные.
export function humanColorOf(g: Pick<GameState, 'seats' | 'toPlay'>): Color {
  if (!hasEngine(g) && g.seats[g.toPlay].controller === 'human') return g.toPlay;
  return seatColor(g.seats, 'human') ?? 'B';
}
```

`packages/protocol/src/retry.ts`:

```ts
// Паузы клиентов game-server после отказов (R2, D-0012). Одно правило у voice-agent (задачи 2, 3) и веба
// (задача 6): правка ступеней или разбора Retry-After не расходится по двум копиям.

// Паузы переподключения потока по попыткам: растут до потолка 15 с.
export const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

// Соединение, прожившее столько, считается рабочим: следующий обрыв — снова с первой ступени.
export const STABLE_CONNECTION_MS = 15_000;

// Retry-After из details ошибки rate_limited (D-0012), в мс. Без поля или с мусором — 1 с: не долбить сервер сразу.
export function retryAfterMs(details?: Record<string, unknown>): number {
  const seconds = Number(details?.retryAfterSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
}
```

В `packages/protocol/src/index.ts` после строки `export * from './human-text.ts';` добавить `export * from './retry.ts';`. Функции `game.ts` попадают в пакет через уже существующий `export * from './game.ts'`.

- [ ] **Step 6: `apps/voice-agent/src/phrases.ts`**

```ts
// Русские формулировки для модели и событий. Всё, что Гоко говорит о партии словами, собрано здесь,
// чтобы модель не переводила коды и не придумывала форму слов.
import { speakCoord } from '@goko/go-core';
import { type Color, RANKS, type Rank, type Result } from '@goko/protocol';

export const colorName = (c: Color): string => (c === 'B' ? 'чёрные' : 'белые');
export const colorNameInstrumental = (c: Color): string => (c === 'B' ? 'чёрными' : 'белыми');

// «10 кю», «10k», «3 дан», «3d», «1-й дан» -> Rank; null, если не разобрали или ранга нет в списке.
// Конец слова — просмотр вперёд по буквам и цифрам Unicode: \b в JS знает только [A-Za-z0-9_]
// и после «кю» или «дан» границы не видит.
export function parseRank(text: string): Rank | null {
  const m = /(\d{1,2})\s*(?:-?\s*(?:й|го|ый|ого))?\s*(k|kyu|кю|d|dan|дан)(?![\p{L}\p{N}])/iu.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const kyu = /^(k|kyu|кю)$/iu.test(m[2] ?? '');
  const rank = `${n}${kyu ? 'k' : 'd'}`;
  return (RANKS as readonly string[]).includes(rank) ? (rank as Rank) : null;
}

export function speakRank(rank: Rank): string {
  const n = Number(rank.slice(0, -1));
  return rank.endsWith('k') ? `${n} кю` : `${n} дан`;
}

// Ход для произношения: «дэ четыре», «пас». Правила произношения живут в go-core.
export const speakMove = (coord: string): string => speakCoord(coord);

// «1 очко», «2 очка», «5 очков», «5,5 очка».
export function formatPoints(n: number): string {
  const abs = Math.abs(n);
  const whole = Math.floor(abs);
  const fractional = abs !== whole;
  const text = fractional ? abs.toFixed(1).replace('.', ',') : String(whole);
  let word = 'очков';
  if (fractional) word = 'очка';
  else {
    const tens = whole % 100;
    const last = whole % 10;
    if (tens < 11 || tens > 14) {
      if (last === 1) word = 'очко';
      else if (last >= 2 && last <= 4) word = 'очка';
    }
  }
  return `${text} ${word}`;
}

const colorNameGenitive = (c: Color): string => (c === 'B' ? 'чёрных' : 'белых');

// Результат словами Гоко: «я» — Гоко, «ты» — человек, без рода для человека.
// humanColor = null — партия двух людей (D-0005): Гоко не участник, называем цвета.
export function describeResult(result: Result, humanColor: Color | null): string {
  if (humanColor === null) {
    const loser: Color = result.winner === 'B' ? 'W' : 'B';
    const who = `победа ${colorNameGenitive(result.winner)}`;
    if (result.reason === 'resign') return `${who}: ${colorName(loser)} сдались`;
    return `${who}, разница ${formatPoints(result.margin ?? 0)}`;
  }
  const humanWon = result.winner === humanColor;
  const who = humanWon ? 'победа за тобой' : 'победа за мной';
  if (result.reason === 'resign') return `${who}: ${humanWon ? 'я сдался' : 'партия сдана'}`;
  return `${who}, разница ${formatPoints(result.margin ?? 0)}`;
}
```

- [ ] **Step 7: `apps/voice-agent/src/state.ts`**

```ts
// Память агента о сессии. Позиции здесь нет (правило 2 CLAUDE.md): только идентификаторы, настройки
// и флаги, по которым события SSE решают, что уже озвучено инструментом, а что надо сказать самому.
import type { Color, Rank, Result } from '@goko/protocol';

export type AgentState = {
  sessionId: string;
  gameId: string | null;
  announceSync: string | null; // session.game сменил партию: sync этой партии озвучить «Продолжаем партию» (задача 3)
  humanColor: Color | null; // null — в партии нет движка, играют два человека (D-0005)
  rank: Rank; // ранг Гоко для следующей партии
  komi: number;
  toolGames: Set<string>; // партии, созданные start_game: их state.updated/new не озвучиваем
  announcedFinish: string | null; // партия, чей результат уже вернул инструмент
  awaitingReply: boolean; // play/pass вернули replyTimedOut: ход движка озвучит событие
  lastTap: { cause: 'play' | 'pass' | 'correct'; coord: string } | null; // ход с экрана, ждём ответ движка
  lastErrorAt: number; // когда в последний раз озвучивали ошибку движка
  retriesExhausted: boolean; // пришёл error retries_exhausted: следующая реплика человека переоткроет поток (D-0006)
  fallbackMove: number | null; // номер последнего хода движка с humanFallback (D-0007)
  startingGame: boolean; // start_game ждёт ответа newGame: событие new приходит раньше ответа HTTP
  awaitingFinish: string | null; // pass ждёт итог этой партии: game.finished кладёт его в finished, не озвучивая
  finished: { gameId: string; result: Result } | null; // итог из потока сессии для ожидающего pass (R2)
  blockedUntil: number; // до этого момента (мс, часы deps.now) запросы к game-server не шлём: rate_limited с Retry-After
};

export const DEFAULT_RANK: Rank = '10k';
export const DEFAULT_KOMI = 7.5;

export function newAgentState(sessionId: string): AgentState {
  return {
    sessionId,
    gameId: null,
    announceSync: null,
    humanColor: 'B',
    rank: DEFAULT_RANK,
    komi: DEFAULT_KOMI,
    toolGames: new Set(),
    announcedFinish: null,
    awaitingReply: false,
    lastTap: null,
    lastErrorAt: 0,
    retriesExhausted: false,
    fallbackMove: null,
    startingGame: false,
    awaitingFinish: null,
    finished: null,
    blockedUntil: 0,
  };
}
```

- [ ] **Step 8: Тесты и typecheck зелёные**

Run: `npx vitest run packages/protocol/src/seat.test.ts packages/protocol/src/retry.test.ts apps/voice-agent/src/phrases.test.ts && npm run typecheck`
Expected: `Test Files  3 passed`, `Tests  12 passed` (4 в `seat.test.ts`, 2 в `retry.test.ts`, 6 в `phrases.test.ts`), typecheck без ошибок.

- [ ] **Step 9: Commit**

```bash
git add package-lock.json apps/voice-agent/package.json apps/voice-agent/src/phrases.ts apps/voice-agent/src/phrases.test.ts apps/voice-agent/src/state.ts packages/protocol/src/game.ts packages/protocol/src/index.ts packages/protocol/src/seat.test.ts packages/protocol/src/retry.ts packages/protocol/src/retry.test.ts
git commit -m "voice-agent: пакет, фразы и разбор ранга; protocol: seatColor, hasEngine, humanColorOf и паузы клиентов"
```

---

### Task 2: `voice-agent` — инструменты над клиентом протокола, фейковый клиент

**Files:**
- Create: `apps/voice-agent/src/tools.ts`, `apps/voice-agent/src/testing/fake-client.ts`
- Test: `apps/voice-agent/src/tools.test.ts`

**Interfaces:**
- Consumes: `GokoClient`, `CallOptions`, `ApiError`, `ClientTimeoutError`, `HttpError`, `humanText`, `GameState`, `PlayResponse`, `Analysis`, `Move`, `Rank`, `Color`, `seatColor`, `hasEngine`, `humanColorOf`, `retryAfterMs` из `@goko/protocol` (Task 1); `phrases.ts`, `state.ts` из Task 1 (поля `awaitingFinish`, `finished`, `blockedUntil`); `llm.tool` из `@livekit/agents`.
- Produces: `type ToolClient = Pick<GokoClient, 'newGame' | 'play' | 'correct' | 'pass' | 'resign' | 'undo' | 'getGame' | 'ascii' | 'analyze' | 'setRank'>`; `type ToolDeps = { client: ToolClient; state: AgentState; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; now?: () => number; log?: (line: string) => void }` (`signal` уходит последним аргументом `{ signal }` в каждый вызов клиента; `now` — часы для `blockedUntil` и ожидания итога); `createToolFns(deps)` с методами `startGame({ my_color?, rank?, komi? })`, `playMove({ coord })`, `correctLastMove({ coord })`, `pass()`, `resign()`, `undo()`, `getPosition(): Promise<string>`, `getAssessment()`, `setRank({ rank })`; `createTools(deps)` — объект из девяти `llm.tool()` с именами из спеки; константы `ASSESSMENT_VISITS = 50`, `FINISH_WAIT_MS = 22000`, `FINISH_POLL_MS = 2500`, `FINISH_TICK_MS = 250`, `NETWORK_TEXT = 'нет связи с сервером'`, `KOMI_TEXT`; `engineColorOf(state): Color`. Своих `retryAfterMs`, `hasEngine`, `humanColorOf` `tools.ts` не определяет и не реэкспортирует: `events.ts` берёт их из `@goko/protocol`. Тестовый клиент: `createFakeClient(opts?: { replies?: string[]; ascii?: string; analysis?: Partial<Analysis>; finishAfterPolls?: number }): FakeClient` (`ToolClient & { calls: Array<{ method: string; args: unknown[] }>; signals: Array<AbortSignal | undefined>; game: GameState | null; failNext(err: Error, when?: 'before' | 'after'): void; replyTimedOut: boolean }`; `'after'` — только у `play`, `pass`, `correct`: ход записан, а вызов бросает ошибку; методы принимают `o?: CallOptions` последним, в `calls.args` его нет, отменённый сигнал бросает его причину); `fakeGame(overrides?: Partial<GameState>): GameState`.

Отказы в инструментах (Global Constraints, «Клиент протокола» и «Лимиты»): `ApiError` → `humanText(code, details)`, у `rate_limited` ещё `state.blockedUntil = now() + retryAfterMs(details)`; `ClientTimeoutError` → `humanText('client_timeout')` («сервер не отвечает»; у хода, паса и поправки — после перечитывания партии, ниже); `HttpError` и `TypeError('fetch failed')` → `NETWORK_TEXT`; остальное (в том числе отмена сигналом сеанса) пробрасывается в лог воркера. Пока `now() < state.blockedUntil`, инструменты партии не зовут клиент и отвечают `humanText('rate_limited')`.

Таймаут клиента на ходе (`play_move`, `pass`, `correct_last_move`). Сервер мог записать ход, а ответ не дошёл, поэтому инструмент ход не повторяет, а перечитывает партию (`getGame`) и сверяет её с тем, что видел раньше:
- ревизия та же, что в последнем ответе сервера инструментам по этой партии, — хода нет;
- иначе ход считается записанным, если ход человека с этой координатой стоит последним (ответа Гоко ещё нет или Гоко в партии нет) или предпоследним, а за ним ход Гоко;
- записан — обычный `ok: true` по перечитанной партии; ответа Гоко нет — `note` и `awaitingReply`, как при `replyTimedOut`;
- не записан — `ok: false` с фактическим «чей ход» и просьбой не повторять ход без человека: «сервер не отвечает: хода D4 в партии пока нет, сейчас ход: чёрные (твой). Не повторяй ход сам: скажи человеку и дождись его слов»;
- перечитать не вышло — отказ перечитывания по общим правилам.

Ревизию инструменты запоминают только из своих ответов: событие `state.updated` о записанном ходе приходит раньше таймаута, и по нему сверка приняла бы записанный ход за незаписанный.

Результаты инструментов (то, что видит модель):

| Инструмент | ok | Поля |
| --- | --- | --- |
| `start_game` | `true` | `gameId`, `youPlay: 'black' \| 'white'`, `rank` («10 кю»), `komi`, `firstMove` (координата или `null`), `firstMoveSpoken`, `note?` |
| `play_move`, `correct_last_move` | `true` | `yourMove`, `myMove` (координата, `'pass'` или `null`), `myMoveSpoken`, `captured` (снял человек этим ходом), `myCaptured`, `toPlay`, `moveNumber`, `note?`, `finished?`, `result?` |
| `pass` | `true` | `myMove`, `myMoveSpoken`, `toPlay`, `finished?`, `result?`, `note?` (после двух пасов без итога за `FINISH_WAIT_MS` — «Гоко ещё считает очки: итог назовёт сам») |
| `resign` | `true` | `result` |
| `undo` | `true` | `removed: string[]`, `removedSpoken: string[]`, `toPlay`, `status` |
| `get_position` | — | текст: ascii-доска, последние 6 ходов, пленные, строка о ходе движка с `humanFallback` (если он ещё на доске), чей ход |
| `get_assessment` | — | `leader: 'you' \| 'me' \| 'even'`, `marginPoints`, `winrateYou` (проценты), `weakGroups: [{ color: 'yours' \| 'mine', where, status }]`, `bestMoves: string[]`, `toPlay: 'you' \| 'me'`; в партии двух людей (D-0005) — цветами: `leader: 'black' \| 'white' \| 'even'`, `winrateBlack`, `weakGroups[].color: 'black' \| 'white'`, `toPlay: 'black' \| 'white'` |
| `set_rank` | `true` | `rank`, `note?` (без партии или в партии без Гоко — ранг для следующей) |
| любой | `false` | `reason` — русский текст: `humanText(code, details)` из протокола по коду ошибки сервера (для `illegal_move` — причина: «точка занята», «ко: сразу забрать нельзя»; для `bad_request` с `reason: 'not_your_seat'` — «это не твой цвет»; `rate_limited`, `too_many_games`), `humanText('client_timeout')` при таймауте клиента (у хода, паса и поправки — после перечитывания партии, с фактическим «чей ход»; записанный ход — обычный `ok: true`), «нет связи с сервером» при потере сети или своя фраза агента («партия не начата: предложи начать», `KOMI_TEXT`) |

- [ ] **Step 1: `apps/voice-agent/src/testing/fake-client.ts`**

```ts
// Фейковый клиент протокола для тестов voice-agent: держит одну партию в памяти, отвечает ходами из сценария,
// пишет журнал вызовов. Правил го здесь нет — только формы ответов game-server.
import {
  type Analysis,
  ApiError,
  type CallOptions,
  type CorrectRequest,
  type GameState,
  type Move,
  type NewGameRequest,
  type NewGameResponse,
  type PassRequest,
  type PlayRequest,
  type PlayResponse,
  type ResignRequest,
  type SetRankRequest,
  type StateResponse,
  type UndoRequest,
  type UndoResponse,
  seatColor,
} from '@goko/protocol';
import type { ToolClient } from '../tools.ts';

export function fakeGame(overrides: Partial<GameState> = {}): GameState {
  return {
    id: 'g1',
    createdAt: '2026-09-07T10:00:00.000Z',
    revision: 0,
    settings: { boardSize: 13, rules: 'chinese', komi: 7.5 },
    seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } },
    status: 'playing',
    toPlay: 'B',
    moves: [],
    board: '.'.repeat(169),
    captures: { B: 0, W: 0 },
    ko: null,
    consecutivePasses: 0,
    pendingEngineMove: false,
    ...overrides,
  };
}

export type FakeClientOptions = {
  replies?: string[]; // ходы движка по очереди; 'pass' — пас; когда кончились — 'pass'
  ascii?: string;
  analysis?: Partial<Analysis>;
  finishAfterPolls?: number; // после двух пасов партия завершается через столько getGame
};

export type FakeClient = ToolClient & {
  calls: Array<{ method: string; args: unknown[] }>; // аргументы без CallOptions
  signals: Array<AbortSignal | undefined>; // сигнал каждого вызова по порядку: инструменты передают deps.signal
  game: GameState | null;
  replyTimedOut: boolean; // следующий play/pass/correct вернёт replyTimedOut без ответа движка
  // Следующий вызов бросает err. 'before' (по умолчанию) — до всякой работы; 'after' — только play, pass и
  // correct: ход и ответ движка уже записаны, а вызов бросает (таймаут клиента после записи на сервере).
  failNext(err: Error, when?: 'before' | 'after'): void;
};

export function createFakeClient(opts: FakeClientOptions = {}): FakeClient {
  const replies = [...(opts.replies ?? ['K10', 'D10', 'K4'])];
  let pending: Error | null = null;
  let pendingAfter = false;
  let pollsLeft = -1;
  let n = 0;

  const self: FakeClient = {
    calls: [],
    signals: [],
    game: null,
    replyTimedOut: false,
    failNext(err, when = 'before') {
      pending = err;
      pendingAfter = when === 'after';
    },
    async newGame(sessionId: string, req: NewGameRequest, o?: CallOptions): Promise<NewGameResponse> {
      record('newGame', o, sessionId, req);
      throwPending();
      const komi = req.settings?.komi ?? 7.5;
      self.game = fakeGame({
        id: `g${++n}`,
        seats: { B: req.black, W: req.white },
        settings: { boardSize: 13, rules: 'chinese', komi },
        pendingEngineMove: req.black.controller === 'engine',
      });
      let firstMove: Move | undefined;
      if (self.game.pendingEngineMove && !self.replyTimedOut) firstMove = engineMove();
      const res: NewGameResponse = { state: self.game, ...(firstMove ? { firstMove } : {}) };
      if (self.game.pendingEngineMove && self.replyTimedOut) res.replyTimedOut = true;
      self.replyTimedOut = false;
      return res;
    },
    async play(id: string, req: PlayRequest, o?: CallOptions): Promise<PlayResponse> {
      record('play', o, id, req);
      return humanMove(req.coord);
    },
    async correct(id: string, req: CorrectRequest, o?: CallOptions): Promise<PlayResponse> {
      record('correct', o, id, req);
      throwPending();
      const g = need();
      g.moves = g.moves.slice(0, -2);
      return humanMove(req.coord);
    },
    async pass(id: string, req: PassRequest = {}, o?: CallOptions): Promise<PlayResponse> {
      record('pass', o, id, req);
      return humanMove('pass');
    },
    async resign(id: string, req: ResignRequest, o?: CallOptions): Promise<StateResponse> {
      record('resign', o, id, req);
      throwPending();
      const g = need();
      g.status = 'finished';
      g.result = { winner: req.color === 'B' ? 'W' : 'B', reason: 'resign' };
      g.revision++;
      return { state: g };
    },
    async undo(id: string, req: UndoRequest = {}, o?: CallOptions): Promise<UndoResponse> {
      record('undo', o, id, req);
      throwPending();
      const g = need();
      if (g.moves.length === 0) throw new ApiError('nothing_to_undo', 'nothing to undo');
      const removed = g.moves.slice(-2);
      g.moves = g.moves.slice(0, -2);
      g.toPlay = seatColor(g.seats, 'human') ?? 'B';
      g.revision++;
      return { state: g, removed };
    },
    async getGame(id: string, o?: CallOptions): Promise<GameState> {
      record('getGame', o, id);
      const g = need();
      if (pollsLeft > 0) pollsLeft--;
      if (pollsLeft === 0) {
        pollsLeft = -1;
        g.status = 'finished';
        g.result = { winner: 'W', margin: 3.5, reason: 'score' };
      }
      return g;
    },
    async ascii(id: string, o?: CallOptions): Promise<string> {
      record('ascii', o, id);
      return opts.ascii ?? '# g1 rev 2 playing toPlay B moves 2\n   A B C\n 3 . . .\n 2 . . .\n 1 . . .\n';
    },
    async analyze(id: string, req = {}, o?: CallOptions): Promise<Analysis> {
      record('analyze', o, id, req);
      throwPending();
      return {
        visits: 50,
        winrateB: 0.7,
        scoreLeadB: 6.2,
        topMoves: [
          { coord: 'K10', winrateB: 0.71, scoreLeadB: 6.5, visits: 20 },
          { coord: 'D10', winrateB: 0.69, scoreLeadB: 6.0, visits: 15 },
          { coord: 'G7', winrateB: 0.68, scoreLeadB: 5.8, visits: 10 },
          { coord: 'C3', winrateB: 0.6, scoreLeadB: 4.0, visits: 5 },
        ],
        ownership: [],
        // Слабая группа — не на лучших ходах: eval «кто впереди» (задача 4) запрещает в ответе K10 и D10,
        // а место слабой группы модель называет законно.
        groups: [
          { color: 'B', stones: ['D4'], liberties: 4, ownershipAvg: 0.9, status: 'safe' },
          { color: 'W', stones: ['C3', 'C4'], liberties: 2, ownershipAvg: -0.1, status: 'unsettled' },
          { color: 'B', stones: ['M3'], liberties: 1, ownershipAvg: -0.8, status: 'dead' },
        ],
        ...opts.analysis,
      };
    },
    async setRank(id: string, req: SetRankRequest, o?: CallOptions): Promise<StateResponse> {
      record('setRank', o, id, req);
      throwPending();
      const g = need();
      g.seats[req.color] = { ...g.seats[req.color], rank: req.rank };
      g.revision++;
      return { state: g };
    },
  };

  // Журнал без CallOptions (сигналы — отдельно); отменённый сигнал ведёт себя как у настоящего клиента:
  // вызов бросает причину отмены до всякой работы.
  function record(method: string, o: CallOptions | undefined, ...args: unknown[]) {
    self.calls.push({ method, args });
    self.signals.push(o?.signal);
    o?.signal?.throwIfAborted();
  }
  function throwPending() {
    if (pending && !pendingAfter) {
      const e = pending;
      pending = null;
      throw e;
    }
  }
  function throwPendingAfter() {
    if (pending && pendingAfter) {
      const e = pending;
      pending = null;
      pendingAfter = false;
      throw e;
    }
  }
  function need(): GameState {
    if (!self.game) throw new ApiError('not_found', 'game not found');
    return self.game;
  }
  function stamp(): string {
    return `2026-09-07T10:0${Math.min(9, self.game?.moves.length ?? 0)}:00.000Z`;
  }
  function engineMove(): Move {
    const g = need();
    const coord = replies.shift() ?? 'pass';
    const move: Move = { n: g.moves.length + 1, color: g.toPlay, coord, captured: 0, at: stamp() };
    g.moves = [...g.moves, move];
    g.toPlay = g.toPlay === 'B' ? 'W' : 'B';
    g.revision++;
    g.pendingEngineMove = false;
    return move;
  }
  function humanMove(coord: string): PlayResponse {
    throwPending();
    const res = applyHumanMove(coord);
    throwPendingAfter();
    return res;
  }
  function applyHumanMove(coord: string): PlayResponse {
    const g = need();
    if (g.status === 'finished') throw new ApiError('game_finished', 'game is finished');
    const human = g.toPlay;
    if (g.seats[human].controller !== 'human') throw new ApiError('not_your_turn', 'it is Goko to play');
    const move: Move = { n: g.moves.length + 1, color: human, coord, captured: 0, at: stamp() };
    g.moves = [...g.moves, move];
    g.toPlay = human === 'B' ? 'W' : 'B';
    g.revision++;
    // Партия двух людей (D-0005): ответа движка нет.
    if (g.seats[g.toPlay].controller !== 'engine') return { state: g, move };
    g.pendingEngineMove = true;
    if (self.replyTimedOut) {
      self.replyTimedOut = false;
      return { state: g, move, replyTimedOut: true };
    }
    const reply = engineMove();
    if (coord === 'pass' && reply.coord === 'pass') pollsLeft = opts.finishAfterPolls ?? 2;
    return { state: g, move, reply };
  }

  return self;
}
```

- [ ] **Step 2: Тест `apps/voice-agent/src/tools.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { ApiError, ClientTimeoutError, type GameState, HttpError, humanText } from '@goko/protocol';
import { type AgentState, newAgentState } from './state.ts';
import { createFakeClient, fakeGame } from './testing/fake-client.ts';
import {
  ASSESSMENT_VISITS,
  FINISH_POLL_MS,
  FINISH_WAIT_MS,
  KOMI_TEXT,
  NETWORK_TEXT,
  createToolFns,
  createTools,
} from './tools.ts';

type FakeOpts = Parameters<typeof createFakeClient>[0];
type OnTick = (now: number, state: AgentState) => void;

// Часы тестов двигает только sleep: ожидание итога и Retry-After проверяются без настоящего времени.
// onTick — что «пришло из потока» к этому моменту (events.ts кладёт итог в state.finished).
function setup(opts: FakeOpts = {}, onTick?: OnTick) {
  const client = createFakeClient(opts);
  const state = newAgentState('s1');
  const clock = { t: 0 };
  const slept: number[] = [];
  const controller = new AbortController();
  const sleep = async (ms: number) => {
    slept.push(ms);
    clock.t += ms;
    onTick?.(clock.t, state);
  };
  const fns = createToolFns({ client, state, sleep, now: () => clock.t, signal: controller.signal });
  return { client, state, fns, slept, clock, controller };
}

async function withGame(opts: FakeOpts = {}, onTick?: OnTick) {
  const t = setup(opts, onTick);
  await t.fns.startGame({ my_color: 'black' });
  t.client.calls.length = 0;
  t.client.signals.length = 0;
  return t;
}

// Партия фейкового клиента без non-null `!`: нет партии — тест падает понятной ошибкой.
function gameOf(client: { game: GameState | null }): GameState {
  if (!client.game) throw new Error('фейковый клиент: партии нет');
  return client.game;
}

describe('без партии', () => {
  it('инструменты партии отвечают ok:false с подсказкой', async () => {
    const { fns, client } = setup();
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: 'партия не начата: предложи начать' });
    expect(await fns.pass()).toMatchObject({ ok: false });
    expect(await fns.getPosition()).toContain('партия не начата');
    expect(client.calls).toEqual([]);
  });
  it('set_rank без партии запоминает ранг для следующей', async () => {
    const { fns, state, client } = setup();
    expect(await fns.setRank({ rank: '5 кю' })).toEqual({ ok: true, rank: '5 кю', note: 'применится к следующей партии' });
    expect(state.rank).toBe('5k');
    expect(client.calls).toEqual([]);
  });
});

describe('start_game', () => {
  it('человек чёрными: движок белыми с рангом по умолчанию, первого хода нет', async () => {
    const { fns, state, client } = setup();
    const res = await fns.startGame({});
    expect(res).toEqual({ ok: true, gameId: 'g1', youPlay: 'black', rank: '10 кю', komi: 7.5, firstMove: null, firstMoveSpoken: null });
    expect(client.calls[0]).toMatchObject({
      method: 'newGame',
      args: ['s1', { black: { controller: 'human' }, white: { controller: 'engine', rank: '10k' }, settings: { komi: 7.5 }, waitForReply: true }],
    });
    expect(state.gameId).toBe('g1');
    expect(state.humanColor).toBe('B');
    expect(state.toolGames.has('g1')).toBe(true);
    expect(state.startingGame).toBe(false);
  });
  it('на время newGame выставляет startingGame и снимает его после ошибки', async () => {
    const { fns, state, client } = setup();
    let during: boolean | null = null;
    const newGame = client.newGame;
    client.newGame = async (...args) => {
      during = state.startingGame;
      return newGame(...args);
    };
    await fns.startGame({});
    expect(during).toBe(true);
    // Лимит незавершённых партий на клиента (D-0012, задача 9): текст — из humanText по details.
    const details = { max: 3, scope: 'client' };
    client.failNext(new ApiError('too_many_games', 'limit of 3 unfinished games per client reached', details));
    expect(await fns.startGame({})).toEqual({ ok: false, reason: humanText('too_many_games', details) });
    expect(state.startingGame).toBe(false);
  });
  it('коми не с половиной или вне 0,5–13,5 — ok:false без запроса', async () => {
    const { fns, client } = setup();
    for (const komi of [7, 0, 14.5, -0.5, Number.NaN]) expect(await fns.startGame({ komi })).toEqual({ ok: false, reason: KOMI_TEXT });
    expect(client.calls).toEqual([]);
    expect(await fns.startGame({ komi: 0.5 })).toMatchObject({ ok: true, komi: 0.5 });
  });
  it('человек белыми с рангом: первый ход движка в ответе', async () => {
    const { fns, state } = setup({ replies: ['K10'] });
    const res = await fns.startGame({ my_color: 'white', rank: '3 кю', komi: 6.5 });
    expect(res).toMatchObject({ ok: true, youPlay: 'white', rank: '3 кю', komi: 6.5, firstMove: 'K10', firstMoveSpoken: 'ка десять' });
    expect(state.humanColor).toBe('W');
    expect(state.rank).toBe('3k');
  });
  it('непонятный ранг — ok:false, партия не создаётся', async () => {
    const { fns, client } = setup();
    expect(await fns.startGame({ rank: 'сильно' })).toEqual({ ok: false, reason: 'не понял ранг «сильно»: назови число и кю или дан' });
    expect(client.calls).toEqual([]);
  });
  it('таймаут первого хода — note и awaitingReply', async () => {
    const { fns, state, client } = setup();
    client.replyTimedOut = true;
    const res = await fns.startGame({ my_color: 'white' });
    expect(res).toMatchObject({ ok: true, firstMove: null, note: 'Гоко ещё думает над первым ходом и назовёт его сам' });
    expect(state.awaitingReply).toBe(true);
  });
});

describe('play_move / correct_last_move', () => {
  it('ход и ответ движка с произношением', async () => {
    const { fns, client } = await withGame({ replies: ['K10'] });
    const res = await fns.playMove({ coord: 'D4' });
    expect(res).toEqual({ ok: true, yourMove: 'D4', myMove: 'K10', myMoveSpoken: 'ка десять', captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 2 });
    expect(client.calls[0]).toMatchObject({ method: 'play', args: ['g1', { coord: 'D4', via: 'voice' }] });
  });
  it('нелегальный ход — причина из humanText по details.reason, не message', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ApiError('illegal_move', 'illegal move D4: occupied', { reason: 'occupied', coord: 'D4' }));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: 'точка занята' });
  });
  it('движок занят — просьба повторить, не исключение', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ApiError('engine_busy', 'engine did not respond within 10000 ms'));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: humanText('engine_busy') });
  });
  it('не наш ход — русский текст по коду, английский message не просачивается', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ApiError('not_your_turn', 'it is Goko to play', { toPlay: 'W' }));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: humanText('not_your_turn') });
  });
  it('таймаут ответа — note, myMove null, awaitingReply', async () => {
    const { fns, state, client } = await withGame();
    client.replyTimedOut = true;
    const res = await fns.playMove({ coord: 'D4' });
    expect(res).toMatchObject({ ok: true, yourMove: 'D4', myMove: null, note: 'Гоко ещё думает: свой ход он назовёт сам, когда решит' });
    expect(state.awaitingReply).toBe(true);
  });
  it('correct_last_move зовёт correct и отвечает как play', async () => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10'] });
    await fns.playMove({ coord: 'D4' });
    const res = await fns.correctLastMove({ coord: 'D5' });
    expect(res).toMatchObject({ ok: true, yourMove: 'D5', myMove: 'D10', myMoveSpoken: 'дэ десять', moveNumber: 2 });
    expect(client.calls.at(-1)).toMatchObject({ method: 'correct', args: ['g1', { coord: 'D5', via: 'voice' }] });
  });
  it('сдача движка после хода — finished и result', async () => {
    const { fns, state, client } = await withGame();
    client.play = async () => {
      const move = { n: 1, color: 'B' as const, coord: 'D4', captured: 0, at: 't' };
      const g = fakeGame({ id: 'g1', status: 'finished', result: { winner: 'B', reason: 'resign' }, moves: [move], toPlay: 'W', revision: 1 });
      return { state: g, move };
    };
    const res = await fns.playMove({ coord: 'D4' });
    expect(res).toMatchObject({ ok: true, finished: true, result: 'победа за тобой: я сдался' });
    expect(state.announcedFinish).toBe('g1');
    expect(state.awaitingReply).toBe(false);
  });
  it('сеть и ответ не по протоколу — «нет связи с сервером» без перечитывания; таймаут чтения — «сервер не отвечает»', async () => {
    const { fns, client } = await withGame();
    client.failNext(new TypeError('fetch failed'));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: NETWORK_TEXT });
    client.failNext(new HttpError(502, '<html>Bad Gateway</html>'));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: NETWORK_TEXT });
    client.failNext(new ClientTimeoutError('analyze', 15_000));
    expect(await fns.getAssessment()).toEqual({ ok: false, reason: humanText('client_timeout') });
    expect(humanText('client_timeout')).not.toBe(NETWORK_TEXT);
    expect(client.calls.map((c) => c.method)).toEqual(['play', 'play', 'getGame', 'analyze']);
  });
  it('ошибка кода пробрасывается: её увидит лог воркера, а не человек', async () => {
    const { fns, client } = await withGame();
    client.failNext(new Error('bug in tool'));
    await expect(fns.playMove({ coord: 'D4' })).rejects.toThrow('bug in tool');
  });
  it('сигнал сеанса уходит в каждый вызов клиента; отменённый сигнал обрывает инструмент', async () => {
    const { fns, client, controller } = await withGame({ replies: ['K10'] });
    await fns.playMove({ coord: 'D4' });
    await fns.getPosition();
    expect(client.signals).toEqual([controller.signal, controller.signal, controller.signal]);
    controller.abort();
    const err = await fns.playMove({ coord: 'E5' }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
  });
  it('rate_limited: текст из humanText, до Retry-After инструменты партии к серверу не ходят', async () => {
    const { fns, client, state, clock } = await withGame({ replies: ['K10'] });
    client.failNext(new ApiError('rate_limited', 'too many requests, retry in 30 s', { retryAfterSeconds: 30 }));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: humanText('rate_limited') });
    expect(state.blockedUntil).toBe(30_000);
    client.calls.length = 0;
    clock.t = 29_999;
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: humanText('rate_limited') });
    expect(await fns.getPosition()).toBe(humanText('rate_limited'));
    expect(await fns.getAssessment()).toEqual({ ok: false, reason: humanText('rate_limited') });
    expect(client.calls).toEqual([]);
    clock.t = 30_000;
    expect(await fns.playMove({ coord: 'D4' })).toMatchObject({ ok: true, myMove: 'K10' });
  });
});

describe('таймаут клиента на ходе, пасе и поправке: перечитывание вместо повтора', () => {
  const NOT_APPLIED_TAIL = 'Не повторяй ход сам: скажи человеку и дождись его слов';

  it('ход не записан: партия перечитана тем же сигналом, ход не повторён, модель слышит, чей ход на самом деле', async () => {
    const { fns, client, state, controller } = await withGame();
    client.failNext(new ClientTimeoutError('play', 15_000));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({
      ok: false,
      reason: `сервер не отвечает: хода D4 в партии пока нет, сейчас ход: чёрные (твой). ${NOT_APPLIED_TAIL}`,
    });
    expect(client.calls.map((c) => c.method)).toEqual(['play', 'getGame']);
    expect(client.signals).toEqual([controller.signal, controller.signal]);
    expect(gameOf(client).moves).toEqual([]);
    expect(state.awaitingReply).toBe(false);
  });

  it('ход записан, ответ не дошёл: результат по перечитанной партии — с ответом Гоко или с note, пока он думает', async () => {
    const { fns, client, state } = await withGame({ replies: ['K10'] });
    client.failNext(new ClientTimeoutError('play', 15_000), 'after');
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: true, yourMove: 'D4', myMove: 'K10', myMoveSpoken: 'ка десять', captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 2 });
    expect(state.awaitingReply).toBe(false);
    client.replyTimedOut = true;
    client.failNext(new ClientTimeoutError('play', 15_000), 'after');
    expect(await fns.playMove({ coord: 'E5' })).toMatchObject({ ok: true, yourMove: 'E5', myMove: null, note: 'Гоко ещё думает: свой ход он назовёт сам, когда решит' });
    expect(state.awaitingReply).toBe(true);
    expect(client.calls.map((c) => c.method)).toEqual(['play', 'getGame', 'play', 'getGame']);
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['D4', 'K10', 'E5']);
  });

  it('пас не записан, хотя прежний ход человека тоже пас: ревизия та же — паса нет', async () => {
    const { fns, client } = await withGame({ replies: ['K10'] });
    expect(await fns.pass()).toMatchObject({ ok: true, myMove: 'K10' });
    client.failNext(new ClientTimeoutError('pass', 15_000));
    // По одним ходам (пас человека, за ним ход Гоко) пас выглядел бы записанным: решает ревизия из ответа пасу.
    expect(await fns.pass()).toEqual({ ok: false, reason: `сервер не отвечает: паса в партии пока нет, сейчас ход: чёрные (твой). ${NOT_APPLIED_TAIL}` });
    expect(client.calls.map((c) => c.method)).toEqual(['pass', 'pass', 'getGame']);
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['pass', 'K10']);
  });

  it('пас и поправка записаны, ответ не дошёл: обычные ответы по перечитанной партии', async () => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10', 'K4'] });
    client.failNext(new ClientTimeoutError('pass', 15_000), 'after');
    expect(await fns.pass()).toEqual({ ok: true, myMove: 'K10', myMoveSpoken: 'ка десять', toPlay: 'B' });
    await fns.playMove({ coord: 'D4' });
    client.failNext(new ClientTimeoutError('correct', 15_000), 'after');
    expect(await fns.correctLastMove({ coord: 'D5' })).toEqual({ ok: true, yourMove: 'D5', myMove: 'K4', myMoveSpoken: 'ка четыре', captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 4 });
    expect(client.calls.map((c) => c.method)).toEqual(['pass', 'getGame', 'play', 'correct', 'getGame']);
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['pass', 'K10', 'D5', 'K4']);
  });

  it('перечитать не вышло — отказ перечитывания; ход не повторён', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ClientTimeoutError('play', 15_000));
    client.getGame = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: NETWORK_TEXT });
    expect(client.calls.map((c) => c.method)).toEqual(['play']);
  });
});

describe('pass / resign / undo', () => {
  it('пас с ответным ходом', async () => {
    const { fns } = await withGame({ replies: ['K10'] });
    expect(await fns.pass()).toEqual({ ok: true, myMove: 'K10', myMoveSpoken: 'ка десять', toPlay: 'B' });
  });
  it('два паса: итог из game.finished потока — без опроса get_game (R2)', async () => {
    const { fns, state, client, clock } = await withGame({ replies: ['pass'], finishAfterPolls: 100 }, (now, s) => {
      expect(s.awaitingFinish).toBe('g1');
      if (now === 1_000) s.finished = { gameId: 'g1', result: { winner: 'B', margin: 3.5, reason: 'score' } };
    });
    const res = await fns.pass();
    expect(res).toMatchObject({ ok: true, myMove: 'pass', finished: true, result: 'победа за тобой, разница 3,5 очка' });
    expect(client.calls.filter((c) => c.method === 'getGame')).toEqual([]);
    expect(clock.t).toBe(1_000);
    expect(state.announcedFinish).toBe('g1');
    expect(state.awaitingFinish).toBeNull();
  });
  it('два паса: поток молчит — опрос не чаще раза в 2,5 с', async () => {
    const { fns, state, client, clock } = await withGame({ replies: ['pass'], finishAfterPolls: 2 });
    const res = await fns.pass();
    expect(res).toMatchObject({ ok: true, myMove: 'pass', myMoveSpoken: 'пас', finished: true, result: 'победа за мной, разница 3,5 очка' });
    expect(client.calls.filter((c) => c.method === 'getGame').length).toBe(2);
    expect(clock.t).toBe(2 * FINISH_POLL_MS);
    expect(state.announcedFinish).toBe('g1');
  });
  it('два паса: итога нет за FINISH_WAIT_MS — не больше 8 опросов, note, итог объявит событие', async () => {
    const { fns, state, client, clock } = await withGame({ replies: ['pass'], finishAfterPolls: 100 });
    const res = await fns.pass();
    expect(res).toEqual({ ok: true, myMove: 'pass', myMoveSpoken: 'пас', toPlay: 'B', note: 'Гоко ещё считает очки: итог назовёт сам' });
    expect(client.calls.filter((c) => c.method === 'getGame').length).toBe(Math.floor((FINISH_WAIT_MS - 1) / FINISH_POLL_MS));
    expect(clock.t).toBe(FINISH_WAIT_MS);
    expect(state.announcedFinish).toBeNull();
    expect(state.awaitingFinish).toBeNull();
  });
  it('resign сдаёт цветом человека', async () => {
    const { fns, state, client } = await withGame();
    expect(await fns.resign()).toEqual({ ok: true, result: 'победа за мной: партия сдана' });
    expect(client.calls.at(-1)).toMatchObject({ method: 'resign', args: ['g1', { color: 'B', via: 'voice' }] });
    expect(state.announcedFinish).toBe('g1');
  });
  it('resign: bad_request с reason not_your_seat — «это не твой цвет»', async () => {
    const { fns, client } = await withGame();
    client.resign = async () => {
      throw new ApiError('bad_request', 'seat is not controlled by a human', { reason: 'not_your_seat' });
    };
    expect(await fns.resign()).toEqual({ ok: false, reason: humanText('bad_request', { reason: 'not_your_seat' }) });
    expect(humanText('bad_request', { reason: 'not_your_seat' })).toBe('это не твой цвет');
  });
  it('undo возвращает снятые ходы с произношением', async () => {
    const { fns, state } = await withGame({ replies: ['K10'] });
    await fns.playMove({ coord: 'D4' });
    state.awaitingReply = true;
    expect(await fns.undo()).toEqual({ ok: true, removed: ['D4', 'K10'], removedSpoken: ['дэ четыре', 'ка десять'], toPlay: 'B', status: 'playing' });
    expect(state.awaitingReply).toBe(false);
  });
  it('undo без ходов — reason из humanText, не английский message', async () => {
    const { fns } = await withGame();
    expect(await fns.undo()).toEqual({ ok: false, reason: humanText('nothing_to_undo') });
  });
});

describe('get_position / get_assessment / set_rank', () => {
  it('позиция: доска, последние 6 ходов, пленные, чей ход', async () => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10', 'K4', 'G7'] });
    for (const c of ['D4', 'C3', 'E3', 'F4']) await fns.playMove({ coord: c });
    gameOf(client).captures = { B: 2, W: 0 };
    const text = await fns.getPosition();
    expect(text).toContain('# g1 rev');
    expect(text).toContain('Последние ходы: 3. чёрные C3; 4. белые D10; 5. чёрные E3; 6. белые K4; 7. чёрные F4; 8. белые G7');
    expect(text).not.toContain('1. чёрные D4');
    expect(text).toContain('Пленные: чёрные сняли 2, белые сняли 0');
    expect(text).toContain('Ход: чёрные (твой)');
    expect(text).not.toContain('из основного поиска');
  });
  it('позиция называет ход движка с humanFallback, пока он на доске (D-0007)', async () => {
    const { fns, state } = await withGame({ replies: ['K10'] });
    await fns.playMove({ coord: 'D4' });
    state.fallbackMove = 2;
    expect(await fns.getPosition()).toContain('Ход 2 (белые K10) Гоко взял из основного поиска, а не из человеческой сети уровня');
    state.fallbackMove = 5;
    expect(await fns.getPosition()).not.toContain('из основного поиска');
  });
  it('оценка: лидер, отрыв, шансы, слабые группы, лучшие ходы', async () => {
    const { fns, client } = await withGame();
    const res = await fns.getAssessment();
    expect(res).toEqual({
      leader: 'you',
      marginPoints: 6,
      winrateYou: 70,
      weakGroups: [
        { color: 'mine', where: 'C3, C4', status: 'неустойчива' },
        { color: 'yours', where: 'M3', status: 'мертва' },
      ],
      bestMoves: ['K10', 'D10', 'G7'],
      toPlay: 'you',
    });
    expect(client.calls.find((c) => c.method === 'analyze')).toMatchObject({ args: ['g1', { maxVisits: ASSESSMENT_VISITS }] });
  });
  it('оценка при отставании', async () => {
    const { fns } = await withGame({ analysis: { winrateB: 0.3, scoreLeadB: -0.2 } });
    expect(await fns.getAssessment()).toMatchObject({ leader: 'even', marginPoints: 0, winrateYou: 30 });
  });
  it('set_rank меняет ранг движка в текущей партии', async () => {
    const { fns, client, state } = await withGame();
    expect(await fns.setRank({ rank: '5 дан' })).toEqual({ ok: true, rank: '5 дан' });
    expect(client.calls.at(-1)).toMatchObject({ method: 'setRank', args: ['g1', { color: 'W', rank: '5d' }] });
    expect(state.rank).toBe('5d');
  });
});

describe('createTools', () => {
  it('отдаёт девять инструментов с именами из спеки', () => {
    const { client, state } = setup();
    const tools = createTools({ client, state });
    expect(Object.keys(tools).sort()).toEqual(
      ['correct_last_move', 'get_assessment', 'get_position', 'pass', 'play_move', 'resign', 'set_rank', 'start_game', 'undo'],
    );
  });
});

describe('человек против человека (D-0005)', () => {
  function hvh() {
    const t = setup();
    t.client.game = fakeGame({
      seats: { B: { controller: 'human' }, W: { controller: 'human' } },
      toPlay: 'W',
      moves: [{ n: 1, color: 'B', coord: 'D4', captured: 0, at: 't' }],
      revision: 1,
    });
    t.state.gameId = 'g1';
    t.state.humanColor = null;
    return t;
  }
  it('ход без ответа движка', async () => {
    const { fns, client, state } = hvh();
    expect(await fns.playMove({ coord: 'K10' })).toEqual({ ok: true, yourMove: 'K10', myMove: null, myMoveSpoken: null, captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 2 });
    expect(client.calls.map((c) => c.method)).toEqual(['play']);
    expect(state.awaitingReply).toBe(false);
  });
  it('сдаётся тот, чей ход; результат цветами', async () => {
    const { fns, client } = hvh();
    expect(await fns.resign()).toEqual({ ok: true, result: 'победа чёрных: белые сдались' });
    expect(client.calls.at(-1)).toMatchObject({ method: 'resign', args: ['g1', { color: 'W', via: 'voice' }] });
  });
  it('set_rank не трогает партию без Гоко', async () => {
    const { fns, client, state } = hvh();
    expect(await fns.setRank({ rank: '5 кю' })).toEqual({ ok: true, rank: '5 кю', note: 'в этой партии нет Гоко: уровень применится к следующей' });
    expect(state.rank).toBe('5k');
    expect(client.calls.map((c) => c.method)).toEqual(['getGame']);
  });
  it('позиция и оценка — цветами, без «твой» и «мой»', async () => {
    const { fns } = hvh();
    expect((await fns.getPosition()).split('\n').at(-1)).toBe('Ход: белые');
    expect(await fns.getAssessment()).toEqual({
      leader: 'black',
      marginPoints: 6,
      winrateBlack: 70,
      weakGroups: [
        { color: 'white', where: 'C3, C4', status: 'неустойчива' },
        { color: 'black', where: 'M3', status: 'мертва' },
      ],
      bestMoves: ['K10', 'D10', 'G7'],
      toPlay: 'white',
    });
  });
});
```

- [ ] **Step 3: Запустить тест, убедиться, что падает**

Run: `npx vitest run apps/voice-agent/src/tools.test.ts`
Expected: FAIL — `Cannot find module './tools.ts'`.

- [ ] **Step 4: `apps/voice-agent/src/tools.ts`**

```ts
// Инструменты Гоко (таблица раздела 9 спеки). createToolFns — чистые функции над клиентом протокола,
// их тестируем с фейковым клиентом; createTools заворачивает их в llm.tool() со схемами zod.
// Никакой позиции в памяти: всё берётся из ответов game-server.
import { llm } from '@livekit/agents';
import { z } from 'zod';
import {
  ApiError,
  ClientTimeoutError,
  type Color,
  type GameState,
  type GokoClient,
  HttpError,
  hasEngine,
  humanColorOf,
  humanText,
  type Move,
  type PlayResponse,
  retryAfterMs,
  seatColor,
} from '@goko/protocol';
import { colorName, describeResult, parseRank, speakMove, speakRank } from './phrases.ts';
import type { AgentState } from './state.ts';

export type ToolClient = Pick<
  GokoClient,
  'newGame' | 'play' | 'correct' | 'pass' | 'resign' | 'undo' | 'getGame' | 'ascii' | 'analyze' | 'setRank'
>;

export type ToolDeps = {
  client: ToolClient;
  state: AgentState;
  signal?: AbortSignal; // сигнал сеанса воркера: уходит в каждый вызов клиента, долгоживущий — это можно (раздел 5 спеки)
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

export const ASSESSMENT_VISITS = 50;
// Счёт после двух пасов сервер ведёт в фоне с бюджетом SCORE_BUDGET_MS = 20 с (D-0010). Ждём итог чуть
// дольше бюджета, но меньше клиентского потолка score (CLIENT_TIMEOUTS.score = 25 с): модель не молчит
// дольше, чем длился бы прямой вызов score. Если счёт упал и сервер начал повтор серии (D-0006), итог
// позже объявит событие game.finished, инструмент отдаёт партию незавершённой с note.
export const FINISH_WAIT_MS = 22_000;
// Итог берём из потока сессии (state.finished); get_game — запасной путь, не чаще раза в 2,5 с (R2).
export const FINISH_POLL_MS = 2_500;
export const FINISH_TICK_MS = 250;

export const NETWORK_TEXT = 'нет связи с сервером';
export const KOMI_TEXT = 'коми бывает только с половиной, от 0,5 до 13,5: например 6,5 или 7,5';
const NO_GAME = 'партия не начата: предложи начать';
const THINKING_NOTE = 'Гоко ещё думает: свой ход он назовёт сам, когда решит';
const SCORING_NOTE = 'Гоко ещё считает очки: итог назовёт сам';

// Коми по протоколу — x.5 от 0,5 до 13,5 (иначе сервер ответит bad_request без понятной человеку причины).
const komiValid = (komi: number): boolean => Number.isFinite(komi) && komi >= 0.5 && komi <= 13.5 && komi % 1 === 0.5;

type Fail = { ok: false; reason: string };
const fail = (reason: string): Fail => ({ ok: false, reason });

// hasEngine, humanColorOf и retryAfterMs — из @goko/protocol (задача 1): то же правило у веба.
export function engineColorOf(state: GameState): Color {
  return seatColor(state.seats, 'engine') ?? 'W';
}

const colorKey = (c: Color) => (c === 'B' ? ('black' as const) : ('white' as const));

function finishedFields(g: GameState) {
  return g.status === 'finished' && g.result
    ? { finished: true as const, result: describeResult(g.result, hasEngine(g) ? humanColorOf(g) : null) }
    : {};
}

// Чей ход словами: с Гоко — «чёрные (твой)» или «белые (мой)», в партии двух людей — только цвет.
function turnOf(g: GameState): string {
  return hasEngine(g) ? `${colorName(g.toPlay)} (${g.toPlay === humanColorOf(g) ? 'твой' : 'мой'})` : colorName(g.toPlay);
}

// Ход человека coord в конце перечитанной партии после таймаута клиента: последним (ответа Гоко ещё нет или
// Гоко в партии нет) или предпоследним, а за ним ход Гоко. Иначе null: хода нет или после него были другие ходы.
function appliedMove(g: GameState, coord: string): PlayResponse | null {
  const byHuman = (m: Move | undefined): m is Move => m !== undefined && m.coord === coord && g.seats[m.color].controller === 'human';
  const last = g.moves.at(-1);
  const prev = g.moves.at(-2);
  if (byHuman(last)) return { state: g, move: last, ...(g.pendingEngineMove ? { replyTimedOut: true } : {}) };
  if (byHuman(prev) && last && g.seats[last.color].controller === 'engine') return { state: g, move: prev, reply: last };
  return null;
}

// Ход после таймаута не записан. Запрос мог ещё дойти до сервера, поэтому модель не повторяет ход сама.
function notAppliedText(g: GameState, coord: string): string {
  const what = coord === 'pass' ? 'паса' : `хода ${coord}`;
  const turn = g.status === 'finished' ? 'партия окончена' : `сейчас ход: ${turnOf(g)}`;
  return `${humanText('client_timeout')}: ${what} в партии пока нет, ${turn}. Не повторяй ход сам: скажи человеку и дождись его слов`;
}

export function createToolFns(deps: ToolDeps) {
  const { client, state, signal } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const opts = { signal };

  // Отказ -> { ok: false, reason } по-русски (D-0007): message сервера английский и модели не отдаётся.
  // Три класса различаются: ответ сервера по протоколу, «сервер не отвечает» (таймаут клиента) и
  // «нет связи» (сеть или ответ не по протоколу, например страница прокси). Остальное — баг или отмена
  // сигналом сеанса: пробрасываем в лог воркера, человеку это не озвучивается.
  function reasonOf(e: unknown): Fail {
    if (e instanceof ApiError) {
      if (e.code === 'rate_limited') state.blockedUntil = Math.max(state.blockedUntil, now() + retryAfterMs(e.details));
      return fail(humanText(e.code, e.details));
    }
    if (e instanceof ClientTimeoutError) return fail(humanText(e.code));
    if (e instanceof HttpError || (e instanceof TypeError && e.message === 'fetch failed')) return fail(NETWORK_TEXT);
    throw e;
  }

  // Retry-After ещё не прошёл: к серверу не идём (D-0012), модель получает ту же фразу, что на сам отказ.
  function blocked(): Fail | null {
    return now() < state.blockedUntil ? fail(humanText('rate_limited')) : null;
  }

  // Последняя ревизия партии из ответов сервера инструментам. События потока сюда не пишутся: state.updated
  // о записанном ходе приходит раньше таймаута, и сверка в sendMove приняла бы записанный ход за незаписанный.
  let seen: { gameId: string; revision: number } | null = null;
  function note(g: GameState): GameState {
    if (!seen || seen.gameId !== g.id || seen.revision < g.revision) seen = { gameId: g.id, revision: g.revision };
    return g;
  }

  // Ход, пас или поправка. ClientTimeoutError не значит, что хода нет: сервер мог записать его, а ответ не
  // дошёл. Повтор вслепую поставил бы камень второй раз или спасовал бы за человека, поэтому партия
  // перечитывается: та же ревизия — хода нет; иначе ход ищется в конце партии (appliedMove).
  async function sendMove(gameId: string, coord: string, call: () => Promise<PlayResponse>): Promise<PlayResponse | Fail> {
    const before = seen?.gameId === gameId ? seen.revision : null;
    try {
      const res = await call();
      note(res.state);
      return res;
    } catch (e) {
      if (!(e instanceof ClientTimeoutError)) return reasonOf(e);
    }
    let g: GameState;
    try {
      g = note(await client.getGame(gameId, opts));
    } catch (e) {
      return reasonOf(e);
    }
    return (g.revision === before ? null : appliedMove(g, coord)) ?? fail(notAppliedText(g, coord));
  }

  function moveResult(res: PlayResponse) {
    const { state: g, move, reply } = res;
    const finished = g.status === 'finished';
    state.awaitingReply = Boolean(res.replyTimedOut) && !finished;
    if (finished) state.announcedFinish = g.id;
    return {
      ok: true as const,
      yourMove: move.coord,
      myMove: reply?.coord ?? null,
      myMoveSpoken: reply ? speakMove(reply.coord) : null,
      captured: move.captured,
      myCaptured: reply?.captured ?? 0,
      toPlay: g.toPlay,
      moveNumber: g.moves.length,
      ...(res.replyTimedOut && !finished ? { note: THINKING_NOTE } : {}),
      ...finishedFields(g),
    };
  }

  // Итог после двух пасов (R2). Первым делом — событие game.finished: events.ts, пока awaitingFinish равен
  // этой партии, кладёт итог в state.finished и не озвучивает его. Запасной путь — get_game не чаще раза
  // в FINISH_POLL_MS и не раньше Retry-After. Первый опрос — через FINISH_POLL_MS после пасов, всего их
  // не больше 8 за FINISH_WAIT_MS.
  async function waitFinished(g0: GameState): Promise<GameState> {
    const gameId = g0.id;
    let g = g0;
    const started = now();
    let lastPoll = started;
    state.awaitingFinish = gameId;
    try {
      for (;;) {
        const fromStream = state.finished;
        if (fromStream?.gameId === gameId) return { ...g, status: 'finished', result: fromStream.result };
        if (now() - started >= FINISH_WAIT_MS) return g;
        if (now() - lastPoll >= FINISH_POLL_MS && now() >= state.blockedUntil) {
          lastPoll = now();
          try {
            g = note(await client.getGame(gameId, opts));
          } catch (e) {
            reasonOf(e); // rate_limited выставит blockedUntil; прочие отказы — ждём дальше; баг и отмена — наружу
          }
          if (g.status === 'finished') return g;
        }
        await sleep(FINISH_TICK_MS);
      }
    } finally {
      state.awaitingFinish = null;
    }
  }

  return {
    async startGame(args: { my_color?: 'black' | 'white'; rank?: string; komi?: number }) {
      const human: Color = args.my_color === 'white' ? 'W' : 'B';
      let rank = state.rank;
      if (args.rank !== undefined) {
        const parsed = parseRank(args.rank);
        if (!parsed) return fail(`не понял ранг «${args.rank}»: назови число и кю или дан`);
        rank = parsed;
      }
      const komi = args.komi ?? state.komi;
      if (!komiValid(komi)) return fail(KOMI_TEXT);
      const blockedFail = blocked();
      if (blockedFail) return blockedFail;
      const engine = { controller: 'engine' as const, rank };
      const humanSeat = { controller: 'human' as const };
      // Сервер публикует state.updated new раньше, чем отвечает на HTTP (а с waitForReply и первым ходом
      // движка — заметно раньше): флаг говорит events.ts, что эта новая партия — от инструмента.
      state.startingGame = true;
      try {
        const res = await client.newGame(
          state.sessionId,
          {
            black: human === 'B' ? humanSeat : engine,
            white: human === 'W' ? humanSeat : engine,
            settings: { komi },
            waitForReply: true,
          },
          opts,
        );
        const g = note(res.state);
        state.gameId = g.id;
        state.humanColor = human;
        state.rank = rank;
        state.komi = komi;
        state.toolGames.add(g.id);
        state.announcedFinish = null;
        state.finished = null;
        state.lastTap = null;
        state.awaitingReply = Boolean(res.replyTimedOut);
        log(`[OK] voice-agent: партия ${g.id}, человек ${colorName(human)}, Гоко ${rank}`);
        return {
          ok: true as const,
          gameId: g.id,
          youPlay: human === 'B' ? ('black' as const) : ('white' as const),
          rank: speakRank(rank),
          komi,
          firstMove: res.firstMove?.coord ?? null,
          firstMoveSpoken: res.firstMove ? speakMove(res.firstMove.coord) : null,
          ...(res.replyTimedOut ? { note: 'Гоко ещё думает над первым ходом и назовёт его сам' } : {}),
        };
      } catch (e) {
        return reasonOf(e);
      } finally {
        state.startingGame = false;
      }
    },

    async playMove({ coord }: { coord: string }) {
      const gameId = state.gameId;
      if (!gameId) return fail(NO_GAME);
      const blockedFail = blocked();
      if (blockedFail) return blockedFail;
      const res = await sendMove(gameId, coord, () => client.play(gameId, { coord, via: 'voice' }, opts));
      return 'state' in res ? moveResult(res) : res;
    },

    async correctLastMove({ coord }: { coord: string }) {
      const gameId = state.gameId;
      if (!gameId) return fail(NO_GAME);
      const blockedFail = blocked();
      if (blockedFail) return blockedFail;
      const res = await sendMove(gameId, coord, () => client.correct(gameId, { coord, via: 'voice' }, opts));
      return 'state' in res ? moveResult(res) : res;
    },

    async pass() {
      const gameId = state.gameId;
      if (!gameId) return fail(NO_GAME);
      const blockedFail = blocked();
      if (blockedFail) return blockedFail;
      const res = await sendMove(gameId, 'pass', () => client.pass(gameId, { via: 'voice' }, opts));
      if (!('state' in res)) return res;
      let g = res.state;
      // Два паса подряд: сервер считает очки в фоне; итог ждём из потока, опрос — запасной путь.
      // Отказы опроса waitFinished разбирает сам; наружу из него идут только баг и отмена сигналом.
      const scoring = res.reply?.coord === 'pass' && g.status !== 'finished';
      if (scoring) g = await waitFinished(g);
      const finished = g.status === 'finished';
      if (finished) state.announcedFinish = g.id;
      state.awaitingReply = Boolean(res.replyTimedOut) && !finished;
      return {
        ok: true as const,
        myMove: res.reply?.coord ?? null,
        myMoveSpoken: res.reply ? speakMove(res.reply.coord) : null,
        toPlay: g.toPlay,
        ...(res.replyTimedOut && !finished ? { note: THINKING_NOTE } : {}),
        ...(scoring && !finished ? { note: SCORING_NOTE } : {}),
        ...finishedFields(g),
      };
    },

    async resign() {
      if (!state.gameId) return fail(NO_GAME);
      const blockedFail = blocked();
      if (blockedFail) return blockedFail;
      try {
        // Цвет сдающегося — до хода: в партии двух людей это тот, чей ход (humanColorOf).
        const current = note(await client.getGame(state.gameId, opts));
        const color = humanColorOf(current);
        const res = await client.resign(state.gameId, { color, via: 'voice' }, opts);
        note(res.state);
        state.announcedFinish = res.state.id;
        state.awaitingReply = false;
        const who = hasEngine(current) ? color : null;
        return { ok: true as const, result: res.state.result ? describeResult(res.state.result, who) : 'партия сдана' };
      } catch (e) {
        return reasonOf(e);
      }
    },

    async undo() {
      if (!state.gameId) return fail(NO_GAME);
      const blockedFail = blocked();
      if (blockedFail) return blockedFail;
      try {
        const res = await client.undo(state.gameId, { via: 'voice' }, opts);
        note(res.state);
        state.awaitingReply = false;
        state.lastTap = null;
        return {
          ok: true as const,
          removed: res.removed.map((m) => m.coord),
          removedSpoken: res.removed.map((m) => speakMove(m.coord)),
          toPlay: res.state.toPlay,
          status: res.state.status,
        };
      } catch (e) {
        return reasonOf(e);
      }
    },

    async getPosition(): Promise<string> {
      if (!state.gameId) return NO_GAME;
      const blockedFail = blocked();
      if (blockedFail) return blockedFail.reason;
      let g: GameState;
      let ascii: string;
      try {
        [g, ascii] = await Promise.all([client.getGame(state.gameId, opts), client.ascii(state.gameId, opts)]);
      } catch (e) {
        return reasonOf(e).reason;
      }
      note(g);
      const last = g.moves
        .slice(-6)
        .map((m) => `${m.n}. ${colorName(m.color)} ${m.coord === 'pass' ? 'пас' : m.coord}`)
        .join('; ');
      const turn = g.status === 'finished' ? 'партия окончена' : turnOf(g);
      // humanFallback приходит только событием state.updated хода движка (events.ts запоминает номер хода).
      const fallback = state.fallbackMove === null ? undefined : g.moves.find((m) => m.n === state.fallbackMove);
      return [
        ascii.trimEnd(),
        `Последние ходы: ${last || 'нет'}`,
        `Пленные: чёрные сняли ${g.captures.B}, белые сняли ${g.captures.W}`,
        ...(fallback
          ? [`Ход ${fallback.n} (${colorName(fallback.color)} ${fallback.coord}) Гоко взял из основного поиска, а не из человеческой сети уровня: по силе он может отличаться от заявленного ранга`]
          : []),
        `Ход: ${turn}`,
      ].join('\n');
    },

    async getAssessment() {
      if (!state.gameId) return fail(NO_GAME);
      const blockedFail = blocked();
      if (blockedFail) return blockedFail;
      try {
        const [g, a] = await Promise.all([client.getGame(state.gameId, opts), client.analyze(state.gameId, { maxVisits: ASSESSMENT_VISITS }, opts)]);
        note(g);
        const lead = a.scoreLeadB;
        const leaderColor: Color | null = Math.abs(lead) < 0.5 ? null : lead > 0 ? 'B' : 'W';
        const marginPoints = Math.abs(Math.round(lead * 2) / 2);
        const weak = a.groups.filter((gr) => gr.status !== 'safe');
        const statusText = (s: string) => (s === 'dead' ? 'мертва' : 'неустойчива');
        const bestMoves = a.topMoves.slice(0, 3).map((m) => m.coord);
        if (!hasEngine(g)) {
          // Партия двух людей (D-0005): «ты» и «я» здесь не значат ничего, говорим цветами.
          return {
            leader: leaderColor === null ? ('even' as const) : colorKey(leaderColor),
            marginPoints,
            winrateBlack: Math.round(a.winrateB * 100),
            weakGroups: weak.map((gr) => ({ color: colorKey(gr.color), where: gr.stones.slice(0, 3).join(', '), status: statusText(gr.status) })),
            bestMoves,
            toPlay: colorKey(g.toPlay),
          };
        }
        const human = humanColorOf(g);
        const winrateHuman = human === 'B' ? a.winrateB : 1 - a.winrateB;
        return {
          leader: leaderColor === null ? ('even' as const) : leaderColor === human ? ('you' as const) : ('me' as const),
          marginPoints,
          winrateYou: Math.round(winrateHuman * 100),
          weakGroups: weak.map((gr) => ({
            color: gr.color === human ? ('yours' as const) : ('mine' as const),
            where: gr.stones.slice(0, 3).join(', '),
            status: statusText(gr.status),
          })),
          bestMoves,
          toPlay: g.toPlay === human ? ('you' as const) : ('me' as const),
        };
      } catch (e) {
        return reasonOf(e);
      }
    },

    async setRank({ rank }: { rank: string }) {
      const parsed = parseRank(rank);
      if (!parsed) return fail(`не понял ранг «${rank}»: назови число и кю или дан`);
      if (!state.gameId) {
        state.rank = parsed;
        return { ok: true as const, rank: speakRank(parsed), note: 'применится к следующей партии' };
      }
      const blockedFail = blocked();
      if (blockedFail) return blockedFail;
      try {
        const g = note(await client.getGame(state.gameId, opts));
        if (!hasEngine(g)) {
          state.rank = parsed;
          return { ok: true as const, rank: speakRank(parsed), note: 'в этой партии нет Гоко: уровень применится к следующей' };
        }
        await client.setRank(state.gameId, { color: engineColorOf(g), rank: parsed }, opts);
        state.rank = parsed;
        return { ok: true as const, rank: speakRank(parsed) };
      } catch (e) {
        return reasonOf(e);
      }
    },
  };
}

export type ToolFns = ReturnType<typeof createToolFns>;

// Обёртки для модели. Описания — часть промпта: модель читает их при выборе инструмента.
export function createTools(deps: ToolDeps) {
  const fns = createToolFns(deps);
  return {
    start_game: llm.tool({
      description:
        'Начать новую партию 13x13. my_color — цвет человека: black (чёрные, ходит первым) или white (белые; тогда Гоко ходит первым, его ход в firstMove). rank — уровень Гоко, например «10 кю» или «2 дан»; без него — прежний. komi — число с половиной от 0.5 до 13.5, по умолчанию 7.5.',
      parameters: z.object({
        my_color: z.enum(['black', 'white']).optional(),
        rank: z.string().optional(),
        komi: z.number().optional(),
      }),
      execute: (args) => fns.startGame(args),
    }),
    play_move: llm.tool({
      description: 'Применить ход человека. coord — латиницей: буква столбца A–N без I и число 1–13, например D4. Ответный ход Гоко приходит в myMove.',
      parameters: z.object({ coord: z.string().describe('Например D4') }),
      execute: (args) => fns.playMove(args),
    }),
    correct_last_move: llm.tool({
      description: 'Человек поправил свой последний ход («нет, дэ пять»): заменить его на coord. Ответ как у play_move.',
      parameters: z.object({ coord: z.string().describe('Например D5') }),
      execute: (args) => fns.correctLastMove(args),
    }),
    pass: llm.tool({
      description: 'Человек пасует. Если Гоко тоже пасует, партия завершается и приходит result.',
      execute: () => fns.pass(),
    }),
    resign: llm.tool({
      description: 'Человек сдаётся (в партии двух людей — тот, чей сейчас ход). Возвращает result.',
      execute: () => fns.resign(),
    }),
    undo: llm.tool({
      description: 'Отменить последний ход человека и ответ Гоко («отмени», «верни ход»).',
      execute: () => fns.undo(),
    }),
    get_position: llm.tool({
      description: 'Текущая позиция: доска, последние ходы, пленные, чей ход. Зови, когда спрашивают о доске или ты не уверен, что было.',
      execute: () => fns.getPosition(),
    }),
    get_assessment: llm.tool({
      description: 'Оценка позиции: кто впереди и на сколько, шансы человека в процентах, слабые группы, bestMoves. bestMoves называй только по прямой просьбе подсказать ход.',
      execute: () => fns.getAssessment(),
    }),
    set_rank: llm.tool({
      description: 'Сменить уровень Гоко: rank словами человека, например «5 кю», «1 дан».',
      parameters: z.object({ rank: z.string() }),
      execute: (args) => fns.setRank(args),
    }),
  };
}

export type GokoTools = ReturnType<typeof createTools>;
```

- [ ] **Step 5: Тесты и typecheck зелёные**

Run: `npx vitest run apps/voice-agent && npm run typecheck`
Expected: все тесты `tools.test.ts` (в том числе блок «человек против человека» и строка `humanFallback`) и `phrases.test.ts` проходят; typecheck без ошибок.

- [ ] **Step 6: Commit**

```bash
git add apps/voice-agent/src/tools.ts apps/voice-agent/src/tools.test.ts apps/voice-agent/src/testing/fake-client.ts
git commit -m "voice-agent: девять инструментов над клиентом протокола, фейковый клиент"
```

---
### Task 3: `voice-agent` — события сессии → реплики, цикл SSE с переподключением

**Files:**
- Create: `apps/voice-agent/src/events.ts`
- Test: `apps/voice-agent/src/events.test.ts`

**Interfaces:**
- Consumes: `ApiError`, `EventsTarget`, `GameEvent`, `GokoClient`, `humanText`, `seatColor`, `hasEngine`, `humanColorOf`, `retryAfterMs`, `RETRY_MS`, `STABLE_CONNECTION_MS` из `@goko/protocol` (Task 1); `AgentState` (в том числе `awaitingFinish`, `finished`, `blockedUntil`); `colorName`, `colorNameInstrumental`, `describeResult`, `speakMove`, `speakRank` из `phrases.ts`; `fakeGame` из `testing/fake-client.ts`.
- Produces: `handleEvent(ev: GameEvent, state: AgentState, now?: () => number): string | null` — инструкция для `generateReply` или `null`; `type WatchOptions = { client: Pick<GokoClient, 'events'>; state: AgentState; speak: (instructions: string) => Promise<void> | void; signal: AbortSignal; log?: (line: string) => void; delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; now?: () => number }`; `type WatchHandle = { done: Promise<void>; humanSpoke: () => void }`; `watchSession(opts: WatchOptions): WatchHandle` — `done` завершается по `signal` или после `not_found` (сессия истекла: одна реплика об этом и выход); переподключение с растущей паузой `RETRY_MS` из `@goko/protocol` (1, 2, 4, 8, потолок 15 с; сброс к первой ступени после соединения, прожившего `STABLE_CONNECTION_MS`), на `rate_limited` пауза не меньше `Retry-After` и `state.blockedUntil`; `humanSpoke()` после `retries_exhausted` переоткрывает поток сессии без паузы (D-0006), в остальное время ничего не делает; `ERROR_REPEAT_MS = 30000`; `SESSION_EXPIRED_INSTRUCTIONS`.

Правила озвучивания (раздел 9 спеки, «Озвучивание событий»), в порядке проверки:

| Событие | Условие | Действие |
| --- | --- | --- |
| `session.game` | всегда | если `gameId` сменился — `announceSync = gameId` (живой поток шлёт `session.game` перед `sync`, `apps/game-server/src/app.ts`); запомнить `gameId`, сбросить `lastTap`, `awaitingReply`, `retriesExhausted`, `fallbackMove`; молчать |
| любой `state.updated` | — | снять `retriesExhausted`: у партии был коммит, серия повторов перезапущена или не нужна; снять `announceSync` |
| `state.updated`, `cause: 'sync'` | партия идёт, и её `gameId` только что сменился: `announceSync` указывает на неё или `gameId` ещё не был известен | «Продолжаем партию»: кто играет (человек цветом или два человека), чей ход |
| `state.updated`, `cause: 'new'` (у сервера `by: 'system'`, без `via`) | партия не из `toolGames` и не идёт `start_game` (`startingGame`) | «Человек начал партию с экрана»; если ход движка — `awaitingReply = true`; при `startingGame` — добавить в `toolGames` и молчать |
| `state.updated`, `status: 'finished'` | любой cause | сбросить флаги, молчать (объявит `game.finished`) |
| `state.updated`, `via: 'tap'`, cause `play/pass/correct` | `pendingEngineMove` | запомнить `lastTap`, молчать до ответа движка |
| то же | нет ответа движка (место `external` или партия двух людей, D-0005) | «Человек сыграл … на экране» |
| `state.updated`, `via: 'tap'`, `cause: 'undo'` | всегда | «Человек отменил ход кнопкой» |
| `state.updated`, `cause: 'engine'` | всегда | `fallbackMove` = номер хода, если `humanFallback`; иначе снять, если он указывал на этот или более поздний ход |
| то же | есть `lastTap` | «Человек сыграл … на экране, ты ответил …» |
| то же | `awaitingReply` | «Твой ход готов: …» |
| то же | иначе (ответ на голосовой ход уже вернул инструмент) | молчать |
| `state.updated`, `by: 'external'` | стадия 2 | «Соперник сыграл …» |
| `game.finished` | всегда (у события нет `gameId`: поток сессии несёт только текущую партию) | `finished = { gameId, result }` для ожидающего `pass` |
| то же | `announcedFinish === gameId` | молчать |
| то же | `awaitingFinish === gameId` (итог ждёт `pass`, R2) | `announcedFinish = gameId`, молчать: итог вернёт инструмент |
| то же | иначе | «Партия окончена: …» |
| `engine.thinking` | — | молчать |
| `error` | `gameId` события не равен `state.gameId` (гонка при смене партии) | молчать, флаги не трогать |
| `error`, `code: 'retries_exhausted'` | всегда | `retriesExhausted = true`; сразу: текст `humanText`, «следующая реплика человека запустит новую попытку» |
| `error`, другой код | прошло ≥ 30 с с прошлой ошибки | «Движку нужно ещё время» |

Цикл потока (`watchSession`, R2): обрыв — пауза по `RETRY_MS` и новое подключение; `ApiError` `rate_limited` при открытии — пауза `max(Retry-After, ступень)`, `blockedUntil` для инструментов; `ApiError` `not_found` — сессии больше нет (TTL или рестарт game-server): лог `[!]`, одна реплика `SESSION_EXPIRED_INSTRUCTIONS`, выход без переподключения; реплика человека после `retries_exhausted` — переоткрытие без паузы.

Комментарий Гоко к ходу с экрана в режиме «Чат» (D-0011) — та же инструкция `generateReply`: при выключенном аудиовыходе ответ приходит только текстом в `lk.transcription` и виден в ленте. Отдельной ветки для режима в `events.ts` нет.

- [ ] **Step 1: Тест `apps/voice-agent/src/events.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { ApiError, type EventsTarget, type GameEvent, type GameState, humanText, type Move, RETRY_MS, STABLE_CONNECTION_MS } from '@goko/protocol';
import { ERROR_REPEAT_MS, SESSION_EXPIRED_INSTRUCTIONS, handleEvent, watchSession } from './events.ts';
import { newAgentState } from './state.ts';
import { fakeGame } from './testing/fake-client.ts';

const mv = (n: number, color: 'B' | 'W', coord: string): Move => ({ n, color, coord, captured: 0, at: 't' });
const upd = (state: GameState, extra: Partial<Extract<GameEvent, { type: 'state.updated' }>> = {}): GameEvent => ({
  type: 'state.updated',
  state,
  cause: 'play',
  by: 'human',
  ...extra,
});

describe('handleEvent: подключение и новые партии', () => {
  it('session.game запоминает партию и молчит', () => {
    const s = newAgentState('s1');
    s.lastTap = { cause: 'play', coord: 'D4' };
    s.awaitingReply = true;
    s.retriesExhausted = true;
    s.fallbackMove = 4;
    expect(handleEvent({ type: 'session.game', gameId: 'g1' }, s)).toBeNull();
    expect(s.gameId).toBe('g1');
    expect(s.lastTap).toBeNull();
    expect(s.awaitingReply).toBe(false);
    expect(s.retriesExhausted).toBe(false);
    expect(s.fallbackMove).toBeNull();
  });
  it('sync после смены партии — «продолжаем», с цветом человека и чьим ходом', () => {
    const s = newAgentState('s1');
    const g = fakeGame({ seats: { B: { controller: 'engine', rank: '10k' }, W: { controller: 'human' } }, toPlay: 'W', moves: [mv(1, 'B', 'D4')] });
    const text = handleEvent(upd(g, { cause: 'sync', by: 'system' }), s);
    expect(text).toContain('Продолжаем партию');
    expect(text).toContain('человек играет белыми');
    expect(text).toContain('сейчас ход человека');
    expect(s.gameId).toBe('g1');
    expect(s.humanColor).toBe('W');
  });
  it('живой поток: session.game, затем sync той же партии — «продолжаем»; переподключение к знакомой партии и sync после new молчат', () => {
    const s = newAgentState('s1');
    const g = fakeGame();
    // Порядок сервера (apps/game-server/src/app.ts): поток сессии открывается событиями session.game и sync.
    expect(handleEvent({ type: 'session.game', gameId: g.id }, s)).toBeNull();
    expect(handleEvent(upd(g, { cause: 'sync', by: 'system' }), s)).toContain('Продолжаем партию');
    expect(s.announceSync).toBeNull();
    // Обрыв и новое подключение к той же партии.
    expect(handleEvent({ type: 'session.game', gameId: g.id }, s)).toBeNull();
    expect(handleEvent(upd(g, { cause: 'sync', by: 'system' }), s)).toBeNull();
    // Новая партия в потоке: session.game и new; флаг снят событием new, sync при следующем подключении молчит.
    const g2 = fakeGame({ id: 'g2' });
    s.toolGames.add('g2');
    expect(handleEvent({ type: 'session.game', gameId: 'g2' }, s)).toBeNull();
    expect(s.announceSync).toBe('g2');
    expect(handleEvent(upd(g2, { cause: 'new', by: 'system' }), s)).toBeNull();
    expect(s.announceSync).toBeNull();
    expect(handleEvent({ type: 'session.game', gameId: 'g2' }, s)).toBeNull();
    expect(handleEvent(upd(g2, { cause: 'sync', by: 'system' }), s)).toBeNull();
  });
  it('повторный sync той же партии молчит', () => {
    const s = newAgentState('s1');
    const g = fakeGame();
    handleEvent(upd(g, { cause: 'sync', by: 'system' }), s);
    expect(handleEvent(upd(g, { cause: 'sync', by: 'system' }), s)).toBeNull();
  });
  it('sync законченной партии молчит', () => {
    const s = newAgentState('s1');
    const g = fakeGame({ status: 'finished', result: { winner: 'B', reason: 'resign' } });
    expect(handleEvent(upd(g, { cause: 'sync', by: 'system' }), s)).toBeNull();
  });
  it('new с экрана — реплика о новой партии; при ходе движка ждём его', () => {
    const s = newAgentState('s1');
    const g = fakeGame({ id: 'g2', seats: { B: { controller: 'engine', rank: '5k' }, W: { controller: 'human' } }, toPlay: 'B', pendingEngineMove: true });
    // Сервер публикует new от имени system и без via — и для кнопки на экране, и для start_game.
    const text = handleEvent(upd(g, { cause: 'new', by: 'system' }), s);
    expect(text).toContain('начал новую партию с экрана');
    expect(text).toContain('человек играет белыми');
    expect(text).toContain('5 кю');
    expect(s.awaitingReply).toBe(true);
    expect(s.gameId).toBe('g2');
  });
  it('new партии из start_game молчит', () => {
    const s = newAgentState('s1');
    s.toolGames.add('g1');
    expect(handleEvent(upd(fakeGame(), { cause: 'new', by: 'system' }), s)).toBeNull();
  });
  it('new, пришедшее раньше ответа start_game, молчит и помечает партию', () => {
    const s = newAgentState('s1');
    s.startingGame = true;
    const g = fakeGame({ id: 'g3', seats: { B: { controller: 'engine', rank: '10k' }, W: { controller: 'human' } }, pendingEngineMove: true });
    expect(handleEvent(upd(g, { cause: 'new', by: 'system' }), s)).toBeNull();
    expect(s.toolGames.has('g3')).toBe(true);
    expect(s.awaitingReply).toBe(false);
  });
  it('партия двух людей (D-0005): sync без «твой ход», тап озвучивается сразу', () => {
    const s = newAgentState('s1');
    const g = fakeGame({ seats: { B: { controller: 'human' }, W: { controller: 'human' } }, toPlay: 'W', moves: [mv(1, 'B', 'D4')] });
    const text = handleEvent(upd(g, { cause: 'sync', by: 'system' }), s);
    expect(text).toContain('играют два человека');
    expect(text).toContain('сейчас ходят белые');
    expect(text).not.toContain('твой ход');
    expect(s.humanColor).toBeNull();
    const tap = fakeGame({ ...g, moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')], toPlay: 'B', revision: 2 });
    expect(handleEvent(upd(tap, { cause: 'play', by: 'human', via: 'tap' }), s)).toContain('сыграл ка десять на экране');
  });
});

describe('handleEvent: ходы', () => {
  it('тап с ответом движка: молчим на тап, говорим на ответ с обоими ходами', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const afterTap = fakeGame({ moves: [mv(1, 'B', 'D4')], toPlay: 'W', pendingEngineMove: true, revision: 1 });
    expect(handleEvent(upd(afterTap, { cause: 'play', by: 'human', via: 'tap' }), s)).toBeNull();
    expect(s.lastTap).toEqual({ cause: 'play', coord: 'D4' });
    const afterReply = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')], toPlay: 'B', revision: 2 });
    const text = handleEvent(upd(afterReply, { cause: 'engine', by: 'engine' }), s);
    expect(text).toContain('дэ четыре');
    expect(text).toContain('ка десять');
    expect(text).toContain('на экране');
    expect(s.lastTap).toBeNull();
  });
  it('пас тапом и ответный пас', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'pass')], toPlay: 'W', pendingEngineMove: true }), { cause: 'pass', by: 'human', via: 'tap' }), s);
    const text = handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'pass'), mv(2, 'W', 'pass')], toPlay: 'B' }), { cause: 'engine', by: 'engine' }), s);
    expect(text).toContain('спасовал');
    expect(text).toContain('ответил пасом');
  });
  it('тап без ответа движка (соперник external) озвучивается сразу', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const g = fakeGame({ seats: { B: { controller: 'human' }, W: { controller: 'external' } }, moves: [mv(1, 'B', 'D4')], toPlay: 'W', pendingEngineMove: false });
    expect(handleEvent(upd(g, { cause: 'play', by: 'human', via: 'tap' }), s)).toContain('сыграл дэ четыре на экране');
    expect(s.lastTap).toBeNull();
  });
  it('голосовой ход и ответ на него молчат: их вернул инструмент', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    expect(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4')], pendingEngineMove: true }), { cause: 'play', by: 'human', via: 'voice' }), s)).toBeNull();
    expect(handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'engine', by: 'engine' }), s)).toBeNull();
  });
  it('ход движка после таймаута инструмента озвучивается', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = true;
    const text = handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'engine', by: 'engine' }), s);
    expect(text).toContain('Твой ход готов: ка десять');
    expect(s.awaitingReply).toBe(false);
  });
  it('humanFallback хода движка запоминается номером хода и снимается следующим обычным ходом (D-0007)', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const two = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] });
    handleEvent(upd(two, { cause: 'engine', by: 'engine', humanFallback: true }), s);
    expect(s.fallbackMove).toBe(2);
    const four = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10'), mv(3, 'B', 'C3'), mv(4, 'W', 'D10')] });
    handleEvent(upd(four, { cause: 'engine', by: 'engine', humanFallback: false }), s);
    expect(s.fallbackMove).toBe(2);
    // undo снял ходы 3–4 и 2 заменён новым ответом без humanFallback
    const replaced = fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'G7')] });
    handleEvent(upd(replaced, { cause: 'engine', by: 'engine', humanFallback: false }), s);
    expect(s.fallbackMove).toBeNull();
  });
  it('state.updated законченной партии сбрасывает флаги и молчит', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = true;
    s.lastTap = { cause: 'play', coord: 'D4' };
    const g = fakeGame({ status: 'finished', result: { winner: 'B', reason: 'resign' }, moves: [mv(1, 'B', 'D4')] });
    expect(handleEvent(upd(g, { cause: 'engine', by: 'engine' }), s)).toBeNull();
    expect(s.awaitingReply).toBe(false);
    expect(s.lastTap).toBeNull();
  });
  it('undo тапом', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingReply = true;
    const text = handleEvent(upd(fakeGame({ toPlay: 'B' }), { cause: 'undo', by: 'human', via: 'tap' }), s);
    expect(text).toContain('отменил');
    expect(text).toContain('сейчас ход человека');
    expect(s.awaitingReply).toBe(false);
  });
  it('ход внешнего соперника (стадия 2)', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const text = handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4'), mv(2, 'W', 'K10')] }), { cause: 'play', by: 'external', via: 'api' }), s);
    expect(text).toContain('Соперник сыграл ка десять');
  });
  it('sync и rank без смены партии молчат', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    expect(handleEvent(upd(fakeGame(), { cause: 'rank', by: 'human', via: 'voice' }), s)).toBeNull();
    expect(handleEvent(upd(fakeGame(), { cause: 'sync', by: 'system' }), s)).toBeNull();
  });
});

describe('handleEvent: конец партии и ошибки', () => {
  it('game.finished объявляет результат один раз', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const ev: GameEvent = { type: 'game.finished', result: { winner: 'B', margin: 4.5, reason: 'score' } };
    expect(handleEvent(ev, s)).toBe('Партия окончена: победа за тобой, разница 4,5 очка. Объяви результат одной фразой.');
    expect(s.announcedFinish).toBe('g1');
    expect(handleEvent(ev, s)).toBeNull();
  });
  it('game.finished после инструмента resign молчит', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.announcedFinish = 'g1';
    expect(handleEvent({ type: 'game.finished', result: { winner: 'W', reason: 'resign' } }, s)).toBeNull();
  });
  it('game.finished, пока pass ждёт итог: итог в state.finished, реплики нет (R2)', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.awaitingFinish = 'g1';
    const result = { winner: 'W' as const, margin: 3.5, reason: 'score' as const };
    expect(handleEvent({ type: 'game.finished', result }, s)).toBeNull();
    expect(s.finished).toEqual({ gameId: 'g1', result });
    expect(s.announcedFinish).toBe('g1');
  });
  it('engine.thinking молчит; error не чаще раза в 30 с, текст по коду, без message', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    let t = 1_000_000;
    const now = () => t;
    expect(handleEvent({ type: 'engine.thinking', gameId: 'g1', color: 'W' }, s)).toBeNull();
    const first = handleEvent({ type: 'error', gameId: 'g1', code: 'engine_unavailable', message: 'engine is unavailable' }, s, now);
    expect(first).toContain(humanText('engine_unavailable'));
    expect(first).not.toContain('engine is unavailable');
    t += ERROR_REPEAT_MS - 1;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'engine_unavailable', message: 'engine is unavailable' }, s, now)).toBeNull();
    t += 2;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'engine_unavailable', message: 'engine is unavailable' }, s, now)).not.toBeNull();
  });
  it('error чужой партии (гонка при смене) молчит и флаги не трогает', () => {
    const s = newAgentState('s1');
    s.gameId = 'g2';
    const now = () => 1_000_000;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' }, s, now)).toBeNull();
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' }, s, now)).toBeNull();
    expect(s.retriesExhausted).toBe(false);
    expect(s.lastErrorAt).toBe(0);
  });
  it('retries_exhausted озвучивается сразу, без «сервер повторит сам», и ставит флаг переоткрытия', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const now = () => 1_000_000;
    expect(handleEvent({ type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' }, s, now)).not.toBeNull();
    const text = handleEvent({ type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' }, s, now);
    expect(text).toContain(humanText('retries_exhausted'));
    expect(text).toContain('следующая реплика человека');
    expect(text).not.toContain('повторит попытку сам');
    expect(text).not.toContain('background task');
    expect(s.retriesExhausted).toBe(true);
  });
  it('любой state.updated снимает retriesExhausted: серию перезапустил коммит', () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    s.retriesExhausted = true;
    handleEvent(upd(fakeGame({ moves: [mv(1, 'B', 'D4')], pendingEngineMove: true }), { cause: 'play', by: 'human', via: 'tap' }), s);
    expect(s.retriesExhausted).toBe(false);
  });
});

describe('watchSession', () => {
  it('озвучивает инструкции, переподключается после обрыва, останавливается по сигналу', async () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const spoken: string[] = [];
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(target: { sessionId: string } | { gameId: string }): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        expect(target).toEqual({ sessionId: 's1' });
        if (connects === 1) {
          yield { type: 'game.finished', result: { winner: 'B', reason: 'resign' } };
          throw new Error('socket hang up');
        }
        yield { type: 'engine.thinking', gameId: 'g1', color: 'W' };
        abort.abort();
      },
    };
    const slept: number[] = [];
    await watchSession({ client, state: s, signal: abort.signal, speak: (t) => void spoken.push(t), now: () => 0, sleep: async (ms) => void slept.push(ms) }).done;
    expect(spoken).toEqual(['Партия окончена: победа за тобой: я сдался. Объяви результат одной фразой.']);
    expect(connects).toBe(2);
    expect(slept).toEqual([RETRY_MS[0]]);
  });
  it('пауза растёт 1, 2, 4, 8 с до потолка 15 с (R2)', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 8) {
          abort.abort();
          return;
        }
        throw new TypeError('fetch failed');
      },
    };
    const slept: number[] = [];
    await watchSession({ client, state: s, signal: abort.signal, speak: () => {}, now: () => 0, sleep: async (ms) => void slept.push(ms) }).done;
    expect(slept).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });
  it('соединение, прожившее 15 с, сбрасывает паузу к первой ступени', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    let t = 0;
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 3) t += STABLE_CONNECTION_MS; // третье соединение жило долго и оборвалось
        if (connects === 4) {
          abort.abort();
          return;
        }
        yield { type: 'session.game', gameId: 'g1' };
        throw new Error('socket hang up');
      },
    };
    const slept: number[] = [];
    await watchSession({ client, state: s, signal: abort.signal, speak: () => {}, now: () => t, sleep: async (ms) => void slept.push(ms) }).done;
    // Первое событие само по себе паузу не сбрасывает: сервер, который шлёт sync и рвёт поток, не крутит цикл раз в секунду.
    expect(slept).toEqual([1_000, 2_000, 1_000]);
  });
  it('rate_limited при открытии: пауза по Retry-After и blockedUntil для инструментов', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 2) {
          abort.abort();
          return;
        }
        throw new ApiError('rate_limited', 'too many requests, retry in 42 s', { retryAfterSeconds: 42 });
      },
    };
    const slept: number[] = [];
    await watchSession({ client, state: s, signal: abort.signal, speak: () => {}, now: () => 0, sleep: async (ms) => void slept.push(ms) }).done;
    expect(slept).toEqual([42_000]);
    expect(s.blockedUntil).toBe(42_000);
  });
  it('not_found (сессия истекла): одна реплика, лог и выход без переподключения', async () => {
    const s = newAgentState('s1');
    const abort = new AbortController();
    const spoken: string[] = [];
    const logs: string[] = [];
    const slept: number[] = [];
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        throw new ApiError('not_found', 'session not found');
      },
    };
    await watchSession({
      client,
      state: s,
      signal: abort.signal,
      speak: (t) => void spoken.push(t),
      log: (l) => void logs.push(l),
      sleep: async (ms) => void slept.push(ms),
    }).done;
    expect(connects).toBe(1);
    expect(spoken).toEqual([SESSION_EXPIRED_INSTRUCTIONS]);
    expect(slept).toEqual([]);
    expect(logs).toContain('[!] voice-agent: сессия не найдена (истекла или сервер перезапущен), поток закрыт');
    expect(abort.signal.aborted).toBe(false);
  });
  it('после retries_exhausted реплика человека переоткрывает поток сразу, без паузы (D-0006)', async () => {
    const s = newAgentState('s1');
    const spoken: string[] = [];
    const logs: string[] = [];
    const slept: number[] = [];
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        expect(target).toEqual({ sessionId: 's1' });
        if (connects === 1) {
          yield { type: 'session.game', gameId: 'g1' };
          yield { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'background task retries are exhausted' };
          // Живой поток молчит, пока его не оборвут.
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
          throw new DOMException('This operation was aborted', 'AbortError');
        }
        yield { type: 'session.game', gameId: 'g1' };
        abort.abort();
      },
    };
    // Реплика об исчерпанных повторах — явный сигнал теста вместо ожидания на реальных таймерах.
    let announced: () => void = () => {};
    const exhaustedSpoken = new Promise<void>((resolve) => {
      announced = resolve;
    });
    const watch = watchSession({
      client,
      state: s,
      signal: abort.signal,
      speak: (t) => {
        spoken.push(t);
        announced();
      },
      log: (l) => void logs.push(l),
      sleep: async (ms) => void slept.push(ms),
    });
    watch.humanSpoke(); // до retries_exhausted — ничего не происходит
    await exhaustedSpoken;
    expect(s.retriesExhausted).toBe(true);
    watch.humanSpoke();
    watch.humanSpoke(); // вторая реплика подряд не рвёт поток ещё раз
    await watch.done;
    expect(connects).toBe(2);
    expect(slept).toEqual([]);
    expect(s.retriesExhausted).toBe(false);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain(humanText('retries_exhausted'));
    expect(logs).toContain('[OK] voice-agent: реплика человека после retries_exhausted, переоткрываю поток сессии');
    expect(logs.some((l) => l.includes('оборвался'))).toBe(false);
  });
  it('ошибка speak не рвёт цикл', async () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const abort = new AbortController();
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        yield { type: 'game.finished', result: { winner: 'B', reason: 'resign' } };
        yield { type: 'error', gameId: 'g1', code: 'x', message: 'y' };
        abort.abort();
      },
    };
    const spoken: string[] = [];
    await watchSession({
      client,
      state: s,
      signal: abort.signal,
      speak: (t) => {
        spoken.push(t);
        throw new Error('session closing');
      },
    }).done;
    expect(spoken.length).toBe(2);
  });
});
```

- [ ] **Step 2: Запустить тест, убедиться, что падает**

Run: `npx vitest run apps/voice-agent/src/events.test.ts`
Expected: FAIL — `Cannot find module './events.ts'`.

- [ ] **Step 3: `apps/voice-agent/src/events.ts`**

```ts
// Озвучивание событий SSE (раздел 9 спеки). handleEvent — чистая функция: событие + память агента ->
// инструкция для generateReply или null. watchSession — цикл чтения потока сессии с переподключением
// и переоткрытием после retries_exhausted (D-0006).
// Паузы переподключения (RETRY_MS, STABLE_CONNECTION_MS, retryAfterMs) — общие с вебом, из @goko/protocol (задача 1).
import {
  ApiError,
  type GameEvent,
  type GameState,
  type GokoClient,
  RETRY_MS,
  STABLE_CONNECTION_MS,
  hasEngine,
  humanColorOf,
  humanText,
  retryAfterMs,
  seatColor,
} from '@goko/protocol';
import { colorName, colorNameInstrumental, describeResult, speakMove, speakRank } from './phrases.ts';
import type { AgentState } from './state.ts';

export const ERROR_REPEAT_MS = 30_000;
export const SESSION_EXPIRED_INSTRUCTIONS =
  'Сессия на сервере закончилась: истекла или сервер перезапущен. Скажи одной фразой, что эту игру отсюда не продолжить и нужно перезагрузить страницу.';

const ONE_PHRASE = 'Скажи одну короткую фразу.';

function whoseTurn(g: GameState): string {
  if (!hasEngine(g)) return `сейчас ходят ${colorName(g.toPlay)}`;
  return g.toPlay === humanColorOf(g) ? 'сейчас ход человека' : 'сейчас твой ход';
}

// Кто играет: человек цветом или два человека (D-0005 — Гоко в такой партии только комментирует).
function seatsText(g: GameState): string {
  const human = seatColor(g.seats, 'human');
  if (!hasEngine(g)) return 'играют два человека, ты только комментируешь';
  return `человек играет ${colorNameInstrumental(human ?? 'B')}`;
}

function resetTurnFlags(state: AgentState) {
  state.lastTap = null;
  state.awaitingReply = false;
}

function describeMove(coord: string): string {
  return coord === 'pass' ? 'спасовал' : `сыграл ${speakMove(coord)}`;
}

function onStateUpdated(ev: Extract<GameEvent, { type: 'state.updated' }>, state: AgentState): string | null {
  const g = ev.state;
  // Живой поток сессии начинается с session.game, и gameId к sync уже тот же: смену партии помнит announceSync.
  const fresh = g.id !== state.gameId || state.announceSync === g.id;
  state.announceSync = null;
  state.gameId = g.id;
  state.humanColor = hasEngine(g) ? humanColorOf(g) : null;
  state.retriesExhausted = false; // был коммит или открытие потока: серия повторов перезапущена (D-0006)
  const last = g.moves.at(-1);

  if (g.status === 'finished') {
    resetTurnFlags(state);
    return null; // объявит game.finished
  }

  switch (ev.cause) {
    case 'sync':
      if (!fresh) return null;
      resetTurnFlags(state);
      return `Продолжаем партию: ${seatsText(g)}, сделано ходов: ${g.moves.length}, ${whoseTurn(g)}. ${ONE_PHRASE} Ход не называй, пока его не вернул инструмент.`;
    case 'new': {
      resetTurnFlags(state);
      // У сервера new всегда by 'system' без via: отличить кнопку на экране от start_game можно только
      // по памяти агента. Событие обгоняет ответ HTTP, поэтому смотрим и на идущий start_game.
      if (state.startingGame) state.toolGames.add(g.id);
      if (state.toolGames.has(g.id)) return null;
      const engineColor = seatColor(g.seats, 'engine');
      if (engineColor === null) {
        return `Человек начал с экрана новую партию двух людей: ты в ней не играешь, только комментируешь и выполняешь просьбы за того, чей ход. ${ONE_PHRASE}`;
      }
      const engineSeat = g.seats[engineColor];
      state.awaitingReply = g.pendingEngineMove;
      return `Человек начал новую партию с экрана: ${seatsText(g)}, Гоко — ${engineSeat.rank ? speakRank(engineSeat.rank) : 'без ранга'}. ${g.pendingEngineMove ? 'Первый ход твой, его назовёт следующее событие: пока не выдумывай.' : 'Первый ход человека.'} ${ONE_PHRASE}`;
    }
    case 'play':
    case 'pass':
    case 'correct': {
      if (ev.by === 'external' && last) return `Соперник ${describeMove(last.coord)}. ${ONE_PHRASE}`;
      if (ev.via !== 'tap' || !last) return null; // голосовой ход уже вернул инструмент
      if (g.pendingEngineMove) {
        state.lastTap = { cause: ev.cause, coord: last.coord };
        return null;
      }
      return `Человек ${describeMove(last.coord)} на экране. ${ONE_PHRASE}`;
    }
    case 'undo':
      resetTurnFlags(state);
      if (ev.via !== 'tap') return null;
      return `Человек отменил последний ход кнопкой на экране, ${whoseTurn(g)}. ${ONE_PHRASE}`;
    case 'engine': {
      if (!last) return null;
      // humanFallback есть только здесь (D-0007): get_position скажет о таком ходе, пока он на доске.
      // Ход с тем же или меньшим номером без признака значит, что прежний ход сняли или заменили.
      if (ev.humanFallback) state.fallbackMove = last.n;
      else if (state.fallbackMove !== null && last.n <= state.fallbackMove) state.fallbackMove = null;
      const reply = last.coord === 'pass' ? 'ответил пасом' : `ответил ${speakMove(last.coord)}`;
      if (state.lastTap) {
        const tap = state.lastTap;
        state.lastTap = null;
        state.awaitingReply = false;
        return `Человек ${describeMove(tap.coord)} на экране, ты ${reply}. Назови свой ход одной фразой.`;
      }
      if (state.awaitingReply) {
        state.awaitingReply = false;
        return `Твой ход готов: ${speakMove(last.coord)}. Назови его одной фразой.`;
      }
      return null;
    }
    case 'rank':
    case 'resign':
      return null;
    default:
      return null;
  }
}

export function handleEvent(ev: GameEvent, state: AgentState, now: () => number = Date.now): string | null {
  switch (ev.type) {
    case 'session.game':
      // Партия сменилась (подключение агента к идущей партии, новая партия): следующий sync о ней — «Продолжаем».
      // Переподключение к уже знакомой партии флаг не ставит, и sync молчит.
      if (ev.gameId !== state.gameId) state.announceSync = ev.gameId;
      state.gameId = ev.gameId;
      resetTurnFlags(state);
      state.retriesExhausted = false;
      state.fallbackMove = null;
      return null;
    case 'state.updated':
      return onStateUpdated(ev, state);
    case 'engine.thinking':
      return null;
    case 'game.finished': {
      // У game.finished нет gameId: поток сессии несёт только текущую партию (раздел 5 спеки).
      // Итог кладём в state.finished всегда: его ждёт pass после двух пасов (R2, tools.ts waitFinished).
      if (state.gameId !== null) state.finished = { gameId: state.gameId, result: ev.result };
      if (state.gameId !== null && state.announcedFinish === state.gameId) return null;
      state.announcedFinish = state.gameId;
      resetTurnFlags(state);
      if (state.gameId !== null && state.awaitingFinish === state.gameId) return null; // итог вернёт инструмент pass
      return `Партия окончена: ${describeResult(ev.result, state.humanColor)}. Объяви результат одной фразой.`;
    }
    case 'error': {
      // Событие прошлой партии, проскочившее при смене текущей: не озвучиваем и флаги не трогаем.
      if (state.gameId !== null && ev.gameId !== state.gameId) return null;
      // Текст — по code (humanText), message английский и только для логов (D-0007).
      // retries_exhausted: сервер больше не повторяет сам. Серию перезапустит мутирующее действие человека
      // или открытие потока (D-0006); watchSession переоткроет поток на первой реплике человека
      // (голосом или в чате) — инструкция ниже обещает человеку ровно это. Реплика — сразу.
      if (ev.code === 'retries_exhausted') {
        state.retriesExhausted = true;
        return `Сервер перестал повторять попытки: ${humanText(ev.code)}. Передай это одной фразой от первого лица; следующая реплика человека сама запустит новую попытку.`;
      }
      const t = now();
      if (t - state.lastErrorAt < ERROR_REPEAT_MS) return null;
      state.lastErrorAt = t;
      return `Сбой на сервере: ${humanText(ev.code)}; сервер повторит попытку сам. Скажи одной фразой, что тебе нужно ещё немного времени.`;
    }
    default:
      return null;
  }
}

export type WatchOptions = {
  client: Pick<GokoClient, 'events'>;
  state: AgentState;
  speak: (instructions: string) => Promise<void> | void;
  signal: AbortSignal;
  log?: (line: string) => void;
  delaysMs?: readonly number[]; // паузы по попыткам, последняя — потолок; по умолчанию RETRY_MS
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type WatchHandle = {
  done: Promise<void>; // завершается по opts.signal или после not_found (сессии больше нет)
  humanSpoke: () => void; // реплика человека (голос или lk.chat): после retries_exhausted переоткрыть поток
};

const failureText = (e: unknown): string => (e instanceof ApiError ? e.code : e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// Читает поток сессии, пока не отменят. Обрыв (сеть, рестарт game-server) — растущая пауза и новое
// подключение: первым сообщением сервер шлёт session.game и sync, так что состояние восстанавливается само.
// rate_limited — ждём не меньше Retry-After (D-0012); not_found — сессии нет, переподключаться бессмысленно.
// Каждое подключение — свой AbortController: humanSpoke обрывает только его, и цикл сразу открывает
// поток заново. Открытие потока сессии перезапускает серию повторов на сервере (D-0006).
export function watchSession(opts: WatchOptions): WatchHandle {
  const log = opts.log ?? (() => {});
  const delays = opts.delaysMs ?? RETRY_MS;
  const now = opts.now ?? Date.now;
  // Пауза по умолчанию просыпается и по отмене сеанса: остановка воркера не ждёт потолок 15 с.
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          opts.signal.removeEventListener('abort', wake);
          resolve();
        };
        const timer = setTimeout(wake, ms);
        opts.signal.addEventListener('abort', wake, { once: true });
      }));
  let conn: AbortController | null = null;
  let reopening = false;

  const say = async (instructions: string) => {
    try {
      await opts.speak(instructions);
    } catch (e) {
      log(`[!] voice-agent: generateReply не удался: ${failureText(e)}`);
    }
  };

  const humanSpoke = () => {
    if (!opts.state.retriesExhausted || reopening || !conn) return;
    reopening = true;
    log('[OK] voice-agent: реплика человека после retries_exhausted, переоткрываю поток сессии');
    conn.abort();
  };

  const run = async () => {
    let attempt = 0;
    while (!opts.signal.aborted) {
      const current = new AbortController();
      conn = current;
      reopening = false;
      const stop = () => current.abort();
      opts.signal.addEventListener('abort', stop, { once: true });
      const openedAt = now();
      let retryAfter = 0;
      try {
        for await (const ev of opts.client.events({ sessionId: opts.state.sessionId }, current.signal)) {
          const instructions = handleEvent(ev, opts.state, now); // те же часы, что у пауз: троттлинг ошибок в тестах без Date.now
          if (instructions) await say(instructions);
        }
      } catch (e) {
        if (opts.signal.aborted) return;
        if (e instanceof ApiError && e.code === 'not_found') {
          log('[!] voice-agent: сессия не найдена (истекла или сервер перезапущен), поток закрыт');
          await say(SESSION_EXPIRED_INSTRUCTIONS);
          return;
        }
        if (e instanceof ApiError && e.code === 'rate_limited') {
          retryAfter = retryAfterMs(e.details);
          opts.state.blockedUntil = Math.max(opts.state.blockedUntil, now() + retryAfter);
        }
        if (!reopening) log(`[!] voice-agent: поток сессии оборвался: ${failureText(e)}`);
      } finally {
        opts.signal.removeEventListener('abort', stop);
        conn = null;
      }
      if (opts.signal.aborted) return;
      if (reopening) {
        opts.state.retriesExhausted = false;
        continue; // без паузы: человек ждёт ответа
      }
      // Сброс только после долгого соединения, а не на первом событии: сервер, который шлёт sync и сразу
      // рвёт поток, иначе держал бы цикл на паузе в 1 с.
      if (now() - openedAt >= STABLE_CONNECTION_MS) attempt = 0;
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? RETRY_MS[0];
      attempt++;
      await sleep(Math.max(retryAfter, delay));
    }
  };

  return { done: run(), humanSpoke };
}
```

Живой поток сессии на ходу движка может молчать долго, кроме пингов; `humanSpoke` обрывает его через `AbortSignal`, который клиент протокола передаёт в `fetch` (`events(target, signal)`). Реплику человека `main.ts` передаёт сюда из двух мест: финальный транскрипт голоса (`user_input_transcribed`) и сообщение пользователя в истории (`conversation_item_added` — туда же попадает текст из `lk.chat`), задача 4.

- [ ] **Step 4: Тесты зелёные**

Run: `npx vitest run apps/voice-agent/src/events.test.ts && npm run typecheck`
Expected: все тесты проходят, typecheck без ошибок.

- [ ] **Step 5: Commit**

```bash
git add apps/voice-agent/src/events.ts apps/voice-agent/src/events.test.ts
git commit -m "voice-agent: события сессии в реплики, цикл SSE с переподключением"
```

---

### Task 4: `voice-agent` — промпт, режимы речи, воркер, evals

**Files:**
- Create: `apps/voice-agent/src/prompt.ts`, `apps/voice-agent/src/voice.ts`, `apps/voice-agent/src/agent.ts`, `apps/voice-agent/src/metadata.ts`, `apps/voice-agent/src/mode.ts`, `apps/voice-agent/src/main.ts`
- Modify: `infra/.env.example` (переменные `VOICE_MODE`, `API_BASE`)
- Test: `apps/voice-agent/src/metadata.test.ts`, `apps/voice-agent/src/voice.test.ts`, `apps/voice-agent/src/mode.test.ts`, `apps/voice-agent/src/agent.eval.test.ts`

**Interfaces:**
- Consumes: `createTools`, `GokoTools` (Task 2); `watchSession`, `WatchHandle` (Task 3); `newAgentState`; `createClient` из `@goko/protocol`; `defineAgent`, `cli`, `ServerOptions`, `voice`, `JobContext` из `@livekit/agents`; `RoomEvent` из `@livekit/rtc-node`; `openai` и `silero` плагины.
- Produces: `INSTRUCTIONS: string`, `GREETING_INSTRUCTIONS: string`; `type VoiceMode = 'realtime' | 'pipeline'`, `parseVoiceMode(v: string | undefined): VoiceMode` (бросает на другом значении), `sessionOptions(mode): Promise<SessionOptions>` где `SessionOptions = ConstructorParameters<typeof voice.AgentSession>[0]`; `class GokoAgent extends voice.Agent` с `constructor(tools: GokoTools, opts?: { greet?: boolean })`; `sessionIdOf(metadata: string | undefined, roomName: string): string`; режим D-0011: `type TalkMode = 'voice' | 'chat'`, `MODE_ATTRIBUTE = 'goko.mode'`, `modeOf(attributes?): TalkMode`, `type AudioSwitch = { input: { setAudioEnabled(enabled: boolean): void }; output: { setAudioEnabled(enabled: boolean): void } }`, `applyMode(session: AudioSwitch, mode: TalkMode): void`, `type ParticipantLike = { identity: string; attributes: Readonly<Record<string, string>> }`, `followMode(opts: { participant: ParticipantLike; session: AudioSwitch; log? }): { readonly mode: TalkMode; onAttributes(p: ParticipantLike): void }`; воркер `node apps/voice-agent/src/main.ts dev|start` с переменными `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`, `APP_KEY` (обязательные, пустые и из пробелов считаются не заданными, выход с кодом 2), `API_BASE` (по умолчанию `http://127.0.0.1:8787`), `AGENT_NAME` (по умолчанию `goko`), `VOICE_MODE` (по умолчанию `realtime`).

Выключение звука в режиме «Чат» (сверено с исходниками `@livekit/agents` 1.8.0 в `node_modules` и документацией LiveKit Agents через context7):
- Основной путь: `session.output.setAudioEnabled(false)` и `session.input.setAudioEnabled(false)` (`AgentOutput` / `AgentInput`, `src/voice/io.ts`). Пока выход выключен, `AgentActivity` не передаёт кадры в аудиовыход (`output.audioEnabled ? output.audio : null`), а текст ответа уходит в `lk.transcription` без синхронизации со звуком. Включение обратно — те же вызовы с `true`. Режим применяется после `session.start`: подключение аудиовыхода `RoomIO` вызывает `onAttached` независимо от флага.
- Чего нет: переключить Realtime на текст на лету. `modalities` у `openai.realtime.RealtimeModel` задаётся только в конструкторе, `updateOptions` принимает лишь `toolChoice`. Модель продолжает генерировать аудио, мы за него платим (цена D-0011). Пересоздавать сессию с `modalities: ['text']` при каждой смене режима не будем: обрыв разговора и контекста дороже.
- Запасной путь, если на живом прогоне звук в «Чате» всё же доходит до телефона: веб в «Чате» отписывается от аудиотрека агента (`RemoteTrackPublication.setSubscribed(false)`, задача 7), это сделано в любом случае. Совсем крайний — `RemoteParticipant.setVolume(0)` на странице.
- Атрибут участника читается из `participant.attributes` после `ctx.waitForParticipant()`, смена — событие `RoomEvent.ParticipantAttributesChanged` (`@livekit/rtc-node` 0.13: `(changedAttributes, participant)`, атрибуты участника к моменту события уже обновлены). Выставить атрибут участник может только с правом `canUpdateOwnMetadata` в токене: его добавляет задача 5 (шаг 1).

- [ ] **Step 1: `apps/voice-agent/src/prompt.ts`**

```ts
// Промпт Гоко: ядро из раздела 9 спеки плюс правила работы с результатами инструментов.
// Единственное место, где живёт «характер» соперника.
export const INSTRUCTIONS = `Ты Гоко, соперник по го на доске 13 на 13. Говоришь по-русски, коротко, как живой игрок за доской.

Правила:
- Любая информация о партии — только из инструментов. Не называй ход, которого не вернул инструмент, и не описывай позицию по памяти: если сомневаешься, вызови get_position.
- Ход человека применяй сразу через play_move, не переспрашивай. Координата в аргументах — латиницей: буква A, B, C, D, E, F, G, H, J, K, L, M, N (буквы I на доске нет) и число от 1 до 13. Человек говорит по-русски: «дэ четыре» — это D4, «ка десять» — K10, «джей три» — J3, «аш семь» — H7, «эль пять» — L5, «эм девять» — M9, «эн один» — N1, «е одиннадцать» — E11, «цэ три» — C3, «бэ два» — B2, «а один» — A1, «эф пять» — F5, «гэ восемь» — G8.
- Если человек поправляет только что названный ход («нет, дэ пять», «точнее ка одиннадцать»), вызывай correct_last_move.
- Если инструмент вернул ok: false, одной фразой скажи причину из reason и жди новый ход.
- Свой ход называй координатой и ничем больше: «Ка десять». Произношение бери из полей myMoveSpoken и firstMoveSpoken. Если пришёл note, что ты ещё думаешь, так и скажи: ход назовёшь сам, когда он придёт.
- Столбцы произносятся: A «а», B «бэ», C «цэ», D «дэ», E «е», F «эф», G «гэ», H «аш», J «джей», K «ка», L «эль», M «эм», N «эн».
- Оценку позиции обсуждай охотно через get_assessment: кто впереди, на сколько, какие группы слабые. Лучший ход (bestMoves) называй только по прямой просьбе подсказать.
- Не пасуй и не предлагай пас, пока пас не стал разумным. «Пас» человека — инструмент pass; «сдаюсь» — resign; «отмени», «верни ход» — undo; «давай партию», «начнём», «новая партия» — start_game (цвет человека — чёрные, если не сказал иначе; «я белыми» — my_color white). «Играй как пять кю», «слабее», «сильнее» — set_rank с рангом словами.
- Если результат содержит finished и result, объяви результат словами из result.
- За человека ходи только по его прямой просьбе («сходи за меня на дэ четыре») и всегда называй этот ход вслух. Размышление вслух («а не пойти ли мне на дэ четыре») ходом не считается: переспроси, если не ясно.
- Человек может писать текстом (режим «Чат»): отвечай так же коротко. Твои реплики всегда видны в ленте на экране, в режиме «Голос» они ещё и звучат.
- Если в партии нет Гоко (играют два человека), ты не играешь: комментируешь, отвечаешь на вопросы о позиции и применяешь названные ходы за того, чей сейчас ход. Результаты таких партий называй цветами.
- Если get_position сообщает, что ход Гоко взят из основного поиска, а не из человеческой сети уровня, и человек спрашивает, почему ход такой сильный или странный, объясни это одной фразой.
- Если сервер перестал повторять попытки, скажи об этом одной фразой: новая попытка начнётся сама, как только человек что-нибудь скажет или напишет.
- Если на ход пришла причина «сервер не отвечает», ход мог уже примениться: прежде чем просить повторить, вызови get_position и скажи, что на доске. Причину «нет связи с сервером» или «слишком много запросов» передай одной фразой и не повторяй инструмент сразу.
- Реплики до двух предложений, если не спрашивают о позиции. Если тебя перебили — замолчи и слушай.`;

export const GREETING_INSTRUCTIONS =
  'Поздоровайся одной короткой фразой как соперник за доской и предложи начать партию или назвать ход. Ничего о позиции не говори.';
```

- [ ] **Step 2: Тесты `apps/voice-agent/src/metadata.test.ts`, `apps/voice-agent/src/voice.test.ts`, `apps/voice-agent/src/mode.test.ts`**

```ts
// metadata.test.ts
import { describe, expect, it } from 'vitest';
import { sessionIdOf } from './metadata.ts';

describe('sessionIdOf', () => {
  it('берёт sessionId из метаданных диспетчеризации', () => {
    expect(sessionIdOf('{"sessionId":"abc"}', 'goko-abc')).toBe('abc');
  });
  it('без метаданных — из имени комнаты goko-<id>', () => {
    expect(sessionIdOf(undefined, 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('', 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('not json', 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('{"other":1}', 'room')).toBe('room');
  });
});
```

```ts
// voice.test.ts
import { describe, expect, it } from 'vitest';
import { parseVoiceMode } from './voice.ts';

describe('parseVoiceMode', () => {
  it('realtime по умолчанию, pipeline по запросу, иначе ошибка', () => {
    expect(parseVoiceMode(undefined)).toBe('realtime');
    expect(parseVoiceMode('')).toBe('realtime');
    expect(parseVoiceMode('realtime')).toBe('realtime');
    expect(parseVoiceMode('pipeline')).toBe('pipeline');
    expect(() => parseVoiceMode('gpt')).toThrow('VOICE_MODE');
  });
});
```

```ts
// mode.test.ts — режим Голос / Чат (D-0011) на замоканном сеансе
import { describe, expect, it } from 'vitest';
import { MODE_ATTRIBUTE, applyMode, followMode, modeOf } from './mode.ts';

function fakeSession() {
  const calls: string[] = [];
  return {
    calls,
    input: { setAudioEnabled: (enabled: boolean) => void calls.push(`in:${enabled}`) },
    output: { setAudioEnabled: (enabled: boolean) => void calls.push(`out:${enabled}`) },
  };
}

describe('modeOf', () => {
  it('chat только при goko.mode=chat, всё остальное — voice', () => {
    expect(MODE_ATTRIBUTE).toBe('goko.mode');
    expect(modeOf({ 'goko.mode': 'chat' })).toBe('chat');
    expect(modeOf({ 'goko.mode': 'voice' })).toBe('voice');
    expect(modeOf({ 'goko.mode': 'CHAT' })).toBe('voice');
    expect(modeOf({})).toBe('voice');
    expect(modeOf(undefined)).toBe('voice');
  });
});

describe('applyMode', () => {
  it('chat выключает аудиовыход и аудиовход сессии, voice включает обратно', () => {
    const s = fakeSession();
    applyMode(s, 'chat');
    applyMode(s, 'voice');
    expect(s.calls).toEqual(['out:false', 'in:false', 'out:true', 'in:true']);
  });
});

describe('followMode', () => {
  it('на старте читает атрибут участника: в чате звук выключен сразу', () => {
    const s = fakeSession();
    const logs: string[] = [];
    const f = followMode({ participant: { identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } }, session: s, log: (l) => void logs.push(l) });
    expect(f.mode).toBe('chat');
    expect(s.calls).toEqual(['out:false', 'in:false']);
    expect(logs).toEqual(['[OK] voice-agent: режим chat']);
  });
  it('смена атрибута переключает режим; чужой участник и тот же режим не трогают сессию', () => {
    const s = fakeSession();
    const f = followMode({ participant: { identity: 'phone-s1', attributes: {} }, session: s });
    expect(f.mode).toBe('voice');
    expect(s.calls).toEqual(['out:true', 'in:true']);
    s.calls.length = 0;
    f.onAttributes({ identity: 'someone-else', attributes: { 'goko.mode': 'chat' } });
    f.onAttributes({ identity: 'phone-s1', attributes: { 'goko.mode': 'voice' } });
    expect(s.calls).toEqual([]);
    f.onAttributes({ identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } });
    expect(f.mode).toBe('chat');
    expect(s.calls).toEqual(['out:false', 'in:false']);
    f.onAttributes({ identity: 'phone-s1', attributes: {} });
    expect(f.mode).toBe('voice');
    expect(s.calls).toEqual(['out:false', 'in:false', 'out:true', 'in:true']);
  });
});
```

- [ ] **Step 3: Запустить тесты, убедиться, что падают**

Run: `npx vitest run apps/voice-agent/src/metadata.test.ts apps/voice-agent/src/voice.test.ts apps/voice-agent/src/mode.test.ts`
Expected: FAIL — модули не найдены.

- [ ] **Step 4: `apps/voice-agent/src/metadata.ts` и `apps/voice-agent/src/mode.ts`**

```ts
// sessionId из метаданных диспетчеризации (game-server кладёт { sessionId } в agents комнаты при createRoom, D-0001);
// запасной путь — имя комнаты goko-<sessionId>.
export function sessionIdOf(metadata: string | undefined, roomName: string): string {
  if (metadata) {
    try {
      const parsed: unknown = JSON.parse(metadata);
      if (parsed && typeof parsed === 'object' && 'sessionId' in parsed && typeof parsed.sessionId === 'string') {
        return parsed.sessionId;
      }
    } catch {
      // не JSON — берём имя комнаты
    }
  }
  return roomName.replace(/^goko-/, '');
}
```

```ts
// Режим разговора (D-0011): веб и scripts/chat.mjs выставляют атрибут участника goko.mode = voice | chat.
// В «Чате» аудиовход и аудиовыход сессии выключены, ответы идут только текстом в lk.transcription.
// Realtime при этом всё равно генерирует аудио (modalities задаются только в конструкторе RealtimeModel):
// это известная цена D-0011. Запасной путь — веб в «Чате» не подписан на аудиотрек агента.
export type TalkMode = 'voice' | 'chat';

export const MODE_ATTRIBUTE = 'goko.mode';

// Незнакомое значение и отсутствие атрибута — «Голос»: основной режим, и старый веб без атрибута работает как раньше.
export function modeOf(attributes: Readonly<Record<string, string>> | undefined): TalkMode {
  return attributes?.[MODE_ATTRIBUTE] === 'chat' ? 'chat' : 'voice';
}

// Ровно то, что нужно от voice.AgentSession (@livekit/agents 1.8: session.input и session.output, src/voice/io.ts).
export type AudioSwitch = {
  input: { setAudioEnabled(enabled: boolean): void };
  output: { setAudioEnabled(enabled: boolean): void };
};

export function applyMode(session: AudioSwitch, mode: TalkMode): void {
  const on = mode === 'voice';
  session.output.setAudioEnabled(on);
  session.input.setAudioEnabled(on);
}

// RemoteParticipant из @livekit/rtc-node подходит как есть: identity и attributes — геттеры.
export type ParticipantLike = { identity: string; attributes: Readonly<Record<string, string>> };

export type ModeFollower = { readonly mode: TalkMode; onAttributes(p: ParticipantLike): void };

// Следит за режимом одного участника — того, кого дождался ctx.waitForParticipant(). Вызывать после
// session.start: подключение аудиовыхода RoomIO внутри start вызывает onAttached независимо от флага.
export function followMode(opts: { participant: ParticipantLike; session: AudioSwitch; log?: (line: string) => void }): ModeFollower {
  const log = opts.log ?? (() => {});
  let mode = modeOf(opts.participant.attributes);
  applyMode(opts.session, mode);
  log(`[OK] voice-agent: режим ${mode}`);
  return {
    get mode() {
      return mode;
    },
    onAttributes(p) {
      if (p.identity !== opts.participant.identity) return;
      const next = modeOf(p.attributes);
      if (next === mode) return;
      mode = next;
      applyMode(opts.session, mode);
      log(`[OK] voice-agent: режим ${mode}`);
    },
  };
}
```

- [ ] **Step 5: `apps/voice-agent/src/voice.ts`**

```ts
// Сборка речи (раздел 9 спеки, «Речь»): realtime — gpt-realtime слушает и говорит сам;
// pipeline — запасной конвейер STT -> LLM -> TTS с VAD Silero. Инструменты и промпт одинаковые.
import type { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';

export type VoiceMode = 'realtime' | 'pipeline';
export type SessionOptions = ConstructorParameters<typeof voice.AgentSession>[0];

export function parseVoiceMode(v: string | undefined): VoiceMode {
  if (v === undefined || v === '' || v === 'realtime') return 'realtime';
  if (v === 'pipeline') return 'pipeline';
  throw new Error(`VOICE_MODE: ожидается realtime или pipeline, получено «${v}»`);
}

// Параметры VAD — из docs/research/stage0-results.md (стадия 0 подбирала перебивание).
export const REALTIME_TURN_DETECTION = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
} as const;

export async function sessionOptions(mode: VoiceMode): Promise<SessionOptions> {
  if (mode === 'realtime') {
    return {
      llm: new openai.realtime.RealtimeModel({
        model: 'gpt-realtime',
        voice: 'marin',
        turnDetection: REALTIME_TURN_DETECTION,
        inputAudioTranscription: { model: 'gpt-live-transcribe', language: 'ru' },
      }),
    };
  }
  return {
    vad: await silero.VAD.load(),
    stt: new openai.STT({ model: 'gpt-transcribe', language: 'ru' }),
    llm: new openai.LLM({ model: 'gpt-4.1-mini' }),
    tts: new openai.TTS({
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      instructions: 'Говори по-русски, спокойно и коротко, как игрок за доской; координаты произноси по буквам, как написано.',
    }),
  };
}
```

Если тип `turnDetection` установленной версии плагина не принимает объект `REALTIME_TURN_DETECTION` — взять форму из `docs/research/stage0-results.md` (стадия 0 подбирала её на этом же плагине); в крайнем случае не передавать `turnDetection` (останется значение по умолчанию плагина).

- [ ] **Step 6: `apps/voice-agent/src/agent.ts`**

```ts
// Агент Гоко: промпт + инструменты; при входе в комнату здоровается через generateReply (раздел 9 спеки).
import { voice } from '@livekit/agents';
import { GREETING_INSTRUCTIONS, INSTRUCTIONS } from './prompt.ts';
import type { GokoTools } from './tools.ts';

export class GokoAgent extends voice.Agent {
  readonly greet: boolean;

  constructor(tools: GokoTools, opts: { greet?: boolean } = {}) {
    super({ instructions: INSTRUCTIONS, tools });
    this.greet = opts.greet ?? true;
  }

  override async onEnter(): Promise<void> {
    if (this.greet) this.session.generateReply({ instructions: GREETING_INSTRUCTIONS });
  }
}
```

- [ ] **Step 7: `apps/voice-agent/src/main.ts`**

```ts
// Воркер LiveKit Agents: одна комната = одна сессия Гоко. Запуск: node apps/voice-agent/src/main.ts dev|start.
// .env берётся из корня репозитория (на VPS переменные приходят из compose).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import { RoomEvent } from '@livekit/rtc-node';
import { createClient } from '@goko/protocol';
import { GokoAgent } from './agent.ts';
import { type WatchHandle, watchSession } from './events.ts';
import { sessionIdOf } from './metadata.ts';
import { followMode } from './mode.ts';
import { GREETING_INSTRUCTIONS } from './prompt.ts';
import { newAgentState } from './state.ts';
import { createTools } from './tools.ts';
import { parseVoiceMode, sessionOptions } from './voice.ts';

const root = path.resolve(import.meta.dirname, '../../..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

// Пустая строка и строка из пробелов — «не задано», как в doctor, go-engine и game-server.
function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v;
}

function need(name: string): string {
  const v = optional(name);
  if (v === undefined) {
    console.error(`[X] voice-agent: нужна переменная ${name} (см. infra/.env.example)`);
    process.exit(2);
  }
  return v;
}

for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'OPENAI_API_KEY']) need(name);
const APP_KEY = need('APP_KEY');
const API_BASE = optional('API_BASE') ?? 'http://127.0.0.1:8787';
const AGENT_NAME = optional('AGENT_NAME') ?? 'goko';
const VOICE_MODE = parseVoiceMode(optional('VOICE_MODE'));

const log = (line: string) => console.log(line);

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const sessionId = sessionIdOf(ctx.job.metadata, ctx.room.name ?? '');
    log(`[OK] voice-agent: комната ${ctx.room.name}, сессия ${sessionId}, речь ${VOICE_MODE}`);
    await ctx.connect();
    // Комнату создал game-server (D-0001), агент приходит раньше телефона: Realtime открываем только
    // при живом участнике, иначе платная сессия шла бы в пустой комнате до emptyTimeout.
    const participant = await ctx.waitForParticipant();

    const client = createClient({ baseUrl: API_BASE, appKey: APP_KEY });
    const state = newAgentState(sessionId);
    // Сигнал сеанса: закрытие сессии или остановка воркера обрывает поток и вызовы инструментов.
    // Долгоживущий сигнал в CallOptions допустим: клиент снимает свой слушатель после каждого вызова.
    const abort = new AbortController();
    // Приветствие не в onEnter, а после применения режима: в «Чате» оно должно прийти только текстом.
    const agent = new GokoAgent(createTools({ client, state, log, signal: abort.signal }), { greet: false });
    const session = new voice.AgentSession(await sessionOptions(VOICE_MODE));
    let watch: WatchHandle | null = null;

    // Лента для логов: что услышали и что сказали. Значений env здесь нет.
    // Реплика человека после retries_exhausted переоткрывает поток сессии (D-0006): голосом — финальный
    // транскрипт, текстом из lk.chat — сообщение пользователя в истории (оно приходит и для голоса, повтор безвреден).
    session.on('user_input_transcribed', (ev) => {
      if (!ev.isFinal) return;
      log(`[user] ${ev.transcript}`);
      watch?.humanSpoke();
    });
    session.on('conversation_item_added', (ev) => {
      const item = ev.item;
      if (item.type !== 'message') return; // AgentHandoffItem без role и текста
      if (item.role === 'user') watch?.humanSpoke();
      if (item.role === 'assistant' && item.textContent) log(`[goko] ${item.textContent}`);
    });
    session.on('function_tools_executed', (ev) => {
      for (const call of ev.functionCalls) log(`[tool] ${call.name} ${call.args}`);
    });

    session.on('close', () => abort.abort());
    ctx.addShutdownCallback(async () => abort.abort());

    await session.start({ agent, room: ctx.room });

    // Режим Голос / Чат (D-0011): атрибут goko.mode участника. Применяется после start, см. mode.ts.
    const mode = followMode({ participant, session, log });
    ctx.room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => mode.onAttributes(p));
    ctx.room.on(RoomEvent.ParticipantConnected, (p) => mode.onAttributes(p)); // вернулся после обрыва с тем же identity
    session.generateReply({ instructions: GREETING_INSTRUCTIONS });

    watch = watchSession({
      client,
      state,
      signal: abort.signal,
      log,
      speak: async (instructions) => {
        session.generateReply({ instructions });
      },
    });
    void watch.done;
  },
});

// Остановка (SIGTERM от compose, режим start): drain ждёт идущие сеансы не дольше DRAIN_TIMEOUT_MS
// (по умолчанию у @livekit/agents 1.8 — 60 минут: разговор мог бы держать деплой час), затем close даёт
// процессу сеанса SHUTDOWN_PROCESS_TIMEOUT_MS на shutdown-колбэки и убивает его. Сумма с закрытием
// процесса инференса (5 с в библиотеке) — около 30 с; stop_grace_period у voice-agent в compose — 60 с (задача 10).
const DRAIN_TIMEOUT_MS = 5_000;
const SHUTDOWN_PROCESS_TIMEOUT_MS = 20_000;

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    drainTimeout: DRAIN_TIMEOUT_MS,
    shutdownProcessTimeout: SHUTDOWN_PROCESS_TIMEOUT_MS,
  }),
);
```

`watch.done` завершается и сам — после `not_found` потока (сессия истекла): агент один раз говорит об этом, комната остаётся до ухода телефона и `emptyTimeout`; `start_game` ответит `humanText('not_found')` (новая партия создаётся только в сессии), партия же на сервере живёт дальше, и инструменты хода над ней работают, но озвучивания событий уже нет. Переподключать поток к несуществующей сессии незачем.

Если у события `function_tools_executed` в установленной версии другое поле (не `functionCalls` с `name`/`args`), подстроить лог по типу `FunctionToolsExecutedEvent` из `@livekit/agents` — суть та же: имя инструмента и аргументы одной строкой. Если `ctx.addShutdownCallback` отсутствует — убрать строку, `close` сессии достаточно. `ParticipantConnected` с тем же `identity` приходит, когда телефон вернулся в комнату после обрыва: его атрибуты уже в `participant.attributes`. Участник с другим `identity` режим не меняет — токен сессии выдаётся на одно `identity` (`phone-<sessionId>`).

- [ ] **Step 8: `infra/.env.example` — переменные агента** (после строки `AGENT_NAME=goko ...`)

```
VOICE_MODE=realtime                # pipeline — запасной конвейер STT -> LLM -> TTS (раздел 9 спеки)
API_BASE=http://127.0.0.1:8787     # куда voice-agent ходит за партией; в контейнере http://game-server:8787
```

- [ ] **Step 9: Тесты, typecheck, запуск воркера**

Run: `npx vitest run apps/voice-agent && npm run typecheck`
Expected: все тесты `voice-agent` проходят, в том числе `mode.test.ts` (eval-файла пока нет), typecheck без ошибок.

Run (нужен `.env` с `LIVEKIT_*`, `OPENAI_API_KEY`, `APP_KEY`): `AGENT_NAME=goko-dev node apps/voice-agent/src/main.ts dev`
Expected: в логе `registered worker` с `agentName goko-dev`; без `.env` или с `LIVEKIT_URL` из пробелов — `[X] voice-agent: нужна переменная LIVEKIT_URL` и код 2. Остановить Ctrl+C. Проверка режима — в задаче 5 (`scripts/chat.mjs` выставляет `goko.mode=chat`: в логе агента `[OK] voice-agent: режим chat`).

- [ ] **Step 10: Платные evals `apps/voice-agent/src/agent.eval.test.ts`** (включаются только `RUN_AGENT_EVALS=1` при `OPENAI_API_KEY`; в `npm run check` — `skipped`)

```ts
// Проверка поведения модели с инструментами (раздел 12 спеки). Стоит денег: RUN_AGENT_EVALS=1 npx vitest run apps/voice-agent/src/agent.eval.test.ts
// Модель — текстовая (gpt-4.1-mini), не realtime: инструменты и промпт те же, проверяем выбор инструмента и аргументы.
// Один файл, один прогон на все сценарии: платных прогонов на весь план не больше 5 (Global Constraints).
import { afterEach, describe, expect, it } from 'vitest';
import { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { GokoAgent } from './agent.ts';
import { followMode } from './mode.ts';
import { newAgentState } from './state.ts';
import { createFakeClient } from './testing/fake-client.ts';
import { createTools } from './tools.ts';

const enabled = process.env.RUN_AGENT_EVALS === '1' && Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!enabled)('Гоко: выбор инструментов (платно)', () => {
  let session: voice.AgentSession | null = null;

  async function start(opts: { withGame?: boolean } = {}) {
    const client = createFakeClient({ replies: ['K10', 'D10', 'K4'] });
    const state = newAgentState('s1');
    const tools = createTools({ client, state });
    if (opts.withGame ?? true) {
      await client.newGame('s1', { black: { controller: 'human' }, white: { controller: 'engine', rank: '10k' } });
      state.gameId = 'g1';
      state.toolGames.add('g1');
    }
    session = new voice.AgentSession({ llm: new openai.LLM({ model: 'gpt-4.1-mini' }) });
    await session.start({ agent: new GokoAgent(tools, { greet: false }) });
    return { session, client, state };
  }

  afterEach(async () => {
    await session?.close();
    session = null;
  });

  // session.run возвращает RunResult, а не промис (@livekit/agents 1.8): без wait() утверждения читают
  // незаконченный прогон, а следующий run бросает «nested runs are not supported».
  it('«дэ четыре» -> play_move D4', async () => {
    const { session } = await start();
    const result = session.run({ userInput: 'дэ четыре' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'play_move', args: { coord: 'D4' } });
  }, 60_000);

  it('«нет, дэ пять» после хода -> correct_last_move D5', async () => {
    const { session } = await start();
    await session.run({ userInput: 'дэ четыре' }).wait();
    const result = session.run({ userInput: 'нет, дэ пять' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'correct_last_move', args: { coord: 'D5' } });
  }, 90_000);

  it('«пас» -> pass', async () => {
    const { session } = await start();
    const result = session.run({ userInput: 'пас' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'pass' });
  }, 60_000);

  it('«кто впереди» -> get_assessment, без лучшего хода в ответе (строка и LLM-судья)', async () => {
    const { session } = await start();
    const result = session.run({ userInput: 'кто впереди?' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'get_assessment' });
    const message = result.expect.at(-1).isMessage({ role: 'assistant' });
    const text = String(message.event().item.textContent ?? '');
    expect(text.length).toBeGreaterThan(0);
    // Строкой — только координаты bestMoves фейкового клиента; место слабой группы (C3, C4) называть можно.
    for (const best of ['K10', 'ка десять', 'D10', 'дэ десять']) expect(text.toLowerCase()).not.toContain(best.toLowerCase());
    // LLM-судья раздела 12 спеки — в этом же прогоне, отдельного платного прогона нет. Отказ судьи бросает ошибку.
    const judge = new openai.LLM({ model: 'gpt-4.1-mini' });
    await message.judge(judge, {
      intent: 'оценивает позицию: кто впереди и насколько; не подсказывает ход — не называет лучший ход и не советует, куда ходить (где слабые группы, сказать можно)',
    });
  }, 90_000);

  it('«давай партию, я белыми» -> start_game white', async () => {
    const { session } = await start({ withGame: false });
    const result = session.run({ userInput: 'давай партию, я белыми' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'start_game', args: { my_color: 'white' } });
  }, 60_000);

  it('D-0004: прямая просьба «сходи за меня на дэ четыре» -> play_move D4, ход назван в ответе', async () => {
    const { session } = await start();
    const result = session.run({ userInput: 'сходи за меня на дэ четыре' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'play_move', args: { coord: 'D4' } });
    const text = String(result.expect.at(-1).isMessage({ role: 'assistant' }).event().item.textContent ?? '');
    expect(text).toMatch(/д[эе][\s-]*четыре|d4/i);
  }, 60_000);

  it('D-0004: размышление «а не пойти ли мне на дэ четыре?» ходом не считается', async () => {
    const { session } = await start();
    const result = session.run({ userInput: 'хм, а не пойти ли мне на дэ четыре?' });
    await result.wait();
    const moved = result.events.some((e) => e.type === 'function_call' && ['play_move', 'correct_last_move'].includes(e.item.name));
    expect(moved).toBe(false);
  }, 60_000);

  it('режим «Чат» (D-0011): goko.mode=chat выключает звук сеанса, ответ на ход приходит текстом', async () => {
    const { session } = await start();
    const mode = followMode({ participant: { identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } }, session });
    expect(mode.mode).toBe('chat');
    expect(session.output.audioEnabled).toBe(false);
    expect(session.input.audioEnabled).toBe(false);
    const result = session.run({ userInput: 'дэ четыре' });
    await result.wait();
    result.expect.containsFunctionCall({ name: 'play_move', args: { coord: 'D4' } });
    const text = String(result.expect.at(-1).isMessage({ role: 'assistant' }).event().item.textContent ?? '');
    expect(text.length).toBeGreaterThan(0);
    expect(session.output.audioEnabled).toBe(false);
  }, 60_000);
});
```

«Без лучшего хода» проверяется дважды в одном сценарии: строкой по координатам `bestMoves` фейкового клиента (известны заранее) и LLM-судьёй раздела 12 спеки — `MessageAssert.judge(llm, { intent })` из `@livekit/agents` 1.8 (`run_result.d.ts`). Судья вызывается в том же прогоне eval и платных прогонов не добавляет. Текст ответа — `event().item.textContent` (`MessageAssert.event(): ChatMessageEvent`). `session.run` возвращает `RunResult` без `then`, поэтому перед утверждениями и перед следующим `run` — `await result.wait()`. Отсутствие вызова проверяется по `result.events` (`RunEvent` с `type: 'function_call'` и `item.name`): утверждения «не вызывал» у `RunAssert` нет. Сценарий «Чат» проверяет то, что агент делает сам — флаги `audioEnabled` сеанса после `followMode` и текстовый ответ; то, что до телефона не доходит звук, — ручная проверка задачи 8 (шаг 6). Модель eval текстовая, поэтому звук она не генерирует в обоих режимах: сценарий ловит поломку `followMode`/`applyMode` и промпта, а не Realtime.

Run: `RUN_AGENT_EVALS=1 npx vitest run apps/voice-agent/src/agent.eval.test.ts` (PowerShell: `$env:RUN_AGENT_EVALS='1'; npx vitest run apps/voice-agent/src/agent.eval.test.ts`)
Expected: 8 passed. Это платный прогон 1 из 5 (Global Constraints). Провал «дэ четыре» или сценариев D-0004 → править формулировки в `prompt.ts` (таблица произношения, правило хода за человека) и описания инструментов в `tools.ts`, не тест; повторный прогон — из запаса (1), не больше одного. Отдельные сценарии по одному (`-t`) не гонять: каждый запуск — отдельный платный прогон.

Run: `npm run check`
Expected: `agent.eval.test.ts` — `skipped`, остальное зелёное.

- [ ] **Step 11: Commit**

```bash
git add apps/voice-agent/src/prompt.ts apps/voice-agent/src/voice.ts apps/voice-agent/src/voice.test.ts apps/voice-agent/src/agent.ts apps/voice-agent/src/metadata.ts apps/voice-agent/src/metadata.test.ts apps/voice-agent/src/mode.ts apps/voice-agent/src/mode.test.ts apps/voice-agent/src/main.ts apps/voice-agent/src/agent.eval.test.ts infra/.env.example
git commit -m "voice-agent: промпт, режимы realtime/pipeline и Голос/Чат, воркер, evals по флагу"
```

---
### Task 5: `scripts/chat.mjs` — текстовый диалог с Гоко из консоли; право атрибута режима в токене

**Files:**
- Create: `scripts/chat.mjs`
- Modify: `apps/game-server/src/livekit.ts` (право `canUpdateOwnMetadata`, D-0011), `package.json` (корень: скрипт `chat`, devDependency `@livekit/rtc-node`)
- Test: `apps/game-server/src/livekit.test.ts`, `apps/game-server/src/app.test.ts` (ожидаемые права токена), `scripts/chat.test.ts`

**Interfaces:**
- Consumes: `createClient` из `@goko/protocol` (`createSession`, `events`, `ascii`); `Room`, `RoomEvent` из `@livekit/rtc-node`; воркер из Task 4, зарегистрированный под тем же `AGENT_NAME`, что и game-server; `mintToken` из `apps/game-server/src/livekit.ts`.
- Produces: токен телефона с правами `{ roomJoin, room, canPublish, canSubscribe, canPublishData, canUpdateOwnMetadata }` — без `roomCreate` и `roomConfig`, как и прежде; `node scripts/chat.mjs [--api http://127.0.0.1:8787]` (`npm run chat`): создаёт сессию через game-server (комнату с агентом создаёт сервер, D-0001; скрипт комнат не создаёт), входит в комнату с токеном сессии (агент диспетчеризуется сам), выставляет атрибут `goko.mode=chat` (D-0011: агент отвечает только текстом), stdin → `lk.chat`, ответы из `lk.transcription` и события SSE → stdout; команда `/board` печатает ascii-доску; `describeEvent(ev): string` и `CHAT_ATTRIBUTES` — экспорт для теста. Реплики печатаются по одному разу на `lk.segment_id`; по EOF на stdin скрипт ждёт тишины (`CHAT_QUIET_MS`, потолок `CHAT_MAX_WAIT_MS`) и закрывается сам, по `Ctrl+C` — отключается от комнаты; коды возврата: 0 — штатно, 1 — сбой LiveKit или game-server, 2 — нет `APP_KEY`.

- [ ] **Step 1: game-server — право `canUpdateOwnMetadata` в токене телефона (D-0011)**

Без этого права LiveKit отклоняет `setAttributes` участника: по умолчанию участник не может менять свои метаданные и атрибуты (комментарий к `canUpdateOwnMetadata` в `livekit-server-sdk`, документация LiveKit «Participant attributes and metadata»). Право касается только своих имени, метаданных и атрибутов; комнат оно не создаёт и агентов не диспетчеризует, так что граница D-0001 не сдвигается.

Сначала тесты. В `apps/game-server/src/livekit.test.ts` заменить заголовок `describe` и ожидание прав:

```ts
describe('mintToken (D-0001, D-0011): roomJoin на комнату сессии и право на свои атрибуты', () => {
```

```ts
    expect(claims.video).toEqual({ roomJoin: true, room: 'goko-s1', canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });
```

В `apps/game-server/src/app.test.ts` в тесте создания сессии заменить заголовок и ожидание прав:

```ts
  it('создание сессии (D-0001, D-0011): комнату с агентом создаёт сервер, токен — roomJoin и право на свои атрибуты; session.game в потоке', async () => {
```

```ts
    expect(claims.video).toEqual({ room: session.room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });
```

Run: `npx vitest run apps/game-server/src/livekit.test.ts apps/game-server/src/app.test.ts`
Expected: FAIL — в `claims.video` нет `canUpdateOwnMetadata`.

В `apps/game-server/src/livekit.ts` заменить вторую и третью строки шапки и грант:

```ts
// RoomServiceClient.createRoom, телефон получает токен с roomJoin на эту комнату, без roomCreate
// и без roomConfig. Токен с roomCreate дал бы любому, кто открыл веб, неограниченное число платных агентов.
// canUpdateOwnMetadata (D-0011) — только свои атрибуты: веб выставляет goko.mode = voice | chat.
```

```ts
  at.addGrant({ roomJoin: true, room: opts.room, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });
```

Run: `npx vitest run apps/game-server/src/livekit.test.ts apps/game-server/src/app.test.ts && npm run typecheck`
Expected: PASS, typecheck без ошибок.

```bash
git add apps/game-server/src/livekit.ts apps/game-server/src/livekit.test.ts apps/game-server/src/app.test.ts
git commit -m "game-server: право canUpdateOwnMetadata в токене телефона для атрибута режима (D-0011)"
```

- [ ] **Step 2: Тест `scripts/chat.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { CHAT_ATTRIBUTES, describeEvent } from './chat.mjs';

describe('CHAT_ATTRIBUTES', () => {
  it('консоль — режим «Чат» (D-0011): агент отвечает текстом, без звука', () => {
    expect(CHAT_ATTRIBUTES).toEqual({ 'goko.mode': 'chat' });
  });
});

describe('describeEvent', () => {
  it('коротко описывает события сессии', () => {
    expect(describeEvent({ type: 'session.game', gameId: 'g1' })).toBe('партия g1');
    expect(describeEvent({ type: 'engine.thinking', gameId: 'g1', color: 'W' })).toBe('Гоко думает за W');
    expect(describeEvent({ type: 'game.finished', result: { winner: 'W', reason: 'resign' } })).toBe('конец: W+R');
    expect(describeEvent({ type: 'game.finished', result: { winner: 'B', margin: 5.5, reason: 'score' } })).toBe('конец: B+5.5');
    expect(describeEvent({ type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' })).toBe('ошибка engine_busy: Гоко думает дольше обычного');
    expect(
      describeEvent({
        type: 'state.updated',
        cause: 'engine',
        by: 'engine',
        state: { revision: 4, toPlay: 'B', moves: [{ n: 1, color: 'B', coord: 'D4' }, { n: 2, color: 'W', coord: 'K10' }] },
      }),
    ).toBe('engine by engine: ход 2 W K10, rev 4, дальше B');
    expect(describeEvent({ type: 'state.updated', cause: 'play', by: 'human', via: 'tap', state: { revision: 1, toPlay: 'W', moves: [] } })).toBe(
      'play by human via tap: ходов 0, rev 1, дальше W',
    );
  });
});
```

- [ ] **Step 3: Запустить тест, убедиться, что падает**

Run: `npx vitest run scripts/chat.test.ts`
Expected: FAIL — `Cannot find module './chat.mjs'`.

- [ ] **Step 4: `scripts/chat.mjs`**

Код ниже — полный, вместе с уроками спайка стадии 0 (живой прогон и два круга ревью 08.09):
печать сегмента ровно один раз (сразу при честном `final="true"`, иначе по короткой паузе без
новых кусков того же сегмента), дедуп по `lk.segment_id`, ожидание тишины перед выходом,
корректный `SIGINT` и диагностика потерянных реплик. Код здесь самодостаточный. `spike/` к этому
моменту ещё в репозитории (его удаляют после голосового прогона founder'а), но оттуда ничего не
копировать: `spike/token.mjs` и `spike/chat.mjs` выдают себе токен с `roomCreate` и `roomConfig`,
а по D-0001 комнату создаёт только game-server.

```js
#!/usr/bin/env node
// Текстовый диалог с Гоко без микрофона (раздел 12 спеки): сессия через game-server (он же создаёт
// комнату с агентом, D-0001), stdin -> lk.chat, lk.transcription и события SSE -> stdout. Нужны LIVEKIT
// на VPS и запущенный воркер с тем же AGENT_NAME, что у game-server (npm run dev поднимает оба под goko-dev).
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Room, RoomEvent } from '@livekit/rtc-node';
import { ApiError, ClientTimeoutError, createClient, humanText } from '@goko/protocol';

// Режим «Чат» (D-0011): агент выключает звук сессии и отвечает только текстом в lk.transcription.
export const CHAT_ATTRIBUTES = { 'goko.mode': 'chat' };

// Пустая строка и строка из пробелов — «не задано», как в doctor и game-server.
const env = (name) => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v;
};
const envMs = (name, fallback) => {
  const n = Number(env(name) ?? fallback);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// Сколько ждать тишины после EOF на stdin: ответ на последнюю фразу приходит позже конца ввода,
// и при скриптовом прогоне (echo 'дэ четыре' | npm run chat) он иначе теряется целиком.
const QUIET_MS = envMs('CHAT_QUIET_MS', 5000);
// Потолок ожидания: агент может замолчать или зациклиться, а висящая комната — это живые деньги
// за сессию Realtime (empty_timeout закрывает её только через 5 минут).
const MAX_WAIT_MS = envMs('CHAT_MAX_WAIT_MS', 60000);
// Пауза без новых кусков сегмента, после которой считаем сегмент законченным.
const SEGMENT_DEBOUNCE_MS = 500;
// Диспетчеризация воркера занимает 3-5 с; фраза, отправленная в эту щель, до агента не доходит
// и пропадает молча — поэтому приглашение печатаем только после входа агента.
const AGENT_WAIT_MS = envMs('CHAT_AGENT_WAIT_MS', 15000);
const POLL_MS = 200;

export function describeEvent(ev) {
  switch (ev.type) {
    case 'session.game':
      return `партия ${ev.gameId}`;
    case 'engine.thinking':
      return `Гоко думает за ${ev.color}`;
    case 'game.finished':
      return `конец: ${ev.result.winner}+${ev.result.reason === 'resign' ? 'R' : ev.result.margin}`;
    case 'error':
      return `ошибка ${ev.code}: ${humanText(ev.code)}`;
    case 'state.updated': {
      const last = ev.state.moves.at(-1);
      const via = ev.via ? ` via ${ev.via}` : '';
      const move = last ? `ход ${last.n} ${last.color} ${last.coord}` : `ходов ${ev.state.moves.length}`;
      return `${ev.cause} by ${ev.by}${via}: ${move}, rev ${ev.state.revision}, дальше ${ev.state.toPlay}`;
    }
    default:
      return JSON.stringify(ev);
  }
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..');
  if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const argv = process.argv.slice(2);
  const apiIndex = argv.indexOf('--api');
  const api = apiIndex >= 0 ? argv[apiIndex + 1] : (env('API_BASE') ?? 'http://127.0.0.1:8787');
  const appKey = env('APP_KEY');
  if (!appKey) {
    console.error('[X] chat: нужен APP_KEY в .env');
    process.exit(2);
  }

  const client = createClient({ baseUrl: api, appKey });
  // Комнату и диспетчеризацию агента создаёт game-server в POST /api/sessions (D-0001); токен — только на эту комнату.
  const { session, livekit } = await client.createSession();
  // Значение AGENT_NAME не печатаем (правило 4 CLAUDE.md): агента диспетчеризует game-server по своей переменной.
  console.log(`[OK] сессия ${session.id}, комната ${session.room}, агент по AGENT_NAME game-server`);

  let gameId = session.currentGameId;
  const room = new Room();
  const abort = new AbortController();

  let lastActivityAt = Date.now();
  let activeStreams = 0;
  let closing = false;
  let agentJoined = false;
  // Сегменты, уже напечатанные: повторные куски того же сегмента игнорируем.
  const printedSegments = new Set();
  // lk.segment_id -> { identity, text, timer } — сегменты в ожидании подтверждения.
  const pendingSegments = new Map();
  // Ключ потока -> { identity, text } — потоки, которые ещё не дочитаны. Без этой карты
  // накопленный текст живёт только в локальной переменной обработчика, и зависший поток
  // (главная причина выхода по потолку ожидания) теряется молча.
  const openStreams = new Map();

  const printSegment = (identity, text) => {
    lastActivityAt = Date.now();
    console.log(`[${identity}] ${text}`);
  };

  const flushSegment = (segmentId) => {
    const pending = pendingSegments.get(segmentId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSegments.delete(segmentId);
    printedSegments.add(segmentId);
    printSegment(pending.identity, pending.text);
  };

  // Выход по потолку ожидания или по Ctrl+C застаёт реплику недопечатанной двумя способами:
  // сегмент дочитан, но ждёт подтверждения, либо поток так и не закрылся. Второй случай и есть
  // обычная причина выхода по потолку, поэтому он тоже должен попасть в лог: «строки просто нет»
  // неотличимо от «агент ничего не сказал», и по такому прогону нечего разбирать.
  const reportLostSegments = () => {
    for (const [segmentId, pending] of pendingSegments) {
      clearTimeout(pending.timer);
      console.error(`[!] сегмент ${segmentId} от ${pending.identity} не подтверждён, недопечатано: ${pending.text}`);
    }
    pendingSegments.clear();
    let silentStreams = 0;
    for (const [streamKey, open] of openStreams) {
      if (!open.text) {
        silentStreams += 1;
        continue;
      }
      console.error(`[!] сегмент ${streamKey} от ${open.identity} поток не закрыт, недопечатано: ${open.text}`);
    }
    if (silentStreams > 0) console.error(`[!] открытых потоков: ${silentStreams}, хвост реплики не получен`);
    openStreams.clear();
  };

  const shutdown = async (code, announce = true) => {
    if (closing) return;
    closing = true;
    reportLostSegments();
    abort.abort();
    if (announce) console.log('[OK] сессия закрыта');
    try {
      await room.disconnect();
    } catch {
      // Отключение уже могло произойти; для выхода это не важно.
    }
    process.exit(code);
  };

  // Регистрировать до connect: первые реплики агента приходят сразу после входа.
  room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
    activeStreams += 1;
    lastActivityAt = Date.now();
    const attrs = reader.info.attributes ?? {};
    const segmentId = attrs['lk.segment_id'];
    const identity = participant?.identity ?? 'agent';
    // Ключ тот же, что у сегмента, чтобы строки лога сходились между собой; на потоке без
    // сегмента берём идентификатор потока, он всегда есть.
    const streamKey = segmentId ?? reader.info.id;
    let text = '';
    try {
      // Поток отмечаем открытым сразу и обновляем на каждом куске: пока он не дочитан, хвост
      // не виден больше нигде, а диагностика на выходе печатала бы пустоту ровно тогда, когда
      // поток завис. Пустая запись тоже нужна — она отличает «поток открылся и молчит».
      openStreams.set(streamKey, { identity, text });
      for await (const chunk of reader) {
        text += chunk;
        openStreams.set(streamKey, { identity, text });
      }
      lastActivityAt = Date.now();
      if (!text) return;

      // Атрибут lk.transcription_final нельзя использовать как фильтр «печатать или нет»:
      // @livekit/agents 1.8.0 ведёт транскрипт агента дельта-потоком (isDeltaStream: true),
      // открывает его один раз с "false" в заголовке и уже не переписывает — фильтр по атрибуту
      // отбрасывал бы все реплики агента (проверено на спайке 08.09). Для агента признак финала —
      // дочитанный поток. Но транскрипт человека идёт НЕ дельта-потоком (isDeltaStream: false):
      // каждый промежуточный результат STT — отдельный закрытый поток с тем же lk.segment_id,
      // и «поток дочитан» там не значит «фраза закончена». Без дедупа по сегменту одна фраза
      // с телефона печаталась бы растущими дублями: «При», «Привет», «Привет, я»...
      // Отсечь по identity нельзя: микрофон на стадии 1 — отдельный участник с чужим именем,
      // и как раз распознанную речь человека в консоли видеть важнее всего.
      if (!segmentId) {
        printSegment(identity, text);
        return;
      }
      if (printedSegments.has(segmentId)) return;

      const pending = pendingSegments.get(segmentId);
      if (pending) clearTimeout(pending.timer);

      // У человека атрибут выставляется честно — печатаем сразу; у агента ждём паузу.
      if (attrs['lk.transcription_final'] === 'true') {
        pendingSegments.set(segmentId, { identity, text, timer: null });
        flushSegment(segmentId);
        return;
      }
      const timer = setTimeout(() => flushSegment(segmentId), SEGMENT_DEBOUNCE_MS);
      pendingSegments.set(segmentId, { identity, text, timer });
    } finally {
      activeStreams -= 1;
      openStreams.delete(streamKey);
    }
  });

  room.on(RoomEvent.ParticipantConnected, (p) => {
    // Любой удалённый участник — это воркер: в комнате goko-<sessionId> кроме него и нас никого
    // нет. Проверять identity по префиксу нельзя: имя воркера нигде в проекте не закреплено, и
    // при другом имени скрипт молча ждал бы весь AGENT_WAIT_MS и ругался бы на пустом месте.
    agentJoined = true;
    console.log(`[OK] в комнате: ${p.identity}`);
  });
  room.on(RoomEvent.ParticipantDisconnected, (p) => console.log(`[!] вышел: ${p.identity}`));
  room.on(RoomEvent.Disconnected, () => {
    // Наше собственное отключение уже ведёт shutdown; выходить здесь — оборвать хвост вывода.
    if (closing) return;
    console.log('[!] комната закрыта');
    process.exit(0);
  });

  try {
    await room.connect(livekit.url, livekit.token, { autoSubscribe: true, dynacast: false });
  } catch {
    // Текст ошибки rtc-node содержит адрес сервера, то есть значение LIVEKIT_URL: не печатаем
    // ни его, ни err.message — репозиторий и логи прогонов публичные.
    console.error('[X] не удалось подключиться к LiveKit; проверьте настройки сессии и воркер');
    process.exit(1);
  }
  console.log(`[OK] вошёл как ${room.localParticipant?.identity}; жду агента...`);
  // Режим «Чат» (D-0011). Агент читает атрибут, когда дождётся участника, и следит за его сменой,
  // так что выставить его сразу после connect достаточно. Без права canUpdateOwnMetadata в токене
  // (задача 5, шаг 1) сервер откажет: разговор всё равно работает, но агент ответит и голосом.
  try {
    await room.localParticipant.setAttributes(CHAT_ATTRIBUTES);
    console.log('[OK] режим чата: агент отвечает текстом');
  } catch {
    console.error('[!] не удалось выставить режим чата (goko.mode): агент будет отвечать и голосом');
  }

  // Ctrl+C без обработчика убил бы процесс молча: участник отвалился бы не по причине из
  // CLOSE_ON_DISCONNECT_REASONS, сессия Realtime висела бы до empty_timeout и стоила денег.
  const onSignal = () => {
    console.log('');
    void shutdown(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  void (async () => {
    try {
      for await (const ev of client.events({ sessionId: session.id }, abort.signal)) {
        if (ev.type === 'session.game') gameId = ev.gameId;
        lastActivityAt = Date.now();
        console.log(`[event] ${describeEvent(ev)}`);
      }
    } catch {
      // Текст ошибки клиента содержит адрес game-server — печатаем свою строку.
      if (!abort.signal.aborted) console.log('[!] SSE оборвался, события больше не приходят');
    }
  })();

  // Участник, уже стоявший в комнате к моменту connect, события ParticipantConnected не породит.
  if (room.remoteParticipants.size > 0) agentJoined = true;
  const agentDeadline = Date.now() + AGENT_WAIT_MS;
  while (!agentJoined && Date.now() < agentDeadline) await sleep(POLL_MS);
  if (!agentJoined) console.log('[!] агент не вошёл в комнату; писать можно, но ответов не будет');

  console.log('[OK] пиши фразы («давай партию», «дэ четыре», «кто впереди»); /board — доска; Ctrl+C — выход');
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    if (text === '/board') {
      if (!gameId) {
        console.log('[!] партии ещё нет');
        continue;
      }
      try {
        console.log(await client.ascii(gameId));
      } catch {
        console.log('[!] не удалось получить доску от game-server');
      }
      continue;
    }
    try {
      await room.localParticipant.sendText(text, { topic: 'lk.chat' });
    } catch {
      console.error('[X] не удалось отправить реплику агенту; соединение с LiveKit потеряно');
      await shutdown(1, false);
    }
    lastActivityAt = Date.now();
  }

  // EOF на stdin — ещё не конец разговора. Ждём тишины: нет открытых потоков, нет неподтверждённых
  // сегментов, QUIET_MS без новой активности, — но не дольше MAX_WAIT_MS.
  const waitStartedAt = Date.now();
  while (activeStreams > 0 || pendingSegments.size > 0 || Date.now() - lastActivityAt < QUIET_MS) {
    if (Date.now() - waitStartedAt >= MAX_WAIT_MS) {
      console.error(`[!] тишины не дождался за ${Math.round(MAX_WAIT_MS / 1000)} с, закрываю сессию`);
      break;
    }
    await sleep(POLL_MS);
  }

  await shutdown(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    // Сюда попадают сбои до входа в комнату (createSession). Текст ошибки клиента содержит адрес
    // game-server, поэтому err.message не печатаем. Ответ сервера по протоколу (limit_reached,
    // rate_limited, unauthorized) и таймаут клиента — фразой humanText и кодом; остальное — своей строкой.
    if (e instanceof ApiError || e instanceof ClientTimeoutError) {
      console.error(`[X] chat: не удалось создать сессию: ${humanText(e.code, e instanceof ApiError ? e.details : undefined)} (${e.code})`);
    } else {
      console.error('[X] chat: не удалось создать сессию; проверьте --api, APP_KEY и запущенный game-server');
    }
    process.exit(1);
  });
}
```

Почему именно так — уроки спайка стадии 0 (живой прогон и два круга ревью), их переносить целиком:

- **Признак финальности.** У транскрипта агента `lk.transcription_final` навсегда `false`, у транскрипта человека выставляется честно. Отсюда правило на два случая: `"true"` — печатаем сразу, иначе по паузе `SEGMENT_DEBOUNCE_MS` без новых кусков того же сегмента. Побочный эффект: реплика агента появляется на ~0.5 с позже; для консоли это не мешает.
- **Дедуп только по `lk.segment_id`.** Транскрипт человека переоткрывается на каждом промежуточном куске, поэтому без дедупа одна фраза печатается растущими дублями. Отсечение по имени участника не годится: микрофон на стадии 1 — отдельный участник с чужим именем, и как раз его распознанную речь важнее всего видеть.
- **Ошибки `connect` и `sendText`** — `[X]` со своим текстом, без `err.message` и без адреса, ненулевой код возврата (правила 4 и 6 `CLAUDE.md`).
- **Ожидание тишины вместо разрыва по EOF** — иначе ответ на последнюю фразу теряется в скриптовом прогоне; потолок `MAX_WAIT_MS` не даёт висеть и жечь деньги.
- **`SIGINT`/`SIGTERM` через `shutdown`** — без него участник отваливается не по причине из `CLOSE_ON_DISCONNECT_REASONS`, сессия Realtime доживает до `empty_timeout`.
- **`[!]` о потерянных репликах** на выходе по потолку ожидания и по Ctrl+C — и о сегментах, ждавших подтверждения, и о незакрытых потоках (`openStreams`). Смотреть только на ожидающие подтверждения бесполезно: там сегмент живёт полсекунды, а выход по потолку случается как раз из-за зависшего потока, чей текст иначе не виден нигде.
- **Ожидание входа агента до приглашения** — диспетчеризация занимает 3-5 с, отправленная в эту щель фраза пропадает без следа.
- **Атрибут `goko.mode=chat`** (D-0011) — консоль не слушает звук, и агент в этом режиме не тратит время на озвучку; Realtime аудио всё равно генерирует (цена D-0011). Отказ `setAttributes` не валит скрипт: разговор важнее режима.

Если `sendText` в установленной версии `@livekit/rtc-node` отсутствует — отправлять через `publishData` с `topic: 'lk.chat'`; обёртка `try/catch` та же. `LocalParticipant.setAttributes(attributes)` в `@livekit/rtc-node` 0.13.34 есть (`src/participant.ts`); если его подпись в установленной версии другая — взять из типа `LocalParticipant`.

- [ ] **Step 5: Корневой `package.json`**

В `"scripts"` добавить `"chat": "node scripts/chat.mjs"`. В `"devDependencies"` добавить `"@livekit/rtc-node": "^0.13.34"` (корень — для скрипта; воркер объявил ту же версию у себя в задаче 1, npm поднимет одну копию). Затем `npm install`.

- [ ] **Step 6: Тест и прогон**

Run: `npx vitest run scripts/chat.test.ts`
Expected: PASS.

Два прогона ниже с агентом — платные (Realtime): 2-й и 3-й из 5 на весь план (Global Constraints), только по явной просьбе founder'а. Их можно слить в один сценарный, если интерактивный не нужен: тогда один прогон остаётся в запасе. Проверка диагностики без сети и прогон с выключенным game-server (`[X] chat: не удалось создать сессию; ...`) — бесплатны.

Run (нужны `.env` с `LIVEKIT_*`, `OPENAI_API_KEY`, `APP_KEY`; в одном терминале `npm run dev`): `npm run chat`
Expected: `[OK] сессия ...`, `[OK] вошёл как phone-<id>`, `[OK] режим чата: агент отвечает текстом` (в логе воркера — `[OK] voice-agent: режим chat`), через 1–3 с `[OK] в комнате: <identity агента>` и приветствие `[<identity агента>] ...`. Ввести `давай партию` → `[event] партия g...`, `[event] new by system: ходов 0, rev 0, дальше B`, реплика агента; `дэ четыре` → `[event] play by human via voice: ход 1 B D4 ...`, `[event] engine by engine: ход 2 W ...`, агент называет ход; `/board` печатает ascii-доску с двумя камнями; `кто впереди` → `[event]`-строк нет (analyze событий не шлёт), агент отвечает без лучшего хода. Каждая реплика агента печатается ровно один раз (с задержкой ~0.5 с после конца потока), растущих префиксов нет даже когда в той же комнате говорит телефон. `Ctrl+C` → `[OK] сессия закрыта`, код 0.

Run (сценарный прогон без клавиатуры): `echo 'дэ четыре' | npm run chat`
Expected: ответ агента на последнюю фразу успевает напечататься (скрипт ждёт тишины, а не рвёт комнату по EOF), затем `[OK] сессия закрыта`, код 0. При зависшем агенте — `[!] тишины не дождался за 60 с...` и следом диагностика потери: `[!] сегмент SG_... не подтверждён, недопечатано: ...` для дочитанного сегмента, `[!] сегмент SG_... поток не закрыт, недопечатано: ...` для зависшего потока с текстом, `[!] открытых потоков: N, хвост реплики не получен` — если текста не пришло вовсе. Молчания на этом пути быть не должно.

Run (проверка диагностики без сети, на заведомо неверных данных LiveKit): ожидается `[X] не удалось подключиться к LiveKit; проверьте настройки сессии и воркер`, код 1; адреса, стека и текста ошибки библиотеки в выводе нет.

Без VPS живые шаги пропускаются и отмечаются в `docs/NOW.md` как `[TODO founder]` проверка.

- [ ] **Step 7: Commit**

```bash
git add scripts/chat.mjs scripts/chat.test.ts package.json package-lock.json
git commit -m "scripts: chat — текстовый диалог с Гоко в комнате LiveKit, режим чата"
```

---
### Task 6: `web` — каркас Vite, геометрия доски, лента, поток событий, тексты, настройки и чат

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/vite-env.d.ts`, `apps/web/src/main.tsx` (заглушка входа для проверки сборки; задача 8 заменяет её), `apps/web/src/geometry.ts`, `apps/web/src/transcript.ts`, `apps/web/src/stream.ts`, `apps/web/src/text.ts`, `apps/web/src/prefs.ts`, `apps/web/src/chat.ts`
- Modify: `package.json` (корень: `typecheck` с веб-конфигом, скрипт `build:web`)
- Test: `apps/web/src/geometry.test.ts`, `apps/web/src/transcript.test.ts`, `apps/web/src/stream.test.ts`, `apps/web/src/text.test.ts`, `apps/web/src/prefs.test.ts`, `apps/web/src/chat.test.ts`

**Interfaces:**
- Consumes: `formatCoord`, `type Point` из `@goko/go-core`; `ApiError`, `ClientTimeoutError`, `HttpError`, `GameEvent`, `GameState`, `GokoClient`, `CallOptions`, `createClient`, `Color`, `Rank`, `RANKS`, `NewGameRequest`, `humanText`, `seatColor`, `hasEngine`, `humanColorOf`, `retryAfterMs`, `RETRY_MS`, `STABLE_CONNECTION_MS` из `@goko/protocol` (`seatColor`, `hasEngine`, `humanColorOf` и паузы добавляет задача 1; своих копий веб не заводит). Пакеты отдают `exports` на `.ts` (`"."` и `"./testing"`); веб импортирует только `"."`.
- Produces: `VIEW = 1000`; `type Layout = { size; step; margin }`; `layout(size): Layout`; `x(l, col)`, `y(l, row)`; `pointAt(l, px, py): Point | null`; `coordAt(p): string`; `hoshi(size): Point[]`; `type Stone = { col; row; color }`; `stones(board, size): Stone[]`; `indexOf(p, size): number`. `type Who = 'me' | 'goko'`; `type Line = { id; who; text; final }`; `MAX_LINES = 200`; `upsertLine(lines, line): Line[]`; `whoOf(attrs, myTrackSids, senderIdentity, myIdentity): Who`; `lineId(attrs, streamId): string`; `acceptLine(attrs, who): boolean`. `streamEvents(client, sessionId, signal, handlers, sleep?, now?): StreamHandle`, `type StreamHandle = { done: Promise<void>; reopen(): void }` (`reopen` раньше `Retry-After` ничего не делает; паузы по `RETRY_MS`, сброс после соединения, прожившего `STABLE_CONNECTION_MS`, — оба из `@goko/protocol`), `type StreamHandlers = { onEvent; onConnected?; onLost }`, `needsRetry(prev: boolean, ev: GameEvent): boolean`. `describeError(e): string` (`ApiError` → `humanText(code, details)`, `ClientTimeoutError` → «сервер не отвечает», остальное → `NETWORK_TEXT` «нет связи с сервером»); `retryDelayMs(e): number` (мс до следующего запроса после `rate_limited` — `retryAfterMs(e.details)` из `@goko/protocol`, иначе 0); `TIMEOUT_NOT_APPLIED_TEXT = 'сервер не отвечает: ход пока не записан'`; `sendTapMove(client: Pick<GokoClient, 'getGame'>, before: GameState, send: (o: CallOptions) => Promise<unknown>, o?: CallOptions): Promise<{ state: GameState; text: string | null } | null>` (таймаут клиента на ходе или пасе тапом — без повтора, перечитывание партии; `null` — ответ пришёл; `text` — только при той же ревизии); `resultText(g): string`; `statusText(g, thinking): string`; `capturesText(g)`, `rankText(g)`. `type Mode = 'voice' | 'chat'`; `type ColorChoice = 'black' | 'white' | 'random'`; `type Prefs = { mode; color; rank }`; `PREFS_KEY = 'goko.prefs'`, `MODE_ATTRIBUTE = 'goko.mode'`, `DEFAULT_PREFS`, `DEFAULT_KOMI = 7.5`; `loadPrefs(storage: () => Pick<Storage, 'getItem'>): Prefs`; `savePrefs(storage: () => Pick<Storage, 'setItem'>, prefs): boolean`; `stepRank(rank, delta): Rank`; `newGameRequest(prefs, current: GameState | null, random?): NewGameRequest`; `modeAttributes(mode): Record<string, string>`. `CHAT_MAX_CHARS = 500`; `type ChatDeps = { send(text): Promise<unknown>; id(): string }`; `type ChatResult = { draft; line: Line | null; error: string | null }`; `sendChat(draft, deps): Promise<ChatResult>`; `agentReady(attrs?): boolean`.

- [ ] **Step 1: Файлы конфигурации**

`apps/web/package.json`:

```json
{
  "name": "@goko/web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1 --port 5173 --strictPort",
    "build": "vite build",
    "preview": "vite preview --host 127.0.0.1 --port 5173"
  },
  "dependencies": {
    "@goko/go-core": "*",
    "@goko/protocol": "*",
    "livekit-client": "^2.22.3",
    "react": "^19.2.8",
    "react-dom": "^19.2.8"
  },
  "devDependencies": {
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.7",
    "@vitejs/plugin-react": "^6.1.1",
    "vite": "^8.2.2"
  }
}
```

`apps/web/tsconfig.json` (свой: DOM, JSX, bundler; корневой `tsconfig.json` исключает `apps/web/**`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "types": ["vite/client", "node"],
    "noEmit": true
  },
  "include": ["src", "vite.config.ts"]
}
```

`apps/web/vite.config.ts`:

```ts
// APP_KEY из корневого .env попадает в бандл как VITE_APP_KEY (телефон шлёт его в X-App-Key) — так задумано
// спекой; других переменных .env в бандле нет. В dev /api проксируется в game-server.
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_APP_KEY': JSON.stringify(env.APP_KEY ?? ''),
      'import.meta.env.VITE_API_BASE': JSON.stringify(env.VITE_API_BASE ?? ''),
    },
    server: {
      proxy: { '/api': { target: `http://127.0.0.1:${env.PORT ?? '8787'}` } },
    },
    build: { outDir: 'dist', sourcemap: false },
  };
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>Гоко</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_KEY: string;
  readonly VITE_API_BASE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

Корневой `package.json`: `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p apps/web/tsconfig.json --noEmit"`, добавить `"build:web": "npm run build --workspace apps/web"`. Затем `npm install`. Нужна сеть: `react`, `react-dom`, `livekit-client`, `@vitejs/plugin-react` в `package-lock.json` ещё нет, их версии офлайн не проверить. При `ETARGET` взять ближайшую опубликованную версию той же мажорной линии и записать её в отчёт задачи.

- [ ] **Step 2: Тесты**

`apps/web/src/geometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { coordAt, hoshi, indexOf, layout, pointAt, stones, x, y } from './geometry.ts';

describe('geometry 13x13', () => {
  const l = layout(13);
  it('каждый пункт попадает сам в себя', () => {
    for (let col = 0; col < 13; col++) {
      for (let row = 0; row < 13; row++) {
        expect(pointAt(l, x(l, col), y(l, row))).toEqual({ col, row });
      }
    }
  });
  it('тап рядом с пунктом (0,45 шага) прилипает к нему, в том числе на краях и в углах', () => {
    const d = l.step * 0.45;
    expect(pointAt(l, x(l, 0) - d, y(l, 0) + d)).toEqual({ col: 0, row: 0 }); // A1: левее и ниже
    expect(pointAt(l, x(l, 12) + d, y(l, 12) - d)).toEqual({ col: 12, row: 12 }); // N13: правее и выше
    expect(pointAt(l, x(l, 3) + d, y(l, 3) - d)).toEqual({ col: 3, row: 3 });
  });
  it('тап в полях за полшага от крайней линии — мимо', () => {
    expect(pointAt(l, 0, 0)).toBeNull();
    expect(pointAt(l, l.margin * 0.4, y(l, 0))).toBeNull();
    expect(pointAt(l, x(l, 12) + l.step * 0.6, y(l, 0))).toBeNull();
    expect(pointAt(l, x(l, 0), y(l, 0) + l.step * 0.6)).toBeNull();
  });
  it('координаты и индексы совпадают с протоколом', () => {
    expect(coordAt({ col: 3, row: 3 })).toBe('D4');
    expect(coordAt({ col: 12, row: 12 })).toBe('N13');
    expect(coordAt({ col: 0, row: 0 })).toBe('A1');
    expect(indexOf({ col: 3, row: 3 }, 13)).toBe(42);
  });
  it('хоси', () => {
    expect(hoshi(13)).toHaveLength(5);
    expect(hoshi(13)).toContainEqual({ col: 6, row: 6 });
    expect(hoshi(9)).toHaveLength(5);
    expect(hoshi(19)).toHaveLength(9);
  });
  it('камни из строки board', () => {
    const board = '.B.W' + '.'.repeat(13 * 13 - 4);
    expect(stones(board, 13)).toEqual([
      { col: 1, row: 0, color: 'B' },
      { col: 3, row: 0, color: 'W' },
    ]);
  });
});
```

`apps/web/src/transcript.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { type Line, MAX_LINES, acceptLine, lineId, upsertLine, whoOf } from './transcript.ts';

const line = (id: string, text: string, who: 'me' | 'goko' = 'goko', final = true): Line => ({ id, who, text, final });

describe('upsertLine', () => {
  it('добавляет новые и заменяет по id (потоковая реплика дописывается)', () => {
    let lines = upsertLine([], line('a', 'При', 'goko', false));
    lines = upsertLine(lines, line('a', 'Привет', 'goko', true));
    lines = upsertLine(lines, line('b', 'дэ четыре', 'me'));
    expect(lines).toEqual([line('a', 'Привет'), line('b', 'дэ четыре', 'me')]);
  });
  it('хранит не больше MAX_LINES последних', () => {
    let lines: Line[] = [];
    for (let i = 0; i < MAX_LINES + 5; i++) lines = upsertLine(lines, line(`l${i}`, String(i)));
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines[0]?.id).toBe('l5');
  });
});

describe('whoOf / lineId', () => {
  const mine = new Set(['TR_mic']);
  it('транскрипт моего трека — я; речь агента — Гоко', () => {
    expect(whoOf({ 'lk.transcribed_track_id': 'TR_mic' }, mine, 'agent-1', 'phone-s1')).toBe('me');
    expect(whoOf({ 'lk.transcribed_track_id': 'TR_agent' }, mine, 'agent-1', 'phone-s1')).toBe('goko');
    expect(whoOf({}, mine, 'agent-1', 'phone-s1')).toBe('goko');
    expect(whoOf({}, mine, 'phone-s1', 'phone-s1')).toBe('me');
  });
  it('id строки — сегмент, иначе id потока', () => {
    expect(lineId({ 'lk.segment_id': 'SG_1' }, 'ST_9')).toBe('SG_1');
    expect(lineId({}, 'ST_9')).toBe('ST_9');
  });
});

describe('acceptLine (D-0011: лента — диалог без дублей)', () => {
  it('реплику Гоко берёт всегда, реплику человека — только финальный сегмент', () => {
    expect(acceptLine({ 'lk.transcription_final': 'false' }, 'goko')).toBe(true);
    expect(acceptLine({}, 'goko')).toBe(true);
    expect(acceptLine({ 'lk.transcription_final': 'false' }, 'me')).toBe(false);
    expect(acceptLine({}, 'me')).toBe(false);
    expect(acceptLine({ 'lk.transcription_final': 'true' }, 'me')).toBe(true);
  });
  it('промежуточные куски человека отброшены, финал того же сегмента — одна строка', () => {
    const chunks: Array<[Record<string, string>, string]> = [
      [{ 'lk.segment_id': 'SG_7', 'lk.transcription_final': 'false' }, 'дэ'],
      [{ 'lk.segment_id': 'SG_7', 'lk.transcription_final': 'false' }, 'дэ чет'],
      [{ 'lk.segment_id': 'SG_7', 'lk.transcription_final': 'true' }, 'дэ четыре'],
      [{ 'lk.segment_id': 'SG_7', 'lk.transcription_final': 'true' }, 'дэ четыре'],
    ];
    let lines: Line[] = [];
    for (const [attrs, text] of chunks) {
      if (acceptLine(attrs, 'me')) lines = upsertLine(lines, { id: lineId(attrs, 'ST_x'), who: 'me', text, final: true });
    }
    expect(lines).toEqual([line('SG_7', 'дэ четыре', 'me')]);
  });
});
```

`apps/web/src/stream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError, type EventsTarget, type GameEvent, RETRY_MS, STABLE_CONNECTION_MS } from '@goko/protocol';
import { needsRetry, streamEvents } from './stream.ts';

// Живой поток, который ничего не шлёт и кончается только отменой своего сигнала — как fetch SSE.
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

describe('streamEvents', () => {
  it('отдаёт события, переподключается с паузой, останавливается по сигналу', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) {
          yield { type: 'session.game', gameId: 'g1' };
          throw new TypeError('network error');
        }
        yield { type: 'engine.thinking', gameId: 'g1', color: 'W' };
        abort.abort();
      },
    };
    const got: string[] = [];
    const conn: boolean[] = [];
    const slept: number[] = [];
    await streamEvents(client, 's1', abort.signal, { onEvent: (ev) => got.push(ev.type), onConnected: (c) => conn.push(c), onLost: () => got.push('LOST') }, async (ms) => void slept.push(ms), () => 0).done;
    expect(got).toEqual(['session.game', 'engine.thinking']);
    expect(conn).toEqual([true, false, true]);
    expect(slept).toEqual([RETRY_MS[0]]);
    expect(connects).toBe(2);
  });
  it('растит паузу 1, 2, 4, 8 с до потолка 15 с', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects < 8) throw new Error('down');
        yield { type: 'engine.thinking', gameId: 'g1', color: 'B' };
        abort.abort();
      },
    };
    const slept: number[] = [];
    await streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, async (ms) => void slept.push(ms), () => 0).done;
    expect(slept).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
  it('сбрасывает паузу только после соединения, прожившего 15 с, а не на первом событии', async () => {
    const abort = new AbortController();
    let t = 0;
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 4) {
          abort.abort();
          return;
        }
        if (connects === 3) t += STABLE_CONNECTION_MS;
        yield { type: 'session.game', gameId: 'g1' }; // sync и сразу обрыв — не повод сбрасывать паузу
        throw new TypeError('network error');
      },
    };
    const slept: number[] = [];
    await streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, async (ms) => void slept.push(ms), () => t).done;
    expect(slept).toEqual([1000, 2000, 1000]);
  });
  it('rate_limited: пауза по Retry-After, «Повторить» раньше срока не переоткрывает (D-0012)', async () => {
    const abort = new AbortController();
    let t = 0;
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) throw new ApiError('rate_limited', 'too many requests, retry in 30 s', { retryAfterSeconds: 30 });
        yield { type: 'session.game', gameId: 'g1' };
        abort.abort();
      },
    };
    const slept: number[] = [];
    // Управляемая пауза: тест ждёт её начала по сигналу, без реальных таймеров.
    let paused: () => void = () => {};
    const pauseStarted = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const handle = streamEvents(
      client,
      's1',
      abort.signal,
      { onEvent: () => {}, onLost: () => {} },
      (ms) => {
        slept.push(ms);
        paused();
        return new Promise<void>(() => {}); // пауза, которая сама не кончится
      },
      () => t,
    );
    await pauseStarted;
    expect(slept).toEqual([30_000]);
    handle.reopen(); // раньше Retry-After — ничего
    await Promise.resolve();
    expect(connects).toBe(1);
    t = 30_000;
    handle.reopen();
    await handle.done;
    expect(connects).toBe(2);
  });
  it('not_found — сессия истекла: onLost и выход без повторов', async () => {
    const abort = new AbortController();
    const client = {
      // eslint-disable-next-line require-yield
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        throw new ApiError('not_found', 'session not found');
      },
    };
    let lost = 0;
    await streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => lost++ }, async () => {}).done;
    expect(lost).toBe(1);
  });
  it('reopen на живом потоке (кнопка «Повторить», D-0006): закрывает соединение и сразу открывает новое', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(_target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) {
          yield { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'engine move retries exhausted' };
          await untilAborted(signal);
        }
        yield { type: 'session.game', gameId: 'g1' };
        abort.abort();
      },
    };
    const got: string[] = [];
    const conn: boolean[] = [];
    const slept: number[] = [];
    // Сигнал о первом событии вместо ожидания на реальных таймерах.
    let received: () => void = () => {};
    const firstEvent = new Promise<void>((resolve) => {
      received = resolve;
    });
    const onEvent = (ev: GameEvent) => {
      got.push(ev.type);
      received();
    };
    const handle = streamEvents(client, 's1', abort.signal, { onEvent, onConnected: (c) => conn.push(c), onLost: () => got.push('LOST') }, async (ms) => void slept.push(ms));
    await firstEvent;
    expect(got).toEqual(['error']);
    handle.reopen();
    await handle.done;
    expect(got).toEqual(['error', 'session.game']);
    expect(connects).toBe(2);
    expect(slept).toEqual([]);
    expect(conn).toEqual([true, true]);
  });
  it('reopen во время паузы между попытками не ждёт конца паузы', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) throw new TypeError('network error');
        yield { type: 'session.game', gameId: 'g1' };
        abort.abort();
      },
    };
    const slept: number[] = [];
    const handle = streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, (ms) => {
      slept.push(ms);
      handle.reopen();
      return new Promise<void>(() => {}); // пауза, которая сама не кончится
    });
    await handle.done;
    expect(slept).toEqual([RETRY_MS[0]]);
    expect(connects).toBe(2);
  });
  it('reopen после остановки ничего не делает', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(_target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        await untilAborted(signal);
      },
    };
    const handle = streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, async () => {});
    abort.abort();
    handle.reopen();
    await handle.done;
    expect(connects).toBe(1);
  });
});

describe('needsRetry', () => {
  it('«Повторить» видна после retries_exhausted и до следующего состояния партии', () => {
    const exhausted: GameEvent = { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'engine move retries exhausted' };
    const other: GameEvent = { type: 'error', gameId: 'g1', code: 'engine_unavailable', message: 'engine is down' };
    expect(needsRetry(false, exhausted)).toBe(true);
    expect(needsRetry(true, other)).toBe(true);
    expect(needsRetry(false, other)).toBe(false);
    expect(needsRetry(true, { type: 'engine.thinking', gameId: 'g1', color: 'W' })).toBe(true);
    expect(needsRetry(true, { type: 'session.game', gameId: 'g2' })).toBe(false);
  });
});
```

`apps/web/src/text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError, type CallOptions, ClientTimeoutError, type GameState, HttpError, humanText } from '@goko/protocol';
import {
  NETWORK_TEXT,
  TIMEOUT_NOT_APPLIED_TEXT,
  capturesText,
  describeError,
  rankText,
  resultText,
  retryDelayMs,
  sendTapMove,
  statusText,
} from './text.ts';

function game(over: Partial<GameState> = {}): GameState {
  return {
    id: 'g1',
    createdAt: 't',
    revision: 0,
    settings: { boardSize: 13, rules: 'chinese', komi: 7.5 },
    seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } },
    status: 'playing',
    toPlay: 'B',
    moves: [],
    board: '.'.repeat(169),
    captures: { B: 0, W: 0 },
    ko: null,
    consecutivePasses: 0,
    pendingEngineMove: false,
    ...over,
  };
}

describe('text', () => {
  it('describeError', () => {
    expect(describeError(new ApiError('not_your_turn', 'it is Goko to play', { toPlay: 'W' }))).toBe('сейчас не твой ход');
    expect(describeError(new ApiError('illegal_move', 'illegal move D4: ko', { reason: 'ko', coord: 'D4' }))).toBe('ко: сразу забрать нельзя');
    expect(describeError(new TypeError('Failed to fetch'))).toBe('нет связи с сервером');
    expect(describeError(new HttpError(502, 'Bad Gateway'))).toBe(NETWORK_TEXT);
  });
  it('describeError различает таймаут и потерю сети, берёт reason и scope из details', () => {
    expect(describeError(new ClientTimeoutError('play', 15_000))).toBe('сервер не отвечает');
    expect(describeError(new ApiError('rate_limited', 'too many requests', { retryAfterSeconds: 30 }))).toBe(humanText('rate_limited'));
    expect(describeError(new ApiError('too_many_games', 'limit of 3 unfinished games per client reached', { max: 3, scope: 'client' }))).toBe(
      humanText('too_many_games', { max: 3, scope: 'client' }),
    );
    expect(describeError(new ApiError('bad_request', 'seat is not controlled by a human', { reason: 'not_your_seat' }))).toBe('это не твой цвет');
    expect(describeError(new ApiError('bad_request', 'invalid body'))).toBe('запрос не по форме');
  });
  it('retryDelayMs: Retry-After только у rate_limited', () => {
    expect(retryDelayMs(new ApiError('rate_limited', 'too many requests', { retryAfterSeconds: 30 }))).toBe(30_000);
    expect(retryDelayMs(new ApiError('rate_limited', 'too many requests'))).toBe(1000);
    expect(retryDelayMs(new ApiError('engine_busy', 'engine is busy'))).toBe(0);
    expect(retryDelayMs(new TypeError('Failed to fetch'))).toBe(0);
  });
  // Фейковый клиент для перечитывания: отдаёт состояния по очереди, пишет чтения с сигналом.
  function reader(queue: Array<GameState | Error>) {
    const reads: Array<{ id: string; signal: AbortSignal | undefined }> = [];
    return {
      reads,
      getGame: async (id: string, o?: CallOptions): Promise<GameState> => {
        reads.push({ id, signal: o?.signal });
        const next = queue.shift();
        if (!next) throw new Error('лишнее чтение');
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }
  it('sendTapMove: ответ пришёл — null без чтения; ошибка сервера — наружу без чтения; отказ перечитывания — наружу; запрос не повторяется', async () => {
    const before = game({ revision: 3 });
    const c = reader([new TypeError('Failed to fetch')]);
    const signal = new AbortController().signal;
    let sent = 0;
    expect(await sendTapMove(c, before, async () => void sent++, { signal })).toBeNull();
    expect(c.reads).toEqual([]);
    const refuse = async () => {
      sent++;
      throw new ApiError('not_your_turn', 'it is Goko to play', { toPlay: 'W' });
    };
    await expect(sendTapMove(c, before, refuse, { signal })).rejects.toMatchObject({ code: 'not_your_turn' });
    expect(c.reads).toEqual([]);
    const timeout = async () => {
      sent++;
      throw new ClientTimeoutError('play', 15_000);
    };
    await expect(sendTapMove(c, before, timeout, { signal })).rejects.toThrow('Failed to fetch');
    expect(c.reads).toEqual([{ id: 'g1', signal }]);
    expect(sent).toBe(3);
  });
  it('sendTapMove: таймаут — партия перечитана тем же сигналом; ревизия та же — текст «ход пока не записан», сменилась — партия без текста', async () => {
    const before = game({ revision: 3 });
    const same = game({ revision: 3 });
    const moved = game({ revision: 5, toPlay: 'W', pendingEngineMove: true, moves: [{ n: 1, color: 'B', coord: 'D4', captured: 0, at: 't' }] });
    const c = reader([same, moved]);
    const signal = new AbortController().signal;
    let sent = 0;
    const timeout = async (o: CallOptions) => {
      sent++;
      expect(o.signal).toBe(signal);
      throw new ClientTimeoutError('play', 15_000);
    };
    expect(await sendTapMove(c, before, timeout, { signal })).toEqual({ state: same, text: TIMEOUT_NOT_APPLIED_TEXT });
    expect(TIMEOUT_NOT_APPLIED_TEXT).toBe('сервер не отвечает: ход пока не записан');
    expect(await sendTapMove(c, before, timeout, { signal })).toEqual({ state: moved, text: null });
    expect(sent).toBe(2);
    expect(c.reads).toEqual([
      { id: 'g1', signal },
      { id: 'g1', signal },
    ]);
  });
  it('statusText', () => {
    expect(statusText(null, false)).toBe('Партии нет: нажми «Новая партия» или попроси Гоко');
    expect(statusText(game(), false)).toBe('Ход 1, твой ход (чёрные)');
    expect(statusText(game({ toPlay: 'W', pendingEngineMove: true, moves: [{ n: 1, color: 'B', coord: 'D4', captured: 0, at: 't' }] }), false)).toBe('Ход 2, ход Гоко (белые)');
    expect(statusText(game({ toPlay: 'W', pendingEngineMove: true }), true)).toBe('Ход 1, Гоко думает (белые)');
    expect(statusText(game({ status: 'finished', result: { winner: 'B', margin: 3.5, reason: 'score' } }), false)).toBe('Победа твоя: +3,5');
  });
  it('resultText, capturesText, rankText', () => {
    expect(resultText(game({ status: 'finished', result: { winner: 'W', reason: 'resign' } }))).toBe('Победа Гоко: сдача');
    expect(resultText(game({ status: 'finished', result: { winner: 'W', margin: 12, reason: 'score' } }))).toBe('Победа Гоко: +12');
    expect(capturesText(game({ captures: { B: 3, W: 1 } }))).toBe('Пленные: чёрные 3, белые 1');
    expect(rankText(game())).toBe('Гоко 10k');
    expect(rankText(game({ seats: { B: { controller: 'engine' }, W: { controller: 'human' } } }))).toBe('Гоко');
  });
  it('человек против человека (D-0005): «ты» — тот, чей ход, победа по цвету', () => {
    const hvh = { B: { controller: 'human' as const }, W: { controller: 'human' as const } };
    const d4 = { n: 1, color: 'B' as const, coord: 'D4', captured: 0, at: 't' };
    expect(statusText(game({ seats: hvh, toPlay: 'W', moves: [d4] }), false)).toBe('Ход 2, ходят белые');
    expect(resultText(game({ seats: hvh, status: 'finished', result: { winner: 'B', reason: 'resign' } }))).toBe('Победа чёрных: сдача');
    expect(resultText(game({ seats: hvh, status: 'finished', result: { winner: 'W', margin: 2.5, reason: 'score' } }))).toBe('Победа белых: +2,5');
    expect(rankText(game({ seats: hvh }))).toBe('Два игрока');
  });
});
```

`apps/web/src/prefs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { GameState } from '@goko/protocol';
import { DEFAULT_PREFS, PREFS_KEY, loadPrefs, modeAttributes, newGameRequest, savePrefs, stepRank } from './prefs.ts';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string): string | null => data.get(k) ?? null,
    setItem: (k: string, v: string): void => void data.set(k, v),
  };
}

describe('prefs: хранение режима, цвета и ранга (D-0011)', () => {
  it('без записи — умолчания: Голос, чёрные, 10k', () => {
    expect(loadPrefs(() => memory())).toEqual({ mode: 'voice', color: 'black', rank: '10k' });
  });
  it('сохраняет и читает обратно', () => {
    const s = memory();
    expect(savePrefs(() => s, { mode: 'chat', color: 'random', rank: '3d' })).toBe(true);
    expect(loadPrefs(() => s)).toEqual({ mode: 'chat', color: 'random', rank: '3d' });
  });
  it('битый JSON и чужие значения — умолчание по каждому полю отдельно', () => {
    expect(loadPrefs(() => memory({ [PREFS_KEY]: '{oops' }))).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(() => memory({ [PREFS_KEY]: 'null' }))).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(() => memory({ [PREFS_KEY]: '7' }))).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(() => memory({ [PREFS_KEY]: JSON.stringify({ mode: 'video', color: 'white', rank: '30k' }) }))).toEqual({
      mode: 'voice',
      color: 'white',
      rank: '10k',
    });
  });
  it('исключение localStorage при чтении и записи не роняет страницу', () => {
    const denied = (): never => {
      throw new DOMException('The operation is insecure.', 'SecurityError'); // Safari с запретом данных сайта
    };
    expect(loadPrefs(denied)).toEqual(DEFAULT_PREFS);
    expect(savePrefs(denied, DEFAULT_PREFS)).toBe(false);
    const broken = {
      getItem: (): string | null => {
        throw new Error('storage is broken');
      },
    };
    expect(loadPrefs(() => broken)).toEqual(DEFAULT_PREFS);
    const full = {
      setItem: (): void => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(savePrefs(() => full, { mode: 'chat', color: 'white', rank: '5k' })).toBe(false);
  });
});

describe('prefs: новая партия только полями NewGameRequest', () => {
  it('человек чёрными, Гоко белыми выбранного ранга, ответ движка не ждём', () => {
    expect(newGameRequest({ mode: 'voice', color: 'black', rank: '5k' }, null)).toEqual({
      black: { controller: 'human' },
      white: { controller: 'engine', rank: '5k' },
      settings: { komi: 7.5 },
      waitForReply: false,
    });
  });
  it('белыми — места меняются; случайно — по жребию', () => {
    expect(newGameRequest({ ...DEFAULT_PREFS, color: 'white' }, null)).toMatchObject({
      black: { controller: 'engine', rank: '10k' },
      white: { controller: 'human' },
    });
    expect(newGameRequest({ ...DEFAULT_PREFS, color: 'random' }, null, () => 0.2).black).toEqual({ controller: 'human' });
    expect(newGameRequest({ ...DEFAULT_PREFS, color: 'random' }, null, () => 0.7).black).toEqual({ controller: 'engine', rank: '10k' });
  });
  it('размер доски и коми берёт у текущей партии', () => {
    const current = { settings: { boardSize: 9, rules: 'chinese', komi: 5.5 } } as const;
    expect(newGameRequest(DEFAULT_PREFS, current as unknown as GameState).settings).toEqual({ boardSize: 9, komi: 5.5 });
  });
  it('stepRank ходит по списку рангов и упирается в края', () => {
    expect(stepRank('10k', 1)).toBe('9k');
    expect(stepRank('1k', 1)).toBe('1d');
    expect(stepRank('1d', -1)).toBe('1k');
    expect(stepRank('20k', -1)).toBe('20k');
    expect(stepRank('9d', 1)).toBe('9d');
  });
  it('атрибут участника для режима', () => {
    expect(modeAttributes('chat')).toEqual({ 'goko.mode': 'chat' });
    expect(modeAttributes('voice')).toEqual({ 'goko.mode': 'voice' });
  });
});
```

`apps/web/src/chat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CHAT_MAX_CHARS, agentReady, sendChat } from './chat.ts';

function deps(fail = false) {
  const sent: string[] = [];
  return {
    sent,
    send: async (text: string) => {
      if (fail) throw new Error('not connected');
      sent.push(text);
    },
    id: () => 'chat-1',
  };
}

describe('sendChat — форма ввода режима «Чат» (D-0011)', () => {
  it('отправляет обрезанный текст, очищает поле и добавляет свою строку в ленту', async () => {
    const d = deps();
    expect(await sendChat('  дэ четыре  ', d)).toEqual({ draft: '', line: { id: 'chat-1', who: 'me', text: 'дэ четыре', final: true }, error: null });
    expect(d.sent).toEqual(['дэ четыре']);
  });
  it('пустое поле не отправляет', async () => {
    const d = deps();
    expect(await sendChat('   ', d)).toEqual({ draft: '', line: null, error: null });
    expect(d.sent).toEqual([]);
  });
  it('слишком длинный текст не отправляет и оставляет черновик', async () => {
    const d = deps();
    const long = 'а'.repeat(CHAT_MAX_CHARS + 1);
    expect(await sendChat(long, d)).toEqual({ draft: long, line: null, error: `слишком длинно: не больше ${CHAT_MAX_CHARS} знаков` });
    expect(d.sent).toEqual([]);
  });
  it('ошибка отправки оставляет черновик и говорит по-русски', async () => {
    expect(await sendChat('кто впереди', deps(true))).toEqual({ draft: 'кто впереди', line: null, error: 'не удалось отправить: нет связи с Гоко' });
  });
});

describe('agentReady', () => {
  it('агент готов, когда выставил lk.agent.state и уже не инициализируется', () => {
    expect(agentReady(undefined)).toBe(false);
    expect(agentReady({})).toBe(false);
    expect(agentReady({ 'lk.agent.state': 'initializing' })).toBe(false);
    expect(agentReady({ 'lk.agent.state': 'listening' })).toBe(true);
    expect(agentReady({ 'lk.agent.state': 'speaking' })).toBe(true);
  });
});
```

- [ ] **Step 3: Запустить тесты, убедиться, что падают**

Run: `npx vitest run apps/web`
Expected: FAIL — шесть модулей не найдены (`geometry`, `transcript`, `stream`, `text`, `prefs`, `chat`).

- [ ] **Step 4: `apps/web/src/geometry.ts`**

```ts
// Геометрия доски в координатах SVG (viewBox 0..VIEW по обеим осям). Пункт (col, row): col от A = 0,
// row 0 — строка «1» внизу, как в протоколе; индекс в строке board = row * size + col.
import { formatCoord, type Point } from '@goko/go-core';

export const VIEW = 1000;

export type Layout = { size: number; step: number; margin: number };

export function layout(size: number): Layout {
  const step = VIEW / (size + 1);
  return { size, step, margin: step };
}

export const x = (l: Layout, col: number): number => l.margin + col * l.step;
export const y = (l: Layout, row: number): number => l.margin + (l.size - 1 - row) * l.step;

// Ближайший пункт к точке касания. Дальше полушага от крайней линии — поля, тап не считается.
export function pointAt(l: Layout, px: number, py: number): Point | null {
  // `+ 0` убирает `-0` у левого края: Math.round(-0,45) = -0, а toEqual отличает -0 от 0.
  const col = Math.round((px - l.margin) / l.step) + 0;
  const row = l.size - 1 - Math.round((py - l.margin) / l.step) + 0;
  if (col < 0 || col >= l.size || row < 0 || row >= l.size) return null;
  return { col, row };
}

export const coordAt = (p: Point): string => formatCoord(p);

export const indexOf = (p: Point, size: number): number => p.row * size + p.col;

export function hoshi(size: number): Point[] {
  const edge = size >= 13 ? 3 : 2;
  const mid = (size - 1) / 2;
  const lines = size >= 15 ? [edge, mid, size - 1 - edge] : [edge, size - 1 - edge];
  const points: Point[] = [];
  for (const col of lines) for (const row of lines) points.push({ col, row });
  if (size < 15 && Number.isInteger(mid)) points.push({ col: mid, row: mid });
  return points;
}

export type Stone = { col: number; row: number; color: 'B' | 'W' };

export function stones(board: string, size: number): Stone[] {
  const out: Stone[] = [];
  for (let i = 0; i < board.length; i++) {
    const c = board[i];
    if (c === 'B' || c === 'W') out.push({ col: i % size, row: Math.floor(i / size), color: c });
  }
  return out;
}
```

- [ ] **Step 5: `apps/web/src/transcript.ts`**

```ts
// Лента диалога из текстовых потоков LiveKit (lk.transcription). Чистые функции без React.
export type Who = 'me' | 'goko';
export type Line = { id: string; who: Who; text: string; final: boolean };

export const MAX_LINES = 200;

// Потоковая реплика приходит кусками под одним id: заменяем строку, а не добавляем новую.
export function upsertLine(lines: readonly Line[], line: Line): Line[] {
  const i = lines.findIndex((l) => l.id === line.id);
  const next = i >= 0 ? lines.map((l, j) => (j === i ? line : l)) : [...lines, line];
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

// Транскрипт моей речи публикует агент с lk.transcribed_track_id = sid моего микрофона; свою речь агент
// помечает своим треком. Текст без трека от меня самого (lk.chat) — тоже «я».
export function whoOf(
  attrs: Readonly<Record<string, string>>,
  myTrackSids: ReadonlySet<string>,
  senderIdentity: string,
  myIdentity: string,
): Who {
  const trackId = attrs['lk.transcribed_track_id'];
  if (trackId) return myTrackSids.has(trackId) ? 'me' : 'goko';
  return senderIdentity === myIdentity ? 'me' : 'goko';
}

export const lineId = (attrs: Readonly<Record<string, string>>, streamId: string): string => attrs['lk.segment_id'] ?? streamId;

// Лента — диалог без дублей (D-0011). Реплика Гоко идёт дельта-потоком с lk.transcription_final навсегда 'false'
// (agents 1.8.0), поэтому её берём всегда и держим строку по сегменту. Реплика человека: каждый промежуточный
// результат STT — отдельный закрытый поток того же сегмента, атрибут у него честный; берём только финал.
export const acceptLine = (attrs: Readonly<Record<string, string>>, who: Who): boolean =>
  who === 'goko' || attrs['lk.transcription_final'] === 'true';
```

- [ ] **Step 6: `apps/web/src/stream.ts`**

```ts
// Поток событий сессии с переподключением. После обрыва сервер первым сообщением шлёт session.game и sync
// с полным состоянием — это и есть «get_game при переподключении» из раздела 10 спеки.
// reopen() — кнопка «Повторить» (D-0006): открытие потока сессии заново запускает серию повторов сервера
// после retries_exhausted. Живое соединение закрывается своим AbortController, пауза между попытками прерывается.
// Поток сессии несёт события только текущей партии; старую партию смотрят её собственным потоком events({ gameId }).
// Паузы RETRY_MS (1, 2, 4, 8, потолок 15 с) — общие с голосовым агентом, из @goko/protocol (задача 1). Сброс — только
// если соединение прожило STABLE_CONNECTION_MS: sync приходит первым событием и при обрыве сразу после него,
// сбрасывать на нём нельзя, иначе сервер, который принимает и тут же рвёт поток, получит переподключение раз в секунду.
// rate_limited (D-0012): пауза не короче Retry-After, и reopen() до этого срока ничего не делает.
import { ApiError, type GameEvent, type GokoClient, RETRY_MS, STABLE_CONNECTION_MS } from '@goko/protocol';
import { retryDelayMs } from './text.ts';

export type StreamHandlers = {
  onEvent: (ev: GameEvent) => void;
  onConnected?: (connected: boolean) => void;
  onLost: () => void; // сессия истекла (not_found): нужна новая
};

export type StreamHandle = { done: Promise<void>; reopen: () => void };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function streamEvents(
  client: Pick<GokoClient, 'events'>,
  sessionId: string,
  signal: AbortSignal,
  handlers: StreamHandlers,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
): StreamHandle {
  let conn: AbortController | null = null;
  let wake: (() => void) | null = null;
  let reopening = false;
  let blockedUntil = 0;
  signal.addEventListener('abort', () => wake?.(), { once: true });

  const reopen = (): void => {
    if (signal.aborted || reopening || now() < blockedUntil) return;
    reopening = true;
    conn?.abort();
    wake?.();
  };

  const done = (async () => {
    let attempt = 0;
    while (!signal.aborted) {
      const current = new AbortController();
      conn = current;
      const stop = () => current.abort();
      signal.addEventListener('abort', stop, { once: true });
      const openedAt = now();
      let wait = 0;
      try {
        let first = true;
        for await (const ev of client.events({ sessionId }, current.signal)) {
          if (first) {
            first = false;
            handlers.onConnected?.(true);
          }
          handlers.onEvent(ev);
        }
      } catch (e) {
        if (signal.aborted) return;
        if (!reopening && e instanceof ApiError && e.code === 'not_found') {
          handlers.onLost();
          return;
        }
        wait = retryDelayMs(e);
      } finally {
        signal.removeEventListener('abort', stop);
        conn = null;
      }
      if (signal.aborted) return;
      if (reopening) {
        reopening = false;
        attempt = 0;
        continue;
      }
      handlers.onConnected?.(false);
      if (now() - openedAt >= STABLE_CONNECTION_MS) attempt = 0;
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 15_000;
      blockedUntil = wait > 0 ? now() + wait : 0;
      // Промис пробуждения создаётся до вызова sleep: reopen() может прийти прямо из него.
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      await Promise.race([sleep(Math.max(wait, delay)), woken]);
      wake = null;
      if (reopening) {
        reopening = false;
        attempt = 0;
        continue;
      }
      attempt++;
    }
  })();

  return { done, reopen };
}

// Показывать ли «Повторить»: после error с кодом retries_exhausted — да, до следующего состояния партии
// (session.game или state.updated, в том числе sync после переоткрытия). Прочие события флаг не меняют.
export function needsRetry(prev: boolean, ev: GameEvent): boolean {
  if (ev.type === 'error') return ev.code === 'retries_exhausted' ? true : prev;
  if (ev.type === 'state.updated' || ev.type === 'session.game') return false;
  return prev;
}
```

- [ ] **Step 7: `apps/web/src/text.ts`**

```ts
// Тексты статуса и ошибок на экране. Позицию не интерпретируем: только поля состояния.
// hasEngine, humanColorOf и retryAfterMs — общие с голосовым агентом, из @goko/protocol (задача 1).
import {
  ApiError,
  type CallOptions,
  ClientTimeoutError,
  type Color,
  type GameState,
  type GokoClient,
  hasEngine,
  humanColorOf,
  humanText,
  retryAfterMs,
  seatColor,
} from '@goko/protocol';

export const NETWORK_TEXT = 'нет связи с сервером';
export const TIMEOUT_NOT_APPLIED_TEXT = 'сервер не отвечает: ход пока не записан';

// Ход или пас тапом (Global Constraints, «Клиент протокола»). ClientTimeoutError не значит, что хода нет: сервер
// мог записать его, а ответ не дошёл. Запрос не повторяется, партия перечитывается. null — ответ пришёл, состояние
// придёт потоком; иначе — перечитанная партия и текст, если ревизия та же, что до тапа. Запрос с expectedRevision
// ещё может записаться позже, поэтому текст говорит «пока». Прочие ошибки и отказ перечитывания — наружу.
export async function sendTapMove(
  client: Pick<GokoClient, 'getGame'>,
  before: GameState,
  send: (o: CallOptions) => Promise<unknown>,
  o: CallOptions = {},
): Promise<{ state: GameState; text: string | null } | null> {
  try {
    await send(o);
    return null;
  } catch (e) {
    if (!(e instanceof ClientTimeoutError)) throw e;
  }
  const state = await client.getGame(before.id, o);
  return { state, text: state.revision === before.revision ? TIMEOUT_NOT_APPLIED_TEXT : null };
}

export function describeError(e: unknown): string {
  // Текст для человека — по code и details, message сервера английский (D-0007). details несут reason
  // (bad_request: not_your_seat, sessionless_disabled) и scope (too_many_games) — фразу выбирает humanText.
  if (e instanceof ApiError) return humanText(e.code, e.details);
  // Таймаут клиента — сервер достижим, но молчит; всё прочее (TypeError fetch, HttpError от прокси) — связи нет.
  if (e instanceof ClientTimeoutError) return humanText(e.code);
  return NETWORK_TEXT;
}

// Сколько не слать запросы после rate_limited (D-0012): details.retryAfterSeconds, без него — секунда.
// Для прочих ошибок 0: паузу выбирает вызывающий.
export function retryDelayMs(e: unknown): number {
  if (!(e instanceof ApiError) || e.code !== 'rate_limited') return 0;
  return retryAfterMs(e.details);
}

const colorName = (c: Color) => (c === 'B' ? 'чёрные' : 'белые');
const colorGenitive = (c: Color) => (c === 'B' ? 'чёрных' : 'белых');
const margin = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

export function resultText(g: GameState): string {
  const r = g.result;
  if (!r) return 'Партия окончена';
  const who = !hasEngine(g) ? `Победа ${colorGenitive(r.winner)}` : r.winner === humanColorOf(g) ? 'Победа твоя' : 'Победа Гоко';
  return r.reason === 'resign' ? `${who}: сдача` : `${who}: +${margin(r.margin ?? 0)}`;
}

export function statusText(g: GameState | null, thinking: boolean): string {
  if (!g) return 'Партии нет: нажми «Новая партия» или попроси Гоко';
  if (g.status === 'finished') return resultText(g);
  const n = g.moves.length + 1;
  if (!hasEngine(g)) return `Ход ${n}, ходят ${colorName(g.toPlay)}`;
  const whose = g.toPlay === humanColorOf(g) ? 'твой ход' : thinking ? 'Гоко думает' : 'ход Гоко';
  return `Ход ${n}, ${whose} (${colorName(g.toPlay)})`;
}

export const capturesText = (g: GameState): string => `Пленные: чёрные ${g.captures.B}, белые ${g.captures.W}`;

export function rankText(g: GameState): string {
  const engine = seatColor(g.seats, 'engine');
  if (!engine) return 'Два игрока';
  const rank = g.seats[engine].rank;
  return rank ? `Гоко ${rank}` : 'Гоко';
}
```

- [ ] **Step 8: `apps/web/src/prefs.ts`**

```ts
// Настройки телефона (D-0011): режим «Голос / Чат», цвет человека и ранг Гоко для «Новой партии».
// Хранятся в localStorage. storage передаётся функцией: в Safari с запретом данных сайта исключение бросает
// уже обращение к window.localStorage, а не только getItem/setItem. Любое исключение — работаем с умолчаниями.
// Форы в NewGameRequest нет: выбор только цвета и ранга, коми и размер доски — от текущей партии.
import { RANKS, Rank, type GameState, type NewGameRequest } from '@goko/protocol';

export type Mode = 'voice' | 'chat';
export type ColorChoice = 'black' | 'white' | 'random';
export type Prefs = { mode: Mode; color: ColorChoice; rank: Rank };

export const PREFS_KEY = 'goko.prefs';
export const MODE_ATTRIBUTE = 'goko.mode';
export const DEFAULT_PREFS: Prefs = { mode: 'voice', color: 'black', rank: '10k' };
export const DEFAULT_KOMI = 7.5;

const isMode = (v: unknown): v is Mode => v === 'voice' || v === 'chat';
const isColor = (v: unknown): v is ColorChoice => v === 'black' || v === 'white' || v === 'random';
const isRank = (v: unknown): v is Rank => Rank.safeParse(v).success;

export function loadPrefs(storage: () => Pick<Storage, 'getItem'>): Prefs {
  try {
    const raw = storage().getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed: unknown = JSON.parse(raw);
    const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { mode?: unknown; color?: unknown; rank?: unknown };
    return {
      mode: isMode(o.mode) ? o.mode : DEFAULT_PREFS.mode,
      color: isColor(o.color) ? o.color : DEFAULT_PREFS.color,
      rank: isRank(o.rank) ? o.rank : DEFAULT_PREFS.rank,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(storage: () => Pick<Storage, 'setItem'>, prefs: Prefs): boolean {
  try {
    storage().setItem(PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false; // приватный режим или квота: выбор живёт до перезагрузки
  }
}

// RANKS упорядочен от 20k к 9d: +1 — сильнее, -1 — слабее.
export function stepRank(rank: Rank, delta: number): Rank {
  const i = RANKS.indexOf(rank);
  return RANKS[Math.max(0, Math.min(RANKS.length - 1, i + delta))] ?? rank;
}

export function newGameRequest(prefs: Prefs, current: GameState | null, random: () => number = Math.random): NewGameRequest {
  const humanBlack = prefs.color === 'black' || (prefs.color === 'random' && random() < 0.5);
  const human = { controller: 'human' as const };
  const engine = { controller: 'engine' as const, rank: prefs.rank };
  return {
    black: humanBlack ? human : engine,
    white: humanBlack ? engine : human,
    settings: current ? { boardSize: current.settings.boardSize, komi: current.settings.komi } : { komi: DEFAULT_KOMI },
    waitForReply: false, // ответ движка придёт событием
  };
}

export const modeAttributes = (mode: Mode): Record<string, string> => ({ [MODE_ATTRIBUTE]: mode });
```

- [ ] **Step 9: `apps/web/src/chat.ts`**

```ts
// Режим «Чат» (D-0011): логика формы ввода без React и LiveKit. send — localParticipant.sendText в lk.chat;
// своя строка добавляется в ленту здесь, потому что lk.chat отправителю не возвращается.
import type { Line } from './transcript.ts';

export const CHAT_MAX_CHARS = 500;

export type ChatDeps = { send: (text: string) => Promise<unknown>; id: () => string };
export type ChatResult = { draft: string; line: Line | null; error: string | null };

export async function sendChat(draft: string, deps: ChatDeps): Promise<ChatResult> {
  const text = draft.trim();
  if (!text) return { draft: '', line: null, error: null };
  if (text.length > CHAT_MAX_CHARS) return { draft, line: null, error: `слишком длинно: не больше ${CHAT_MAX_CHARS} знаков` };
  try {
    await deps.send(text);
    return { draft: '', line: { id: deps.id(), who: 'me', text, final: true }, error: null };
  } catch {
    return { draft, line: null, error: 'не удалось отправить: нет связи с Гоко' };
  }
}

// Агент в комнате и слушает: атрибут lk.agent.state выставляет RoomIO @livekit/agents 1.8
// (initializing, idle, listening, thinking, speaking). До этого текст в lk.chat некому принять.
export function agentReady(attrs: Readonly<Record<string, string>> | undefined): boolean {
  const state = attrs?.['lk.agent.state'];
  return state !== undefined && state !== 'initializing';
}
```

- [ ] **Step 10: Тесты и typecheck зелёные**

Run: `npx vitest run apps/web && npm run typecheck`
Expected: все шесть файлов тестов проходят; `tsc -p apps/web/tsconfig.json` без ошибок (в `src` эти модули и заглушка `main.tsx` из шага 11; страница появится в задаче 8). Тесты `prefs` и `chat` не трогают `window`: storage и отправка передаются функциями, vitest остаётся в окружении `node`.

- [ ] **Step 11: Сборка Vite берёт пакеты workspace с `exports` на `.ts` и не тянет `./testing`**

`@goko/protocol` и `@goko/go-core` отдают исходники: `exports` `"."` → `./src/index.ts`, `"./testing"` → тестовые помощники (`fakeFetch`, `positionFromRows`). Node 22 в тестах их читает, а Vite должен сам транспилировать `.ts` из `node_modules/@goko/*` (симлинки workspace) и не включить `testing` в бандл. Проверяем сразу, до компонентов, чтобы задача 8 не упёрлась в сборку.

`apps/web/src/main.tsx` (заглушка; задача 8, шаг 3 заменяет файл целиком):

```tsx
// Заглушка входа (задача 6): сборка проверяет пакеты workspace с exports на .ts. Задача 8 заменяет файл страницей.
import { formatCoord } from '@goko/go-core';
import { createClient } from '@goko/protocol';
import { describeError } from './text.ts';

const client = createClient({ baseUrl: import.meta.env.VITE_API_BASE || location.origin, appKey: import.meta.env.VITE_APP_KEY });
const root = document.getElementById('root');
if (root) {
  root.textContent = `Гоко: ${formatCoord({ col: 3, row: 3 })}`;
  client.listGames().catch((e: unknown) => {
    root.textContent = describeError(e);
  });
}
```

Run (Git Bash):

```bash
npm run build --workspace apps/web
grep -l "client timeout: " apps/web/dist/assets/*.js && grep -l "point is outside the letters range" apps/web/dist/assets/*.js && echo "[OK] пакеты workspace в бандле"
grep -l -e "fakeFetch: no handlers provided" -e 'expected one of ".XO"' apps/web/dist/assets/*.js && echo "[X] testing попал в бандл" || echo "[OK] testing не в бандле"
# grep по рабочему дереву, а не git grep: файлы веба ещё не в индексе (git add — шаг 12). Код 1 — совпадений нет.
grep -rn -e "@goko/[a-z-]*/src/" -e "test-helpers" -e "@goko/[a-z-]*/testing" apps/web/src --include='*.ts' --include='*.tsx' --exclude='*.test.ts'; [ $? -eq 1 ] && echo "[OK] веб импортирует пакеты только через exports"
```

Expected: `vite build` без ошибок, `dist/index.html` и `dist/assets/*.js`; обе строки `[OK]` о пакетах и testing (первая — литералы из `ClientTimeoutError` и `formatCoord` пришли в бандл); третья `[OK]`. Литералы выбраны уникальные для файлов: `'has unexpected char'` не годится, он есть и в `board.ts`. Связанные пакеты workspace Vite считает исходниками проекта (путь после симлинка вне `node_modules`) и транспилирует их `.ts` сам. Если сборка всё же падает на `.ts` из пакета — остановиться и сообщить с текстом ошибки: `exports` пакетов менять не в этой задаче. `apps/web/dist` в `.gitignore` уже есть (корневой `dist/`); проверить `git status --short apps/web` — `dist` не виден.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/src/vite-env.d.ts apps/web/src/main.tsx apps/web/src/geometry.ts apps/web/src/geometry.test.ts apps/web/src/transcript.ts apps/web/src/transcript.test.ts apps/web/src/stream.ts apps/web/src/stream.test.ts apps/web/src/text.ts apps/web/src/text.test.ts apps/web/src/prefs.ts apps/web/src/prefs.test.ts apps/web/src/chat.ts apps/web/src/chat.test.ts
git commit -m "web: каркас Vite, геометрия доски, лента без дублей, поток событий с «Повторить», тексты, настройки и чат"
```

---

### Task 7: `web` — клиент, `useSession`, `useGame`

**Files:**
- Create: `apps/web/src/api.ts`, `apps/web/src/hooks/useSession.ts`, `apps/web/src/hooks/useGame.ts`

**Interfaces:**
- Consumes: `createClient`, `CreateSessionResponse`, `GameState`, `humanText`, `hasEngine`, `humanColorOf` (Task 1), `type CallOptions` (последний аргумент каждого метода клиента, `{ signal }`) из `@goko/protocol`; `retryDelayMs` из Task 6; `Room`, `RoomEvent`, `Track` из `livekit-client` 2.22 (`Room.connect`, `Room.startAudio`, `Room.disconnect`, `Room.registerTextStreamHandler`, `Room.remoteParticipants`, `LocalParticipant.setMicrophoneEnabled`, `LocalParticipant.setAttributes`, `LocalParticipant.sendText(text, { topic })`, `Participant.getTrackPublications()`, `RemoteTrackPublication.setSubscribed`, `Track.attach/detach`, `TextStreamReader.readAll()`); из Task 6: `upsertLine`, `whoOf`, `lineId`, `acceptLine`, `Line`, `streamEvents`, `StreamHandle`, `needsRetry`, `describeError`, `sendTapMove`, `loadPrefs`, `savePrefs`, `modeAttributes`, `newGameRequest`, `Prefs`, `Mode`, `sendChat`, `agentReady`.
- Produces: `client: GokoClient`; `useSession(): { session: Session | null; lines: Line[]; mic: MicState; link: LinkState; agent: boolean; prefs: Prefs; error: string | null; clearError(): void; activate(): Promise<void>; enableMic(): Promise<void>; setMode(mode: Mode): Promise<void>; updatePrefs(patch: Partial<Prefs>): void; sendText(draft: string): Promise<string>; reset(): void }`, `type MicState = 'off' | 'connecting' | 'on' | 'failed'`, `type LinkState = 'idle' | 'connecting' | 'connected' | 'failed'`; `useGame(sessionId: string | null, onLost: () => void): { state: GameState | null; gameId: string | null; thinking: boolean; connected: boolean; retry: boolean; message: string | null; play(coord): Promise<void>; pass(); resign(); undo(); newGame(prefs: Prefs): Promise<void>; reopen(): void }`.

- [ ] **Step 1: `apps/web/src/api.ts`**

```ts
// Один клиент протокола на страницу. VITE_API_BASE пустой — тот же origin (Caddy на VPS или прокси Vite в dev).
import { createClient } from '@goko/protocol';

export const client = createClient({
  baseUrl: import.meta.env.VITE_API_BASE || window.location.origin,
  appKey: import.meta.env.VITE_APP_KEY,
});
```

- [ ] **Step 2: `apps/web/src/hooks/useSession.ts`**

Как устроено (D-0001, D-0008, D-0011):

- Сессию создаёт `POST /api/sessions`; комнату с диспетчеризацией агента создаёт сервер там же. Веб комнат не создаёт: только `room.connect(url, token)` по токену из ответа. Ответ хранится в `sessionStorage`, чтобы перезагрузка страницы не плодила сессии.
- В комнату страница входит по первому касанию в любом месте (`activate`, вызывает `App`): `room.startAudio()` на iOS работает только из жеста, а агент открывает Realtime только после входа телефона. В «Голосе» тот же жест включает микрофон; кнопка «Микрофон» остаётся для повтора после отказа.
- Режим: сразу после входа и при каждом переключении — `localParticipant.setAttributes({ 'goko.mode': mode })`. Для этого токену нужно право `canUpdateOwnMetadata` (задача 5, шаг 1). Отказ атрибута не ломает страницу: в «Чате» веб всё равно отписывается от аудиотрека агента (запасной путь D-0011), а микрофон выключен.
- «Чат»: `setMicrophoneEnabled(false)`, аудиотреки агента `setSubscribed(false)`; текст — `sendText(text, { topic: 'lk.chat' })`, своя строка добавляется в ленту сразу. «Голос»: подписка обратно, `TrackSubscribed` прикрепляет `<audio>`, микрофон включается.
- Лента: реплику Гоко переписываем по сегменту с каждым куском, реплику человека добавляем один раз — финальный сегмент (`acceptLine`).
- `agent` — в комнате есть участник с атрибутом `lk.agent.state` не `initializing` (`agentReady`); пересчитывается по событиям входа, выхода и смены атрибутов, аргументы событий не используются.
- Токен LiveKit живёт TTL сессии от её создания (D-0008) и может истечь раньше продлённой сессии. Если вход в комнату не удался, страница забывает сохранённую сессию: партия продолжается тапами, а перезагрузка страницы создаст новую сессию с новым токеном.

```ts
// Сессия Гоко на телефоне: сессия через game-server (sessionStorage), комната LiveKit по её токену, режим
// «Голос / Чат» атрибутом goko.mode, микрофон, чат и лента диалога. Комнат страница не создаёт (D-0001).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { CreateSessionResponse } from '@goko/protocol';
import { client } from '../api.ts';
import { agentReady, sendChat } from '../chat.ts';
import { type Mode, type Prefs, loadPrefs, modeAttributes, savePrefs } from '../prefs.ts';
import { describeError } from '../text.ts';
import { type Line, acceptLine, lineId, upsertLine, whoOf } from '../transcript.ts';

const STORAGE_KEY = 'goko.session';

export type MicState = 'off' | 'connecting' | 'on' | 'failed';
export type LinkState = 'idle' | 'connecting' | 'connected' | 'failed';

// Функцией: в Safari с запретом данных сайта исключение бросает уже обращение к localStorage (prefs.ts ловит).
const local = () => localStorage;

function loadStored(): CreateSessionResponse | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = CreateSessionResponse.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function saveStored(res: CreateSessionResponse | null) {
  try {
    if (res) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(res));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // приватный режим без storage — просто не запоминаем
  }
}

function setRemoteAudio(room: Room, on: boolean) {
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.getTrackPublications()) {
      if (pub.kind === Track.Kind.Audio) pub.setSubscribed(on);
    }
  }
}

const chatLineId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function useSession() {
  const [info, setInfo] = useState<CreateSessionResponse | null>(loadStored);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [mic, setMic] = useState<MicState>('off');
  const [link, setLink] = useState<LinkState>('idle');
  const [agent, setAgent] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(local));
  const modeRef = useRef<Mode>(prefs.mode);
  const roomRef = useRef<Room | null>(null);
  const joining = useRef<Promise<Room | null> | null>(null);
  const creating = useRef(false);

  useEffect(() => {
    savePrefs(local, prefs);
  }, [prefs]);

  useEffect(() => {
    if (info || creating.current) return;
    creating.current = true;
    client
      .createSession()
      .then((res) => {
        saveStored(res);
        setInfo(res);
      })
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => {
        creating.current = false;
      });
  }, [info]);

  // Сессия истекла на сервере (SSE ответил not_found): комната тоже мертва — отключаемся и создаём новую.
  const reset = useCallback(() => {
    saveStored(null);
    const room = roomRef.current;
    roomRef.current = null;
    joining.current = null;
    void room?.disconnect();
    setMic('off');
    setLink('idle');
    setAgent(false);
    setLines([]);
    setInfo(null);
  }, []);

  const sendMode = useCallback(async (room: Room, mode: Mode) => {
    try {
      await room.localParticipant.setAttributes(modeAttributes(mode));
    } catch (e) {
      // Нет права canUpdateOwnMetadata или сервер не ответил: агент останется в прежнем режиме.
      console.warn('[!] web: не удалось выставить goko.mode', e);
    }
  }, []);

  // Вход в комнату, идемпотентный: повторные касания получают тот же промис.
  const connect = useCallback((): Promise<Room | null> => {
    if (!info) return Promise.resolve(null);
    if (joining.current) return joining.current;
    const room = new Room();
    const audioHost = document.getElementById('audio') ?? document.body;
    const refreshAgent = () => setAgent([...room.remoteParticipants.values()].some((p) => agentReady(p.attributes)));
    room.on(RoomEvent.TrackSubscribed, (track, publication) => {
      if (track.kind !== Track.Kind.Audio) return;
      if (modeRef.current === 'voice') audioHost.appendChild(track.attach());
      else publication.setSubscribed(false); // «Чат»: звук агента не принимаем (запасной путь D-0011)
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const el of track.detach()) el.remove();
    });
    room.on(RoomEvent.ParticipantConnected, refreshAgent);
    room.on(RoomEvent.ParticipantDisconnected, refreshAgent);
    room.on(RoomEvent.ParticipantAttributesChanged, refreshAgent);
    room.on(RoomEvent.Disconnected, () => {
      if (roomRef.current === room) roomRef.current = null;
      joining.current = null;
      setLink('idle');
      setMic('off');
      setAgent(false);
    });
    // Регистрировать до connect: первые реплики агента приходят сразу после входа.
    room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
      const attrs = reader.info.attributes ?? {};
      const id = lineId(attrs, reader.info.id);
      const mySids = new Set(room.localParticipant.getTrackPublications().map((p) => p.trackSid));
      const who = whoOf(attrs, mySids, participant?.identity ?? '', room.localParticipant.identity);
      if (who === 'me') {
        // Человек: промежуточные результаты STT — отдельные закрытые потоки того же сегмента; берём только финал.
        const text = await reader.readAll();
        if (acceptLine(attrs, who) && text.trim()) setLines((ls) => upsertLine(ls, { id, who, text, final: true }));
        return;
      }
      // Гоко: дельта-поток, lk.transcription_final у него навсегда 'false' (agents 1.8.0) — финал = дочитанный поток.
      let text = '';
      for await (const chunk of reader) {
        text += chunk;
        setLines((ls) => upsertLine(ls, { id, who, text, final: false }));
      }
      setLines((ls) => upsertLine(ls, { id, who, text, final: true }));
    });
    setLink('connecting');
    const joined = (async (): Promise<Room | null> => {
      try {
        await room.connect(info.livekit.url, info.livekit.token);
        await room.startAudio(); // iOS: воспроизведение только после жеста пользователя
        roomRef.current = room;
        await sendMode(room, modeRef.current);
        setLink('connected');
        refreshAgent();
        return room;
      } catch (e) {
        console.warn('[!] web: вход в комнату не удался', e);
        joining.current = null;
        void room.disconnect();
        // Токен мог истечь раньше продлённой сессии (D-0008): перезагрузка страницы создаст новую.
        saveStored(null);
        setLink('failed');
        setError('нет связи с Гоко: доска работает тапами, перезагрузи страницу, чтобы подключиться заново');
        return null;
      }
    })();
    joining.current = joined;
    return joined;
  }, [info, sendMode]);

  const enableMic = useCallback(async () => {
    const room = await connect();
    if (!room || modeRef.current !== 'voice') return;
    setMic('connecting');
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      setMic('on');
    } catch {
      setMic('failed');
      setError('не удалось включить микрофон: разреши его в браузере или переключись на «Чат»');
    }
  }, [connect]);

  // Первое касание страницы: вход в комнату; в «Голосе» — ещё и микрофон.
  const activate = useCallback(async () => {
    if (modeRef.current === 'voice') await enableMic();
    else await connect();
  }, [connect, enableMic]);

  const setMode = useCallback(
    async (mode: Mode) => {
      modeRef.current = mode;
      setPrefs((p) => ({ ...p, mode }));
      const room = await connect();
      if (!room) return;
      await sendMode(room, mode);
      if (mode === 'chat') {
        try {
          await room.localParticipant.setMicrophoneEnabled(false);
        } catch {
          // микрофона и не было
        }
        setMic('off');
        setRemoteAudio(room, false);
      } else {
        setRemoteAudio(room, true);
        await enableMic();
      }
    },
    [connect, sendMode, enableMic],
  );

  const updatePrefs = useCallback((patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })), []);

  // Отправка из поля ввода «Чата». Возвращает, что оставить в поле: '' после успеха, черновик при ошибке.
  const sendText = useCallback(
    async (draft: string): Promise<string> => {
      const room = await connect();
      if (!room) return draft;
      const res = await sendChat(draft, {
        send: (text) => room.localParticipant.sendText(text, { topic: 'lk.chat' }),
        id: chatLineId,
      });
      const line = res.line;
      if (line) setLines((ls) => upsertLine(ls, line));
      if (res.error) setError(res.error);
      return res.draft;
    },
    [connect],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    session: info?.session ?? null,
    lines,
    mic,
    link,
    agent,
    prefs,
    error,
    clearError,
    activate,
    enableMic,
    setMode,
    updatePrefs,
    sendText,
    reset,
  };
}
```

`[!]` Сверить с установленной `livekit-client` 2.22 на шаге 4 (typecheck). По документации (context7, `/livekit/client-sdk-js`) подтверждены `setAttributes`, `sendText(text, { topic })`, `registerTextStreamHandler`, `setMicrophoneEnabled`, `startAudio`, `RemoteTrackPublication.setSubscribed`, `RoomEvent.TrackSubscribed`. Не подтверждены сигнатура `RoomEvent.ParticipantAttributesChanged` и `TextStreamReader.readAll()`: код не читает аргументы события, а если `readAll` нет — дочитать поток циклом `for await` и склеить куски. Если `getTrackPublications()` у участника называется иначе — взять публикации из `trackPublications` (Map). Если `setSubscribed(false)` на треке агента не сработает, запасной путь второго уровня — не прикреплять `<audio>` в «Чате» и при переключении снимать уже прикреплённые элементы (`track.detach()`): звук тогда приходит, но не играет.

- [ ] **Step 3: `apps/web/src/hooks/useGame.ts`**

```ts
// Партия на экране: состояние из SSE сессии, действия тапами через тот же протокол, что и голос.
// Проверка «чей ход» — только по полям состояния; правил го здесь нет.
// Поток сессии несёт только текущую партию; engine.thinking и error чужой партии (гонка при смене партии) не показываем.
// Запросы идут с signal жизни компонента: после размонтирования ответ не трогает состояние и ошибку не показывает.
// rate_limited (D-0012): до Retry-After тапы запросов не шлют, а сразу показывают ту же фразу.
import { useCallback, useEffect, useRef, useState } from 'react';
import { type CallOptions, type GameState, hasEngine, humanColorOf, humanText } from '@goko/protocol';
import { client } from '../api.ts';
import { type Prefs, newGameRequest } from '../prefs.ts';
import { type StreamHandle, needsRetry, streamEvents } from '../stream.ts';
import { describeError, retryDelayMs, sendTapMove } from '../text.ts';

const MESSAGE_MS = 3000;

export function useGame(sessionId: string | null, onLost: () => void) {
  const [state, setState] = useState<GameState | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stream = useRef<StreamHandle | null>(null);
  const gameRef = useRef<string | null>(null);
  const blockedUntil = useRef(0);
  // Контроллер создаётся в эффекте, а не при первом рендере: StrictMode в dev монтирует дважды,
  // и контроллер, отменённый первой уборкой, иначе отменял бы все запросы второго монтирования.
  const life = useRef<AbortController | null>(null);

  useEffect(() => {
    const c = new AbortController();
    life.current = c;
    return () => c.abort();
  }, []);

  const flash = useCallback((text: string) => {
    setMessage(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), MESSAGE_MS);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const abort = new AbortController();
    stream.current = streamEvents(client, sessionId, abort.signal, {
      onConnected: setConnected,
      onLost,
      onEvent: (ev) => {
        if ((ev.type === 'engine.thinking' || ev.type === 'error') && ev.gameId !== gameRef.current) return;
        setRetry((r) => needsRetry(r, ev));
        switch (ev.type) {
          case 'session.game':
            gameRef.current = ev.gameId;
            setGameId(ev.gameId);
            break;
          case 'state.updated':
            gameRef.current = ev.state.id;
            setState(ev.state);
            setGameId(ev.state.id);
            setThinking(false);
            break;
          case 'engine.thinking':
            setThinking(true);
            break;
          case 'game.finished':
            setThinking(false);
            break;
          case 'error':
            setThinking(false);
            flash(humanText(ev.code)); // message события — английский текст для логов (D-0007)
            break;
        }
      },
    });
    return () => {
      abort.abort();
      stream.current = null;
    };
  }, [sessionId, onLost, flash]);

  // «Повторить» (D-0006): переоткрытие потока сессии заново запускает серию повторов сервера.
  const reopen = useCallback(() => {
    setRetry(false);
    stream.current?.reopen();
  }, []);

  // Ход человека — место того, чей черёд, у человека (в партии двух людей — всегда, D-0005).
  const humanTurn = Boolean(state && state.status === 'playing' && state.seats[state.toPlay].controller === 'human' && !state.pendingEngineMove);

  // Общая обёртка запроса: пауза после rate_limited, signal жизни компонента, текст ошибки через describeError
  // (таймаут клиента — «сервер не отвечает», потеря сети — «нет связи с сервером», коды — humanText).
  const request = useCallback(
    async (fn: (o: CallOptions) => Promise<unknown>) => {
      if (Date.now() < blockedUntil.current) return flash(humanText('rate_limited'));
      const signal = life.current?.signal;
      try {
        await fn({ signal });
      } catch (e) {
        if (signal?.aborted) return;
        const wait = retryDelayMs(e);
        if (wait > 0) blockedUntil.current = Date.now() + wait;
        flash(describeError(e));
      }
    },
    [flash],
  );

  // Действие над текущей партией. Без партии или после её конца — фраза без запроса; иначе fn получает
  // id партии и состояние уже проверенными, и действиям не нужны gameId! и state!.
  const act = useCallback(
    async (fn: (id: string, g: GameState, o: CallOptions) => Promise<unknown>, needTurn: boolean) => {
      if (!gameId || !state) return flash('партии ещё нет');
      if (state.status === 'finished') return flash('партия окончена');
      if (needTurn && !humanTurn) return flash(hasEngine(state) ? 'сейчас ход Гоко' : 'сейчас не твой ход');
      await request((o) => fn(gameId, state, o));
    },
    [gameId, state, humanTurn, flash, request],
  );

  // Ход и пас тапом. Таймаут клиента не значит, что ход не записан: запрос не повторяется, партия перечитывается
  // и рисуется как есть (sendTapMove); та же ревизия — ещё и фраза «ход пока не записан». Перечитанное состояние
  // не затирает более новое из потока и не рисуется, если текущая партия сессии уже другая.
  const tapMove = useCallback(
    (send: (id: string, revision: number, o: CallOptions) => Promise<unknown>) =>
      act(async (id, before, o) => {
        const reread = await sendTapMove(client, before, (opts) => send(id, before.revision, opts), o);
        if (!reread || gameRef.current !== reread.state.id) return;
        const actual = reread.state;
        setState((s) => (s && s.id === actual.id && s.revision > actual.revision ? s : actual));
        if (reread.text) flash(reread.text);
      }, true),
    [act, flash],
  );
  const play = useCallback(
    (coord: string) => tapMove((id, revision, o) => client.play(id, { coord, via: 'tap', expectedRevision: revision, waitForReply: false }, o)),
    [tapMove],
  );
  const pass = useCallback(() => tapMove((id, revision, o) => client.pass(id, { via: 'tap', expectedRevision: revision, waitForReply: false }, o)), [tapMove]);
  const undo = useCallback(() => act((id, _g, o) => client.undo(id, { via: 'tap' }, o), false), [act]);
  const resign = useCallback(() => act((id, g, o) => client.resign(id, { color: humanColorOf(g), via: 'tap' }, o), false), [act]);

  // «Новая партия» — цвет и ранг из выбора на экране (prefs), размер доски и коми от текущей партии.
  // Ответ движка ждать не надо: придёт событием, а Гоко прокомментирует новую партию сам.
  // Партии создаются только внутри сессии (D-0012): POST /api/games в prod выключен (задача 9).
  const newGame = useCallback(
    async (prefs: Prefs) => {
      if (!sessionId) return;
      await request((o) => client.newGame(sessionId, newGameRequest(prefs, state), o));
    },
    [sessionId, state, request],
  );

  return { state, gameId, thinking, connected, retry, message, play, pass, undo, resign, newGame, reopen };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: без ошибок. Расхождения с установленной `livekit-client` — по примечанию к шагу 2; тексты и логику страницы не менять.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/hooks/useSession.ts apps/web/src/hooks/useGame.ts
git commit -m "web: клиент протокола, useSession (комната, режим Голос/Чат, микрофон, чат, лента), useGame (SSE, «Повторить», тапы)"
```

---

### Task 8: `web` — компоненты, страница, стили, проверка в браузере

**Files:**
- Create: `apps/web/src/components/Board.tsx`, `apps/web/src/components/Transcript.tsx`, `apps/web/src/components/StatusBar.tsx`, `apps/web/src/components/Controls.tsx`, `apps/web/src/components/ModeSwitch.tsx`, `apps/web/src/components/NewGame.tsx`, `apps/web/src/components/ChatInput.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles.css`
- Modify: `apps/web/src/main.tsx` (заглушка задачи 6, шаг 11, заменяется целиком)

**Interfaces:**
- Consumes: `geometry.ts`, `transcript.ts`, `text.ts`, `prefs.ts` (`Mode`, `Prefs`, `ColorChoice`, `stepRank`), `chat.ts` (`CHAT_MAX_CHARS`), хуки Task 7; `COLUMN_LETTERS`, `parseCoord` из `@goko/go-core`; `GameState` из `@goko/protocol`.
- Produces: `Board({ state, size, onTap })`, `Transcript({ lines, mode })`, `StatusBar({ state, thinking, message, connected, retry, onRetry })`, `Controls({ mode, mic, canAct, onMic, onPass, onResign, onUndo })`, `ModeSwitch({ mode, onChange })`, `NewGame({ prefs, onChange, onStart })`, `ChatInput({ ready, onSend })`, `App()`; сборка `npm run build:web` → `apps/web/dist`.

- [ ] **Step 1: `apps/web/src/components/Board.tsx`**

```tsx
// Доска SVG (раздел 10 спеки): сетка, хоси, координаты по краям, камни, метка последнего хода;
// после счёта — территория и мёртвые камни из result.score. Тап -> ближайший пункт -> onTap(coord).
import { useRef } from 'react';
import type { MouseEvent } from 'react';
import { COLUMN_LETTERS, parseCoord } from '@goko/go-core';
import type { GameState } from '@goko/protocol';
import { VIEW, coordAt, hoshi, indexOf, layout, pointAt, stones, x, y } from '../geometry.ts';

type Props = { state: GameState | null; size: number; onTap: (coord: string) => void };

const TERRITORY_THRESHOLD = 0.6;

export function Board({ state, size, onTap }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const l = layout(size);
  const board = state?.board ?? '.'.repeat(size * size);
  const last = state?.moves.at(-1);
  const lastPoint = last && last.coord !== 'pass' ? parseCoord(last.coord, size) : null;
  const score = state?.status === 'finished' ? state.result?.score : undefined;
  const dead = new Set(score?.dead ?? []);
  const lineIdx = Array.from({ length: size }, (_, i) => i);

  const onClick = (e: MouseEvent<SVGSVGElement>) => {
    const svg = ref.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const p = pointAt(l, ((e.clientX - r.left) * VIEW) / r.width, ((e.clientY - r.top) * VIEW) / r.height);
    if (p) onTap(coordAt(p));
  };

  return (
    <svg ref={ref} className="board" viewBox={`0 0 ${VIEW} ${VIEW}`} onClick={onClick} role="img" aria-label="доска">
      <rect className="board-bg" width={VIEW} height={VIEW} />
      {lineIdx.map((i) => (
        <g key={i} className="grid">
          <line x1={x(l, i)} y1={y(l, 0)} x2={x(l, i)} y2={y(l, size - 1)} />
          <line x1={x(l, 0)} y1={y(l, i)} x2={x(l, size - 1)} y2={y(l, i)} />
          <text className="coord" x={x(l, i)} y={VIEW - l.margin * 0.3}>
            {COLUMN_LETTERS[i]}
          </text>
          <text className="coord" x={l.margin * 0.3} y={y(l, i)}>
            {i + 1}
          </text>
        </g>
      ))}
      {hoshi(size).map((p) => (
        <circle key={`h${p.col}-${p.row}`} className="hoshi" cx={x(l, p.col)} cy={y(l, p.row)} r={l.step * 0.1} />
      ))}
      {score &&
        lineIdx.flatMap((row) =>
          lineIdx.map((col) => {
            const v = score.ownership[indexOf({ col, row }, size)] ?? 0;
            if (Math.abs(v) < TERRITORY_THRESHOLD || board[indexOf({ col, row }, size)] !== '.') return null;
            return <rect key={`t${col}-${row}`} className={v > 0 ? 'territory-b' : 'territory-w'} x={x(l, col) - l.step * 0.18} y={y(l, row) - l.step * 0.18} width={l.step * 0.36} height={l.step * 0.36} />;
          }),
        )}
      {stones(board, size).map((s) => {
        const coord = coordAt({ col: s.col, row: s.row });
        return (
          <g key={coord}>
            <circle className={s.color === 'B' ? 'stone-b' : 'stone-w'} cx={x(l, s.col)} cy={y(l, s.row)} r={l.step * 0.47} />
            {dead.has(coord) && (
              <g className="dead">
                <line x1={x(l, s.col) - l.step * 0.25} y1={y(l, s.row) - l.step * 0.25} x2={x(l, s.col) + l.step * 0.25} y2={y(l, s.row) + l.step * 0.25} />
                <line x1={x(l, s.col) - l.step * 0.25} y1={y(l, s.row) + l.step * 0.25} x2={x(l, s.col) + l.step * 0.25} y2={y(l, s.row) - l.step * 0.25} />
              </g>
            )}
          </g>
        );
      })}
      {lastPoint && lastPoint !== 'pass' && (
        <circle className={last?.color === 'B' ? 'mark-on-b' : 'mark-on-w'} cx={x(l, lastPoint.col)} cy={y(l, lastPoint.row)} r={l.step * 0.16} />
      )}
    </svg>
  );
}
```

- [ ] **Step 2: `apps/web/src/components/Transcript.tsx`, `StatusBar.tsx`, `Controls.tsx`, `ModeSwitch.tsx`, `NewGame.tsx`, `ChatInput.tsx`**

```tsx
// Transcript.tsx — диалог «Ты / Гоко» (D-0011): реплики агента, финальные реплики человека и свои строки чата.
import { useEffect, useRef } from 'react';
import type { Mode } from '../prefs.ts';
import type { Line } from '../transcript.ts';

const EMPTY: Record<Mode, string> = {
  voice: 'Здесь будет диалог с Гоко. Коснись экрана и скажи «давай партию».',
  chat: 'Здесь будет диалог с Гоко. Напиши ему внизу, например «давай партию».',
};

export function Transcript({ lines, mode }: { lines: Line[]; mode: Mode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div ref={ref} className="transcript" aria-live="polite">
      {lines.length === 0 && <p className="muted">{EMPTY[mode]}</p>}
      {lines.map((l) => (
        <p key={l.id} className={`line line-${l.who}${l.final ? '' : ' line-partial'}`}>
          <span className="who">{l.who === 'me' ? 'Ты' : 'Гоко'}</span> {l.text}
        </p>
      ))}
    </div>
  );
}
```

```tsx
// StatusBar.tsx — чей ход, номер хода, ранг, пленные; при finished — результат; сообщения на 3 с;
// «Повторить» после retries_exhausted (D-0006): переоткрывает поток сессии.
import type { GameState } from '@goko/protocol';
import { capturesText, rankText, statusText } from '../text.ts';

type Props = { state: GameState | null; thinking: boolean; message: string | null; connected: boolean; retry: boolean; onRetry: () => void };

export function StatusBar({ state, thinking, message, connected, retry, onRetry }: Props) {
  return (
    <div className="status">
      <div className="status-row">
        <div className="status-main">{message ?? statusText(state, thinking)}</div>
        {retry && (
          <button type="button" className="btn btn-inline btn-accent" onClick={onRetry}>
            Повторить
          </button>
        )}
      </div>
      <div className="status-sub muted">
        {state ? `${rankText(state)} · ${capturesText(state)}` : ''}
        {!connected && state ? ' · нет связи, переподключаюсь' : ''}
      </div>
    </div>
  );
}
```

```tsx
// Controls.tsx — «Микрофон» крупно, только в «Голосе» (повтор после отказа; первое касание страницы включает его само),
// остальные мелко. Цели ≥ 44 px.
import { useEffect, useState } from 'react';
import type { MicState } from '../hooks/useSession.ts';
import type { Mode } from '../prefs.ts';

type Props = {
  mode: Mode;
  mic: MicState;
  canAct: boolean;
  onMic: () => void;
  onPass: () => void;
  onResign: () => void;
  onUndo: () => void;
};

const MIC_LABEL: Record<MicState, string> = { off: 'Микрофон', connecting: 'Подключаю…', on: 'Микрофон включён', failed: 'Микрофон: ещё раз' };

export function Controls({ mode, mic, canAct, onMic, onPass, onResign, onUndo }: Props) {
  const [armed, setArmed] = useState(false); // «Сдаться» — двумя касаниями за 3 с
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const resign = () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    onResign();
  };
  return (
    <div className="controls">
      {mode === 'voice' && (
        <button type="button" className="btn btn-mic" onClick={onMic} disabled={mic === 'connecting' || mic === 'on'}>
          {MIC_LABEL[mic]}
        </button>
      )}
      <div className="controls-row">
        <button type="button" className="btn" onClick={onPass} disabled={!canAct}>Пас</button>
        <button type="button" className="btn" onClick={resign} disabled={!canAct}>{armed ? 'Точно?' : 'Сдаться'}</button>
        <button type="button" className="btn" onClick={onUndo} disabled={!canAct}>Отменить</button>
      </div>
    </div>
  );
}
```

```tsx
// ModeSwitch.tsx — «Голос / Чат» (D-0011). Выбор хранит prefs.ts, атрибут goko.mode выставляет useSession.
import type { Mode } from '../prefs.ts';

const MODES: Array<[Mode, string]> = [
  ['voice', 'Голос'],
  ['chat', 'Чат'],
];

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div className="seg mode-switch" role="group" aria-label="режим">
      {MODES.map(([m, label]) => (
        <button key={m} type="button" className="btn seg-btn" aria-pressed={m === mode} onClick={() => m !== mode && onChange(m)}>
          {label}
        </button>
      ))}
    </div>
  );
}
```

```tsx
// NewGame.tsx — «Новая партия» (D-0011): перед стартом цвет человека и ранг Гоко тапом, выбор помнится (prefs.ts).
// Форы в NewGameRequest нет, поэтому здесь только цвет и ранг.
import { useState } from 'react';
import { type ColorChoice, type Prefs, stepRank } from '../prefs.ts';

type Props = { prefs: Prefs; onChange: (patch: Partial<Prefs>) => void; onStart: () => void };

const COLORS: Array<[ColorChoice, string]> = [
  ['black', 'Чёрные'],
  ['white', 'Белые'],
  ['random', 'Случайно'],
];

export function NewGame({ prefs, onChange, onStart }: Props) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Новая партия
      </button>
    );
  }
  return (
    <div className="newgame">
      <div className="muted">Ты играешь</div>
      <div className="seg" role="group" aria-label="цвет">
        {COLORS.map(([c, label]) => (
          <button key={c} type="button" className="btn seg-btn" aria-pressed={prefs.color === c} onClick={() => onChange({ color: c })}>
            {label}
          </button>
        ))}
      </div>
      <div className="muted">Уровень Гоко</div>
      <div className="rank-row">
        <button type="button" className="btn btn-square" aria-label="слабее" disabled={prefs.rank === '20k'} onClick={() => onChange({ rank: stepRank(prefs.rank, -1) })}>
          −
        </button>
        <div className="rank-value">{prefs.rank}</div>
        <button type="button" className="btn btn-square" aria-label="сильнее" disabled={prefs.rank === '9d'} onClick={() => onChange({ rank: stepRank(prefs.rank, 1) })}>
          +
        </button>
      </div>
      <div className="controls-row">
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => {
            setOpen(false);
            onStart();
          }}
        >
          Начать
        </button>
      </div>
    </div>
  );
}
```

```tsx
// ChatInput.tsx — поле ввода «Чата» (D-0011): Enter или «Отправить» -> lk.chat через useSession.sendText.
// Логика отправки и её тесты — chat.ts; до готовности агента кнопка выключена.
import { useState } from 'react';
import type { FormEvent } from 'react';
import { CHAT_MAX_CHARS } from '../chat.ts';

type Props = { ready: boolean; onSend: (draft: string) => Promise<string> };

export function ChatInput({ ready, onSend }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    try {
      setDraft(await onSend(draft));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="chat-input" onSubmit={(e) => void submit(e)}>
      <input
        className="chat-field"
        value={draft}
        readOnly={busy}
        maxLength={CHAT_MAX_CHARS}
        enterKeyHint="send"
        aria-label="сообщение Гоко"
        placeholder={ready ? 'Напиши Гоко' : 'Гоко подключается…'}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="btn btn-inline btn-accent" disabled={!ready || busy || !draft.trim()}>
        Отправить
      </button>
    </form>
  );
}
```

- [ ] **Step 3: `apps/web/src/App.tsx`, `apps/web/src/main.tsx`, `apps/web/src/styles.css`**

```tsx
// App.tsx — одна страница: режим, статус, доска, кнопки, новая партия, лента, поле чата.
// Без агента в комнате всё, кроме ленты и чата, работает тапами.
import { useRef } from 'react';
import type { PointerEvent } from 'react';
import { Board } from './components/Board.tsx';
import { ChatInput } from './components/ChatInput.tsx';
import { Controls } from './components/Controls.tsx';
import { ModeSwitch } from './components/ModeSwitch.tsx';
import { NewGame } from './components/NewGame.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Transcript } from './components/Transcript.tsx';
import { useGame } from './hooks/useGame.ts';
import { useSession } from './hooks/useSession.ts';

export function App() {
  const s = useSession();
  const g = useGame(s.session?.id ?? null, s.reset);
  const size = g.state?.settings.boardSize ?? 13;
  const activated = useRef(false);

  // Первое касание страницы: вход в комнату (startAudio на iOS — только из жеста), в «Голосе» ещё и микрофон.
  // Касание переключателя режима не считается: setMode сам входит в комнату и включает нужное.
  const onFirstTouch = (e: PointerEvent<HTMLDivElement>) => {
    if (activated.current || !s.session) return;
    if (e.target instanceof Element && e.target.closest('.mode-switch')) return;
    activated.current = true;
    void s.activate();
  };

  return (
    <div className="app" onPointerDownCapture={onFirstTouch}>
      <div className="top-row">
        <ModeSwitch mode={s.prefs.mode} onChange={(m) => void s.setMode(m)} />
      </div>
      <StatusBar state={g.state} thinking={g.thinking} message={g.message ?? s.error} connected={g.connected} retry={g.retry} onRetry={g.reopen} />
      <Board state={g.state} size={size} onTap={(coord) => void g.play(coord)} />
      <Controls
        mode={s.prefs.mode}
        mic={s.mic}
        canAct={g.state?.status === 'playing'}
        onMic={() => void s.enableMic()}
        onPass={() => void g.pass()}
        onResign={() => void g.resign()}
        onUndo={() => void g.undo()}
      />
      <NewGame prefs={s.prefs} onChange={s.updatePrefs} onStart={() => void g.newGame(s.prefs)} />
      <Transcript lines={s.lines} mode={s.prefs.mode} />
      {s.prefs.mode === 'chat' && <ChatInput ready={s.agent} onSend={s.sendText} />}
      <div id="audio" hidden />
    </div>
  );
}
```

`apps/web/src/main.tsx` — заменить заглушку задачи 6 целиком:

```tsx
// main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('web: нет #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/web/src/styles.css`:

```css
/* Несколько переменных, две темы по prefers-color-scheme, никаких библиотек (раздел 10 спеки). Цели касания ≥ 44 px. */
:root {
  --bg: #f4f1ea;
  --fg: #1d1a16;
  --muted: #6b665c;
  --panel: #ffffff;
  --board: #dcb35c;
  --line: #4a3a1a;
  --accent: #2f6f4f;
  --btn: #e8e3d8;
  --btn-fg: #1d1a16;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15130f;
    --fg: #ece7dc;
    --muted: #9a938a;
    --panel: #1f1c17;
    --board: #b98d3f;
    --line: #2b2110;
    --accent: #5fb58a;
    --btn: #2b2721;
    --btn-fg: #ece7dc;
  }
}
* { box-sizing: border-box; }
html, body, #root { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--fg); font: 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-tap-highlight-color: transparent; }
.app { display: flex; flex-direction: column; height: 100dvh; padding: env(safe-area-inset-top) 8px env(safe-area-inset-bottom); gap: 8px; }
.top-row { display: flex; justify-content: flex-end; padding-top: 6px; }
.status { padding: 0 4px; }
.status-row { display: flex; align-items: center; gap: 8px; }
.status-main { flex: 1; font-size: 18px; font-weight: 600; min-height: 26px; }
.status-sub { font-size: 14px; min-height: 20px; }
.muted { color: var(--muted); }
.board { width: min(100%, calc(100dvh - 380px)); max-width: 100%; aspect-ratio: 1; align-self: center; touch-action: manipulation; user-select: none; }
.board-bg { fill: var(--board); }
.grid line { stroke: var(--line); stroke-width: 2.5; }
.coord { fill: var(--line); font-size: 32px; text-anchor: middle; dominant-baseline: middle; }
.hoshi { fill: var(--line); }
.stone-b { fill: #111; stroke: #000; stroke-width: 1.5; }
.stone-w { fill: #f7f7f2; stroke: #555; stroke-width: 1.5; }
.mark-on-b { fill: none; stroke: #fff; stroke-width: 5; }
.mark-on-w { fill: none; stroke: #111; stroke-width: 5; }
.territory-b { fill: #111; opacity: 0.6; }
.territory-w { fill: #fff; opacity: 0.8; }
.dead line { stroke: #d33; stroke-width: 6; }
.controls { display: flex; flex-direction: column; gap: 8px; }
.controls-row { display: flex; gap: 8px; }
.btn { min-height: 44px; flex: 1; border: 0; border-radius: 10px; background: var(--btn); color: var(--btn-fg); font-size: 16px; padding: 0 10px; }
.btn:disabled { opacity: 0.45; }
.btn-mic { background: var(--accent); color: #fff; font-size: 18px; font-weight: 600; min-height: 52px; }
.btn-accent { background: var(--accent); color: #fff; font-weight: 600; }
.btn-inline { flex: 0 0 auto; }
.btn-square { flex: 0 0 44px; width: 44px; font-size: 22px; padding: 0; }
.seg { display: flex; gap: 4px; background: var(--btn); border-radius: 12px; padding: 3px; }
.seg-btn { background: transparent; min-width: 44px; }
.seg-btn[aria-pressed="true"] { background: var(--accent); color: #fff; font-weight: 600; }
.mode-switch { width: min(100%, 220px); }
.newgame { display: flex; flex-direction: column; gap: 6px; background: var(--panel); border-radius: 10px; padding: 8px; }
.rank-row { display: flex; align-items: center; gap: 8px; }
.rank-value { flex: 1; text-align: center; font-size: 18px; font-weight: 600; }
.transcript { flex: 1; min-height: 80px; overflow-y: auto; background: var(--panel); border-radius: 10px; padding: 8px 10px; }
.line { margin: 0 0 6px; }
.line .who { font-weight: 600; color: var(--muted); }
.line-me .who { color: var(--accent); }
.line-partial { opacity: 0.6; }
.chat-input { display: flex; gap: 8px; padding-bottom: 4px; }
/* 16px в поле ввода: iOS не увеличивает страницу при фокусе. */
.chat-field { flex: 1; min-width: 0; min-height: 44px; font-size: 16px; border-radius: 10px; border: 1px solid var(--muted); background: var(--panel); color: var(--fg); padding: 0 10px; }
```

- [ ] **Step 4: Typecheck и сборка**

Run: `npm run typecheck && npm run build:web`, затем три проверки бандла из задачи 6, шаг 11 (те же команды `grep`; импорт пакетов проверяется `grep -rn` по рабочему дереву — новые компоненты ещё не в индексе).
Expected: без ошибок; `apps/web/dist/index.html` и `apps/web/dist/assets/*.js` созданы. `dist/` уже в `.gitignore`. Проверки бандла снова `[OK]`: страница с `livekit-client` и хуками по-прежнему не тянет `@goko/protocol/testing` и `@goko/go-core/testing`.

- [ ] **Step 5: Проверка в браузере на ПК без агента** (бесплатно: без voice-agent и без Realtime; нужны LiveKit на VPS и `LIVEKIT_*` в `.env`)

По D-0001 `POST /api/sessions` создаёт комнату на сервере LiveKit, поэтому `.env` должен содержать `APP_KEY` и рабочие `LIVEKIT_*` (сервер LiveKit на VPS); с фиктивными значениями сессия не создаётся (`internal`), и страница без сессии не играет. Без LiveKit на VPS и `LIVEKIT_*` в `.env` шаг не выполняется: записать его `[TODO founder]` в `docs/NOW.md` (задача 11, шаг 5) и идти дальше. `npm run dev` здесь не подходит: он запускает и voice-agent `goko-dev`, который по первому касанию откроет платную сессию Realtime. Поэтому два процесса вручную, в двух терминалах Git Bash, без `cmd.exe`; `--env-file` не перекрывает переменные, заданные в команде, значения не печатаются:

Run:
```bash
FAKE_ENGINE=1 AGENT_NAME=goko-dev node --env-file=.env apps/game-server/src/main.ts
node node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 5173 --strictPort
```

Открыть `http://127.0.0.1:5173` (браузерная панель агента-разработчика или обычный браузер). Воркера `goko-dev` нет, поэтому комната остаётся без агента.

Expected, по шагам:
1. Статус «Партии нет: нажми «Новая партия» или попроси Гоко», пустая доска 13×13 с координатами A–N и 1–13, переключатель «Голос / Чат» с нажатым «Голос», кнопка «Микрофон», в ленте «Здесь будет диалог с Гоко. Коснись экрана и скажи «давай партию».».
2. Первое касание страницы → браузер спрашивает микрофон (разрешить) → «Микрофон включён». В DevTools → Application → Local Storage ключ `goko.prefs` уже записан с умолчаниями.
3. «Новая партия» → панель: «Ты играешь» с нажатыми «Чёрные», «Уровень Гоко» 10k. «+» → 9k, «−» → 10k, «+» → 9k. «Начать» → статус «Ход 1, твой ход (чёрные)», подпись «Гоко 9k · Пленные: чёрные 0, белые 0».
4. Тап на D4 → чёрный камень на D4 с меткой, через долю секунды белый ответ фейкового движка, статус «Ход 3, твой ход (чёрные)». Тап в занятый пункт → «точка занята» на 3 с; тап сразу после своего хода, пока думает движок, → «сейчас ход Гоко».
5. «Отменить» → оба камня исчезают. «Пас» → Гоко пасует в ответ (у фейкового движка `passAfterPass` по умолчанию), два паса подряд — автосчёт → статус «Победа …: +N». Второй «Пас» не нужен: партия уже окончена. Фейковый движок территорию не размечает (собственность только на камнях), заливки пустых пунктов нет, мёртвых камней нет.
6. «Новая партия» → «Белые» → «Начать» → движок ходит первым, статус «Ход 2, твой ход (белые)». «Сдаться» → «Точно?» → второе касание → «Победа Гоко: сдача».
7. «Чат» → кнопка «Микрофон» исчезает, внизу поле «Гоко подключается…» и выключенная «Отправить» (агента нет, `lk.agent.state` никто не выставил); доска и кнопки работают тапами. В консоли нет `[!] web: не удалось выставить goko.mode` — токен несёт `canUpdateOwnMetadata` (задача 5, шаг 1).
8. Перезагрузка страницы → та же сессия (sessionStorage), состояние партии пришло первым событием; режим «Чат», «Белые» и 9k сохранились (localStorage).
9. DevTools → Application → Local Storage → запретить или очистить хранилище сайта и перезагрузить → страница открывается с умолчаниями («Голос», «Чёрные», 10k), без ошибок в консоли.
10. Остановить game-server (Ctrl+C) → статус-подпись «нет связи, переподключаюсь»; запустить снова → не позже 15 с (паузы 1, 2, 4, 8, 15 с) новая сессия: SSE ответил `not_found`, страница создала сессию заново.
Лимит партий на клиента (D-0012) здесь не проверяется: его добавляет задача 9, ручная проверка страницей — её шаг 10.

«Повторить» здесь не проверяется: фейковый движок не исчерпывает повторы; механизм покрыт тестами `stream.test.ts`. Пауза до `Retry-After` тоже не проверяется руками: 60 запросов в минуту с одной страницы не набрать, поведение покрыто тестами `stream.test.ts` и `text.test.ts`. В консоли браузера — без ошибок, кроме отказов на шаге 10. На телефоне у доски проверяет founder после деплоя (задача 11).

- [ ] **Step 6: Проверка режимов с агентом** (платно: Realtime; только по явной просьбе founder'а в текущей сессии, правило 5 `CLAUDE.md`; платный прогон 4 из 5, пункты 1–3 — одна сессия, одна вкладка)

Run: `npm run dev` (запускает voice-agent `goko-dev`), открыть `http://127.0.0.1:5173`.
Expected:
1. «Чат» → поле «Напиши Гоко» и активная «Отправить» после входа агента. «давай партию» → своя строка «Ты: давай партию» сразу, ответ «Гоко: …» текстом в ленте, звука нет; в логе воркера `[OK] voice-agent: режим chat`.
2. Тап по доске → комментарий Гоко к ходу в ленте, без звука.
3. «Голос» → лог `[OK] voice-agent: режим voice`, микрофон включён; фраза «дэ четыре» появляется в ленте один раз («Ты: …»), ответ Гоко звучит и пишется в ленту; тап → комментарий вслух и в ленте.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components apps/web/src/App.tsx apps/web/src/main.tsx apps/web/src/styles.css
git commit -m "web: доска SVG, лента, статус с «Повторить», кнопки, режим Голос/Чат, новая партия с выбором цвета и ранга, поле чата"
```

---

### Task 9: `game-server` — прежняя партия сессии брошена при смене, не больше трёх незавершённых партий на клиента, партии без сессии только по флагу (R9, D-0012)

Блокер публичного деплоя (широкое ревью, R9). `APP_KEY` публичный (лежит в бандле), поэтому один адрес мог занять весь общий лимит 20 незавершённых партий, а `POST /api/games` создавал партии мимо `MAX_SESSIONS`. Отдельная задача, а не шаг задачи 5: правка затрагивает `packages/protocol`, сервис, хранилище снапшотов, приложение, запуск сервера, `smoke`, `dev`, D-0012 и разделы 5 и 7 спеки; у неё свой ревью и свой коммит, и она обязана лечь раньше compose (задача 10), где флаг выключен в prod. Задача 5 трогает `game-server` только правом токена — другая тема. Веб (задача 7), voice-agent (задача 2) и `scripts/chat.mjs` (задача 5) создают партии только через `POST /api/sessions/:sid/games` (`client.newGame`); `createGame` в коде плана не вызывается — проверка на шаге 9.

**Files:**
- Modify: `packages/protocol/src/human-text.ts`, `packages/protocol/src/human-text.test.ts`
- Modify: `apps/game-server/src/service.ts`, `apps/game-server/src/service.test.ts`
- Modify: `apps/game-server/src/store.ts`, `apps/game-server/src/store.test.ts`, `apps/game-server/src/test-helpers.ts`
- Modify: `apps/game-server/src/app.ts`, `apps/game-server/src/app.test.ts`
- Modify: `apps/game-server/src/start-server.ts`, `apps/game-server/src/start-server.test.ts`
- Modify: `scripts/smoke.mjs`, `scripts/smoke.test.ts`, `scripts/dev.mjs`, `scripts/dev.test.ts`
- Modify: `infra/.env.example`, `docs/decisions/0012-limits-rate-games-retention.md`, `docs/superpowers/specs/2026-09-07-goko-voice-go-opponent-design.md` (разделы 5 и 7)

**Interfaces:**
- Consumes: `clientKey(c, trustProxy)` из `app.ts` (ключ лимитера частоты: IPv4 целиком, IPv6 /64, IPv4-mapped → IPv4; `TRUST_PROXY=1` — последний адрес `X-Forwarded-For`); `GameService.create`, `init`, `resume`, `humanAction`, `close`, `isStale`, `pendingCreates`, `currentGameBySession`, `switchSessionGame`, `checkActiveLimit`, `log`; `errorDetail`; `GameStore` (`dir`, `fs`, `checkId`, `syncDir`), `memoryStore`; `ApiError`; `humanText`.
- Produces: `GameStore.loadAbandoned(): Promise<string[]>`, `markAbandoned(id)`, `clearAbandoned(id)` (пустой файл `<dir>/<id>.abandoned`); `type AbandonMarks = Pick<GameStore, 'loadAbandoned' | 'markAbandoned' | 'clearAbandoned'>`; `GameServiceDeps.marks?: AbandonMarks` (без него отметка только в памяти); `memoryMarks(): MemoryMarks` в `test-helpers.ts` (`AbandonMarks & { ids: Set<string> }`); `MAX_GAMES_PER_CLIENT = 3`; `GameServiceDeps.maxGamesPerClient?: number`; `GameService.create(req, opts: { sessionId?: string; clientKey?: string })`; ошибка `429 too_many_games` с `details: { max, scope: 'client' }`; `AppDeps.sessionlessGames?: boolean`; `POST /api/games` без флага — `400 bad_request` с `details.reason: 'sessionless_disabled'`; env `ALLOW_SESSIONLESS_GAMES` (включает только `1`, пробелы по краям не мешают); `BadRequestReasonCode = 'not_your_seat' | 'sessionless_disabled'`; `TooManyGamesScope = 'client'`, `TOO_MANY_GAMES_SCOPE_TEXT`. Тексты: «партии создаются только внутри сессии», «у тебя слишком много незаконченных партий, новую можно начать позже».

Брошенная партия. Незавершённая партия брошена в двух случаях: у неё нет активности дольше `STALE_GAME_MS` (как было) или в её сессии началась новая партия. Во втором случае сервис ставит отметку сразу, в памяти и на диске: пустой файл `<id>.abandoned` рядом со снапшотом. `load` его не читает (не `.json`), поэтому формат снапшота и протокол не меняются, а отметка переживает рестарт. Брошенная партия не считается ни в общем лимите 20, ни в лимите на клиента, и `init` не ставит ей задачу. Возврат человека снимает отметку: открытие потока партии (`resume`) или любое действие в ней (`humanAction`). Лимит при возврате не проверяется, потому что возврат партию не создаёт. Отметки пишутся по одной в порядке вызовов, `close` дожидается последней. Отказ записи даёт строку `[!]`, а отметка в памяти всё равно действует.

Правила счёта (одинаковые у общего лимита 20 и лимита на клиента):
- создаваемая партия уже в счёте;
- завершённая и брошенная партия не в счёте;
- к брошенной вернулись — она снова в счёте;
- текущая партия сессии не мешает create в той же сессии: новая партия её заменит, и та станет брошенной.

Так через сессии в счёте не больше `MAX_SESSIONS` партий, если не возвращаться к старым. Лимит 3 на клиента нужен режиму без сессий (dev, smoke) и держит возврат к брошенным партиям: иначе один адрес по кругу «новая партия → открыть поток старой» занял бы весь общий лимит 20. Партия сессии идёт в счёт владельца сессии — адреса, создавшего её через `POST /api/sessions`, а не адреса запроса: партии за телефон создаёт voice-agent из сети compose, и без этого все сессии делили бы один счёт контейнера. Общий лимит проверяется первым. Код не новый: `too_many_games` и `bad_request` уже в протоколе, различие — в `details`.

- [ ] **Step 1: Тесты `humanText`**

`packages/protocol/src/human-text.test.ts` — строку импорта заменить:

```ts
import { BAD_REQUEST_REASON_TEXT, CLIENT_ERROR_TEXT, ERROR_TEXT, ILLEGAL_REASON_TEXT, TOO_MANY_GAMES_SCOPE_TEXT, humanText } from './human-text.ts';
```

строку `expect(BAD_REQUEST_REASON_TEXT).toEqual({ not_your_seat: 'это не твой цвет' });` заменить:

```ts
    expect(BAD_REQUEST_REASON_TEXT).toEqual({ not_your_seat: 'это не твой цвет', sessionless_disabled: 'партии создаются только внутри сессии' });
    expect(humanText('bad_request', { reason: 'sessionless_disabled' })).toBe('партии создаются только внутри сессии');
```

тест `'лимиты: частые запросы и слишком много партий'` заменить целиком:

```ts
  it('лимиты: частые запросы и слишком много партий; лимит на клиента — свой текст по details.scope', () => {
    expect(humanText('rate_limited')).toBe('слишком много запросов, подожди немного');
    expect(humanText('too_many_games')).toBe('сейчас идёт слишком много партий, попробуй позже');
    expect(humanText('too_many_games', { max: 20 })).toBe(ERROR_TEXT.too_many_games);
    expect(TOO_MANY_GAMES_SCOPE_TEXT).toEqual({ client: 'у тебя слишком много незаконченных партий, новую можно начать позже' });
    expect(humanText('too_many_games', { max: 3, scope: 'client' })).toBe('у тебя слишком много незаконченных партий, новую можно начать позже');
    // Своё свойство, а не прототип; scope у другого кода ничего не меняет.
    expect(humanText('too_many_games', { scope: 'constructor' })).toBe(ERROR_TEXT.too_many_games);
    expect(humanText('rate_limited', { scope: 'client' })).toBe(ERROR_TEXT.rate_limited);
    expect(protocol.TOO_MANY_GAMES_SCOPE_TEXT).toBe(TOO_MANY_GAMES_SCOPE_TEXT);
  });
```

- [ ] **Step 2: Тесты сервиса, хранилища и помощник отметок**

`apps/game-server/src/service.test.ts` — в импорт из `./service.ts` добавить `MAX_GAMES_PER_CLIENT` (по алфавиту, после `MAX_ACTIVE_GAMES`); строку `import { type GuardedService, type MemoryStore, closeWithin, guardService, memoryStore, track } from './test-helpers.ts';` заменить на `import { type GuardedService, type MemoryStore, closeWithin, guardService, memoryMarks, memoryStore, track } from './test-helpers.ts';`. В `describe('GameService: лимит партий и старые снапшоты (B5)', ...)` сразу после теста `'незавершённая партия без активности дольше STALE_GAME_MS в лимите не считается; порог — последняя активность в момент create'` вставить:

```ts
  it('не больше MAX_GAMES_PER_CLIENT незавершённых партий на клиента: лишняя — too_many_games со scope client; другой клиент и create без клиента не в счёте; сдача освобождает место', async () => {
    expect(MAX_GAMES_PER_CLIENT).toBe(3);
    const { service } = await make(createFakeEngine());
    const mine = { clientKey: '203.0.113.7' };
    const first = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, mine);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, mine);
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, mine);
    const refused = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { ...mine, sessionId: 's1' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ code: 'too_many_games', status: 429, message: 'limit of 3 unfinished games per client reached', details: { max: 3, scope: 'client' } });
    expect(service.list()).toHaveLength(3);
    // Отказ не привязал партию к сессии и не сделал её текущей: её не было.
    expect(service.internalSizes()).toMatchObject({ sessionsByGame: 0, currentGames: 0 });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: '203.0.113.8' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await service.resign(first.state.id, { color: 'B', via: 'api' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, mine);
    expect(service.list()).toHaveLength(6);
  });

  it('общий лимит проверяется раньше лимита на клиента: без scope', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 1, maxGamesPerClient: 1 });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    const refused = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'too_many_games', details: { max: 1 } });
    expect((refused as ApiError).details).not.toHaveProperty('scope');
  });

  it('create клиента, ещё не записавший снапшот, уже в его счёте; отказ записи место освобождает', async () => {
    const real = memoryStore();
    let release: (() => void) | undefined;
    let gated = 1;
    const store = {
      load: () => real.load(),
      save: async (state: GameState) => {
        if (gated-- > 0) {
          await new Promise<void>((r) => (release = r));
          throw new Error('disk full');
        }
        return real.save(state);
      },
    } as unknown as GameStore;
    const { service } = await make(createFakeEngine(), { store, maxGamesPerClient: 1 });
    const first = service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    const firstFails = expect(first).rejects.toThrow('disk full');
    await untilTick(() => release !== undefined);
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 1, scope: 'client' } });
    // Другой клиент в это время создаёт: пишущийся create занимает место только своего клиента.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c2' });
    release?.();
    await firstFails;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    expect(service.list()).toHaveLength(2);
  });

  it('брошенная партия клиента в его счёте не идёт; ход в ней возвращает её в счёт', async () => {
    let clock = NOW.getTime();
    const { service } = await make(createFakeEngine(), { now: () => new Date(clock), maxGamesPerClient: 2 });
    const old = await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' })).rejects.toMatchObject({ code: 'too_many_games' });
    clock += STALE_GAME_MS + 1;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' });
    await service.play(old.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { clientKey: 'c1' })).rejects.toMatchObject({ code: 'too_many_games', details: { scope: 'client' } });
    expect(service.list()).toHaveLength(3);
  });

  it('новая партия в сессии бросает прежнюю незавершённую: в общем лимите её нет, а текущая партия сессии не мешает своей замене', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 2 });
    for (let i = 0; i < 4; i++) await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    // В счёте текущая партия s1 и партия без сессии: лимит полон, в новой сессии партия не создаётся.
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 2 } });
    // Новая партия s1 заменит текущую, и та станет брошенной: create проходит и при полном лимите.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    expect(service.list()).toHaveLength(6);
  });

  it('брошенная сменой партия не в счёте клиента; текущие партии других сессий того же клиента — в счёте', async () => {
    const { service } = await make(createFakeEngine(), { maxGamesPerClient: 2 });
    for (let i = 0; i < 3; i++) await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1', clientKey: 'c1' });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2', clientKey: 'c1' });
    await expect(service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's3', clientKey: 'c1' })).rejects.toMatchObject({ code: 'too_many_games', details: { max: 2, scope: 'client' } });
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2', clientKey: 'c1' });
    expect(service.list()).toHaveLength(5);
  });

  it('возврат к брошенной сменой партии — ход в ней или открытие её потока (resume) — возвращает её в счёт без проверки лимита', async () => {
    const { service } = await make(createFakeEngine(), { maxActiveGames: 2 });
    const create = () => service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    const a = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    const b = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    // a и b брошены, в счёте одна текущая. Ход в a возвращает её: с текущей лимит 2 полон.
    await service.play(a, { coord: 'D4', waitForReply: false, via: 'api' });
    await expect(create()).rejects.toMatchObject({ code: 'too_many_games', details: { max: 2 } });
    // Поток b возвращает и её, лимит при этом не проверяется: в счёте три при лимите 2.
    service.resume(b);
    await service.resign(a, { color: 'B', via: 'api' });
    await expect(create()).rejects.toMatchObject({ code: 'too_many_games' });
    await service.resign(b, { color: 'B', via: 'api' });
    await create();
    expect(service.list()).toHaveLength(4);
  });

  it('отметка брошенной сменой партии переживает рестарт: после init партия не в лимите и без задачи; возврат снимает отметку, ставит задачу и возвращает партию в счёт', async () => {
    const store = memoryStore();
    const marks = memoryMarks();
    // Первый запуск: движок не отвечает, пока задачу не отменят.
    const silent: Engine = {
      ...createFakeEngine(),
      genmove: (_req, signal) => new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    };
    const first = await make(silent, { store, marks });
    const a = (await first.service.create({ ...HUMAN_BLACK, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    await first.service.play(a, { coord: 'D4', waitForReply: false, via: 'voice' });
    // Сданная партия при смене не отмечается: она завершена, а не брошена.
    const done = (await first.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2' })).state.id;
    await first.service.resign(done, { color: 'B', via: 'api' });
    await first.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2' });
    // Новая партия s1: раздумье в a отменено, a брошена.
    await first.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await first.service.close();
    expect([...marks.ids]).toEqual([a]);

    const engine = createFakeEngine({ script: ['E5'] });
    const second = await make(engine, { store, marks, maxActiveGames: 3 });
    const create = () => second.service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false });
    await tick(20);
    expect(engine.calls).toMatchObject({ genmove: 0 });
    expect(second.service.get(a)).toMatchObject({ status: 'playing', pendingEngineMove: true });
    // В счёте две текущие партии сессий; будь a в счёте, лимит 3 был бы уже полон.
    const extra = await create();
    second.service.resume(a);
    await untilTick(() => second.service.get(a).moves.length === 2);
    await untilTick(() => marks.ids.size === 0);
    await second.service.resign(extra.state.id, { color: 'B', via: 'api' });
    // a снова в счёте: с двумя текущими партиями сессий лимит 3 полон.
    await expect(create()).rejects.toMatchObject({ code: 'too_many_games', details: { max: 3 } });
  });

  it('отказ записи отметки — строка [!] в лог; в памяти партия всё равно брошена', async () => {
    const logs: string[] = [];
    const marks = {
      ...memoryMarks(),
      markAbandoned: async () => {
        throw new Error('disk full');
      },
    };
    const { service } = await make(createFakeEngine(), { marks, maxActiveGames: 2, log: (line: string) => logs.push(line) });
    const a = (await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' })).state.id;
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's1' });
    await untilTick(() => logs.length > 0);
    expect(logs).toEqual([`[!] could not mark game ${a} as abandoned: disk full`]);
    // a не в счёте: в новой сессии место есть.
    await service.create({ ...HUMAN_ONLY, ...S9, waitForReply: false }, { sessionId: 's2' });
    expect(service.list()).toHaveLength(3);
  });
```

`apps/game-server/src/store.test.ts` — в `describe('GameStore', ...)` после теста `'файлы не .json игнорируются'` вставить:

```ts
  it('отметки брошенных партий: пустой <id>.abandoned рядом со снапшотом; load их не читает; повтор и снятие отсутствующей — не ошибка; id проверяется', async () => {
    const store = new GameStore(dir);
    await store.init();
    await store.save(state());
    await store.markAbandoned('g1');
    await store.markAbandoned('g1');
    expect((await readdir(dir)).sort()).toEqual(['g1.abandoned', 'g1.json']);
    expect(await readFile(path.join(dir, 'g1.abandoned'), 'utf8')).toBe('');
    // Имя не по форме id — не отметка.
    await writeFile(path.join(dir, 'NOT-SAFE.abandoned'), '', 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await store.load()).map((g) => g.id)).toEqual(['g1']);
    expect(console.error).not.toHaveBeenCalled();
    expect(await new GameStore(dir).loadAbandoned()).toEqual(['g1']);
    await store.clearAbandoned('g1');
    await store.clearAbandoned('g1');
    expect(await store.loadAbandoned()).toEqual([]);
    await expect(store.markAbandoned('../x')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(store.clearAbandoned('../x')).rejects.toMatchObject({ code: 'bad_request' });
    expect(await new GameStore(path.join(dir, 'fresh')).loadAbandoned()).toEqual([]);
  });
```

`apps/game-server/src/test-helpers.ts` — строку `import type { SnapshotStore } from './store.ts';` заменить на `import type { AbandonMarks, SnapshotStore } from './store.ts';`; после функции `memoryStore` добавить:

```ts
// Отметки брошенных партий в памяти вместо файлов <id>.abandoned: ids — отмеченные сейчас, их увидит init
// следующего сервиса на тех же отметках (рестарт).
export type MemoryMarks = AbandonMarks & { ids: Set<string> };

export function memoryMarks(): MemoryMarks {
  const ids = new Set<string>();
  return {
    ids,
    loadAbandoned: async () => [...ids].sort(),
    markAbandoned: async (id: string) => {
      ids.add(id);
    },
    clearAbandoned: async (id: string) => {
      ids.delete(id);
    },
  };
}
```

Прежние тесты сервиса проходят и после шага 7: отметка меняет только счёт лимитов и задачи `init`, а тесты смены партии в сессии (B2) лимитов не касаются, и их возврат через `resume` отметку снимает.

- [ ] **Step 3: Тесты приложения**

`apps/game-server/src/app.test.ts` — в `type MakeOptions` после `trustProxy?: boolean;` добавить:

```ts
  maxGamesPerClient?: number;
  sessionlessGames?: boolean;
```

в `make` строку `const service = new GameService({ store, engine: opts.engine ?? engine, bus, replyTimeoutMs: 500 });` заменить:

```ts
  // Лимит на клиента по умолчанию высокий, а партии без сессии включены: прежние тесты создают партии
  // клиентом протокола без адреса сокета (общий ключ unknown) и через POST /api/games. Новые тесты задают оба явно.
  const service = new GameService({ store, engine: opts.engine ?? engine, bus, replyTimeoutMs: 500, maxGamesPerClient: opts.maxGamesPerClient ?? 1000 });
```

в вызове `createApp` после `trustProxy: opts.trustProxy,` добавить `sessionlessGames: opts.sessionlessGames ?? true,`.

В конец файла:

```ts
describe('createApp: партии только в сессии и не больше трёх незавершённых на клиента (D-0012)', () => {
  const H = { 'x-app-key': KEY, 'content-type': 'application/json' };
  const from = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
  type App = Awaited<ReturnType<typeof make>>['app'];
  type ErrorJson = { error: { code: string; message: string; details?: Record<string, unknown> } };
  const post = (app: App, path: string, address: string, body?: unknown) =>
    app.request(path, { method: 'POST', headers: H, ...(body ? { body: JSON.stringify(body) } : {}) }, from(address));
  const sessionOf = async (app: App, address: string): Promise<string> => {
    const res = await post(app, '/api/sessions', address);
    expect(res.status).toBe(200);
    return ((await res.json()) as { session: { id: string } }).session.id;
  };
  const gameIn = async (app: App, sid: string, address: string): Promise<string> => {
    const res = await post(app, `/api/sessions/${sid}/games`, address, HUMAN_ONLY);
    expect(res.status).toBe(200);
    return ((await res.json()) as { state: { id: string } }).state.id;
  };

  it('новая партия в сессии бросает прежнюю: «Новая партия» подряд не упирается в лимит; ходы в брошенных возвращают их в счёт, и лишний create — 429 со scope client и своим текстом; сдача освобождает место', async () => {
    const { app } = await make({ maxGamesPerClient: 2, ttlMs: 60 * MIN });
    const sid = await sessionOf(app, '203.0.113.7');
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await gameIn(app, sid, '203.0.113.7'));
    // Возврат к брошенной партии лимит не проверяет: обе в счёте вместе с текущей, это три при лимите 2.
    expect((await post(app, `/api/games/${ids[0]}/play`, '203.0.113.7', { coord: 'D4' })).status).toBe(200);
    expect((await post(app, `/api/games/${ids[1]}/play`, '203.0.113.7', { coord: 'D4' })).status).toBe(200);
    const refused = await post(app, `/api/sessions/${sid}/games`, '203.0.113.7', HUMAN_ONLY);
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as ErrorJson;
    expect(body.error).toEqual({ code: 'too_many_games', message: 'limit of 2 unfinished games per client reached', details: { max: 2, scope: 'client' } });
    expect(humanText(body.error.code, body.error.details)).toBe('у тебя слишком много незаконченных партий, новую можно начать позже');
    const other = await sessionOf(app, '203.0.113.8');
    await gameIn(app, other, '203.0.113.8');
    expect((await post(app, `/api/games/${ids[0]}/resign`, '203.0.113.7', { color: 'B' })).status).toBe(200);
    await gameIn(app, sid, '203.0.113.7');
  });

  it('партии сессии идут в счёт владельца сессии, даже когда их создаёт voice-agent со своего адреса', async () => {
    const { app } = await make({ maxGamesPerClient: 1, ttlMs: 60 * MIN });
    const agent = '172.18.0.5'; // адрес контейнера voice-agent в сети compose: мимо Caddy, без X-Forwarded-For
    const sid = await sessionOf(app, '198.51.100.20');
    const first = await gameIn(app, sid, agent);
    // Замена текущей партии сессии проходит и при лимите 1.
    await gameIn(app, sid, '198.51.100.20');
    // Ход агента в первой партии возвращает её в счёт владельца.
    expect((await post(app, `/api/games/${first}/play`, agent, { coord: 'D4' })).status).toBe(200);
    const refused = await post(app, `/api/sessions/${sid}/games`, agent, HUMAN_ONLY);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as ErrorJson).error.details).toEqual({ max: 1, scope: 'client' });
    // Сессия другого телефона — свой счёт, хотя партии создаёт тот же агент.
    const other = await sessionOf(app, '198.51.100.21');
    await gameIn(app, other, agent);
  });

  it('владелец сессии за Caddy — последний адрес X-Forwarded-For при её создании', async () => {
    const { app } = await make({ trustProxy: true, maxGamesPerClient: 1, ttlMs: 60 * MIN });
    const viaProxy = (path: string, xff: string, body?: unknown) =>
      app.request(path, { method: 'POST', headers: { ...H, 'x-forwarded-for': xff }, ...(body ? { body: JSON.stringify(body) } : {}) }, from('127.0.0.1'));
    const a = ((await (await viaProxy('/api/sessions', '6.6.6.6, 203.0.113.60')).json()) as { session: { id: string } }).session.id;
    const b = ((await (await viaProxy('/api/sessions', '6.6.6.6, 203.0.113.61')).json()) as { session: { id: string } }).session.id;
    const g1 = await gameIn(app, a, '172.18.0.5');
    await gameIn(app, a, '172.18.0.5');
    expect((await post(app, `/api/games/${g1}/play`, '172.18.0.5', { coord: 'D4' })).status).toBe(200);
    expect((await post(app, `/api/sessions/${a}/games`, '172.18.0.5', HUMAN_ONLY)).status).toBe(429);
    // Владелец b — 203.0.113.61; по первому адресу X-Forwarded-For обе сессии делили бы счёт 6.6.6.6.
    await gameIn(app, b, '172.18.0.5');
  });

  it('без sessionlessGames POST /api/games — 400 bad_request с reason sessionless_disabled до разбора тела; партия в сессии и чтение списка работают', async () => {
    const { app, service } = await make({ sessionlessGames: false });
    const res = await post(app, '/api/games', '192.0.2.40', HUMAN_ONLY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorJson;
    expect(body).toEqual({ error: { code: 'bad_request', message: 'games are created only inside a session', details: { reason: 'sessionless_disabled' } } });
    expect(humanText(body.error.code, body.error.details)).toBe('партии создаются только внутри сессии');
    // Тело не разбирается: мусор получает тот же ответ, а не ошибку схемы.
    expect(await (await app.request('/api/games', { method: 'POST', headers: H, body: 'not json' }, from('192.0.2.40'))).json()).toEqual(body);
    expect(service.list()).toHaveLength(0);
    const sid = await sessionOf(app, '192.0.2.40');
    expect((await post(app, `/api/sessions/${sid}/games`, '192.0.2.40', HUMAN_ONLY)).status).toBe(200);
    expect((await app.request('/api/games', { headers: H }, from('192.0.2.40'))).status).toBe(200);
  });

  it('с sessionlessGames POST /api/games создаёт партию, и она в счёте адреса; IPv6 одной /64 — один клиент', async () => {
    const { app } = await make({ sessionlessGames: true, maxGamesPerClient: 1 });
    expect((await post(app, '/api/games', '192.0.2.41', HUMAN_ONLY)).status).toBe(200);
    expect((await post(app, '/api/games', '192.0.2.41', HUMAN_ONLY)).status).toBe(429);
    expect((await post(app, '/api/games', '192.0.2.42', HUMAN_ONLY)).status).toBe(200);
    expect((await post(app, '/api/games', '2001:db8:5:6::1', HUMAN_ONLY)).status).toBe(200);
    expect((await post(app, '/api/games', '2001:db8:5:6::2', HUMAN_ONLY)).status).toBe(429);
  });
});
```

- [ ] **Step 4: Тест запуска сервера**

`apps/game-server/src/start-server.test.ts` — в `harness` строку `env: { ...BASE_ENV, DATA_DIR: dir },` заменить на `env: { ...BASE_ENV, DATA_DIR: dir, ALLOW_SESSIONLESS_GAMES: '1' },` (тесты остановки создают партии через `POST /api/games`). Перед тестом `'FAKE_ENGINE=1: фейковый движок, ENGINE_KEY не нужен, строка [!]; иначе клиент go-engine с ENGINE_URL и ENGINE_KEY'` вставить:

```ts
  it('ALLOW_SESSIONLESS_GAMES=1 (и 1 с пробелами) разрешает POST /api/games; без него, пустой, из пробелов или другой — 400 sessionless_disabled; партия в сессии создаётся всегда', async () => {
    say();
    const headers = { 'x-app-key': BASE_ENV.APP_KEY, 'content-type': 'application/json' };
    const body = JSON.stringify({ black: { controller: 'human' }, white: { controller: 'human' }, settings: { boardSize: 9 } });
    for (const [value, allowed] of [['1', true], [' 1 ', true], [undefined, false], ['', false], ['   ', false], ['0', false], ['true', false], ['11', false]] as const) {
      const { deps } = harness();
      const started = await startServer({ ...deps, env: { ...deps.env, ALLOW_SESSIONLESS_GAMES: value } });
      if (!started) throw new Error('сервер не запустился');
      const res = await started.app.request('/api/games', { method: 'POST', headers, body });
      expect(res.status, `ALLOW_SESSIONLESS_GAMES=${value}`).toBe(allowed ? 200 : 400);
      if (!allowed) expect(((await res.json()) as { error: { details?: unknown } }).error.details).toEqual({ reason: 'sessionless_disabled' });
      const created = await started.app.request('/api/sessions', { method: 'POST', headers });
      const { session } = (await created.json()) as { session: { id: string } };
      expect((await started.app.request(`/api/sessions/${session.id}/games`, { method: 'POST', headers, body })).status).toBe(200);
    }
  });
```

в тесте `'значения из env: порт, хост, агент, каталог данных, лимит; сессии истекают по SESSION_TTL_MS'` после строки `expect(rec.serviceDeps[0]?.store.dir).toBe(dir);` добавить:

```ts
    // Отметки брошенных партий лежат в том же каталоге, что и снапшоты (D-0012).
    expect(rec.serviceDeps[0]?.marks).toBe(rec.serviceDeps[0]?.store);
```

- [ ] **Step 5: Тесты `smoke` и `dev`**

`scripts/smoke.test.ts` — в тесте `'свои ключ, порт, каталог и фейковый движок; чужие пределы сессий не протекают'` строку `expect(env).toMatchObject({ APP_KEY: SMOKE_APP_KEY, PORT: '18787', HOST: '127.0.0.1', DATA_DIR: '/tmp/x', FAKE_ENGINE: '1' });` заменить:

```ts
    expect(env).toMatchObject({ APP_KEY: SMOKE_APP_KEY, PORT: '18787', HOST: '127.0.0.1', DATA_DIR: '/tmp/x', FAKE_ENGINE: '1', ALLOW_SESSIONLESS_GAMES: '1' });
    // smoke создаёт партии через POST /api/games: флаг свой, значение родителя не протекает.
    expect(gameServerEnv({ ALLOW_SESSIONLESS_GAMES: '0' }, { port: 1, dataDir: '/tmp/x', real: true }).ALLOW_SESSIONLESS_GAMES).toBe('1');
```

`scripts/dev.test.ts` — в первом тесте `toMatchObject({ FAKE_ENGINE: '1', AGENT_NAME: DEV_AGENT_NAME, LIVEKIT_URL: 'wss://secret-livekit' })` дополнить полем `ALLOW_SESSIONLESS_GAMES: '1'`; во втором `toMatchObject({ ENGINE_KEY: 'one-time', ENGINE_URL: 'http://127.0.0.1:8788', AGENT_NAME: DEV_AGENT_NAME })` — тоже `ALLOW_SESSIONLESS_GAMES: '1'`.

- [ ] **Step 6: Запустить тесты, убедиться, что падают**

Run: `npx vitest run packages/protocol/src/human-text.test.ts apps/game-server/src/service.test.ts apps/game-server/src/store.test.ts apps/game-server/src/app.test.ts apps/game-server/src/start-server.test.ts scripts/smoke.test.ts scripts/dev.test.ts`
Expected: FAIL — нет `TOO_MANY_GAMES_SCOPE_TEXT`, `MAX_GAMES_PER_CLIENT` и `GameStore.loadAbandoned`; новые тесты лимита на клиента и флага падают (лишняя партия создаётся, `POST /api/games` отвечает 200); тесты смены партии, возврата и рестарта падают (брошенная сменой партия в счёте, отметок нет, `marks` не передан в сервис); `ALLOW_SESSIONLESS_GAMES` нет в окружении `smoke` и `dev`. Прежние тесты `app.test.ts`, `store.test.ts` и `start-server.test.ts` проходят.

- [ ] **Step 7: Код**

`packages/protocol/src/human-text.ts` — блок от `export type BadRequestReasonCode = 'not_your_seat';` до конца `BAD_REQUEST_REASON_TEXT` заменить:

```ts
export type BadRequestReasonCode = 'not_your_seat' | 'sessionless_disabled';

// Причины bad_request, у которых есть своя фраза: сдача за цвет, которым человек не управляет, и партия
// без сессии там, где такие выключены (D-0012).
export const BAD_REQUEST_REASON_TEXT: Record<BadRequestReasonCode, string> = {
  not_your_seat: 'это не твой цвет',
  sessionless_disabled: 'партии создаются только внутри сессии',
};

export type TooManyGamesScope = 'client';

// too_many_games без scope — общий лимит сервера; scope client — лимит незавершённых партий на адрес (D-0012).
// Старые партии с телефона не открыть, поэтому текст не зовёт их доигрывать.
export const TOO_MANY_GAMES_SCOPE_TEXT: Record<TooManyGamesScope, string> = {
  client: 'у тебя слишком много незаконченных партий, новую можно начать позже',
};
```

в `humanText` после строки с `BAD_REQUEST_REASON_TEXT` добавить:

```ts
  if (code === 'too_many_games' && own(TOO_MANY_GAMES_SCOPE_TEXT, details?.scope)) return TOO_MANY_GAMES_SCOPE_TEXT[details.scope];
```

`apps/game-server/src/store.ts`:

после функции `checkId` добавить:

```ts
// Отметка брошенной сменой партии (D-0012): пустой файл рядом со снапшотом. load его не читает (не .json),
// поэтому формат снапшота не меняется, а отметка переживает рестарт.
const ABANDONED_SUFFIX = '.abandoned';
```

строку `export type SnapshotStore = Pick<GameStore, 'dir' | 'init' | 'load' | 'save' | 'remove'>;` заменить:

```ts
export type SnapshotStore = Pick<GameStore, 'dir' | 'init' | 'load' | 'save' | 'remove'>;
// Отметки брошенных партий: отдельный необязательный шов сервиса, подделка в памяти — memoryMarks.
export type AbandonMarks = Pick<GameStore, 'loadAbandoned' | 'markAbandoned' | 'clearAbandoned'>;
```

после метода `remove` добавить:

```ts
  // id партий с отметкой <id>.abandoned; имя не по форме id пропускается, как чужой файл.
  async loadAbandoned(): Promise<string[]> {
    await this.init();
    return (await readdir(this.dir))
      .filter((name) => name.endsWith(ABANDONED_SUFFIX))
      .map((name) => name.slice(0, -ABANDONED_SUFFIX.length))
      .filter(isSafeId)
      .sort();
  }

  // Пустой файл долговечно, как снапшот: sync файла и каталога. Повтор — не ошибка.
  async markAbandoned(id: string): Promise<void> {
    checkId(id);
    const handle = await this.fs.open(path.join(this.dir, `${id}${ABANDONED_SUFFIX}`), 'w');
    try {
      await handle.sync();
    } catch (e) {
      await handle.close().catch(() => undefined);
      throw e;
    }
    await handle.close();
    await this.syncDir();
  }

  // Снятие отметки: к партии вернулись или она уже не идёт. Отсутствующий файл — не ошибка.
  async clearAbandoned(id: string): Promise<void> {
    checkId(id);
    try {
      await this.fs.unlink(path.join(this.dir, `${id}${ABANDONED_SUFFIX}`));
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'ENOENT') throw e;
      return;
    }
    await this.syncDir();
  }
```

`apps/game-server/src/service.ts`:

строку `import type { SnapshotStore } from './store.ts';` заменить на `import type { AbandonMarks, SnapshotStore } from './store.ts';`.

в `GameServiceDeps` после `store: SnapshotStore;` добавить:

```ts
  // Отметки брошенных сменой партий на диске (D-0012); без них отметка живёт только в памяти.
  marks?: AbandonMarks;
```

после поля `gaveUp` добавить:

```ts
  // Партии, брошенные сменой партии в сессии (D-0012): не в лимитах и без задачи init, как устаревшие.
  // Возврат человека (resume, humanAction) снимает отметку. Записи на диск идут цепочкой, close её ждёт.
  private readonly abandoned = new Set<string>();
  private marksWrite: Promise<void> = Promise.resolve();
```

в `init` строки

```ts
    // Устаревшей партии задача не ставится (D-0012): после рестарта движок не доигрывает брошенные партии.
    // Она отмечена, как отменённая, и её снова запустит действие человека или открытие потока (resume).
```

заменить:

```ts
    // Отметка идущей партии действует; отметка завершённой или удалённой партии — остаток, её снимаем.
    for (const id of (await this.deps.marks?.loadAbandoned()) ?? []) {
      if (this.games.get(id)?.status === 'playing') this.abandoned.add(id);
      else this.persistMark(id, false);
    }
    // Устаревшей или брошенной сменой партии задача не ставится (D-0012): после рестарта движок не доигрывает
    // брошенные партии. Она отмечена, как отменённая, и её снова запустит действие человека или открытие потока (resume).
```

в `close` после строки `await Promise.allSettled([...this.engineTasks.values(), ...this.scoringTasks.values()]);` добавить `await this.marksWrite;`.

в `resume` перед строкой `if (!this.gaveUp.delete(id)) return;` добавить `this.reactivate(id);`; в `humanAction` перед строкой `const resumed = human && this.gaveUp.delete(id);` добавить `if (human) this.reactivate(id);`.

строку `if (this.sessionsByGame.get(previous) === sessionId) this.sessionsByGame.delete(previous);` в `switchSessionGame` оставить, а после `this.cancelBackground(previous);` добавить `this.abandon(previous);`.

метод `isStale` заменить:

```ts
  // Не в счёте лимитов и без задачи init: без активности дольше порога или брошена сменой партии (D-0012).
  private isStale(state: GameState, now: number): boolean {
    return this.abandoned.has(state.id) || lastActivity(state) < now - (this.deps.staleGameMs ?? STALE_GAME_MS);
  }

  // Прежняя идущая партия сессии брошена: отметка в памяти сразу, на диск — в очередь записей.
  private abandon(id: string): void {
    if (this.games.get(id)?.status !== 'playing' || this.abandoned.has(id)) return;
    this.abandoned.add(id);
    this.persistMark(id, true);
  }

  // Человек вернулся к брошенной партии: она снова в счёте. Лимит не проверяется — партия не создаётся.
  private reactivate(id: string): void {
    if (this.abandoned.delete(id)) this.persistMark(id, false);
  }

  // Отказ записи — строка [!], память уже верна. После рестарта незаписанная отметка значит, что партия
  // в счёте и получит задачу, как свежая; неснятая — что партия вне счёта до следующего возврата.
  private persistMark(id: string, abandoned: boolean): void {
    const marks = this.deps.marks;
    if (!marks) return;
    this.marksWrite = this.marksWrite.then(async () => {
      try {
        await (abandoned ? marks.markAbandoned(id) : marks.clearAbandoned(id));
      } catch (e) {
        this.log(`[!] could not ${abandoned ? 'mark' : 'unmark'} game ${id} as abandoned: ${errorDetail(e)}`);
      }
    });
  }
```

метод `checkActiveLimit` заменить:

```ts
  // Лимит незавершённых партий (D-0012). Партия, чей create ещё пишет снапшот, уже занимает место;
  // устаревшая (без активности дольше порога на момент create) и брошенная сменой — нет. replaced — текущая
  // партия сессии, в которой идёт create: новая партия её заменит, поэтому своей замене она не мешает.
  private checkActiveLimit(replaced?: string): void {
    const max = this.deps.maxActiveGames ?? MAX_ACTIVE_GAMES;
    const now = (this.deps.now?.() ?? new Date()).getTime();
    let active = 0;
    for (const state of this.games.values()) if (state.id !== replaced && state.status !== 'finished' && !this.isStale(state, now)) active++;
    for (const id of this.pendingCreates) if (!this.games.has(id)) active++;
    if (active >= max) throw new ApiError('too_many_games', `limit of ${max} unfinished games reached`, { max });
  }
```

после `export const MAX_ACTIVE_GAMES = 20;` добавить:

```ts
// Не больше стольких незавершённых партий на клиента (D-0012): ключ — тот же, что у лимита частоты
// (IPv4, IPv6 /64); у партии сессии — ключ владельца сессии. Лишний create — too_many_games со scope client.
export const MAX_GAMES_PER_CLIENT = 3;
```

в `GameServiceDeps` после `maxActiveGames?: number;` добавить `maxGamesPerClient?: number;`.

после поля `pendingCreates` добавить:

```ts
  // Клиент, в чей счёт идёт партия (ключ из app.ts). Только память: после рестарта партии, созданные до него,
  // в счёт клиента не идут, в общем лимите — идут. Записи завершённых партий вычищает checkClientLimit.
  private readonly clientByGame = new Map<string, string>();
```

сигнатуру `async create(req: NewGameInput, opts: { sessionId?: string } = {}): Promise<NewGameResponse> {` заменить на `async create(req: NewGameInput, opts: { sessionId?: string; clientKey?: string } = {}): Promise<NewGameResponse> {`; строку `this.checkActiveLimit();` в `create` заменить:

```ts
    const replaced = opts.sessionId === undefined ? undefined : this.currentGameBySession.get(opts.sessionId);
    this.checkActiveLimit(replaced);
    if (opts.clientKey !== undefined) this.checkClientLimit(opts.clientKey, replaced);
```

строку `this.pendingCreates.add(id);` заменить (проверка и запись — в одном синхронном отрезке: параллельный create того же клиента уже видит эту партию):

```ts
    this.pendingCreates.add(id);
    if (opts.clientKey !== undefined) this.clientByGame.set(id, opts.clientKey);
```

в `catch` этого же `create` после `this.sessionsByGame.delete(id);` добавить `this.clientByGame.delete(id);`.

после метода `checkActiveLimit` добавить:

```ts
  // Лимит незавершённых партий на клиента (D-0012), счёт как у общего: создаваемая уже в счёте, завершённая,
  // устаревшая и брошенная сменой — нет, заменяемая текущая партия сессии — тоже нет. Брошенная не вычищается:
  // возврат к ней вернёт её в счёт.
  private checkClientLimit(clientKey: string, replaced?: string): void {
    const max = this.deps.maxGamesPerClient ?? MAX_GAMES_PER_CLIENT;
    const now = (this.deps.now?.() ?? new Date()).getTime();
    let active = 0;
    for (const [id, key] of this.clientByGame) {
      const state = this.games.get(id);
      if (state?.status === 'finished') {
        this.clientByGame.delete(id);
        continue;
      }
      if (key !== clientKey || id === replaced) continue;
      if (state ? !this.isStale(state, now) : this.pendingCreates.has(id)) active++;
    }
    if (active >= max) throw new ApiError('too_many_games', `limit of ${max} unfinished games per client reached`, { max, scope: 'client' });
  }
```

`apps/game-server/src/app.ts`:

в `AppDeps` после `trustProxy?: boolean;` добавить:

```ts
  // ALLOW_SESSIONLESS_GAMES=1: POST /api/games создаёт партию без сессии (dev, smoke). Без флага партии создаются
  // только внутри сессии (D-0012): публичный APP_KEY иначе давал бы партии мимо MAX_SESSIONS.
  sessionlessGames?: boolean;
```

строку `const watchers = new Map<string, () => void>();` заменить:

```ts
  const watchers = new Map<string, () => void>();
  // Владелец сессии — ключ адреса, создавшего её (D-0012): партии сессии идут в его счёт, даже когда их
  // создаёт voice-agent со своего адреса. Запись живёт, пока жив наблюдатель сессии.
  const sessionOwners = new Map<string, string>();
```

в `unwatch` после `watchers.delete(sid);` добавить `sessionOwners.delete(sid);`.

в `POST /api/sessions` строку `watch(session.id);` заменить:

```ts
    sessionOwners.set(session.id, clientKey(c, trustProxy));
    watch(session.id);
```

в `POST /api/sessions/:sid/games` строку `return c.json(await service.create(req, { sessionId: sid }));` заменить:

```ts
    // Сессия, созданная до рестарта или другим путём, владельца не имеет: счёт по адресу запроса.
    return c.json(await service.create(req, { sessionId: sid, clientKey: sessionOwners.get(sid) ?? clientKey(c, trustProxy) }));
```

строку `app.post('/api/games', async (c) => c.json(await service.create(await parseBody(c, NewGameRequest))));` заменить:

```ts
  app.post('/api/games', async (c) => {
    if (deps.sessionlessGames !== true) throw new ApiError('bad_request', 'games are created only inside a session', { reason: 'sessionless_disabled' });
    return c.json(await service.create(await parseBody(c, NewGameRequest), { clientKey: clientKey(c, trustProxy) }));
  });
```

`apps/game-server/src/start-server.ts`: в `type Config` после `trustProxy: boolean;` добавить `sessionlessGames: boolean;`; в `readConfig` после строки `trustProxy: optional('TRUST_PROXY')?.trim() === '1',` добавить:

```ts
      // POST /api/games без сессии — только dev и smoke (D-0012); в prod compose переменной нет.
      sessionlessGames: optional('ALLOW_SESSIONLESS_GAMES')?.trim() === '1',
```

в вызове `createApp` после `trustProxy: config.trustProxy,` добавить `sessionlessGames: config.sessionlessGames,`. Строки в лог нет: тесты запуска сверяют лог целиком, а выключенный флаг в prod проверяет задача 10 (шаг 8). Строку `const service = createService({ store: new GameStore(config.dataDir), engine, bus, staleGameMs: config.sessionTtlMs, log });` заменить:

```ts
  // Одно хранилище и для снапшотов, и для отметок брошенных партий (D-0012): отметки лежат рядом с <id>.json.
  const store = new GameStore(config.dataDir);
  const service = createService({ store, marks: store, engine, bus, staleGameMs: config.sessionTtlMs, log });
```

`scripts/smoke.mjs`: в `SERVER_OWNED` добавить `'ALLOW_SESSIONLESS_GAMES'` последним элементом; строку `Object.assign(env, LIVEKIT_STUB, { APP_KEY: SMOKE_APP_KEY, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, AGENT_NAME: 'goko-smoke' });` заменить:

```js
  // ALLOW_SESSIONLESS_GAMES=1: сценарий smoke создаёт партии через POST /api/games (create_game без сессии, D-0012).
  Object.assign(env, LIVEKIT_STUB, { APP_KEY: SMOKE_APP_KEY, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, AGENT_NAME: 'goko-smoke', ALLOW_SESSIONLESS_GAMES: '1' });
```

`scripts/dev.mjs`: строку `const serverEnv = { ...env, ENGINE_KEY: /** @type {string} */ (engineKey), ENGINE_URL: \`http://127.0.0.1:${enginePort}\`, AGENT_NAME: DEV_AGENT_NAME };` дополнить полем `ALLOW_SESSIONLESS_GAMES: '1'` в конце объекта; во второй ветке `env: { ...env, FAKE_ENGINE: '1', AGENT_NAME: DEV_AGENT_NAME }` — тоже `ALLOW_SESSIONLESS_GAMES: '1'`. Над первой из строк комментарий: `// dev и smoke разрешают партии без сессии (curl, отладка); в prod compose флага нет (D-0012).`

`infra/.env.example` — после строки `TRUST_PROXY=...` добавить:

```
ALLOW_SESSIONLESS_GAMES=           # 1 — POST /api/games создаёт партию без сессии; npm run dev и smoke ставят сами; на VPS пусто (D-0012)
```

- [ ] **Step 8: D-0012 и спека — одной правкой каждого файла**

`docs/decisions/0012-limits-rate-games-retention.md`: в шапке `updated:` — дата правки. В «Последствиях» пункт `- Партия, брошенная сменой партии в сессии, закрытым телефоном или рестартом сервера, остаётся \`playing\` и занимает место в лимите 20 не дольше \`SESSION_TTL_MS\` после последней активности. Её снапшот остаётся на диске: срок хранения есть только у завершённых партий.` (четыре строки) заменить:

```markdown
- Партия, брошенная закрытым телефоном или рестартом сервера, остаётся
  `playing` и занимает место в лимите 20 не дольше `SESSION_TTL_MS` после
  последней активности. Брошенная сменой партии в сессии места не занимает
  сразу (дополнение ниже). Снапшот остаётся на диске: срок хранения есть
  только у завершённых партий.
```

пункт `- После деплоя движок не доигрывает партии, брошенные больше \`SESSION_TTL_MS\` назад: …: отмена в снапшот не пишется.` (четыре строки) заменить:

```markdown
- После деплоя движок не доигрывает партии, брошенные больше
  `SESSION_TTL_MS` назад или сменой партии в сессии: KataGo не получает
  пачку `genmove` сразу после старта. Смена партии помнится отметкой рядом
  со снапшотом (дополнение ниже).
```

В конец файла:

```markdown

## Дополнение: брошенная сменой партия, лимит партий на клиента и партии без сессии

- Дата: день исполнения задачи 9 плана голоса и веба; пункт R9 широкого ревью (блокер публичного деплоя)

Решение:

- Новая партия в сессии бросает прежнюю незавершённую сразу, не дожидаясь
  `SESSION_TTL_MS`. Отметка — в памяти и пустым файлом
  `data/games/<id>.abandoned` рядом со снапшотом; формат снапшота и протокол
  не меняются, отметка переживает рестарт. Отказ записи отметки — строка
  `[!]`, в памяти отметка действует.
- Брошенная сменой партия не считается ни в общем лимите 20, ни в лимите на
  клиента, и при старте сервера ей не ставится фоновая задача.
- Возврат человека — открытие потока этой партии или любое действие в ней —
  снимает отметку, и партия снова в счёте. Лимит при возврате не
  проверяется: возврат партию не создаёт.
- Текущая партия сессии не мешает созданию новой партии в той же сессии:
  новая её заменит.
- Не больше 3 незавершённых партий на клиента, считая создаваемые, по тем же
  правилам счёта. Ключ клиента — тот же, что у лимита частоты (IPv4 целиком,
  IPv6 /64, с `TRUST_PROXY=1` — последний адрес `X-Forwarded-For`). Партия
  сессии идёт в счёт владельца сессии — адреса, создавшего её
  (`POST /api/sessions`), даже когда её создаёт voice-agent со своего адреса.
  Сессия без записанного владельца (создана до рестарта) — счёт по адресу
  запроса.
- Лишняя — `429 too_many_games` с `details: { max: 3, scope: 'client' }`,
  `humanText` — «у тебя слишком много незаконченных партий, новую можно
  начать позже». Общий лимит 20 проверяется раньше и отвечает без `scope`.
- Партия без сессии (`POST /api/games`, `create_game`) создаётся только при
  `ALLOW_SESSIONLESS_GAMES=1` (включает только `1`, пробелы по краям не
  мешают): так запускают `npm run dev` и `npm run smoke`. В prod compose
  переменной нет, и маршрут отвечает `400 bad_request` с
  `details.reason: 'sessionless_disabled'` («партии создаются только внутри
  сессии») до разбора тела. Новых кодов ошибок нет.
- Веб, voice-agent и `scripts/chat.mjs` создают партии только внутри сессии.

Последствия:

- Через сессии в счёте не больше `MAX_SESSIONS` партий, пока никто не
  возвращается к брошенным: «Новая партия» подряд в лимит не упирается.
- Лимит 3 на клиента нужен режиму без сессий (dev, smoke) и возврату к
  брошенным: без него один адрес по кругу «новая партия → открыть поток
  старой» занял бы весь лимит 20.
- Счёт на клиента и владельцы сессий живут в памяти: рестарт их обнуляет,
  общий лимит 20 после рестарта считает все незавершённые партии без
  отметки. Текущие партии сессий до рестарта отметки не получают: сессии
  рестарт не переживают, и такие партии в счёте до порога `SESSION_TTL_MS`.
- Отметки незавершённых партий с диска сами не уходят: снапшот идущей
  партии срока хранения не имеет. Отметку завершённой или удалённой партии
  снимает старт сервера. Ручная уборка — runbook VPS.
- Разные адреса (другая сеть, другая /64) обходят лимит на клиента, но не
  общий лимит 20 и не `MAX_SESSIONS`.
- `create_game` для MCP (стадия 2) потребует сессии или включения флага
  вместе с отдельной защитой — решение стадии 2.
```

Спека, раздел 5: в абзаце о потоке сессии фрагмент `поток; задачу снова ставит действие человека на этой партии или открытие её
потока. После рестарта сервера отмена не помнится: задачу получает каждая
незавершённая партия с активностью за последние \`SESSION_TTL_MS\`, а более
старая ждёт того же действия человека или открытия потока (раздел 7, D-0012).` заменить на `поток. Прежняя незавершённая партия становится брошенной: она не в счёте
лимитов, отметка переживает рестарт, и при старте задача ей не ставится. Задачу
и место в счёте ей возвращает действие человека на этой партии или открытие её
потока (раздел 7, D-0012). После рестарта задачу получает каждая незавершённая
партия без отметки с активностью за последние \`SESSION_TTL_MS\`.`. Строку таблицы `| \`create_game\` | \`POST /api/games\` | то же | то же (без сессии, для MCP) |` заменить на `| \`create_game\` | \`POST /api/games\` | то же | то же (без сессии, для MCP); только при \`ALLOW_SESSIONLESS_GAMES=1\` (dev, smoke), иначе \`400 bad_request\` с \`details.reason: 'sessionless_disabled'\` (D-0012) |`. В перечне кодов фрагмент `сдача за место \`engine\` —
\`details.reason: 'not_your_seat'\`), \`limit_reached\`` заменить на `сдача за место \`engine\` —
\`details.reason: 'not_your_seat'\`; партия без сессии при выключенном флаге — \`details.reason: 'sessionless_disabled'\`), \`limit_reached\``; фрагмент `\`too_many_games\` (превышен лимит незавершённых партий, D-0012)` — на `\`too_many_games\` (превышен лимит незавершённых партий на сервере или на клиента, D-0012)`. В «Язык и санитизация ошибок»: `\`BAD_REQUEST_REASON_TEXT\` для \`not_your_seat\`)` → `\`BAD_REQUEST_REASON_TEXT\` для \`not_your_seat | sessionless_disabled\`, \`TOO_MANY_GAMES_SCOPE_TEXT\` для \`scope: 'client'\`)`; `\`limit_reached\` и
  \`too_many_games\` — \`details.max\`` → `\`limit_reached\` и
  \`too_many_games\` — \`details.max\` (у лимита на клиента ещё \`details.scope: 'client'\`)`; конец того же пункта `место \`engine\` — \`details.reason: 'not_your_seat'\`.` → `место \`engine\` — \`details.reason: 'not_your_seat'\`, \`bad_request\` партии без сессии — \`details.reason: 'sessionless_disabled'\`.`. Других мест раздела 5 и раздела 8 правка не касается.

Спека, раздел 7: в первом пункте фрагмент `(по умолчанию 2 ч), считается брошенной: при старте фоновая задача (ход
  движка, автосчёт) ей не ставится, её ставит действие человека на партии или
  открытие её потока, как после отмены сменой партии (раздел 5).` заменить на `(по умолчанию 2 ч), считается брошенной; брошенной сразу становится и
  прежняя незавершённая партия сессии, в которой началась новая, — отметкой
  \`data/games/<id>.abandoned\` рядом со снапшотом. Брошенной партии при старте
  фоновая задача (ход движка, автосчёт) не ставится, её ставит действие
  человека на партии или открытие её потока (раздел 5).`. Пункт `- Не больше 20 незавершённых партий на сервере, …` (три строки) заменить:

```markdown
- Не больше 20 незавершённых партий на сервере, считая создаваемые; лишняя —
  `429 too_many_games` (D-0012). Брошенные партии (последний ход или создание
  старше `SESSION_TTL_MS` на момент создания новой, или брошенные сменой
  партии) в счёт не идут, к брошенной вернулись — снова в счёте. Текущая
  партия сессии не мешает созданию новой в той же сессии.
- Не больше 3 незавершённых партий на клиента (ключ лимита частоты; у партии
  сессии — владелец сессии, создавший её), те же правила счёта; лишняя —
  `429 too_many_games` с `details.scope: 'client'`. `POST /api/games` — только
  при `ALLOW_SESSIONLESS_GAMES=1` (dev, smoke), иначе `400 bad_request` с
  `details.reason: 'sessionless_disabled'` (D-0012).
```

- [ ] **Step 9: Тесты зелёные, smoke, проверка вызовов**

Run:
```bash
npm run check
npm run smoke
git grep -n "createGame\|'/api/games'" -- apps/voice-agent apps/web scripts/chat.mjs || echo "[OK] партии создаются только через сессию"
```
Expected: `check` зелёный (typecheck и все unit, в том числе прежние тесты лимитов частоты; тесты задач 2 и 6 на `too_many_games` и `bad_request` сравнивают с `humanText(...)` и проходят до и после этой задачи); `smoke` — прежние `[OK]` с фейковым движком, сценарий идёт через `POST /api/games` с флагом из `gameServerEnv`; `git grep` печатает только `[OK]` (задачи 2, 5 и 7 уже выполнены к этому моменту, если порядок задач сохранён; если нет — повторить `git grep` в задаче 10, шаг 8).

- [ ] **Step 10: Проверка страницей на ПК без агента** (бесплатно: без voice-agent и без Realtime; веб задач 6–8 уже есть; нужны LiveKit на VPS и `LIVEKIT_*` в `.env`)

Сессию страница создаёт через LiveKit на VPS (D-0001), поэтому без LiveKit и `LIVEKIT_*` в `.env` шаг не выполняется: записать его `[TODO founder]` в `docs/NOW.md` (задача 11, шаг 5) и идти дальше.

Run — как в задаче 8, шаг 5; game-server без `ALLOW_SESSIONLESS_GAMES`, то есть как в prod:
```bash
FAKE_ENGINE=1 AGENT_NAME=goko-dev node --env-file=.env apps/game-server/src/main.ts
node node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 5173 --strictPort
```

Открыть `http://127.0.0.1:5173`. Expected:
1. «Новая партия» → «Начать» — партия началась: веб создаёт партии только в сессии, флаг ему не нужен.
2. Ещё четыре раза «Новая партия» → «Начать», не доигрывая. Каждое «Начать» начинает партию, текста о слишком многих партиях нет: прежняя партия сессии брошена и не в счёте.
3. В другом терминале: `ls data/games/*.abandoned | wc -l` печатает `4` — по отметке на каждую заменённую незавершённую партию.
4. «Сдаться» → «Точно?» → «Начать» → новая партия началась; `ls data/games/*.abandoned | wc -l` по-прежнему `4`: сданная партия завершена, а не брошена.
5. Остановить game-server (Ctrl+C) и запустить той же командой. `ls data/games/*.abandoned | wc -l` — `4`: отметки пережили рестарт; в логе game-server нет строк `[!] could not mark`.

Незаконченные партии этой проверки и их отметки остаются в `data/games`; удалить их можно вместе: `rm -i data/games/<id>.json data/games/<id>.abandoned`. Создания проверки (1 сессия и 6 запросов партии) укладываются в предел 10 за 10 минут на адрес. Если вместо новой партии пришло «слишком много запросов, подожди немного», это предел частоты: повторить после паузы из `Retry-After` (DevTools → Network).

- [ ] **Step 11: Commit**

```bash
git add packages/protocol/src/human-text.ts packages/protocol/src/human-text.test.ts apps/game-server/src/service.ts apps/game-server/src/service.test.ts apps/game-server/src/store.ts apps/game-server/src/store.test.ts apps/game-server/src/test-helpers.ts apps/game-server/src/app.ts apps/game-server/src/app.test.ts apps/game-server/src/start-server.ts apps/game-server/src/start-server.test.ts scripts/smoke.mjs scripts/smoke.test.ts scripts/dev.mjs scripts/dev.test.ts infra/.env.example docs/decisions/0012-limits-rate-games-retention.md docs/superpowers/specs/2026-09-07-goko-voice-go-opponent-design.md
git commit -m "game-server: прежняя партия сессии брошена при смене, не больше трёх незавершённых партий на клиента, партии без сессии только с ALLOW_SESSIONLESS_GAMES (D-0012)"
```

---

### Task 10: Контейнеры game-server, go-engine, voice-agent; сервисы compose; деплой статики

**Files:**
- Create: `apps/game-server/Dockerfile`, `apps/voice-agent/Dockerfile`, `.dockerignore`
- Modify: `apps/go-engine/Dockerfile` (стадия `katago` берёт `analysis.cfg` из контекста корня и открывает `/opt/katago` на чтение всем; добавить стадию `engine`), `infra/docker-compose.yml` (три сервиса; `stop_grace_period`, `init`, `healthcheck`; том логов KataGo; `KATAGO_ASSET` и `KATAGO_SHA256` в `args`), `infra/.env.example` (`ENGINE_CPUS`, `KATAGO_ASSET`, `KATAGO_SHA256`), `infra/scripts/deploy.sh` (`--build-web`, каталог снапшотов на VPS)
- Без изменений: `infra/Caddyfile` (`flush_interval -1` на `/api/*` уже есть; `reverse_proxy` сам добавляет `X-Forwarded-For` с адресом клиента)

**Interfaces:**
- Consumes: `infra/docker-compose.yml`, `infra/Caddyfile` (`API_UPSTREAM`), `infra/scripts/deploy.sh [--host goko] [--web-dir DIR]` на HEAD (`trap` на ошибку, проверка `/opt/goko/.env` на VPS, `SYNC` rsync или tar, общий массив `EXCLUDES`); `ARG KATAGO_ASSET`, `ARG KATAGO_SHA256` в `apps/go-engine/Dockerfile` из плана стадии 0; переменные `main.ts` game-server (`APP_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `AGENT_NAME`, `ENGINE_URL`, `ENGINE_KEY`, `DATA_DIR`, `MAX_SESSIONS`, `SESSION_TTL_MS`, `PORT`, `HOST`, `TRUST_PROXY`) из плана ядра и `ALLOW_SESSIONLESS_GAMES` из задачи 9; go-engine (`KATAGO_BIN`, `KATAGO_MODEL`, `KATAGO_HUMAN_MODEL`, `KATAGO_CONFIG`, `ENGINE_KEY`, `ENGINE_PORT`, `ENGINE_HOST`) из плана ядра; `logDir = analysis_logs` (относительный путь) в `apps/go-engine/config/analysis.cfg`; voice-agent (`LIVEKIT_*`, `OPENAI_API_KEY`, `APP_KEY`, `API_BASE`, `AGENT_NAME`, `VOICE_MODE`) и `DRAIN_TIMEOUT_MS` 5 с, `SHUTDOWN_PROCESS_TIMEOUT_MS` 20 с из задачи 4 (шаг 7); `API_RATE` 60 в минуту и `CREATE_RATE` 10 за 10 минут на адрес из `apps/game-server/src/rate-limit.ts`; `apps/web/dist` из задачи 8.
- Produces: образы `goko-game-server`, `goko-go-engine`, `goko-voice-agent` (Node 22 запускает `.ts` напрямую, без сборки); сервисы compose `game-server` (порт `127.0.0.1:8787`, `TRUST_PROXY=1`, без `ALLOW_SESSIONLESS_GAMES`, снапшоты в `/opt/goko/data/games`), `go-engine` (без опубликованных портов, `cpus`, логи KataGo в томе `engine_logs`), `voice-agent`; `deploy.sh [--host goko] [--web-dir DIR] [--build-web]`.

Решения по контейнерам (пункт 7 брифа второго прохода):

- **Порты.** Docker публикует порты через свои правила iptables раньше цепочек ufw, поэтому `ufw deny` их не закрывает. Публикуется только `game-server` и только на `127.0.0.1:8787` — туда ходит Caddy (`network_mode: host`). `go-engine` портов не публикует вовсе (`EXPOSE` в образе — лишь пометка), `game-server` ходит к нему по имени сервиса.
- **`TRUST_PROXY=1` у `game-server`.** Запросы телефона приходят от Caddy, и без флага лимиты частоты и лимит партий на клиента (D-0012) видели бы один адрес на всех. С флагом ключ — последний адрес `X-Forwarded-For`, который пишет Caddy. Подделать заголовок извне нельзя: порт слушает только `127.0.0.1`, а Caddy дописывает настоящий адрес последним. Запрос без заголовка (voice-agent из сети compose) считается по адресу сокета.
- **`ALLOW_SESSIONLESS_GAMES` в compose не задан**, то есть `POST /api/games` выключен (задача 9). Шаг 8 проверяет отсутствие переменной, не печатая значений.
- **PID 1 и остановка.** `CMD` — `node` напрямую в exec-форме, без `npm` и `sh`, и SIGTERM доходит до процесса Node. Плюс `init: true` у всех трёх сервисов: `go-engine` порождает KataGo через `sh`-обёртку, `voice-agent` — процессы заданий и инференса, а Node в роли PID 1 не собирает осиротевших потомков. `tini` пересылает сигнал и собирает их.
- **`stop_grace_period`.**
  - `game-server` и `go-engine` — `30s`: запас над `SHUTDOWN_MS` 25 с (D-0010).
  - `voice-agent` — `60s`. По `@livekit/agents` 1.8.0 остановка идёт так: `drain` ждёт идущие задания не дольше `drainTimeout` (задача 4: 5 с), затем `close` даёт процессу задания `shutdownProcessTimeout` (20 с) на shutdown-колбэки и убивает его, процесс инференса закрывается до 5 с (внутренний `closeTimeout`). В сумме около 30 с; удвоено на медленный диск и сеть при деплое. Меньше 30 с нельзя: SIGKILL обрежет shutdown-колбэки, и сессия Realtime закроется без `close`.
- **Переменные по сервисам** — только `environment` с подстановкой из `/opt/goko/.env`, без `env_file` (он передал бы контейнеру весь `.env`):
  - `go-engine` — только `ENGINE_KEY`;
  - `game-server` — без `OPENAI_API_KEY`;
  - `voice-agent` — `LIVEKIT_*`, `OPENAI_API_KEY`, `APP_KEY`, без `ENGINE_KEY`.
  - Пути KataGo (`KATAGO_BIN`, `KATAGO_MODEL`, `KATAGO_HUMAN_MODEL`, `KATAGO_CONFIG`) заданы явно в образе, `.env` на VPS их не задаёт.
- **Данные.** Снапшоты — bind-mount `/opt/goko/data` → `/data`, партии в `/data/games` (`DATA_DIR` в образе). Путь на хосте известен, поэтому runbook (задача 11) чистит брошенные партии без `docker cp`. Каталог принадлежит uid 1000 (`node` в образе).
  - Логи KataGo: `logDir = analysis_logs` в `analysis.cfg` относительный (долг стадии 0 в `docs/research/stage0-results.md`), процесс KataGo наследует рабочий каталог `/app`, а `/app` принадлежит root.
  - Образ создаёт `/app/analysis_logs` с владельцем `node`, compose монтирует туда именованный том `engine_logs`: новый том наследует владельца каталога образа, логи переживают пересборку, а место под них видно в `docker system df -v`.
  - `logAllRequests` и `logSearchInfo` выключены: один файл на запуск KataGo, килобайты. Правка `analysis.cfg` не нужна.

**Серверная квота voice-agent — отдельного ключа нет (R2, серверная часть).** voice-agent ходит в `game-server` по сети compose мимо Caddy и без `X-Forwarded-For`, поэтому все его запросы — один ключ, адрес контейнера. На этот ключ действуют общие правила: `API_RATE` 60 запросов в минуту и `CREATE_RATE` 10 созданий за 10 минут. Расчёт на `MAX_SESSIONS` = 3.

Запросы агента за одну сессию:
- `play_move`, `correct_last_move`, `pass`, `undo` — 1 запрос;
- `get_position`, `get_assessment` — 2 (`getGame` вместе с `ascii` или `analyze`);
- `set_rank`, `resign` — 2 (`getGame` для цвета, затем сама операция);
- `start_game` — 1 создание;
- открытие потока — 1 запрос за соединение, события в счёт не идут.

Реплика в разговоре занимает не меньше 4 с: речь человека, ответ модели, инструмент и речь Гоко. Отсюда:
- обычная минута партии — 8 ходов и 1 вопрос о позиции, 10 запросов;
- пиковая — 15 реплик по 1 запросу, 15 запросов;
- конец партии — `score` в бюджете 20 с и не больше 8 опросов `getGame` раз в 2,5 с (задача 2), до 9 запросов раз за партию;
- потеря связи — переподключения потока 1, 2, 4, 8, 15 с, не больше 5 открытий в первую минуту.

На три сессии:
- обычный режим — 30 запросов в минуту;
- все три на пике и одна при этом заканчивает партию — 45 + 9 = 54 < 60.

Созданий за 10 минут: партия 13×13 длится дольше 10 минут, поэтому три сессии дают 3–6 созданий, меньше 10. Зацикленную на `new_game` модель остановит предел 10 созданий за 10 минут на адрес voice-agent (общий для всех сессий), а не лимит 3 партий на клиента: заменённая партия сессии брошена и в счёт не идёт (задача 9).

За предел выходит только теоретический случай — три сессии каждые 4 с целую минуту задают вопросы на 2 запроса (90 в минуту). Тогда агент получает `rate_limited`, ждёт `Retry-After` (`blockedUntil`, задача 2) и говорит «слишком много запросов, подожди немного»: деградация, а не отказ.

Отдельный ключ (`X-Agent-Key` с секретом `AGENT_KEY`) не нужен:
- он не отделил бы зациклившуюся сессию от соседних, у всех сессий агента он общий;
- утёкший, он снял бы лимиты с любого клиента;
- это ещё один секрет и ещё код.

`[!]` При `MAX_SESSIONS` больше 3 пересчитать: 4 × 15 = 60, пик упирается в предел. Тогда решать между ключом агента и лимитом по сессии.

- [ ] **Step 1: `.dockerignore` в корне** (контекст сборки — корень репозитория)

```
.git
node_modules
**/node_modules
data
apps/web/dist
apps/go-engine/models
apps/go-engine/bin
.env
.env.*
docs
spike
*.log
```

- [ ] **Step 2: `apps/game-server/Dockerfile`**

```dockerfile
# game-server: Node 22 запускает TypeScript напрямую (type stripping), сборка не нужна.
# npm ci по workspace'у ставит только его зависимости; package.json workspace'ов нужны для lock-файла
# (spike/ исключён .dockerignore — если npm ci на это ругается, см. шаг 8).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/go-core/package.json packages/go-core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/go-engine/package.json apps/go-engine/
COPY apps/game-server/package.json apps/game-server/
COPY apps/voice-agent/package.json apps/voice-agent/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/game-server --include-workspace-root=false
COPY packages/go-core/src packages/go-core/src
COPY packages/protocol/src packages/protocol/src
COPY apps/game-server/src apps/game-server/src
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data/games
EXPOSE 8787
USER node
CMD ["node", "apps/game-server/src/main.ts"]
```

Если `npm ci --workspace` в установленной версии npm не принимает `--include-workspace-root=false`, убрать этот флаг: корень зависимостей не имеет, кроме dev.

- [ ] **Step 3: `apps/voice-agent/Dockerfile`**

```dockerfile
# voice-agent: воркер LiveKit Agents. download-files кладёт модель Silero VAD (режим pipeline) в кэш образа.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/go-core/package.json packages/go-core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/go-engine/package.json apps/go-engine/
COPY apps/game-server/package.json apps/game-server/
COPY apps/voice-agent/package.json apps/voice-agent/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/voice-agent --include-workspace-root=false
COPY packages/go-core/src packages/go-core/src
COPY packages/protocol/src packages/protocol/src
COPY apps/voice-agent/src apps/voice-agent/src
RUN npx livekit-agents download-files
ENV VOICE_MODE=realtime API_BASE=http://game-server:8787
USER node
CMD ["node", "apps/voice-agent/src/main.ts", "start"]
```

- [ ] **Step 4: `apps/go-engine/Dockerfile` — стадия `engine`**

Контекст сборки теперь корень репозитория (compose: `context: ..`), а не `apps/go-engine`: стадии `engine` нужны `packages/*`. В стадии `katago` из плана стадии 0 две правки:
- строку `COPY config/analysis.cfg /opt/katago/analysis.cfg` заменить на `COPY apps/go-engine/config/analysis.cfg /opt/katago/analysis.cfg`;
- последнюю строку `CMD` и комментарий над ней удалить;
- на их место, последней строкой стадии `katago`, дописать:

```dockerfile
# Сервис engine работает под node: бинарник, обёртка и сети должны читаться всеми,
# даже если релизный zip кладёт файлы с правами 600.
RUN chmod -R a+rX /opt/katago
```

`apps/go-engine/.dockerignore` при контексте корня не читается; его работу (не тащить `models/` и `bin/`) делает корневой `.dockerignore` из шага 1. Замер стадии 0 теперь собирается из корня: `docker build -f apps/go-engine/Dockerfile --target katago .`. После стадии `katago` дописать:

```dockerfile
# Стадия engine: Node 22 с обёрткой поверх бинарника и сетей из стадии katago.
FROM node:22-slim AS engine
ENV NODE_ENV=production
# libzip4 — имя пакета в Debian bookworm (в Ubuntu noble — libzip4t64); libgomp1 нужен eigen-сборке KataGo (OpenMP).
RUN apt-get update && apt-get install -y --no-install-recommends libzip4 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=katago /opt/katago /opt/katago
WORKDIR /app
# logDir = analysis_logs в analysis.cfg относительный: KataGo пишет в рабочий каталог /app/analysis_logs.
# Каталог принадлежит node, compose монтирует сюда том engine_logs (новый том наследует владельца).
RUN mkdir analysis_logs && chown node:node analysis_logs
COPY package.json package-lock.json ./
COPY packages/go-core/package.json packages/go-core/
COPY packages/protocol/package.json packages/protocol/
COPY apps/go-engine/package.json apps/go-engine/
COPY apps/game-server/package.json apps/game-server/
COPY apps/voice-agent/package.json apps/voice-agent/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/go-engine --include-workspace-root=false
COPY packages/go-core/src packages/go-core/src
COPY packages/protocol/src packages/protocol/src
COPY apps/go-engine/src apps/go-engine/src
COPY apps/go-engine/config apps/go-engine/config
ENV KATAGO_BIN=/opt/katago/katago \
    KATAGO_MODEL=/opt/katago/models/main.txt.gz \
    KATAGO_HUMAN_MODEL=/opt/katago/models/human.bin.gz \
    KATAGO_CONFIG=/opt/katago/analysis.cfg \
    ENGINE_HOST=0.0.0.0 ENGINE_PORT=8788
EXPOSE 8788
USER node
CMD ["node", "apps/go-engine/src/main.ts"]
```

Стадия `engine` (`node:22-slim`, Debian bookworm, `libzip4`) поверх бинарника из `ubuntu:24.04` до деплоя не собиралась. Если на ПК есть Docker (нужна сеть, бесплатно):

Run: `docker build -f apps/go-engine/Dockerfile --target engine -t goko-go-engine . && docker run --rm --entrypoint /opt/katago/katago goko-go-engine version`
Expected: образ собран, `version` печатает версию KataGo 1.18.1 под пользователем `node`. Без Docker на ПК проверка переносится на VPS: первая сборка в `deploy.sh`.

- [ ] **Step 5: `infra/docker-compose.yml` — три сервиса** (после `livekit`, перед `volumes:`)

```yaml
  game-server:
    build:
      context: ..
      dockerfile: apps/game-server/Dockerfile
    restart: unless-stopped
    # tini PID 1: пересылает SIGTERM node и собирает осиротевших потомков.
    init: true
    # Остановка game-server укладывается в SHUTDOWN_MS 25 с (D-0010); docker stop по умолчанию ждёт 10 с и шлёт SIGKILL.
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8787/health').then((r) => r.json()).then((j) => process.exit(j.ok ? 0 : 1), () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    # Только 127.0.0.1: порты Docker обходят ufw. Сюда ходит Caddy (network_mode: host).
    ports:
      - "127.0.0.1:8787:8787"
    # Переменные по одной, без env_file: контейнер не видит OPENAI_API_KEY и прочее из .env.
    # ALLOW_SESSIONLESS_GAMES не задан намеренно: POST /api/games в prod выключен (D-0012).
    environment:
      APP_KEY: ${APP_KEY}
      LIVEKIT_URL: ${LIVEKIT_URL}
      LIVEKIT_API_KEY: ${LIVEKIT_API_KEY}
      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
      AGENT_NAME: ${AGENT_NAME:-goko}
      ENGINE_URL: http://go-engine:8788
      ENGINE_KEY: ${ENGINE_KEY}
      MAX_SESSIONS: ${MAX_SESSIONS:-3}
      SESSION_TTL_MS: ${SESSION_TTL_MS:-7200000}
      # За Caddy: ключ лимитов — последний адрес X-Forwarded-For; voice-agent без заголовка — по адресу сокета.
      TRUST_PROXY: "1"
    # Снапшоты партий: /opt/goko/data/games на хосте (DATA_DIR=/data/games в образе), владелец uid 1000.
    volumes:
      - /opt/goko/data:/data
    depends_on:
      - go-engine

  go-engine:
    build:
      context: ..
      dockerfile: apps/go-engine/Dockerfile
      # Сумма идёт в паре со сборкой: Dockerfile проверяет zip через sha256sum -c.
      # Пустые или незаданные переменные — сборка eigenavx2 и её сумма из Dockerfile стадии 0.
      args:
        KATAGO_ASSET: ${KATAGO_ASSET:-katago-v1.18.1-eigenavx2-linux-x64.zip}
        KATAGO_SHA256: ${KATAGO_SHA256:-33e79780dbe3bf6ee859e16f64952cdfc90f7210c8f71ad978ffcba85ad20d79}
    restart: unless-stopped
    # KataGo запускается через sh-обёртку: tini собирает потомков, которых Node в роли PID 1 не соберёт.
    init: true
    # Остановка KataGo: SIGTERM -> stop() движка; запас над 25 с, как у game-server (D-0010).
    stop_grace_period: 30s
    # Портов нет: go-engine доступен только game-server по имени сервиса в сети compose.
    # Порт открывается только после прогрева KataGo (до 300 с, D-0010): start_period с запасом,
    # неудачи в нём не считаются, первая удачная проверка сразу делает сервис healthy.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8788/health').then((r) => r.json()).then((j) => process.exit(j.ok ? 0 : 1), () => process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 320s
    cpus: ${ENGINE_CPUS:-1.5}
    # Только ключ движка: пути KataGo заданы в образе, LIVEKIT_* и OPENAI_API_KEY движку не нужны.
    environment:
      ENGINE_KEY: ${ENGINE_KEY}
    # Логи KataGo (logDir = analysis_logs относительно /app): один файл на запуск, в томе, а не в слое контейнера.
    volumes:
      - engine_logs:/app/analysis_logs

  voice-agent:
    build:
      context: ..
      dockerfile: apps/voice-agent/Dockerfile
    restart: unless-stopped
    init: true
    # drain 5 с + shutdownProcessTimeout 20 с + закрытие инференса до 5 с ≈ 30 с (задача 4, main.ts); запас вдвое.
    stop_grace_period: 60s
    environment:
      LIVEKIT_URL: ${LIVEKIT_URL}
      LIVEKIT_API_KEY: ${LIVEKIT_API_KEY}
      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      APP_KEY: ${APP_KEY}
      AGENT_NAME: ${AGENT_NAME:-goko}
      VOICE_MODE: ${VOICE_MODE:-realtime}
    depends_on:
      - game-server
```

В корневой секции `volumes:` после `caddy_config:` добавить строку `  engine_logs:`.

Почему так: `caddy` и `livekit` в `network_mode: host`, поэтому `API_UPSTREAM=127.0.0.1:8787` из плана стадии 0 попадает в опубликованный порт `game-server`; `go-engine` наружу не публикуется, `game-server` ходит к нему по имени сервиса; `voice-agent` ходит в LiveKit по публичному `LIVEKIT_URL` (`wss://<LK_HOST>`, тот же адрес, что у телефона) и в `game-server` по имени сервиса (`API_BASE` задан в образе). Секретов в файле нет — только подстановки из `/opt/goko/.env`.

`game-server` зависит от `go-engine` без `condition: service_healthy` намеренно: иначе страница и сессии ждали бы прогрева KataGo до 5 минут, а до готовности движка ходы и так получают `engine_unavailable` с повторами сервера (D-0006). `/health` у обоих сервисов не требует ключа, поэтому секретов в проверке нет. `[!]` Закрыть `[TODO]` из `docs/NOW.md` про `stop_grace_period` game-server — в задаче 11.

SSE за Caddy: `infra/Caddyfile` уже содержит нужное, правка не нужна. Синтаксис Caddy 2 — субдиректива `flush_interval` внутри блока `reverse_proxy`, отрицательное значение отключает буфер и сбрасывает ответ после каждой записи (документация `reverse_proxy`, раздел Streaming):

```caddyfile
{$WEB_HOST} {
  handle /api/* {
    reverse_proxy {$API_UPSTREAM} {
      flush_interval -1
    }
  }
  # ...
}
```

Живая проверка потока и адреса за Caddy — задача 11, раздел runbook «Проверки после деплоя».

- [ ] **Step 6: `infra/.env.example`** (в конец)

```
ENGINE_CPUS=1.5                    # лимит CPU контейнера go-engine, чтобы LiveKit и Caddy не голодали во время analyze
KATAGO_ASSET=katago-v1.18.1-eigenavx2-linux-x64.zip   # без AVX2 на VPS: katago-v1.18.1-eigen-linux-x64.zip
KATAGO_SHA256=                     # при смене KATAGO_ASSET — sha256 скачанного zip этой сборки; пусто — сумма eigenavx2 из Dockerfile
```

- [ ] **Step 7: `infra/scripts/deploy.sh`**

Правка — дифф к версии на HEAD, файл целиком не заменять. На HEAD уже есть `trap` на ошибку, проверка `/opt/goko/.env` на VPS, выбор `SYNC` (rsync или tar по ssh для Git Bash без rsync), общий массив `EXCLUDES` (в нём `apps/go-engine/bin`, `dist build coverage`, `.superpowers`, `spike/log.jsonl`, `spike/last-url.txt`) и блок статики по `WEB_DIR` через `$SYNC`. Всё это остаётся как есть.

1. Строку использования (`# Использование: infra/scripts/deploy.sh [--host goko] [--web-dir apps/web/dist]`) заменить на две:

```bash
# Использование: infra/scripts/deploy.sh [--host goko] [--web-dir apps/web/dist] [--build-web]
#   --build-web: собрать apps/web (npm run build:web) и выложить apps/web/dist как статику
```

2. После `WEB_DIR=""` добавить строку `BUILD_WEB=0`; в `case` после ветки `--web-dir` добавить ветку:

```bash
    --build-web) BUILD_WEB=1; shift;;
```

3. Сразу после строки `ROOT="$(cd "$(dirname "$0")/../.." && pwd)"` добавить:

```bash

if [ "$BUILD_WEB" = 1 ]; then
  (cd "$ROOT" && npm run build:web)
  WEB_DIR="apps/web/dist"
fi
```

4. `EXCLUDES`, ветки rsync и tar и блок статики не трогать: шаблон `dist` уже закрывает `apps/web/dist` при синхронизации репозитория, а статика уезжает отдельно по `WEB_DIR`.

5. В удалённом блоке (`REMOTE`) перед строкой `cd /opt/goko/src/infra` добавить:

```bash
# Снапшоты партий пишет node (uid 1000) в контейнере game-server; bootstrap создал /opt/goko/data от root.
install -d -o 1000 -g 1000 /opt/goko/data/games
```

`docker compose up -d --build` и итоговая строка `[OK] deploy` без изменений. `APP_KEY` в бандл берётся из `.env` на ПК: он должен совпадать с `APP_KEY` в `/opt/goko/.env`, иначе телефон получит `401 unauthorized`.

- [ ] **Step 8: Проверка на ПК**

Проверки `docker compose config` и `docker build` ниже — если на ПК есть Docker; иначе они переносятся на VPS перед деплоем (там же, из `/opt/goko/src/infra`, с теми же фиктивными значениями и без печати настоящих).

Run: `cd infra && WEB_HOST=goko.example.org LK_HOST=goko-lk.example.org LIVEKIT_API_KEY=k LIVEKIT_API_SECRET=s APP_KEY=a ENGINE_KEY=e OPENAI_API_KEY=o LIVEKIT_URL=wss://goko-lk.example.org docker compose config >/dev/null && echo "[OK] compose"`
Expected: `[OK] compose` (значения подстановок в вывод не печатать: `config` их раскрывает, поэтому `>/dev/null`). Фиктивные значения в этой команде — только для проверки синтаксиса, не настоящие ключи. Проверить без раскрытия значений (печатаются только имена переменных, длительности и порты), что остановка, порты и переменные по сервисам на месте:

```bash
cd infra && WEB_HOST=x LK_HOST=x LIVEKIT_API_KEY=x LIVEKIT_API_SECRET=x APP_KEY=x ENGINE_KEY=x OPENAI_API_KEY=x LIVEKIT_URL=wss://x docker compose config --format json | node -e "
const c = JSON.parse(require('fs').readFileSync(0, 'utf8')).services;
for (const s of ['game-server', 'go-engine', 'voice-agent']) {
  const env = Object.keys(c[s].environment ?? {}).sort().join(',');
  const ports = (c[s].ports ?? []).map((p) => (p.host_ip ?? '*') + ':' + p.published).join(',') || '-';
  console.log(s, c[s].stop_grace_period, 'init=' + c[s].init, 'ports=' + ports, 'env=' + env);
}
const ok = c['game-server'].environment.TRUST_PROXY === '1' && !('ALLOW_SESSIONLESS_GAMES' in c['game-server'].environment)
  && !('OPENAI_API_KEY' in c['game-server'].environment) && Object.keys(c['go-engine'].environment).join() === 'ENGINE_KEY'
  && !c['go-engine'].ports && c['game-server'].ports.every((p) => p.host_ip === '127.0.0.1');
console.log(ok ? '[OK] compose: TRUST_PROXY, без партий вне сессии, порты и переменные по сервисам' : '[X] compose: см. строки выше');
process.exit(ok ? 0 : 1);
"
```

Expected: строки `game-server 30s init=true ports=127.0.0.1:8787 env=AGENT_NAME,APP_KEY,ENGINE_KEY,ENGINE_URL,LIVEKIT_API_KEY,LIVEKIT_API_SECRET,LIVEKIT_URL,MAX_SESSIONS,SESSION_TTL_MS,TRUST_PROXY`, `go-engine 30s init=true ports=- env=ENGINE_KEY`, `voice-agent 1m0s init=true ports=- env=AGENT_NAME,APP_KEY,LIVEKIT_API_KEY,LIVEKIT_API_SECRET,LIVEKIT_URL,OPENAI_API_KEY,VOICE_MODE` и `[OK] compose: ...` (compose может нормализовать длительности: `1m0s` = `60s`; `published` бывает строкой). `TRUST_PROXY` сравнивается внутри скрипта и не печатается; остальные значения не выводятся.

Run: `git grep -n "createGame\|'/api/games'" -- apps/voice-agent apps/web scripts/chat.mjs || echo "[OK] партии создаются только через сессию"`
Expected: только `[OK]` — с выключенным `POST /api/games` агент, веб и консоль работают.

Run (если на ПК есть Docker; go-engine здесь не собирать — его проверка с загрузкой KataGo и сетей в шаге 4): `docker build -f apps/game-server/Dockerfile -t goko-game-server . && docker build -f apps/voice-agent/Dockerfile -t goko-voice-agent .`
Expected: оба образа собираются; `docker run --rm goko-game-server` печатает пять строк `[X] game-server: нужна переменная …` (`APP_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ENGINE_KEY`), первая — `[X] game-server: нужна переменная APP_KEY (см. infra/.env.example)`, и завершается с кодом 2 (переменные не заданы — это ожидаемо и подтверждает, что `.ts` запускается).

Корневые workspaces включают `spike` (`package.json`, `package-lock.json`), а Dockerfile копируют `package.json` без `spike/`, и `.dockerignore` исключает `spike`. `npm ci --workspace` лишнюю запись lock, скорее всего, терпит, но до деплоя это проверяет только сборка выше. Если `npm ci` в сборке падает на отсутствующем `spike` — во все три Dockerfile после строки `COPY apps/web/package.json apps/web/` добавить `COPY spike/package.json spike/`, в `.dockerignore` после строки `spike` — строку `!spike/package.json`; убрать обе правки вместе с удалением `spike/` (задача 8 стадии 0). Без Docker на ПК это проверит первая сборка на VPS.

Run: `bash -n infra/scripts/deploy.sh && echo "[OK] deploy.sh"`
Expected: `[OK] deploy.sh`.

Run (исключения HEAD не потеряны при правке): `grep -c "spike/log.jsonl\|.superpowers" infra/scripts/deploy.sh`
Expected: число не меньше 1, не `0`. `bash -n` проверяет только синтаксис и потерю исключений или ветки tar не заметит. Сам деплой не запускать: только по явной просьбе founder'а (правило 5 `CLAUDE.md`).

- [ ] **Step 9: Commit**

```bash
git add .dockerignore apps/game-server/Dockerfile apps/voice-agent/Dockerfile apps/go-engine/Dockerfile infra/docker-compose.yml infra/.env.example infra/scripts/deploy.sh
git commit -m "infra: контейнеры game-server, go-engine, voice-agent; сервисы compose; deploy --build-web"
```

---

### Task 11: Runbook VPS, доки, `NOW.md`, финальная проверка

**Files:**
- Create: `docs/runbooks/vps.md`
- Modify: `docs/README.md` (строка `runbooks/`), `CLAUDE.md` (строка стадии, раздел команд), `README.md` (статус, раздел «Запуск»), `docs/NOW.md`, `infra/.env.example` (комментарий `SESSION_TTL_MS`)
- Modify только при проблеме на шаге 7: `scripts/dev.mjs` (web без `cmd.exe`), `scripts/dev.test.ts`

**Interfaces:**
- Consumes: команды из задачи 5 (`npm run chat`), задачи 8 (`npm run build:web`, запуск web через `node node_modules/vite/bin/vite.js`), задачи 10 (`deploy.sh --build-web`, сервисы compose, `stop_grace_period`, `init`, `healthcheck`, `TRUST_PROXY=1`, `/opt/goko/data/games`, том `engine_logs`); задачи 9 (`ALLOW_SESSIONLESS_GAMES`, `too_many_games` со `scope: 'client'`, отметка брошенной сменой партии — пустой `data/games/<id>.abandoned`); `STALE_GAME_MS = SESSION_TTL_MS` и `FINISHED_RETENTION_MS` 30 дней из `apps/game-server/src/service.ts` (завершённые снапшоты удаляются сами, незавершённые — никогда); снапшот `data/games/<id>.json` с `status`, `createdAt`, `moves[].at` из `apps/game-server/src/store.ts`; `API_RATE` 60 в минуту на адрес; `infra/README.md` из плана стадии 0 (первичная настройка); `devPlan(parentEnv, exists, makeKey?)` из `scripts/dev.mjs` плана ядра.
- Produces: `docs/runbooks/vps.md` — эксплуатация после деплоя с живыми проверками SSE за Caddy, `empty_timeout` (D-0001), адреса клиента за Caddy и выключенных партий без сессии; ручная чистка брошенных незавершённых партий; комментарий `SESSION_TTL_MS` в `infra/.env.example`; доки со статусом «стадия 1 готова»; результат проверки Ctrl+C `npm run dev` с web на Windows.

- [ ] **Step 1: `docs/runbooks/vps.md`**

````markdown
---
status: living
area: infra
updated: <дата выполнения>
---

# Runbook: VPS Гоко

Эксплуатация после первичной настройки (`infra/README.md`). Все команды на VPS
выполняются из `/opt/goko/src/infra` с `--env-file /opt/goko/.env`; ниже
`dc` = `docker compose --env-file /opt/goko/.env`. Значения переменных из
`.env` не печатать и не вставлять в доки и issue.

## Состав

| Сервис | Что | Порт |
|---|---|---|
| `caddy` | TLS, статика `<WEB_HOST>` из `/opt/goko/web`, `/api/*` → `API_UPSTREAM`, `<LK_HOST>` → LiveKit | 80, 443 (host) |
| `livekit` | комнаты, TURN | 7880, 7881/tcp, 3478/udp, 30000–40000/udp, 50000–60000/udp (host) |
| `game-server` | сессии, партии, SSE, токены | `127.0.0.1:8787` |
| `go-engine` | KataGo: genmove / analyze / score | не публикуется; внутренняя сеть, `go-engine:8788` |
| `voice-agent` | воркер LiveKit Agents `goko` | портов нет |

Снапшоты партий — `/opt/goko/data/games` (bind-mount в `game-server`,
владелец uid 1000, каталог создаёт `deploy.sh`). Логи KataGo — том
`engine_logs` (`/app/analysis_logs` в `go-engine`), один файл на запуск.
Порты Docker обходят ufw: наружу не публиковать ничего, кроме того, что в
таблице.

## Деплой (с ПК, по явной просьбе founder'а)

```bash
infra/scripts/deploy.sh --build-web      # собрать web с APP_KEY из .env на ПК, выложить статику, пересобрать образы
infra/scripts/deploy.sh                  # только код и образы, статику не трогать
```

`APP_KEY` в `.env` на ПК и в `/opt/goko/.env` должны совпадать: ключ зашит в
бандл страницы. Первая сборка `go-engine` качает KataGo и две сети (около 200
МБ) и занимает несколько минут; дальше слои кэшируются.

## Логи и состояние

```bash
dc ps
dc logs -f --tail=100 voice-agent      # реплики [user]/[goko]/[tool], без содержимого ключей
dc logs -f --tail=100 game-server
dc logs -f --tail=100 go-engine        # старт KataGo, очередь, перезапуски
dc logs -f --tail=100 livekit
```

Признаки здоровья:

```bash
curl -s http://127.0.0.1:8787/health                 # {"ok":true,"games":N,"sessions":M}
dc exec go-engine node -e "fetch('http://127.0.0.1:8788/health').then(r=>r.text()).then(console.log)"
curl -sI https://<WEB_HOST>/ | head -1               # HTTP/2 200
curl -s https://<LK_HOST>/                          # OK
dc logs voice-agent | grep -c "registered worker"   # не 0 — воркер зарегистрирован (без --tail: после регистрации бывает много строк заданий)
dc ps --format '{{.Service}} {{.Status}}'           # game-server и go-engine: (healthy); go-engine до 5 мин после старта — (health: starting), идёт прогрев KataGo
```

## Проверки после деплоя

Бесплатные (Realtime не открывается: телефон в комнату не входит, агент ждёт
участника), но это действия на VPS — только по явной просьбе founder'а.
Каждая занимает один слот `MAX_SESSIONS` до истечения TTL сессии; если слот
нужен сразу, а никто не играет, — `dc restart game-server`. Значения из
`.env` читаются в подоболочке и не печатаются; ответ `POST /api/sessions`
содержит токен LiveKit, поэтому из него вырезается только id сессии.

```bash
# 1. Сессия и поток SSE через Caddy: строки должны приходить по одной, со своими метками времени,
#    а не пачкой при закрытии (flush_interval -1 на /api/*). Выход — Ctrl+C.
( set -a; . /opt/goko/.env; set +a
  SID=$(curl -s -X POST -H "X-App-Key: $APP_KEY" -H 'content-type: application/json' -d '{}' "https://$WEB_HOST/api/sessions" \
    | grep -o '"id":"[0-9a-z]*"' | head -1 | cut -d'"' -f4)
  [ -n "$SID" ] && echo "[OK] сессия $SID, комната goko-$SID" || { echo "[X] сессия не создана"; exit 1; }
  curl -sN -H "X-App-Key: $APP_KEY" "https://$WEB_HOST/api/sessions/$SID/events" \
    | while IFS= read -r line; do echo "$(date +%T) $line"; done )
```

Ожидание: `[OK] сессия …`, затем тишина около 15 с — у только что созданной
сессии партии нет, начальных событий поток не шлёт. Первая строка `: ping`
примерно через 15 с после запуска, дальше каждые 15 с (`DEFAULT_HEARTBEAT_MS`),
у каждой своя метка времени с шагом 15 с. Если строк нет до Ctrl+C и потом они
приходят пачкой — буферизует прокси: проверить `infra/Caddyfile` на VPS и
`dc up -d caddy`.

```bash
# 2. D-0001: комната с одним агентом (телефон не вошёл) закрывается по empty_timeout 300 с.
#    SID задан в подоболочке проверки 1 и здесь пуст: взять id из её строки [OK]; засечь время создания сессии.
SID=<id из строки [OK] проверки 1>
dc logs -f --since 10m livekit | grep --line-buffered "goko-$SID"
dc logs -f --since 10m voice-agent | grep --line-buffered -i "job\|goko-$SID"
```

Ожидание: в логе LiveKit — создание комнаты `goko-<SID>` и вход агента, затем
не позже чем через 5–6 минут после создания — закрытие комнаты; в логе
воркера — завершение задания. Если комната живёт дольше 10 минут, агент
удерживает её от `empty_timeout`: записать `[!]` в `docs/NOW.md` с временем и
строками лога (без значений `.env`) и вынести в D-0001 на решение founder'а.

```bash
# 3. D-0012: за Caddy лимит частоты считает адрес клиента, а не адрес Caddy (TRUST_PROXY=1).
#    На VPS: 61 чтение через публичный адрес — последнее получает 429 (60 в минуту на адрес).
#    Не раньше чем через минуту после проверок 1–2 (их запросы с VPS тоже в счёте).
( set -a; . /opt/goko/.env; set +a
  for i in $(seq 61); do curl -s -o /dev/null -w '%{http_code}\n' -H "X-App-Key: $APP_KEY" "https://$WEB_HOST/api/games"; done \
    | sort | uniq -c )
```

Ожидание: `60 200` и `1 429`. Сразу после этого, в ту же минуту, с ПК (другая
сеть; `.env` на ПК, значение не печатается):

```bash
( set -a; . ./.env; set +a; read -r -p "WEB_HOST: " H
  curl -s -o /dev/null -w '%{http_code}\n' -H "X-App-Key: $APP_KEY" "https://$H/api/games" )
```

Ожидание: `200` — у ПК свой счёт. `429` значит, что game-server видит всех
клиентов одним адресом: проверить `TRUST_PROXY` у сервиса без печати значения
(`dc exec game-server node -e "console.log(process.env.TRUST_PROXY === '1')"` →
`true`). Страницу на телефоне для этой проверки не открывать: она создаёт
сессию, агент входит в Realtime, и это платный прогон. Телефон ходит через тот
же Caddy, что и ПК, поэтому ответ ПК подтверждает и адрес телефона.

```bash
# 4. D-0012: партия без сессии в prod выключена, партия в сессии создаётся.
#    Не раньше чем через минуту после проверки 3: она исчерпала API_RATE адреса VPS в 60-секундном окне,
#    лимитер стоит раньше маршрута, и в ту же минуту ответ был бы 429 rate_limited, а не bad_request.
( set -a; . /opt/goko/.env; set +a
  curl -s -X POST -H "X-App-Key: $APP_KEY" -H 'content-type: application/json' \
    -d '{"black":{"controller":"human"},"white":{"controller":"human"}}' "https://$WEB_HOST/api/games" )
```

Ожидание: `{"error":{"code":"bad_request","message":"games are created only inside a session","details":{"reason":"sessionless_disabled"}}}`.
Токена в ответе нет, печатать можно. Партию в сессии проверяет приёмка у доски.

## Брошенные незавершённые партии

Завершённые снапшоты `game-server` удаляет сам через 30 дней. Незавершённые
не удаляет никогда. Брошенной считается партия без хода дольше
`SESSION_TTL_MS` (по умолчанию 2 часа) и партия, заменённая новой в своей
сессии: у второй рядом со снапшотом лежит пустой файл `<id>.abandoned`
(D-0012). Брошенная в лимиты (20 на сервер, 3 на клиента) не идёт, пока к ней
не вернулись, но файлы остаются и загружаются в память при каждом старте.
Чистить руками, когда `games` в `/health` заметно растёт, или раз в месяц.

```bash
# Список: незавершённые партии без активности дольше DAYS дней. Печатает только имя файла,
# время последнего хода и число ходов — ни ключей, ни окружения. go-engine не поднимается (--no-deps).
DAYS=7
dc run --rm --no-deps -T -e DAYS=$DAYS game-server node -e '
const fs = require("fs");
const dir = "/data/games";
const cutoff = Date.now() - Number(process.env.DAYS) * 86400000;
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
  let g;
  try { g = JSON.parse(fs.readFileSync(dir + "/" + name, "utf8")); } catch { console.log("[!] не читается:", name); continue; }
  const last = Date.parse(g.moves.at(-1)?.at ?? g.createdAt);
  const mark = fs.existsSync(dir + "/" + name.slice(0, -".json".length) + ".abandoned") ? "отметка смены" : "";
  if (g.status === "playing" && last < cutoff) console.log(name, new Date(last).toISOString(), "ходов:", g.moves.length, mark);
}'
```

Удаление — только файлов из списка, просмотренного глазами, и при
остановленном `game-server`: работающий сервер держит партии в памяти и
перепишет удалённый файл следующим ходом.

```bash
dc stop game-server                     # до 30 с; сессии и комнаты теряются
cd /opt/goko/data/games && rm -i <id>.json <id>.abandoned   # имена из списка, отметку вместе со снапшотом (её может не быть); *.tmp — остатки оборванной записи, их тоже можно
cd /opt/goko/src/infra && dc start game-server
```

Логи KataGo в томе `engine_logs` растут на файл за запуск движка; место —
`docker system df -v`, очистка — `dc exec go-engine sh -c 'find /app/analysis_logs -type f -mtime +30 -delete'`.

## Перезапуск и обновление одного сервиса

```bash
dc restart voice-agent                  # без пересборки
dc up -d --build voice-agent            # пересобрать после правки кода (после rsync через deploy.sh)
dc up -d --build go-engine              # то же для движка; партии в это время получат engine_unavailable
```

`game-server` при рестарте загружает снапшоты из `/opt/goko/data/games`;
сессии и комнаты LiveKit при этом теряются — телефон создаст новую сессию сам.
Остановка `game-server` и `go-engine` может занять до 30 с (`stop_grace_period`,
D-0010): сервис дожидается запросов и гасит KataGo, ждать без `docker kill`.
После рестарта `go-engine` до 5 минут в `(health: starting)` — прогрев KataGo;
ходы в это время получают `engine_unavailable` и повторяются сервером.

## Режимы API: prod и dev

В `/opt/goko/.env`:

- prod: `API_UPSTREAM=127.0.0.1:8787` — контейнер `game-server` на VPS, воркер `goko` в контейнере.
- dev: `API_UPSTREAM=http://<tailscale-ip-ПК>:8787` — game-server и воркер `goko-dev` на ПК (`npm run dev`), VPS даёт только TLS, LiveKit и статику.

Переключение:

```bash
dc up -d caddy                          # перечитать API_UPSTREAM
```

В dev-режиме контейнер `voice-agent` может оставаться запущенным: имя `goko`
в комнаты dev-сессий не диспетчеризуется (game-server на ПК выпускает токены с
`goko-dev`).

`[!]` `npm run dev` запускает game-server с `ALLOW_SESSIONLESS_GAMES=1` и без
`TRUST_PROXY`: пока Caddy смотрит на ПК, `POST /api/games` открыт всем, у кого
есть `APP_KEY` из бандла, а лимиты частоты и партий считают всех клиентов
одним адресом Caddy. Держать dev-режим только на время отладки и возвращать
prod тем же `dc up -d caddy`.

## Откат

```bash
# на ПК: вернуть рабочий коммит и задеплоить его
git checkout <commit> && infra/scripts/deploy.sh --build-web && git checkout -   # вернуться на ветку, с которой ушли
# на VPS: остановить всё
dc down
```

Снапшоты партий при откате не трогаются; формат снапшота обратно совместим в
пределах стадии 1.

## Место и ресурсы

```bash
df -h /                                 # диск
docker system prune -f                  # старые слои образов после пересборок
dc stats --no-stream                    # CPU/RAM; go-engine ограничен ENGINE_CPUS
```

Если `analyze` регулярно упирается в таймауты (`engine_busy` в логах
game-server), поднять `ENGINE_CPUS` или сделать рескейл cx23 → cx33 в панели
Hetzner (только CPU/RAM, без переезда), затем `dc up -d go-engine`.

## Секреты

Ротация любого ключа: поправить `/opt/goko/.env` (и `.env` на ПК для
`APP_KEY`, `LIVEKIT_*`), затем `dc up -d` для затронутых сервисов;
`APP_KEY` требует ещё `deploy.sh --build-web`. `dc config` раскрывает значения
— в терминал с историей и в доки не выводить.
````

- [ ] **Step 2: `docs/README.md`**

Строку таблицы `| `runbooks/` | эксплуатация: VPS, LiveKit, KataGo, откат | `[TODO]` стадия 1 |` заменить на `| `runbooks/` | эксплуатация: [vps](runbooks/vps.md) — деплой, логи, режимы API, откат, ресурсы | стадия 1 |`.

- [ ] **Step 3: `CLAUDE.md`**

Строку стадии (после плана ядра она начинается с `- Стадия: 1, ядро готово`) заменить на:

```
- Стадия: 1 завершена (ядро, голос, веб); приёмка у доски и стадия 2 (agent-native) — `docs/NOW.md`
```

В разделе `## Команды` строку `node scripts/chat.mjs   # текстовый диалог с Гоко в комнате LiveKit (появится вместе с voice-agent)` заменить на две:

```
npm run chat     # текстовый диалог с Гоко в комнате LiveKit (нужны VPS с LiveKit и запущенный воркер)
npm run build:web   # статика телефона в apps/web/dist (APP_KEY из .env попадает в бандл)
```

- [ ] **Step 4: `README.md`**

Строку статуса заменить на: `Статус: `[WIP]` стадия 1 готова — партия голосом и с экрана телефона против Гоко; идёт приёмка у доски. Стадии и критерии — в спеке.`

В разделе `## Запуск` после строки `npm run dev ...` добавить:

```
npm run chat                 # текстовый диалог с Гоко (в другом терминале; нужны LIVEKIT_* и OPENAI_API_KEY)
npm run build:web            # статика для VPS; деплой — infra/scripts/deploy.sh --build-web (docs/runbooks/vps.md)
```

Абзац `Для голоса нужен VPS с LiveKit (...)` заменить на: `Для голоса нужны VPS с LiveKit (`infra/README.md`, `docs/runbooks/vps.md`) и ключ OpenAI в `.env`. KataGo и сети — `apps/go-engine/models/README.md`.`

- [ ] **Step 5: `docs/NOW.md`**

`## Фокус` — первый абзац заменить на:

```
Стадия 1 завершена по планам `superpowers/plans/2026-09-07-goko-stage1-core.md`
и `superpowers/plans/2026-09-07-goko-stage1-voice-web.md`: voice-agent,
web, контейнеры, runbook. Открыта приёмка founder'ом у доски (телефон, голос,
тапы) и замер стоимости партии в realtime.
```

В списке планов строку `` `voice-agent`, `scripts/chat.mjs`, `web`, контейнеры, runbook (10 задач). `` заменить на ту же с «(11 задач)».

`## Следующий шаг` заменить на:

```
Приёмка у доски (после деплоя по явной просьбе founder'а): партия голосом
на 13×13 против Гоко 10k, тапы с экрана, «кто впереди», конец партии.
Результаты и цену партии — в `docs/research/`. Затем brainstorming стадии 2
(место `external`, `mcp-server`).
```

В `## Сделано` добавить строку: `- <дата>: стадия 1, голос и веб: voice-agent (девять инструментов, промпт, события, realtime/pipeline, режимы Голос/Чат по D-0011), chat из консоли, web (доска, лента-диалог, микрофон, чат, выбор цвета и ранга, «Повторить»), контейнеры и compose, runbook VPS.`

В `## Открытые вопросы founder'у` добавить пункт со следующим свободным номером: `**Проверка на телефоне** после деплоя: микрофон в Safari/Chrome, задержка ответа, разборчивость координат, режим «Чат» без звука; realtime или pipeline по цене партии (в «Чате» Realtime всё равно генерирует аудио — цена D-0011).`

В `## Открыто`:

- пункт `[TODO]` про `stop_grace_period` game-server — удалить: сделано в задаче 10 (`30s` у `game-server` и `go-engine`, `60s` у `voice-agent`);
- пункт `[TODO]` про `flush_interval -1` — оставить до живой проверки 1 раздела runbook «Проверки после деплоя», после неё заменить результатом;
- пункт `[TODO]` про `empty_timeout` — дописать «порядок — `docs/runbooks/vps.md`, проверка 2»; после прогона заменить результатом;
- пункт `[TODO]` про Ctrl+C для `web` через `cmd.exe` — вернуться к нему после шага 7 и заменить результатом (`[OK]` или `[FIX]` с описанием правки `dev.mjs`);
- пункт `[X]` «Блокер публичного деплоя (широкое ревью, R9)» заменить на `[OK]`: лимит незавершённых партий на клиента и партии в prod только внутри сессии — задача 9 этого плана, D-0012;
- пункт `[TODO]` «План голоса и веба (широкое ревью, R2)» заменить на `[OK]`: опрос `get_game` не чаще раза в 2,5 с и `blockedUntil` по `Retry-After` — задача 2; растущая пауза, `Retry-After` и выход на `not_found` в `watchSession` — задача 3; серверная квота агента — расчёт в задаче 10, отдельного ключа нет;
- пункт `[TODO]` «Снапшоты брошенных незавершённых партий с диска не удаляются…» заменить на: чистка руками — `docs/runbooks/vps.md`, раздел «Брошенные незавершённые партии»; комментарий к `SESSION_TTL_MS` в `infra/.env.example` дописан в шаге 6;
- если проверка страницей (задача 8, шаг 5; задача 9, шаг 10) не выполнялась без LiveKit на VPS и `LIVEKIT_*` — добавить `[TODO founder]` с номерами этих шагов;
- добавить `[TODO]` Живые проверки 3 и 4 runbook (адрес клиента за Caddy, `POST /api/games` в prod → `sessionless_disabled`) — после первого деплоя, результат сюда;
- добавить `[!]` Токен LiveKit живёт TTL сессии от её создания (D-0008): продлённая сессия может пережить токен, тогда вход в комнату не удастся; страница забывает сессию, и перезагрузка создаёт новую (Task 7). Если на приёмке это мешает — выпуск нового токена на живую сессию, отдельное решение.

- [ ] **Step 6: `infra/.env.example` — комментарий `SESSION_TTL_MS`**

`SESSION_TTL_MS` задаёт не только жизнь сессии, но и порог брошенной партии (`STALE_GAME_MS = SESSION_TTL_MS`, D-0012). Строку `SESSION_TTL_MS=7200000             # 2 часа без событий — сессия закрывается` заменить на:

```
SESSION_TTL_MS=7200000             # 2 часа без событий — сессия закрывается; тот же порог: незавершённая партия без хода дольше него брошена и в лимиты не идёт (D-0012)
```

Run: `git diff --stat infra/.env.example` → одна строка изменена; значений `.env` в диффе нет (файл — заготовка).

- [ ] **Step 7: Ctrl+C `npm run dev` на Windows** (на ПК, бесплатно: воркер `goko-dev` стартует, но пока в комнату не вошёл телефон, Realtime не открывается)

Run: в Windows Terminal (PowerShell) `npm run dev`, дождаться строки, начинающейся с `[OK] dev: запущено` (в ней ещё список процессов — при `KATAGO_BIN` и `go-engine` — и имя диспетчеризации), **не открывая страницу**, нажать Ctrl+C один раз. Воркер `goko-dev` подключается к LiveKit на VPS (нужна сеть и `LIVEKIT_*` в `.env`); без них он пишет ошибку подключения — Ctrl+C проверять всё равно.
Expected: вопроса «Завершить выполнение пакетного файла [Y(да)/N(нет)]?» нет; `dev` печатает остановку и выходит; порты свободны:

```powershell
Get-NetTCPConnection -LocalPort 8787,5173 -State Listen -ErrorAction SilentlyContinue   # пусто
```

Если вопрос появился или `vite` остался слушать `5173` — запустить web без оболочки. Тест в `scripts/dev.test.ts` (в `describe` с `devPlan`, рядом с тестом `web и voice-agent — только если есть их package.json`):

```ts
  it('web — vite через node без cmd.exe: Ctrl+C не спрашивает про пакетный файл', () => {
    const plan = devPlan(secretEnv, (rel) => rel === 'apps/web/package.json');
    const web = plan.procs.find((p) => p.name === 'web');
    expect(web?.cmd).toBe(process.execPath);
    expect(web?.args).toEqual(['node_modules/vite/bin/vite.js', 'apps/web', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
    expect(web?.shell).toBeUndefined();
  });
```

Run: `npx vitest run scripts/dev.test.ts` → FAIL (у web `cmd: 'npm'`). В `scripts/dev.mjs` строку запуска web заменить на:

```js
  // web — vite через node без оболочки: npm на Windows — это npm.cmd, cmd.exe на Ctrl+C спрашивает
  // «Завершить выполнение пакетного файла?», и web не останавливается. vite.config.ts берётся из apps/web.
  if (exists('apps/web/package.json')) procs.push({ name: 'web', cmd: node, args: ['node_modules/vite/bin/vite.js', 'apps/web', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], env });
```

Run: `npx vitest run scripts/dev.test.ts` → PASS; повторить ручную проверку Ctrl+C → вопроса нет, порты свободны.

- [ ] **Step 8: Полная проверка**

Run: `npm run check && npm run smoke`
Expected: typecheck (корень и `apps/web`), все unit-тесты (`go-core`, `protocol`, `go-engine`, `game-server`, `voice-agent`, `web`, `scripts`) и smoke — `[OK]`, код 0. `agent.eval.test.ts` — `skipped` без `RUN_AGENT_EVALS`.

- [ ] **Step 9: Commit**

Только если шаг 7 потребовал правки — сначала отдельный коммит:

```bash
git add scripts/dev.mjs scripts/dev.test.ts
git commit -m "scripts: dev запускает web через node без cmd.exe"
```

Затем всегда:

```bash
git add docs/runbooks/vps.md docs/README.md CLAUDE.md README.md docs/NOW.md infra/.env.example
git commit -m "docs: runbook VPS с проверками после деплоя и чисткой брошенных партий, команды и статус стадии 1, NOW"
```

Живые проверки runbook («Проверки после деплоя») и деплой исполнитель не запускает: только по явной просьбе founder'а (правило 5 `CLAUDE.md`); их результаты вносит в `docs/NOW.md` тот, кто их выполнил.

---

## Самопроверка плана

Обновлена 14.09 после сверки с кодом ядра на HEAD (`packages/protocol`, `apps/game-server`, `scripts/smoke.mjs`, `scripts/dev.mjs`) и решениями D-0001…D-0012; второй проход — после широкого ревью ядра (протокол финальный, R2, R9); правки после второго прохода — брошенная сменой партия вне лимитов (задача 9) и перечитывание партии после таймаута хода у агента и веба (задачи 2, 6, 7); правки по предполётной сверке — общие `hasEngine`, `humanColorOf`, `retryAfterMs`, `RETRY_MS`, `STABLE_CONNECTION_MS` в `@goko/protocol` (задача 1), «Продолжаем партию» после `session.game` (задача 3), `RunResult.wait()` и LLM-судья в eval (задача 4), `deploy.sh` дифф к HEAD (задача 10), runbook и `NOW.md` (задача 11).

- **Покрытие спеки.** Раздел 3 (поток хода: голос → инструмент → game-server → событие → реплика; тап → `via: 'tap'` → событие → реплика) — Task 2 (инструменты), Task 3 (`handleEvent`: тап при `pendingEngineMove` копится в `lastTap` и озвучивается вместе с ответом движка), Task 7 (`useGame.play`). Раздел 5 (события `session.game`, `state.updated` с `cause/by/via/humanFallback`, `engine.thinking`, `game.finished`, `error`) — Task 3 и Task 7 читают все пять типов; `not_found` на SSE → новая сессия (Task 6 `streamEvents`, Task 7 `useSession.reset`). Раздел 9: таблица инструментов один в один — Task 2 (`createTools`); результаты для модели с `myMoveSpoken`, `note` при таймауте ответа, `finished/result` — Task 2; `get_assessment` без лучшего хода в тексте — правило в `INSTRUCTIONS` (Task 4) и eval; озвучивание событий — Task 3; промпт с произношением координат, правилом D-0004 и режимом «Чат» — Task 4; `realtime`/`pipeline` по `VOICE_MODE`, серверный VAD, транскрипция входа `ru` — Task 4 `voice.ts`; приветствие — `generateReply` после `session.start` и применения режима, `onEnter` с `greet: false` — Task 4 `main.ts`, `agent.ts`; `sessionId` из метаданных диспетчеризации — Task 4 `metadata.ts`. Раздел 10: одна страница, SVG-доска, тап = ближайший пункт, «сейчас ход Гоко» без запроса, лента-диалог из `lk.transcription`, вход в комнату и микрофон по первому касанию со `startAudio`, кнопки ≥ 44 px, темы, статус, результат с территорией и мёртвыми камнями, работа без агента — Task 6–8; сессия в `sessionStorage` — Task 7. Раздел 11: контейнеры `game-server` (`TRUST_PROXY=1`, без `ALLOW_SESSIONLESS_GAMES`), `go-engine` (`cpus`, без опубликованных портов, логи KataGo в томе), `voice-agent` (`stop_grace_period` 60 с по drain и shutdown), у всех `init: true`; порт публикует только `game-server` и только на `127.0.0.1`; `API_UPSTREAM` prod/dev и `docker compose up -d caddy`; `flush_interval -1` на `/api/*` (уже в `infra/Caddyfile`); `AGENT_NAME` `goko`/`goko-dev`; деплой статики — Task 10, runbook с живыми проверками — Task 11. Раздел 12: замоканный клиент и замоканный сеанс для `voice-agent` (Task 2, 3, 4), evals по флагу без новых (Task 4), unit для веб-геометрии, ленты, потока, текстов, настроек и чата (Task 6), `chat.mjs` (Task 5), ручная приёмка у доски — `NOW.md` (Task 11). Раздел 18: все проверки — командами с кодом возврата; секреты — только через `.env`.
- **Решения.** D-0001: комнату создаёт game-server, веб и `chat.mjs` только входят по токену, без `roomConfig`; агент ждёт `waitForParticipant()` до Realtime (Task 4); живая проверка `empty_timeout` — runbook, Task 11. D-0004: ход за человека только по прямой просьбе и вслух — промпт Task 4. D-0005: партия двух людей разрешена — `hasEngine`/`humanColorOf` в `@goko/protocol` (Task 1), тексты в Task 2, 3, 6; фейковый клиент не запрещает её (Task 2). D-0006: `retries_exhausted` → агент переоткрывает поток на первой реплике человека (`watchSession().humanSpoke`, Task 3, `main.ts` Task 4), веб — «Повторить» (`StreamHandle.reopen`, `needsRetry`, Task 6–8), обещания без механизма нет. D-0007: человеку и модели — только `humanText(code, details)`, `message` — в логи; `humanFallback` из `state.updated` хода движка → `fallbackMove` и строка в `get_position` (Task 2, 3). D-0008: токен живёт TTL сессии от создания — поведение веба при отказе входа (Task 7), `[!]` в `NOW.md` (Task 11). D-0009: id — непрозрачные строки, план их формат не разбирает (кроме `grep` id в runbook по алфавиту `[0-9a-z]`). D-0010: `FINISH_WAIT_MS` 22 с — выше серверного `SCORE_BUDGET_MS` 20 с и ниже клиентского `score` 25 с, опрос `getGame` не чаще раза в 2,5 с (Task 2), `stop_grace_period: 30s` над `SHUTDOWN_MS` 25 с и `start_period` над прогревом 300 с (Task 10). D-0011: переключатель «Голос / Чат» (`prefs.ts`, `ModeSwitch`), атрибут `goko.mode` (веб `setAttributes`, `chat.mjs` `CHAT_ATTRIBUTES`), право `canUpdateOwnMetadata` в токене (Task 5, шаг 1), агент — `followMode` + `session.output/input.setAudioEnabled` (Task 4), запасной путь — отписка веба от аудио агента (Task 7), выбор цвета и ранга только полями `NewGameRequest` (Task 6, 8), тапы в любом режиме. D-0012: `rate_limited` — ожидание `Retry-After` у агента (`state.blockedUntil`, `retryAfterMs` из `@goko/protocol` — Task 1, Task 2, опрос итога и поток — Task 3) и у веба (`retryDelayMs`, пауза потока — Task 6, `blockedUntil` в `useGame` — Task 7); `too_many_games` и `bad_request` с `reason` — только `humanText` (Task 2, 5, 6); прежняя партия сессии брошена при смене (отметка `<id>.abandoned` переживает рестарт, не в лимитах и без задачи при старте, возврат без проверки лимита), лимит 3 незавершённых партий на клиента и `ALLOW_SESSIONLESS_GAMES` с правкой D-0012 и спеки — Task 9; `TRUST_PROXY=1` и отсутствие флага в compose — Task 10; квота voice-agent без отдельного ключа — расчёт в Task 10; чистка брошенных партий и живые проверки адреса за Caddy — Task 11.
- **Заглушек нет.** Все файлы приведены целиком; условные ветки — только на отсутствие VPS/ключей (`chat`, evals и проверки страницей без LiveKit пропускаются с пометкой в `NOW.md`), на Docker на ПК (Task 10: `compose config`, сборки, `npm ci` при `spike` в workspaces), на `ETARGET` при `npm install` (Task 1, 6), на имена в установленной `livekit-client` (Task 7, примечание к шагу 2), на флаг `npm ci` (Task 10, Step 2) и на результат ручной проверки Ctrl+C (Task 11, Step 7, правка `dev.mjs` с тестом приведена целиком).
- **Типы.** `ToolClient` (Task 2) — `Pick<GokoClient, 'newGame' | 'play' | 'correct' | 'pass' | 'resign' | 'undo' | 'getGame' | 'ascii' | 'analyze' | 'setRank'>` по именам `createClient` из `packages/protocol/src/client.ts`; поток событий — отдельный `Pick<GokoClient, 'events'>` в `watchSession` (Task 3) и `streamEvents` (Task 6) с `events(target: EventsTarget, signal?)`. `seatColor` объявлена в Task 1 и используется в Task 2, 3, 6. `AgentState` (Task 1) — поля, которые читают Task 2 и 3: `gameId`, `humanColor: Color | null`, `rank`, `komi`, `toolGames`, `announcedFinish`, `awaitingReply`, `lastTap`, `lastErrorAt`, `retriesExhausted`, `announceSync`, `fallbackMove`, `startingGame`. `hasEngine`/`humanColorOf` над `Pick<GameState, …>` и `RETRY_MS`, `STABLE_CONNECTION_MS`, `retryAfterMs` объявлены в `@goko/protocol` (Task 1) и импортируются в `tools.ts` (Task 2), `events.ts` (Task 3), `stream.ts` и `text.ts` (Task 6), `useGame` (Task 7); своих копий нет. `handleEvent(ev, state, now?)` и `watchSession(opts): WatchHandle` (Task 3) вызываются из `main.ts` (Task 4); `modeOf/applyMode/followMode` (Task 4 `mode.ts`) — в `main.ts` с `RoomEvent.ParticipantAttributesChanged` и `ParticipantConnected` из `@livekit/rtc-node`; `GokoAgent(tools, { greet })` (Task 4) — в `main.ts` и eval. `describeEvent`, `CHAT_ATTRIBUTES` (Task 5) — в тесте и `chat.mjs`. `layout/x/y/pointAt/coordAt/hoshi/stones/indexOf` (Task 6) — в `Board.tsx` (Task 8); `upsertLine/whoOf/lineId/acceptLine` (Task 6) — в `useSession` (Task 7); `streamEvents(...): StreamHandle` и `needsRetry` (Task 6) — в `useGame` (Task 7), `reopen` → `StatusBar.onRetry` (Task 8); `describeError/resultText/statusText/capturesText/rankText` (Task 6) — в Task 7 и 8; `loadPrefs/savePrefs/modeAttributes/newGameRequest/stepRank`, `Mode`, `Prefs`, `ColorChoice` (Task 6) — в `useSession`, `useGame` (Task 7), `ModeSwitch`, `NewGame`, `Controls`, `Transcript` (Task 8); `sendChat/agentReady/CHAT_MAX_CHARS` (Task 6) — в `useSession` (Task 7) и `ChatInput` (Task 8); `MicState` (Task 7) — в `Controls.tsx`; `useSession().reset` передаётся в `useGame(sessionId, onLost)`, `useSession().prefs` — в `useGame().newGame(prefs)` (Task 8 `App.tsx`). Импорты протокола сверены с `packages/protocol/src/index.ts`: `ApiError`, `humanText`, `createClient`, `GokoClient`, `EventsTarget`, `GameEvent`, `GameState`, `CreateSessionResponse`, `NewGameRequest`, `Color`, `Rank`, `RANKS`, `Result`, `Seat`, `Controller` существуют; `seatColor`, `hasEngine`, `humanColorOf`, `RETRY_MS`, `STABLE_CONNECTION_MS`, `retryAfterMs` добавляет Task 1. Переменные окружения контейнеров (Task 10) — по спискам `main.ts` плана ядра и Task 4.
- **Известные границы.** Форы в `NewGameRequest` нет — выбор только цвета и ранга. Отключить генерацию аудио в Realtime на лету нельзя (`modalities` только в конструкторе `RealtimeModel`): в «Чате» платим за аудио-токены, это цена D-0011. Изменения протокола после широкого ревью (`gameId` в `engine.thinking` и `error`, `CLIENT_TIMEOUTS` и `CallOptions`, `ClientTimeoutError`, `rate_limited` и `too_many_games`, `bad_request` с `reason`, полуцелое коми) отражены во втором проходе, в том числе в литералах событий тестов. Счёт на клиента и владельцы сессий живут в памяти `game-server`: рестарт их обнуляет; отметки брошенных сменой партий лежат на диске и рестарт переживают, а текущие партии сессий до рестарта отметки не получают и в общем счёте до `SESSION_TTL_MS`. Разные адреса (другая сеть, другая /64) обходят лимит на клиента, но не общий лимит 20 и не `MAX_SESSIONS`. Отметки идущих партий сами с диска не уходят — ручная чистка вместе со снапшотом (runbook, Task 11). Сверка после таймаута хода у агента опирается на ревизию из ответов инструментов: если после них ревизию сменили тап или ответ Гоко, решает только конец партии: незаписанный пас после прежнего паса человека может сойти за записанный, а записанный ход, за которым уже есть другие ходы, — за незаписанный. Повтора хода нет ни в одном случае. Поправки хода в вебе нет, перечитывание там — у хода и паса. Проверки сборки веба и compose — командами; поведение за Caddy и `empty_timeout` — только живыми проверками runbook после деплоя.

### Пары задач: общие файлы и интерфейсы

| Пара | Общий файл или интерфейс | Что производит первая | Что потребляет вторая | Согласовано? |
| --- | --- | --- | --- | --- |
| 1 — 2 | `apps/voice-agent/src/state.ts`; `seatColor`, `hasEngine`, `humanColorOf`, `retryAfterMs` из `@goko/protocol` | `AgentState` с `gameId`, `humanColor`, `blockedUntil`, `awaitingFinish`, `announcedFinish`, `startingGame`; функции мест и `retryAfterMs(details)` в протоколе | инструменты читают и пишут эти поля, цвет человека — через `seatColor`/`humanColorOf`, пауза — `retryAfterMs`; `tools.ts` их не определяет и не реэкспортирует | да: имена полей и типы совпадают, `blockedUntil` — число мс эпохи, `retryAfterMs` возвращает мс |
| 1 — 3 | `state.ts`; `@goko/protocol` | те же поля и `announceSync`; `hasEngine`, `humanColorOf`, `retryAfterMs`, `RETRY_MS`, `STABLE_CONNECTION_MS` | `handleEvent` и `watchSession` ставят `announcedFinish`, `retriesExhausted`, `announceSync` (ставит `session.game` со сменой партии, снимает любой `state.updated`), сбрасывают `awaitingFinish`; паузы потока — константы протокола | да |
| 1 — 6 | `seatColor`, `hasEngine`, `humanColorOf`, `retryAfterMs`, `RETRY_MS`, `STABLE_CONNECTION_MS` из `@goko/protocol` | функции и константы, экспорт `retry.ts` в `index.ts` | `text.ts` (`statusText`, `rankText`, `retryDelayMs` над `retryAfterMs`), `stream.ts` (паузы) | да: своих копий в вебе нет |
| 1 — 7 | `hasEngine`, `humanColorOf` из `@goko/protocol` | функции мест | `useGame`: «сейчас ход Гоко» или «сейчас не твой ход», цвет при сдаче | да |
| 2 — 3 | `testing/fake-client.ts` | `createFakeClient`, `fakeGame` (с `gameId` у событий) | опрос итога, тесты `events.test.ts` на фейковом клиенте; `retryAfterMs`, `hasEngine`, `humanColorOf` обе задачи берут из протокола (Task 1), а не из `tools.ts` | да |
| 2 — 4 | `createTools(deps)`, `ToolDeps.signal` | инструменты с долгоживущим `CallOptions.signal` | `main.ts` передаёт сигнал сеанса, eval строит те же инструменты | да |
| 2 — 5 | тексты `humanText` для `too_many_games`, `bad_request` | инструменты отдают `humanText(code, details)` | `scripts/chat.mjs` строит тексты своих ошибок и событий `error` тем же `humanText` и отдельно называет `ClientTimeoutError` | да |
| 3 — 4 | `watchSession(opts): WatchHandle`, `SESSION_EXPIRED_INSTRUCTIONS` | цикл потока с паузами 1–15 с и выходом на `not_found` | `main.ts`: `speak`, `signal`, `humanSpoke` | да |
| 3 — 6 | `STABLE_CONNECTION_MS`, `RETRY_MS` (1, 2, 4, 8, 15 с) | `watchSession` импортирует константы из `@goko/protocol` (Task 1) | `streamEvents` веба импортирует те же константы | да: одна константа протокола, правило пауз не разойдётся |
| 4 — 5 | атрибут `goko.mode`, право `canUpdateOwnMetadata` | агент читает `goko.mode` (`mode.ts`) | `chat.mjs` выставляет `CHAT_ATTRIBUTES`; токен с правом — шаг 1 задачи 5 | да |
| 4 — 8 | eval и ручная проверка режимов, бюджет платных прогонов | eval — прогон 1 из 5 (сценарии D-0004 и «Чат» в том же файле) | проверка режимов с агентом — прогон 4 из 5 | да: раскладка в Global Constraints, всего не больше 5 |
| 4 — 9 | `infra/.env.example` | строки `VOICE_MODE`, `API_BASE` после `AGENT_NAME` | строка `ALLOW_SESSIONLESS_GAMES` после `TRUST_PROXY` | да: разные якоря |
| 4 — 10 | остановка воркера | `DRAIN_TIMEOUT_MS` 5 с, `SHUTDOWN_PROCESS_TIMEOUT_MS` 20 с | `stop_grace_period: 60s` у `voice-agent` | да: около 30 с остановки, запас вдвое |
| 5 — 7, 8 | право токена `canUpdateOwnMetadata` | `livekit.ts` выдаёт право | `useSession` вызывает `setAttributes` с `modeAttributes` | да |
| 5 — 9 | `apps/game-server/src/app.test.ts` | ожидаемые права токена | `MakeOptions`, `make` и новый `describe` лимита | да: разные места файла, тест прав не создаёт партий |
| 5 — 6 | корневой `package.json` | скрипт `chat`, devDependency `@livekit/rtc-node` | `typecheck` с веб-конфигом, `build:web` | да: разные ключи |
| 6 — 7 | `stream.ts`, `text.ts`, `prefs.ts`, `chat.ts` | `streamEvents(..., sleep?, now?)`, `needsRetry`, `describeError`, `retryDelayMs`, `sendTapMove`, `newGameRequest`, `modeAttributes`, `sendChat` | `useGame`: `blockedUntil` по `retryDelayMs`, `request` с `CallOptions`, `tapMove` над `sendTapMove`; `useSession` | да: сигнатуры и единицы (мс) совпадают |
| 6 — 8 | `apps/web/src/main.tsx` | заглушка проверки сборки (шаг 11) | задача 8 заменяет файл целиком и повторяет проверку бандла | да |
| 7 — 8 | `useSession`, `useGame`, `MicState` | хуки и их поля | `App.tsx`, `Controls`, `StatusBar.onRetry`, `NewGame` | да |
| 2, 5, 6, 7 — 9 | создание партий только в сессии; тексты `humanText` | агент, `chat.mjs` и веб зовут `newGame(sessionId, …)`, `createGame` нет | задача 9 выключает `POST /api/games` и добавляет `sessionless_disabled` и `scope: 'client'`; `git grep` на шаге 9 | да: тесты задач 2 и 6 сравнивают с `humanText(...)`, проходят до и после задачи 9 |
| 8 — 9 | ручная проверка страницей | шаг 5 задачи 8 без лимита на клиента | шаг 10 задачи 9 той же страницей: «Новая партия» подряд не упирается в лимит, отметки `<id>.abandoned` на диске и после рестарта | да: проверка лимитов перенесена в задачу 9 |
| 9 — 10 | `ALLOW_SESSIONLESS_GAMES`, `TRUST_PROXY`, `.env.example` | флаг (включает только `1`), ключ клиента, строка флага | compose без флага, `TRUST_PROXY: "1"`; `ENGINE_CPUS`, `KATAGO_ASSET`, `KATAGO_SHA256` в конец `.env.example` | да: шаг 8 задачи 10 проверяет без печати значений |
| 9 — 11 | `scripts/dev.mjs`, `scripts/dev.test.ts`, `.env.example`, D-0012 | флаг в двух ветках `serverEnv`, два `toMatchObject`; лимит на клиента; отметки `<id>.abandoned` | шаг 7 меняет только строку запуска web и добавляет тест; шаг 6 — комментарий `SESSION_TTL_MS`; проверка 4 runbook и чистка снапшота вместе с отметкой; пункта `[!]` о лимите в `NOW.md` нет — замена партии в лимит не упирается | да: разные строки файлов |
| 10 — 11 | сервисы compose, пути, тома | `/opt/goko/data/games` (uid 1000, `deploy.sh`), том `engine_logs`, `stop_grace_period`, `TRUST_PROXY` | runbook: состав, чистка брошенных партий через `dc run --no-deps game-server`, проверки 3–4, пункт `NOW.md` про `stop_grace_period` | да |

### Тесты согласуются с кодом шага

| Задача | Тесты | Согласовано? |
| --- | --- | --- |
| 1 | `phrases.test.ts` (в том числе «поставь 3 кю пожалуйста»), `seat.test.ts` (`seatColor`, `hasEngine`, `humanColorOf`), `retry.test.ts` (`RETRY_MS`, `retryAfterMs`) — функции шага | да: 12 тестов в трёх файлах |
| 2 | `tools.test.ts` на `createFakeClient` без `!` (`gameOf`): `FINISH_WAIT_MS` 22 с, опрос 2,5 с, `blockedUntil` (сам `retryAfterMs` — в `retry.test.ts` задачи 1), слабые группы фейка на `C3, C4` отдельно от `bestMoves`, `client_timeout`, `too_many_games` по `humanText`; таймаут хода, паса и поправки — `failNext(err, 'before' \| 'after')`: перечитывание тем же сигналом, записанный ход с ответом Гоко и без него, пас при прежнем пасе решает ревизия, отказ перечитывания | да: текст незаписанного хода и порядок вызовов совпадают с `sendMove` шага 4 |
| 3 | `events.test.ts`: события с `gameId`, чужой `gameId` игнорируется, `session.game` → `sync` той же партии — «Продолжаем партию», паузы 1–15 с, `Retry-After`, `not_found` → выход и одна реплика; ожидание реплики — явный промис, без `vi.waitFor` | да |
| 4 | `metadata`, `voice`, `mode` — unit; `agent.eval.test.ts` — все сценарии файла за один прогон, в том числе два теста D-0004 (прямая просьба и размышление) и режим «Чат» | да |
| 5 | `livekit.test.ts`, `app.test.ts` (права токена), `chat.test.ts` (`describeEvent` с `gameId`, `CHAT_ATTRIBUTES`) | да |
| 6 | `geometry` (левый край без `-0`), `transcript`, `stream` (паузы, сброс после 15 с, `Retry-After`; ожидание паузы и первого события — явные промисы, без `vi.waitFor` и `setTimeout`), `text` (`describeError`, `retryDelayMs`, `sendTapMove` на фейковом `getGame`: без чтения при ответе, перечитывание при таймауте, текст только при той же ревизии), `prefs`, `chat`; сборка Vite и проверка бандла — шаг 11 | да |
| 7 | unit-тестов нет (хуки React); `npm run typecheck` по импортам из задачи 6 | да: всё, что хуки считают, покрыто тестами задачи 6, в том числе перечитывание после таймаута тапа (`sendTapMove`) |
| 8 | компонентных тестов нет; `npm run build:web`, проверка бандла, ручные шаги 5–6 | да |
| 9 | `human-text.test.ts`, `service.test.ts` (3 на клиента, создаваемая в счёте, устаревшая не в счёте, общий лимит раньше; смена партии бросает прежнюю в общем лимите и в лимите клиента, возврат ходом и `resume`, рестарт с отметкой без задачи, отказ записи отметки), `store.test.ts` (файл `<id>.abandoned`, `load` его не читает, повтор и снятие, проверка id), `app.test.ts` (замена партий подряд, возврат ходом, владелец сессии, `X-Forwarded-For`, флаг, IPv6 /64), `start-server.test.ts` (значения флага, `marks` — то же хранилище), `smoke.test.ts`, `dev.test.ts` | да: сообщения, `details`, строка `[!]` и статусы в тестах совпадают с кодом шага 7 |
| 10 | unit-тестов нет; `docker compose config` с проверкой переменных, портов, `init`, `stop_grace_period`; `bash -n deploy.sh` и `grep` исключений HEAD; сборка образов (при Docker на ПК) | да |
| 11 | тест `dev.test.ts` только при правке шага 7; `npm run check && npm run smoke` | да |
