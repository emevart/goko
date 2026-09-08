# Гоко, стадия 1, голос и веб: `voice-agent`, `scripts/chat.mjs`, `web`, контейнеры и деплой — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поверх ядра стадии 1 (план `2026-09-07-goko-stage1-core.md`) — голосовой соперник целиком: воркер LiveKit Agents с инструментами и промптом Гоко, озвучивание событий партии, текстовый канал из консоли, страница для телефона (доска, лента, микрофон), контейнеры game-server / go-engine / voice-agent в compose, деплой статики и runbook VPS.

**Architecture:** `apps/voice-agent` — воркер `@livekit/agents` (`agentName` из `AGENT_NAME`): на каждую комнату читает `sessionId` из метаданных диспетчеризации, собирает `AgentSession` в режиме `realtime` (gpt-realtime, голос marin) или `pipeline` (STT → LLM → TTS, `VOICE_MODE`), даёт модели девять инструментов над `GokoClient` из `@goko/protocol` и слушает SSE сессии, превращая события (тап на экране, ход движка после таймаута, конец партии) в `generateReply`. Инструменты — чистые функции над клиентом (`createToolFns`), тестируются с фейковым клиентом без LLM; обёртки `llm.tool()` — тонкие. `apps/web` — Vite + React, одна страница: `useSession` (сессия, комната LiveKit, транскрипты), `useGame` (SSE, действия тапами через тот же клиент), SVG-доска с геометрией в отдельном модуле с тестами. `scripts/chat.mjs` — участник комнаты из консоли: stdin → `lk.chat`, `lk.transcription` и события SSE → stdout. Инфраструктура: три Dockerfile (Node 22 запускает `.ts` напрямую, без сборки), сервисы в `infra/docker-compose.yml` на `127.0.0.1`, Caddy остаётся единственной точкой входа.

**Tech Stack:** Node 22.22 (нативный `.ts`), npm workspaces, TypeScript 5.9, vitest 5, zod 4.5, `@livekit/agents` 1.8 + `@livekit/agents-plugin-openai` 1.8 + `@livekit/agents-plugin-silero` 1.8, `@livekit/rtc-node` 0.13, `livekit-client` 2.22, Vite 8 + `@vitejs/plugin-react` 6, React 19, Docker Compose, Caddy 2.

**Spec:** `docs/superpowers/specs/2026-09-07-goko-voice-go-opponent-design.md` — разделы 3 (архитектура, поток хода), 5 (протокол и события), 9 (`voice-agent`: речь, инструменты, озвучивание событий, промпт), 10 (`web`), 11 (инфраструктура, два режима маршрутизации, локальная разработка), 12 (тестирование), 18 (AI-first). Предполагаются выполненные планы стадии 0 (`2026-09-07-goko-stage0-spike.md`: `infra/`, базовый образ движка, `docs/research/stage0-results.md` с параметрами VAD и решением realtime/pipeline) и ядра стадии 1 (`2026-09-07-goko-stage1-core.md`: `@goko/go-core`, `@goko/protocol` с `createClient`, `game-server`, `go-engine`, `scripts/dev.mjs`, `scripts/smoke.mjs`).

## Global Constraints

- Node `>=22.18`; импорты внутри пакетов с расширением `.ts`/`.tsx`; между пакетами — по имени `@goko/go-core`, `@goko/protocol`; `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (типы только через `import type`), `erasableSyntaxOnly` (никаких `enum`, `namespace`, parameter properties). `apps/web` имеет свой `tsconfig.json` (DOM, JSX, bundler) и исключён из корневого.
- Правила го, координаты и озвучивание координат (`speakCoord`) — только из `@goko/go-core`; веб рисует присланную строку `board`; агент не хранит позицию: каждая реплика о партии — из результата инструмента (правило 2 `CLAUDE.md`). В памяти агента только `sessionId`, `gameId`, цвет человека, ранг, коми и служебные флаги.
- Инструменты ровно по таблице раздела 9 спеки: `start_game`, `play_move`, `correct_last_move`, `pass`, `resign`, `undo`, `get_position`, `get_assessment`, `set_rank`; `get_assessment` — `analyze` с `maxVisits: 50`; тексты `note`/`reason` для модели — по-русски; координаты в аргументах и результатах — латиницей (`D4`), рядом произношение (`дэ четыре`).
- Речь: `VOICE_MODE=realtime` (по умолчанию) — `openai.realtime.RealtimeModel({ model: 'gpt-realtime', voice: 'marin' })`, серверный VAD с перебиванием, транскрипция входа `gpt-4o-mini-transcribe` с `language: 'ru'`; `VOICE_MODE=pipeline` — `silero.VAD` + `openai.STT` (`gpt-4o-transcribe`, `ru`) + `openai.LLM` + `openai.TTS` (`gpt-4o-mini-tts` с инструкцией по тону). Приветствие — `generateReply` в `onEnter`.
- Текстовые каналы LiveKit: вход `lk.chat` (стандартный `RoomIO`), выход `lk.transcription` (атрибуты `lk.segment_id`, `lk.transcription_final`, `lk.transcribed_track_id`).
- Имена воркера: `AGENT_NAME=goko` на VPS, `goko-dev` на ПК; game-server кладёт то же имя в `roomConfig` токена (`AGENT_NAME` у него же). Метаданные диспетчеризации — `{ "sessionId": "<id>" }`, комната — `goko-<sessionId>`.
- Веб: одна страница, портретный телефон, SVG-доска, тап = ближайший пункт → `play` с `via: 'tap'` и `waitForReply: false`; не ход человека — сообщение «сейчас ход Гоко» без запроса; цели касания ≥ 44 px; тёмная и светлая тема по `prefers-color-scheme`; без UI-библиотек; без агента в комнате страница играет тапами.
- Протокол и заголовки как в ядре: `X-App-Key` на `/api/*`; ключ в веб попадает на этапе сборки (`APP_KEY` из `.env` → `import.meta.env.VITE_APP_KEY`), в git не попадает. Значения переменных не печатать в логи и не вставлять в доки.
- Порты dev: game-server `8787`, go-engine `8788`, web `5173`; воркер портов не слушает. В compose сервисы публикуют порты только на `127.0.0.1`; `go-engine` с лимитом `cpus`.
- Тесты: `voice-agent` — фейковый клиент протокола (бесплатно, всегда); evals через `AgentSession.run` — только при `RUN_AGENT_EVALS=1` и `OPENAI_API_KEY`; `web` — чистые модули (`geometry`, `transcript`, `stream`) под vitest в `node`; экран телефона агент не видит — приёмка руками у founder'а.
- Язык доков, комментариев, коммитов — русский; код и идентификаторы — английский; без эмодзи; маркеры `[OK] [!] [FIX] [X] [WIP] [TODO]`; коммиты `<область>: <что сделано>`.
- Деплой, Hetzner, DNS, tailnet и аудио-тесты с телефона — только по явной просьбе founder'а в текущей сессии (правило 5 `CLAUDE.md`); план описывает команды, исполнитель их не запускает сам.

---

## Файловая структура стадии 1 (голос и веб)

```
packages/protocol/src/game.ts         + seatColor(seats, controller)
packages/protocol/src/index.ts        + экспорт seatColor

apps/voice-agent/package.json         @goko/voice-agent: @livekit/agents, плагины openai и silero, @goko/*, zod
apps/voice-agent/src/phrases.ts       parseRank, speakRank, speakMove, describeResult, formatPoints, colorName
apps/voice-agent/src/state.ts         AgentState: sessionId, gameId, humanColor, rank, komi, флаги озвучивания
apps/voice-agent/src/tools.ts         createToolFns(deps) — чистые функции; createTools(deps) — llm.tool() со схемами
apps/voice-agent/src/events.ts        handleEvent(ev, state) -> инструкция | null; watchSession(...) — цикл SSE с переподключением
apps/voice-agent/src/prompt.ts        INSTRUCTIONS, GREETING_INSTRUCTIONS
apps/voice-agent/src/voice.ts         parseVoiceMode, sessionOptions(mode) — realtime | pipeline
apps/voice-agent/src/agent.ts         class GokoAgent extends voice.Agent (onEnter — приветствие)
apps/voice-agent/src/metadata.ts      sessionIdOf(metadata, roomName)
apps/voice-agent/src/main.ts          defineAgent + cli.runApp; env: APP_KEY, API_BASE, AGENT_NAME, VOICE_MODE, LIVEKIT_*, OPENAI_API_KEY
apps/voice-agent/src/testing/fake-client.ts   createFakeClient(): ToolClient со сценарием и журналом вызовов; fakeGame()
apps/voice-agent/src/*.test.ts        phrases, tools, events, metadata, voice; agent.eval.test.ts — платный, по флагу
apps/voice-agent/Dockerfile

scripts/chat.mjs                      сессия через game-server, комната LiveKit, stdin -> lk.chat, ответы и события -> stdout
scripts/chat.test.ts                  describeEvent

apps/web/package.json                 @goko/web: react, react-dom, livekit-client, @goko/*; vite, @vitejs/plugin-react
apps/web/tsconfig.json                DOM, react-jsx, bundler
apps/web/vite.config.ts               proxy /api -> 127.0.0.1:8787; VITE_APP_KEY из APP_KEY корневого .env
apps/web/index.html
apps/web/src/vite-env.d.ts
apps/web/src/main.tsx
apps/web/src/App.tsx
apps/web/src/api.ts                   client = createClient({ baseUrl, appKey })
apps/web/src/geometry.ts              layout, x, y, pointAt, coordAt, hoshi, stones, indexOf  (+ geometry.test.ts)
apps/web/src/transcript.ts            Line, upsertLine, whoOf              (+ transcript.test.ts)
apps/web/src/stream.ts                streamEvents: SSE с переподключением (+ stream.test.ts)
apps/web/src/text.ts                  describeError, resultText, statusText (+ text.test.ts)
apps/web/src/hooks/useSession.ts      сессия в sessionStorage, комната, микрофон, лента
apps/web/src/hooks/useGame.ts         состояние партии по SSE, действия тапами
apps/web/src/components/Board.tsx
apps/web/src/components/Transcript.tsx
apps/web/src/components/StatusBar.tsx
apps/web/src/components/Controls.tsx
apps/web/src/styles.css

apps/game-server/Dockerfile
apps/go-engine/Dockerfile             + стадия engine (Node поверх стадии katago)
.dockerignore
infra/docker-compose.yml              + game-server, go-engine, voice-agent
infra/.env.example                    + VOICE_MODE, API_BASE, ENGINE_CPUS, KATAGO_ASSET
infra/scripts/deploy.sh               + --build-web, исключения
docs/runbooks/vps.md
package.json                          + chat, typecheck web, devDependency @livekit/rtc-node
CLAUDE.md, README.md, docs/README.md, docs/NOW.md
```

---

### Task 1: `voice-agent` — пакет, фразы, разбор ранга, `seatColor`

**Files:**
- Create: `apps/voice-agent/package.json`, `apps/voice-agent/src/phrases.ts`, `apps/voice-agent/src/state.ts`
- Modify: `packages/protocol/src/game.ts` (добавить `seatColor`), `packages/protocol/src/index.ts` (экспорт)
- Test: `apps/voice-agent/src/phrases.test.ts`, `packages/protocol/src/seat.test.ts`

**Interfaces:**
- Consumes: `speakCoord` из `@goko/go-core`; `Color`, `Rank`, `RANKS`, `Result`, `Seat`, `Controller` из `@goko/protocol`.
- Produces: `seatColor(seats: { B: Seat; W: Seat }, controller: Controller): Color | null` в `@goko/protocol` (первый цвет с таким контроллером, порядок B, W); `parseRank(text): Rank | null`; `speakRank(rank): string` («10 кю», «3 дан»); `speakMove(coord): string`; `colorName(c)` («чёрные»/«белые»), `colorNameInstrumental(c)` («чёрными»/«белыми»); `formatPoints(n): string` («1 очко», «5,5 очка», «12 очков»); `describeResult(result: Result, humanColor: Color): string`; `type AgentState`, `newAgentState(sessionId): AgentState`.

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
    "zod": "^4.5.4"
  }
}
```

`npm install` в корне (workspace `apps/*` уже объявлен). `@livekit/agents` принимает zod `^3.25.76 || ^4.1.8`, конфликтов с zod 4.5 нет.

- [ ] **Step 2: Тест `packages/protocol/src/seat.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { seatColor } from './game.ts';

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
});
```

- [ ] **Step 4: Запустить тесты, убедиться, что падают**

Run: `npx vitest run packages/protocol/src/seat.test.ts apps/voice-agent/src/phrases.test.ts`
Expected: FAIL — `seatColor` не экспортируется из `./game.ts`; `Cannot find module './phrases.ts'`.

- [ ] **Step 5: `seatColor` в `packages/protocol/src/game.ts`**

В конец файла добавить:

```ts
// Цвет места с данным контроллером; при двух одинаковых — чёрные. null, если такого места нет.
export function seatColor(seats: { B: Seat; W: Seat }, controller: Controller): Color | null {
  if (seats.B.controller === controller) return 'B';
  if (seats.W.controller === controller) return 'W';
  return null;
}
```

В `packages/protocol/src/index.ts` `seatColor` попадает через уже существующий `export * from './game.ts'` — если в ядре экспорт поимённый, добавить `seatColor` в список.

- [ ] **Step 6: `apps/voice-agent/src/phrases.ts`**

```ts
// Русские формулировки для модели и событий. Всё, что Гоко говорит о партии словами, собрано здесь,
// чтобы модель не переводила коды и не придумывала форму слов.
import { speakCoord } from '@goko/go-core';
import { type Color, RANKS, type Rank, type Result } from '@goko/protocol';

export const colorName = (c: Color): string => (c === 'B' ? 'чёрные' : 'белые');
export const colorNameInstrumental = (c: Color): string => (c === 'B' ? 'чёрными' : 'белыми');

// «10 кю», «10k», «3 дан», «3d», «1-й дан» -> Rank; null, если не разобрали или ранга нет в списке.
export function parseRank(text: string): Rank | null {
  const m = /(\d{1,2})\s*(?:-?\s*(?:й|го|ый|ого))?\s*(k|kyu|кю|d|dan|дан)\b/iu.exec(text.trim());
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

// Результат словами Гоко: «я» — Гоко, «ты» — человек, без рода для человека.
export function describeResult(result: Result, humanColor: Color): string {
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
import type { Color, Rank } from '@goko/protocol';

export type AgentState = {
  sessionId: string;
  gameId: string | null;
  humanColor: Color;
  rank: Rank; // ранг Гоко для следующей партии
  komi: number;
  toolGames: Set<string>; // партии, созданные start_game: их state.updated/new не озвучиваем
  announcedFinish: string | null; // партия, чей результат уже вернул инструмент
  awaitingReply: boolean; // play/pass вернули replyTimedOut: ход движка озвучит событие
  lastTap: { cause: 'play' | 'pass' | 'correct'; coord: string } | null; // ход с экрана, ждём ответ движка
  lastErrorAt: number; // когда в последний раз озвучивали ошибку движка
};

export const DEFAULT_RANK: Rank = '10k';
export const DEFAULT_KOMI = 7.5;

export function newAgentState(sessionId: string): AgentState {
  return {
    sessionId,
    gameId: null,
    humanColor: 'B',
    rank: DEFAULT_RANK,
    komi: DEFAULT_KOMI,
    toolGames: new Set(),
    announcedFinish: null,
    awaitingReply: false,
    lastTap: null,
    lastErrorAt: 0,
  };
}
```

- [ ] **Step 8: Тесты и typecheck зелёные**

Run: `npx vitest run packages/protocol/src/seat.test.ts apps/voice-agent/src/phrases.test.ts && npm run typecheck`
Expected: `2 passed` и `10 passed`, typecheck без ошибок.

- [ ] **Step 9: Commit**

```bash
git add package-lock.json apps/voice-agent/package.json apps/voice-agent/src/phrases.ts apps/voice-agent/src/phrases.test.ts apps/voice-agent/src/state.ts packages/protocol/src/game.ts packages/protocol/src/index.ts packages/protocol/src/seat.test.ts
git commit -m "voice-agent: пакет, фразы и разбор ранга; protocol: seatColor"
```

---

### Task 2: `voice-agent` — инструменты над клиентом протокола, фейковый клиент

**Files:**
- Create: `apps/voice-agent/src/tools.ts`, `apps/voice-agent/src/testing/fake-client.ts`
- Test: `apps/voice-agent/src/tools.test.ts`

**Interfaces:**
- Consumes: `GokoClient`, `ApiError`, `GameState`, `PlayResponse`, `Analysis`, `Move`, `Rank`, `Color`, `seatColor` из `@goko/protocol`; `phrases.ts`, `state.ts` из Task 1; `llm.tool` из `@livekit/agents`.
- Produces: `type ToolClient = Pick<GokoClient, 'newGame' | 'play' | 'correct' | 'pass' | 'resign' | 'undo' | 'getGame' | 'ascii' | 'analyze' | 'setRank'>`; `type ToolDeps = { client: ToolClient; state: AgentState; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void }`; `createToolFns(deps)` с методами `startGame({ my_color?, rank?, komi? })`, `playMove({ coord })`, `correctLastMove({ coord })`, `pass()`, `resign()`, `undo()`, `getPosition(): Promise<string>`, `getAssessment()`, `setRank({ rank })`; `createTools(deps)` — объект из девяти `llm.tool()` с именами из спеки; константы `ASSESSMENT_VISITS = 50`, `FINISH_WAIT_MS = 35000`, `FINISH_POLL_MS = 500`; `humanColorOf(state: GameState): Color`, `engineColorOf(state): Color`. Тестовый клиент: `createFakeClient(opts?: { replies?: string[]; ascii?: string; analysis?: Partial<Analysis>; finishAfterPolls?: number }): FakeClient` (`ToolClient & { calls: Array<{ method: string; args: unknown[] }>; game: GameState | null; failNext(err: Error): void; replyTimedOut: boolean }`); `fakeGame(overrides?: Partial<GameState>): GameState`.

Результаты инструментов (то, что видит модель):

| Инструмент | ok | Поля |
| --- | --- | --- |
| `start_game` | `true` | `gameId`, `youPlay: 'black' \| 'white'`, `rank` («10 кю»), `komi`, `firstMove` (координата или `null`), `firstMoveSpoken`, `note?` |
| `play_move`, `correct_last_move` | `true` | `yourMove`, `myMove` (координата, `'pass'` или `null`), `myMoveSpoken`, `captured` (снял человек этим ходом), `myCaptured`, `toPlay`, `moveNumber`, `note?`, `finished?`, `result?` |
| `pass` | `true` | `myMove`, `myMoveSpoken`, `toPlay`, `finished?`, `result?`, `note?` |
| `resign` | `true` | `result` |
| `undo` | `true` | `removed: string[]`, `removedSpoken: string[]`, `toPlay`, `status` |
| `get_position` | — | текст: ascii-доска, последние 6 ходов, пленные, чей ход |
| `get_assessment` | — | `leader: 'you' \| 'me' \| 'even'`, `marginPoints`, `winrateYou` (проценты), `weakGroups: [{ color: 'yours' \| 'mine', where, status }]`, `bestMoves: string[]`, `toPlay: 'you' \| 'me'` |
| `set_rank` | `true` | `rank`, `note?` |
| любой | `false` | `reason` — русский текст (`illegalMessage` сервера, «партия не начата: предложи начать», «движок не отвечает, попробуй ещё раз через пару секунд») |

- [ ] **Step 1: `apps/voice-agent/src/testing/fake-client.ts`**

```ts
// Фейковый клиент протокола для тестов voice-agent: держит одну партию в памяти, отвечает ходами из сценария,
// пишет журнал вызовов. Правил го здесь нет — только формы ответов game-server.
import {
  type Analysis,
  ApiError,
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
  calls: Array<{ method: string; args: unknown[] }>;
  game: GameState | null;
  replyTimedOut: boolean; // следующий play/pass/correct вернёт replyTimedOut без ответа движка
  failNext(err: Error): void;
};

export function createFakeClient(opts: FakeClientOptions = {}): FakeClient {
  const replies = [...(opts.replies ?? ['K10', 'D10', 'K4'])];
  let pending: Error | null = null;
  let pollsLeft = -1;
  let n = 0;

  const self: FakeClient = {
    calls: [],
    game: null,
    replyTimedOut: false,
    failNext(err) {
      pending = err;
    },
    async newGame(sessionId: string, req: NewGameRequest): Promise<NewGameResponse> {
      record('newGame', sessionId, req);
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
    async play(id: string, req: PlayRequest): Promise<PlayResponse> {
      record('play', id, req);
      return humanMove(req.coord);
    },
    async correct(id: string, req: CorrectRequest): Promise<PlayResponse> {
      record('correct', id, req);
      const g = need();
      g.moves = g.moves.slice(0, -2);
      return humanMove(req.coord);
    },
    async pass(id: string, req: PassRequest = {}): Promise<PlayResponse> {
      record('pass', id, req);
      return humanMove('pass');
    },
    async resign(id: string, req: ResignRequest): Promise<StateResponse> {
      record('resign', id, req);
      throwPending();
      const g = need();
      g.status = 'finished';
      g.result = { winner: req.color === 'B' ? 'W' : 'B', reason: 'resign' };
      g.revision++;
      return { state: g };
    },
    async undo(id: string, req: UndoRequest = {}): Promise<UndoResponse> {
      record('undo', id, req);
      throwPending();
      const g = need();
      if (g.moves.length === 0) throw new ApiError('nothing_to_undo', 'отменять нечего');
      const removed = g.moves.slice(-2);
      g.moves = g.moves.slice(0, -2);
      g.toPlay = seatColor(g.seats, 'human') ?? 'B';
      g.revision++;
      return { state: g, removed };
    },
    async getGame(id: string): Promise<GameState> {
      record('getGame', id);
      const g = need();
      if (pollsLeft > 0) pollsLeft--;
      if (pollsLeft === 0) {
        pollsLeft = -1;
        g.status = 'finished';
        g.result = { winner: 'W', margin: 3.5, reason: 'score' };
      }
      return g;
    },
    async ascii(id: string): Promise<string> {
      record('ascii', id);
      return opts.ascii ?? '# g1 rev 2 playing toPlay B moves 2\n   A B C\n 3 . . .\n 2 . . .\n 1 . . .\n';
    },
    async analyze(id: string, req = {}): Promise<Analysis> {
      record('analyze', id, req);
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
        groups: [
          { color: 'B', stones: ['D4'], liberties: 4, ownershipAvg: 0.9, status: 'safe' },
          { color: 'W', stones: ['K10', 'K11'], liberties: 2, ownershipAvg: -0.1, status: 'unsettled' },
          { color: 'B', stones: ['M3'], liberties: 1, ownershipAvg: -0.8, status: 'dead' },
        ],
        ...opts.analysis,
      };
    },
    async setRank(id: string, req: SetRankRequest): Promise<StateResponse> {
      record('setRank', id, req);
      throwPending();
      const g = need();
      g.seats[req.color] = { ...g.seats[req.color], rank: req.rank };
      g.revision++;
      return { state: g };
    },
  };

  function record(method: string, ...args: unknown[]) {
    self.calls.push({ method, args });
  }
  function throwPending() {
    if (pending) {
      const e = pending;
      pending = null;
      throw e;
    }
  }
  function need(): GameState {
    if (!self.game) throw new ApiError('not_found', 'партии нет');
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
    const g = need();
    if (g.status === 'finished') throw new ApiError('game_finished', 'партия окончена');
    const human = seatColor(g.seats, 'human') ?? 'B';
    if (g.toPlay !== human) throw new ApiError('not_your_turn', 'сейчас ходит Гоко');
    const move: Move = { n: g.moves.length + 1, color: human, coord, captured: 0, at: stamp() };
    g.moves = [...g.moves, move];
    g.toPlay = human === 'B' ? 'W' : 'B';
    g.revision++;
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
import { ApiError } from '@goko/protocol';
import { newAgentState } from './state.ts';
import { createFakeClient, fakeGame } from './testing/fake-client.ts';
import { ASSESSMENT_VISITS, createToolFns, createTools, humanColorOf } from './tools.ts';

function setup(opts: Parameters<typeof createFakeClient>[0] = {}) {
  const client = createFakeClient(opts);
  const state = newAgentState('s1');
  const slept: number[] = [];
  const fns = createToolFns({ client, state, sleep: async (ms) => void slept.push(ms) });
  return { client, state, fns, slept };
}

async function withGame(opts: Parameters<typeof createFakeClient>[0] = {}) {
  const t = setup(opts);
  await t.fns.startGame({ my_color: 'black' });
  t.client.calls.length = 0;
  return t;
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
  it('нелегальный ход — причина словами сервера', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ApiError('illegal_move', 'точка занята', { reason: 'occupied', coord: 'D4' }));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: 'точка занята' });
  });
  it('движок занят — просьба повторить, не исключение', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ApiError('engine_busy', 'движок занят'));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: 'движок не отвечает, попробуй ещё раз через пару секунд' });
  });
  it('не наш ход — reason сервера', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ApiError('not_your_turn', 'сейчас ходит Гоко'));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: 'сейчас ходит Гоко' });
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
      const g = fakeGame({ id: 'g1', status: 'finished', result: { winner: 'B', reason: 'resign' }, moves: [{ n: 1, color: 'B', coord: 'D4', captured: 0, at: 't' }], toPlay: 'W', revision: 1 });
      return { state: g, move: g.moves[0]! };
    };
    const res = await fns.playMove({ coord: 'D4' });
    expect(res).toMatchObject({ ok: true, finished: true, result: 'победа за тобой: я сдался' });
    expect(state.announcedFinish).toBe('g1');
    expect(state.awaitingReply).toBe(false);
  });
  it('не ApiError пробрасывается', async () => {
    const { fns, client } = await withGame();
    client.failNext(new TypeError('fetch failed'));
    await expect(fns.playMove({ coord: 'D4' })).rejects.toThrow('fetch failed');
  });
});

describe('pass / resign / undo', () => {
  it('пас с ответным ходом', async () => {
    const { fns } = await withGame({ replies: ['K10'] });
    expect(await fns.pass()).toEqual({ ok: true, myMove: 'K10', myMoveSpoken: 'ка десять', toPlay: 'B' });
  });
  it('два паса: ждём результат опросом и объявляем', async () => {
    const { fns, state, slept, client } = await withGame({ replies: ['pass'], finishAfterPolls: 2 });
    const res = await fns.pass();
    expect(res).toMatchObject({ ok: true, myMove: 'pass', myMoveSpoken: 'пас', finished: true, result: 'победа за мной, разница 3,5 очка' });
    expect(slept).toEqual([500]);
    expect(client.calls.filter((c) => c.method === 'getGame').length).toBe(2);
    expect(state.announcedFinish).toBe('g1');
  });
  it('resign сдаёт цветом человека', async () => {
    const { fns, state, client } = await withGame();
    expect(await fns.resign()).toEqual({ ok: true, result: 'победа за мной: партия сдана' });
    expect(client.calls.at(-1)).toMatchObject({ method: 'resign', args: ['g1', { color: 'B', via: 'voice' }] });
    expect(state.announcedFinish).toBe('g1');
  });
  it('undo возвращает снятые ходы с произношением', async () => {
    const { fns, state } = await withGame({ replies: ['K10'] });
    await fns.playMove({ coord: 'D4' });
    state.awaitingReply = true;
    expect(await fns.undo()).toEqual({ ok: true, removed: ['D4', 'K10'], removedSpoken: ['дэ четыре', 'ка десять'], toPlay: 'B', status: 'playing' });
    expect(state.awaitingReply).toBe(false);
  });
  it('undo без ходов — reason сервера', async () => {
    const { fns } = await withGame();
    expect(await fns.undo()).toEqual({ ok: false, reason: 'отменять нечего' });
  });
});

describe('get_position / get_assessment / set_rank', () => {
  it('позиция: доска, последние 6 ходов, пленные, чей ход', async () => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10', 'K4', 'G7'] });
    for (const c of ['D4', 'C3', 'E3', 'F4']) await fns.playMove({ coord: c });
    client.game!.captures = { B: 2, W: 0 };
    const text = await fns.getPosition();
    expect(text).toContain('# g1 rev');
    expect(text).toContain('Последние ходы: 3. чёрные C3; 4. белые D10; 5. чёрные E3; 6. белые K4; 7. чёрные F4; 8. белые G7');
    expect(text).not.toContain('1. чёрные D4');
    expect(text).toContain('Пленные: чёрные сняли 2, белые сняли 0');
    expect(text).toContain('Ход: чёрные (твой)');
  });
  it('оценка: лидер, отрыв, шансы, слабые группы, лучшие ходы', async () => {
    const { fns, client } = await withGame();
    const res = await fns.getAssessment();
    expect(res).toEqual({
      leader: 'you',
      marginPoints: 6,
      winrateYou: 70,
      weakGroups: [
        { color: 'mine', where: 'K10, K11', status: 'неустойчива' },
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
  it('humanColorOf берёт место человека, по умолчанию чёрные', () => {
    expect(humanColorOf(fakeGame())).toBe('B');
    expect(humanColorOf(fakeGame({ seats: { B: { controller: 'engine' }, W: { controller: 'human' } } }))).toBe('W');
    expect(humanColorOf(fakeGame({ seats: { B: { controller: 'engine' }, W: { controller: 'external' } } }))).toBe('B');
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
  type Color,
  type GameState,
  type GokoClient,
  type PlayResponse,
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
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export const ASSESSMENT_VISITS = 50;
export const FINISH_WAIT_MS = 35_000; // score на сервере — до 30 с
export const FINISH_POLL_MS = 500;

const NO_GAME = 'партия не начата: предложи начать';
const THINKING_NOTE = 'Гоко ещё думает: свой ход он назовёт сам, когда решит';

type Fail = { ok: false; reason: string };
const fail = (reason: string): Fail => ({ ok: false, reason });

export function humanColorOf(state: GameState): Color {
  return seatColor(state.seats, 'human') ?? 'B';
}

export function engineColorOf(state: GameState): Color {
  return seatColor(state.seats, 'engine') ?? 'W';
}

// Ошибки протокола -> { ok: false, reason } с русским текстом. Всё остальное (сеть, баги) пробрасываем:
// это попадёт в лог воркера, а модель получит ошибку инструмента.
function reasonOf(e: unknown): Fail {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'engine_busy':
      case 'engine_unavailable':
        return fail('движок не отвечает, попробуй ещё раз через пару секунд');
      case 'revision_conflict':
        return fail('позиция только что изменилась, повтори ход');
      default:
        return fail(e.message);
    }
  }
  throw e;
}

function finishedFields(g: GameState) {
  return g.status === 'finished' && g.result ? { finished: true as const, result: describeResult(g.result, humanColorOf(g)) } : {};
}

export function createToolFns(deps: ToolDeps) {
  const { client, state } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? (() => {});

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

  async function waitFinished(gameId: string): Promise<GameState> {
    let g = await client.getGame(gameId);
    for (let i = 0; g.status !== 'finished' && i < FINISH_WAIT_MS / FINISH_POLL_MS; i++) {
      await sleep(FINISH_POLL_MS);
      g = await client.getGame(gameId);
    }
    return g;
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
      const engine = { controller: 'engine' as const, rank };
      const humanSeat = { controller: 'human' as const };
      try {
        const res = await client.newGame(state.sessionId, {
          black: human === 'B' ? humanSeat : engine,
          white: human === 'W' ? humanSeat : engine,
          settings: { komi },
          waitForReply: true,
        });
        const g = res.state;
        state.gameId = g.id;
        state.humanColor = human;
        state.rank = rank;
        state.komi = komi;
        state.toolGames.add(g.id);
        state.announcedFinish = null;
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
      }
    },

    async playMove({ coord }: { coord: string }) {
      if (!state.gameId) return fail(NO_GAME);
      try {
        return moveResult(await client.play(state.gameId, { coord, via: 'voice' }));
      } catch (e) {
        return reasonOf(e);
      }
    },

    async correctLastMove({ coord }: { coord: string }) {
      if (!state.gameId) return fail(NO_GAME);
      try {
        return moveResult(await client.correct(state.gameId, { coord, via: 'voice' }));
      } catch (e) {
        return reasonOf(e);
      }
    },

    async pass() {
      if (!state.gameId) return fail(NO_GAME);
      try {
        const res = await client.pass(state.gameId, { via: 'voice' });
        let g = res.state;
        // Два паса подряд: сервер считает очки асинхронно, ждём завершения и объявляем результат сами.
        if (res.reply?.coord === 'pass' && g.status !== 'finished') g = await waitFinished(g.id);
        const finished = g.status === 'finished';
        if (finished) state.announcedFinish = g.id;
        state.awaitingReply = Boolean(res.replyTimedOut) && !finished;
        return {
          ok: true as const,
          myMove: res.reply?.coord ?? null,
          myMoveSpoken: res.reply ? speakMove(res.reply.coord) : null,
          toPlay: g.toPlay,
          ...(res.replyTimedOut && !finished ? { note: THINKING_NOTE } : {}),
          ...finishedFields(g),
        };
      } catch (e) {
        return reasonOf(e);
      }
    },

    async resign() {
      if (!state.gameId) return fail(NO_GAME);
      try {
        const current = await client.getGame(state.gameId);
        const res = await client.resign(state.gameId, { color: humanColorOf(current), via: 'voice' });
        state.announcedFinish = res.state.id;
        state.awaitingReply = false;
        return { ok: true as const, result: res.state.result ? describeResult(res.state.result, humanColorOf(res.state)) : 'партия сдана' };
      } catch (e) {
        return reasonOf(e);
      }
    },

    async undo() {
      if (!state.gameId) return fail(NO_GAME);
      try {
        const res = await client.undo(state.gameId, { via: 'voice' });
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
      const [g, ascii] = await Promise.all([client.getGame(state.gameId), client.ascii(state.gameId)]);
      const human = humanColorOf(g);
      const last = g.moves
        .slice(-6)
        .map((m) => `${m.n}. ${colorName(m.color)} ${m.coord === 'pass' ? 'пас' : m.coord}`)
        .join('; ');
      const turn = g.status === 'finished' ? 'партия окончена' : `${colorName(g.toPlay)} (${g.toPlay === human ? 'твой' : 'мой'})`;
      return [
        ascii.trimEnd(),
        `Последние ходы: ${last || 'нет'}`,
        `Пленные: чёрные сняли ${g.captures.B}, белые сняли ${g.captures.W}`,
        `Ход: ${turn}`,
      ].join('\n');
    },

    async getAssessment() {
      if (!state.gameId) return fail(NO_GAME);
      try {
        const [g, a] = await Promise.all([client.getGame(state.gameId), client.analyze(state.gameId, { maxVisits: ASSESSMENT_VISITS })]);
        const human = humanColorOf(g);
        const lead = a.scoreLeadB;
        const leaderColor: Color | null = Math.abs(lead) < 0.5 ? null : lead > 0 ? 'B' : 'W';
        const winrateHuman = human === 'B' ? a.winrateB : 1 - a.winrateB;
        return {
          leader: leaderColor === null ? ('even' as const) : leaderColor === human ? ('you' as const) : ('me' as const),
          marginPoints: Math.abs(Math.round(lead * 2) / 2),
          winrateYou: Math.round(winrateHuman * 100),
          weakGroups: a.groups
            .filter((gr) => gr.status !== 'safe')
            .map((gr) => ({
              color: gr.color === human ? ('yours' as const) : ('mine' as const),
              where: gr.stones.slice(0, 3).join(', '),
              status: gr.status === 'dead' ? 'мертва' : 'неустойчива',
            })),
          bestMoves: a.topMoves.slice(0, 3).map((m) => m.coord),
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
      try {
        const g = await client.getGame(state.gameId);
        await client.setRank(state.gameId, { color: engineColorOf(g), rank: parsed });
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
        'Начать новую партию 13x13. my_color — цвет человека: black (чёрные, ходит первым) или white (белые; тогда Гоко ходит первым, его ход в firstMove). rank — уровень Гоко, например «10 кю» или «2 дан»; без него — прежний. komi по умолчанию 7.5.',
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
      description: 'Человек сдаётся. Возвращает result.',
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
Expected: все тесты `tools.test.ts` и `phrases.test.ts` проходят; typecheck без ошибок. Если `llm.tool` в установленной версии требует `parameters` всегда — передать `z.object({})` у инструментов без аргументов.

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
- Consumes: `GameEvent`, `GokoClient` из `@goko/protocol`; `AgentState`; `describeResult`, `speakMove`, `colorName` из `phrases.ts`; `humanColorOf` из `tools.ts`; `fakeGame` из `testing/fake-client.ts`.
- Produces: `handleEvent(ev: GameEvent, state: AgentState, now?: () => number): string | null` — инструкция для `generateReply` или `null`; `watchSession(opts: { client: Pick<GokoClient, 'events'>; state: AgentState; speak: (instructions: string) => Promise<void> | void; signal: AbortSignal; log?: (line: string) => void; retryMs?: number; sleep?: (ms) => Promise<void> }): Promise<void>`; `ERROR_REPEAT_MS = 30000`.

Правила озвучивания (раздел 9 спеки, «Озвучивание событий»), в порядке проверки:

| Событие | Условие | Действие |
| --- | --- | --- |
| `session.game` | всегда | запомнить `gameId`, сбросить `lastTap`, `awaitingReply`; молчать |
| `state.updated`, `cause: 'sync'` | `gameId` только что сменился и партия идёт | «Продолжаем партию»: цвет человека, чей ход |
| `state.updated`, `cause: 'new'` | партия не из `toolGames` | «Человек начал партию с экрана»; если ход движка — `awaitingReply = true` |
| `state.updated`, `status: 'finished'` | любой cause | сбросить флаги, молчать (объявит `game.finished`) |
| `state.updated`, `via: 'tap'`, cause `play/pass/correct` | `pendingEngineMove` | запомнить `lastTap`, молчать до ответа движка |
| то же | нет ответа движка (место `external`) | «Человек сыграл … на экране» |
| `state.updated`, `via: 'tap'`, `cause: 'undo'` | всегда | «Человек отменил ход кнопкой» |
| `state.updated`, `cause: 'engine'` | есть `lastTap` | «Человек сыграл … на экране, ты ответил …» |
| то же | `awaitingReply` | «Твой ход готов: …» |
| то же | иначе (ответ на голосовой ход уже вернул инструмент) | молчать |
| `state.updated`, `by: 'external'` | стадия 2 | «Соперник сыграл …» |
| `game.finished` | `announcedFinish !== gameId` | «Партия окончена: …» |
| `engine.thinking` | — | молчать |
| `error` | прошло ≥ 30 с с прошлой ошибки | «Движку нужно ещё время» |

- [ ] **Step 1: Тест `apps/voice-agent/src/events.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { GameEvent, GameState, Move } from '@goko/protocol';
import { ERROR_REPEAT_MS, handleEvent, watchSession } from './events.ts';
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
    expect(handleEvent({ type: 'session.game', gameId: 'g1' }, s)).toBeNull();
    expect(s.gameId).toBe('g1');
    expect(s.lastTap).toBeNull();
    expect(s.awaitingReply).toBe(false);
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
    const text = handleEvent(upd(g, { cause: 'new', by: 'human', via: 'tap' }), s);
    expect(text).toContain('начал новую партию с экрана');
    expect(text).toContain('человек играет белыми');
    expect(text).toContain('5 кю');
    expect(s.awaitingReply).toBe(true);
    expect(s.gameId).toBe('g2');
  });
  it('new партии из start_game молчит', () => {
    const s = newAgentState('s1');
    s.toolGames.add('g1');
    expect(handleEvent(upd(fakeGame(), { cause: 'new', by: 'human', via: 'voice' }), s)).toBeNull();
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
  it('engine.thinking молчит; error не чаще раза в 30 с', () => {
    const s = newAgentState('s1');
    let t = 1_000_000;
    const now = () => t;
    expect(handleEvent({ type: 'engine.thinking', color: 'W' }, s)).toBeNull();
    expect(handleEvent({ type: 'error', code: 'engine_unavailable', message: 'движок недоступен' }, s, now)).toContain('ещё немного времени');
    t += ERROR_REPEAT_MS - 1;
    expect(handleEvent({ type: 'error', code: 'engine_unavailable', message: 'движок недоступен' }, s, now)).toBeNull();
    t += 2;
    expect(handleEvent({ type: 'error', code: 'engine_unavailable', message: 'движок недоступен' }, s, now)).not.toBeNull();
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
        yield { type: 'engine.thinking', color: 'W' };
        abort.abort();
      },
    };
    const slept: number[] = [];
    await watchSession({ client, state: s, signal: abort.signal, speak: (t) => void spoken.push(t), retryMs: 7, sleep: async (ms) => void slept.push(ms) });
    expect(spoken).toEqual(['Партия окончена: победа за тобой: я сдался. Объяви результат одной фразой.']);
    expect(connects).toBe(2);
    expect(slept).toEqual([7]);
  });
  it('ошибка speak не рвёт цикл', async () => {
    const s = newAgentState('s1');
    s.gameId = 'g1';
    const abort = new AbortController();
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        yield { type: 'game.finished', result: { winner: 'B', reason: 'resign' } };
        yield { type: 'error', code: 'x', message: 'y' };
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
    });
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
// инструкция для generateReply или null. watchSession — цикл чтения потока сессии с переподключением.
import type { GameEvent, GameState, GokoClient } from '@goko/protocol';
import { colorNameInstrumental, describeResult, speakMove, speakRank } from './phrases.ts';
import type { AgentState } from './state.ts';
import { humanColorOf } from './tools.ts';

export const ERROR_REPEAT_MS = 30_000;

const ONE_PHRASE = 'Скажи одну короткую фразу.';

function whoseTurn(g: GameState): string {
  return g.toPlay === humanColorOf(g) ? 'сейчас ход человека' : 'сейчас твой ход';
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
  const fresh = g.id !== state.gameId;
  state.gameId = g.id;
  state.humanColor = humanColorOf(g);
  const last = g.moves.at(-1);

  if (g.status === 'finished') {
    resetTurnFlags(state);
    return null; // объявит game.finished
  }

  switch (ev.cause) {
    case 'sync':
      if (!fresh) return null;
      resetTurnFlags(state);
      return `Продолжаем партию: человек играет ${colorNameInstrumental(state.humanColor)}, сделано ходов: ${g.moves.length}, ${whoseTurn(g)}. ${ONE_PHRASE} Ход не называй, пока его не вернул инструмент.`;
    case 'new': {
      resetTurnFlags(state);
      if (state.toolGames.has(g.id)) return null;
      const engineSeat = g.seats.B.controller === 'engine' ? g.seats.B : g.seats.W;
      state.awaitingReply = g.pendingEngineMove;
      return `Человек начал новую партию с экрана: человек играет ${colorNameInstrumental(state.humanColor)}, Гоко — ${engineSeat.rank ? speakRank(engineSeat.rank) : 'без ранга'}. ${g.pendingEngineMove ? 'Первый ход твой, его назовёт следующее событие: пока не выдумывай.' : 'Первый ход человека.'} ${ONE_PHRASE}`;
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
      state.gameId = ev.gameId;
      resetTurnFlags(state);
      return null;
    case 'state.updated':
      return onStateUpdated(ev, state);
    case 'engine.thinking':
      return null;
    case 'game.finished': {
      if (state.gameId !== null && state.announcedFinish === state.gameId) return null;
      state.announcedFinish = state.gameId;
      resetTurnFlags(state);
      return `Партия окончена: ${describeResult(ev.result, state.humanColor)}. Объяви результат одной фразой.`;
    }
    case 'error': {
      const t = now();
      if (t - state.lastErrorAt < ERROR_REPEAT_MS) return null;
      state.lastErrorAt = t;
      return `Движок не ответил вовремя (${ev.message}); сервер повторит попытку сам. Скажи одной фразой, что тебе нужно ещё немного времени на ход.`;
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
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

// Читает поток сессии, пока не отменят. Обрыв (сеть, рестарт game-server) — пауза и новое подключение:
// первым сообщением сервер шлёт session.game и sync, так что состояние восстанавливается само.
export async function watchSession(opts: WatchOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const retryMs = opts.retryMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (!opts.signal.aborted) {
    try {
      for await (const ev of opts.client.events({ sessionId: opts.state.sessionId }, opts.signal)) {
        const instructions = handleEvent(ev, opts.state);
        if (!instructions) continue;
        try {
          await opts.speak(instructions);
        } catch (e) {
          log(`[!] voice-agent: generateReply не удался: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      if (opts.signal.aborted) return;
      log(`[!] voice-agent: поток сессии оборвался: ${(e as Error).message}`);
    }
    if (opts.signal.aborted) return;
    await sleep(retryMs);
  }
}
```

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
- Create: `apps/voice-agent/src/prompt.ts`, `apps/voice-agent/src/voice.ts`, `apps/voice-agent/src/agent.ts`, `apps/voice-agent/src/metadata.ts`, `apps/voice-agent/src/main.ts`
- Modify: `infra/.env.example` (переменные `VOICE_MODE`, `API_BASE`)
- Test: `apps/voice-agent/src/metadata.test.ts`, `apps/voice-agent/src/voice.test.ts`, `apps/voice-agent/src/agent.eval.test.ts`

**Interfaces:**
- Consumes: `createTools`, `GokoTools` (Task 2); `watchSession` (Task 3); `newAgentState`; `createClient` из `@goko/protocol`; `defineAgent`, `cli`, `ServerOptions`, `voice`, `JobContext` из `@livekit/agents`; `openai` и `silero` плагины.
- Produces: `INSTRUCTIONS: string`, `GREETING_INSTRUCTIONS: string`; `type VoiceMode = 'realtime' | 'pipeline'`, `parseVoiceMode(v: string | undefined): VoiceMode` (бросает на другом значении), `sessionOptions(mode): Promise<SessionOptions>` где `SessionOptions = ConstructorParameters<typeof voice.AgentSession>[0]`; `class GokoAgent extends voice.Agent` с `constructor(tools: GokoTools, opts?: { greet?: boolean })`; `sessionIdOf(metadata: string | undefined, roomName: string): string`; воркер `node apps/voice-agent/src/main.ts dev|start` с переменными `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY`, `APP_KEY` (обязательные, выход с кодом 2), `API_BASE` (по умолчанию `http://127.0.0.1:8787`), `AGENT_NAME` (по умолчанию `goko`), `VOICE_MODE` (по умолчанию `realtime`).

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
- Реплики до двух предложений, если не спрашивают о позиции. Если тебя перебили — замолчи и слушай.`;

export const GREETING_INSTRUCTIONS =
  'Поздоровайся одной короткой фразой как соперник за доской и предложи начать партию или назвать ход. Ничего о позиции не говори.';
```

- [ ] **Step 2: Тест `apps/voice-agent/src/metadata.test.ts` и `apps/voice-agent/src/voice.test.ts`**

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

- [ ] **Step 3: Запустить тесты, убедиться, что падают**

Run: `npx vitest run apps/voice-agent/src/metadata.test.ts apps/voice-agent/src/voice.test.ts`
Expected: FAIL — модули не найдены.

- [ ] **Step 4: `apps/voice-agent/src/metadata.ts`**

```ts
// sessionId из метаданных диспетчеризации (game-server кладёт { sessionId } в roomConfig токена);
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
        inputAudioTranscription: { model: 'gpt-4o-mini-transcribe', language: 'ru' },
      }),
    };
  }
  return {
    vad: await silero.VAD.load(),
    stt: new openai.STT({ model: 'gpt-4o-transcribe', language: 'ru' }),
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
import { createClient } from '@goko/protocol';
import { GokoAgent } from './agent.ts';
import { watchSession } from './events.ts';
import { sessionIdOf } from './metadata.ts';
import { newAgentState } from './state.ts';
import { createTools } from './tools.ts';
import { parseVoiceMode, sessionOptions } from './voice.ts';

const root = path.resolve(import.meta.dirname, '../../..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[X] voice-agent: нужна переменная ${name} (см. infra/.env.example)`);
    process.exit(2);
  }
  return v;
}

for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'OPENAI_API_KEY']) need(name);
const APP_KEY = need('APP_KEY');
const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const AGENT_NAME = process.env.AGENT_NAME ?? 'goko';
const VOICE_MODE = parseVoiceMode(process.env.VOICE_MODE);

const log = (line: string) => console.log(line);

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const sessionId = sessionIdOf(ctx.job.metadata, ctx.room.name ?? '');
    log(`[OK] voice-agent: комната ${ctx.room.name}, сессия ${sessionId}, режим ${VOICE_MODE}`);
    await ctx.connect();

    const client = createClient({ baseUrl: API_BASE, appKey: APP_KEY });
    const state = newAgentState(sessionId);
    const agent = new GokoAgent(createTools({ client, state, log }));
    const session = new voice.AgentSession(await sessionOptions(VOICE_MODE));

    // Лента для логов: что услышали и что сказали. Значений env здесь нет.
    session.on('user_input_transcribed', (ev) => {
      if (ev.isFinal) log(`[user] ${ev.transcript}`);
    });
    session.on('conversation_item_added', (ev) => {
      if (ev.item.role === 'assistant' && ev.item.textContent) log(`[goko] ${ev.item.textContent}`);
    });
    session.on('function_tools_executed', (ev) => {
      for (const call of ev.functionCalls) log(`[tool] ${call.name} ${call.args}`);
    });

    const abort = new AbortController();
    session.on('close', () => abort.abort());
    ctx.addShutdownCallback(async () => abort.abort());

    await session.start({ agent, room: ctx.room });
    void watchSession({
      client,
      state,
      signal: abort.signal,
      log,
      speak: async (instructions) => {
        session.generateReply({ instructions });
      },
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
```

Если у события `function_tools_executed` в установленной версии другое поле (не `functionCalls` с `name`/`args`), подстроить лог по типу `FunctionToolsExecutedEvent` из `@livekit/agents` — суть та же: имя инструмента и аргументы одной строкой. Если `ctx.addShutdownCallback` отсутствует — убрать строку, `close` сессии достаточно.

- [ ] **Step 8: `infra/.env.example` — переменные агента** (после строки `AGENT_NAME=goko ...`)

```
VOICE_MODE=realtime                # pipeline — запасной конвейер STT -> LLM -> TTS (раздел 9 спеки)
API_BASE=http://127.0.0.1:8787     # куда voice-agent ходит за партией; в контейнере http://game-server:8787
```

- [ ] **Step 9: Тесты, typecheck, запуск воркера**

Run: `npx vitest run apps/voice-agent && npm run typecheck`
Expected: все тесты `voice-agent` проходят (eval-файла пока нет), typecheck без ошибок.

Run (нужен `.env` с `LIVEKIT_*`, `OPENAI_API_KEY`, `APP_KEY`): `AGENT_NAME=goko-dev node apps/voice-agent/src/main.ts dev`
Expected: в логе `registered worker` с `agentName goko-dev`; без `.env` — `[X] voice-agent: нужна переменная LIVEKIT_URL` и код 2. Остановить Ctrl+C.

- [ ] **Step 10: Платные evals `apps/voice-agent/src/agent.eval.test.ts`** (включаются только `RUN_AGENT_EVALS=1` при `OPENAI_API_KEY`; в `npm run check` — `skipped`)

```ts
// Проверка поведения модели с инструментами (раздел 12 спеки). Стоит денег: RUN_AGENT_EVALS=1 npx vitest run apps/voice-agent/src/agent.eval.test.ts
// Модель — текстовая (gpt-4.1-mini), не realtime: инструменты и промпт те же, проверяем выбор инструмента и аргументы.
import { afterEach, describe, expect, it } from 'vitest';
import { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { GokoAgent } from './agent.ts';
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

  it('«дэ четыре» -> play_move D4', async () => {
    const { session } = await start();
    const result = await session.run({ userInput: 'дэ четыре' });
    result.expect.containsFunctionCall({ name: 'play_move', args: { coord: 'D4' } });
  }, 60_000);

  it('«нет, дэ пять» после хода -> correct_last_move D5', async () => {
    const { session } = await start();
    await session.run({ userInput: 'дэ четыре' });
    const result = await session.run({ userInput: 'нет, дэ пять' });
    result.expect.containsFunctionCall({ name: 'correct_last_move', args: { coord: 'D5' } });
  }, 90_000);

  it('«пас» -> pass', async () => {
    const { session } = await start();
    const result = await session.run({ userInput: 'пас' });
    result.expect.containsFunctionCall({ name: 'pass' });
  }, 60_000);

  it('«кто впереди» -> get_assessment, без лучшего хода в ответе', async () => {
    const { session } = await start();
    const result = await session.run({ userInput: 'кто впереди?' });
    result.expect.containsFunctionCall({ name: 'get_assessment' });
    const message = result.expect.at(-1).isMessage({ role: 'assistant' });
    const text = String(message.item.textContent ?? '');
    expect(text.length).toBeGreaterThan(0);
    for (const best of ['K10', 'ка десять', 'D10', 'дэ десять']) expect(text.toLowerCase()).not.toContain(best.toLowerCase());
  }, 60_000);

  it('«давай партию, я белыми» -> start_game white', async () => {
    const { session } = await start({ withGame: false });
    const result = await session.run({ userInput: 'давай партию, я белыми' });
    result.expect.containsFunctionCall({ name: 'start_game', args: { my_color: 'white' } });
  }, 60_000);
});
```

Судья «без лучшего хода» — проверка строки, а не LLM-судья: в `RunResult` agents-js судьи нет, а координаты из `bestMoves` фейкового клиента известны заранее. Если у `MessageAssert` в установленной версии другое имя поля с текстом (не `item.textContent`) — взять его из типа `MessageAssert` в `@livekit/agents`.

Run: `RUN_AGENT_EVALS=1 npx vitest run apps/voice-agent/src/agent.eval.test.ts` (PowerShell: `$env:RUN_AGENT_EVALS='1'; npx vitest run apps/voice-agent/src/agent.eval.test.ts`)
Expected: 5 passed. Провал «дэ четыре» → править формулировки в `prompt.ts` (таблица произношения) и описания инструментов в `tools.ts`, не тест. Запусков мало: каждый прогон стоит денег.

Run: `npm run check`
Expected: `agent.eval.test.ts` — `skipped`, остальное зелёное.

- [ ] **Step 11: Commit**

```bash
git add apps/voice-agent/src/prompt.ts apps/voice-agent/src/voice.ts apps/voice-agent/src/voice.test.ts apps/voice-agent/src/agent.ts apps/voice-agent/src/metadata.ts apps/voice-agent/src/metadata.test.ts apps/voice-agent/src/main.ts apps/voice-agent/src/agent.eval.test.ts infra/.env.example
git commit -m "voice-agent: промпт, режимы realtime/pipeline, воркер, evals по флагу"
```

---
### Task 5: `scripts/chat.mjs` — текстовый диалог с Гоко из консоли

**Files:**
- Create: `scripts/chat.mjs`
- Modify: `package.json` (корень: скрипт `chat`, devDependency `@livekit/rtc-node`)
- Test: `scripts/chat.test.ts`

**Interfaces:**
- Consumes: `createClient` из `@goko/protocol` (`createSession`, `events`, `ascii`); `Room`, `RoomEvent` из `@livekit/rtc-node`; воркер из Task 4, зарегистрированный под тем же `AGENT_NAME`, что и game-server.
- Produces: `node scripts/chat.mjs [--api http://127.0.0.1:8787]` (`npm run chat`): создаёт сессию через game-server, входит в комнату с токеном сессии (агент диспетчеризуется сам), stdin → `lk.chat`, ответы из `lk.transcription` и события SSE → stdout; команда `/board` печатает ascii-доску; `describeEvent(ev): string` — экспорт для теста.

- [ ] **Step 1: Тест `scripts/chat.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { describeEvent } from './chat.mjs';

describe('describeEvent', () => {
  it('коротко описывает события сессии', () => {
    expect(describeEvent({ type: 'session.game', gameId: 'g1' })).toBe('партия g1');
    expect(describeEvent({ type: 'engine.thinking', color: 'W' })).toBe('Гоко думает за W');
    expect(describeEvent({ type: 'game.finished', result: { winner: 'W', reason: 'resign' } })).toBe('конец: W+R');
    expect(describeEvent({ type: 'game.finished', result: { winner: 'B', margin: 5.5, reason: 'score' } })).toBe('конец: B+5.5');
    expect(describeEvent({ type: 'error', code: 'engine_busy', message: 'занят' })).toBe('ошибка engine_busy: занят');
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

- [ ] **Step 2: Запустить тест, убедиться, что падает**

Run: `npx vitest run scripts/chat.test.ts`
Expected: FAIL — `Cannot find module './chat.mjs'`.

- [ ] **Step 3: `scripts/chat.mjs`**

```js
#!/usr/bin/env node
// Текстовый диалог с Гоко без микрофона (раздел 12 спеки): сессия через game-server, комната LiveKit,
// stdin -> lk.chat, lk.transcription и события SSE -> stdout. Нужны LIVEKIT на VPS и запущенный воркер
// с тем же AGENT_NAME, что у game-server (npm run dev поднимает оба под goko-dev).
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Room, RoomEvent } from '@livekit/rtc-node';
import { createClient } from '@goko/protocol';

export function describeEvent(ev) {
  switch (ev.type) {
    case 'session.game':
      return `партия ${ev.gameId}`;
    case 'engine.thinking':
      return `Гоко думает за ${ev.color}`;
    case 'game.finished':
      return `конец: ${ev.result.winner}+${ev.result.reason === 'resign' ? 'R' : ev.result.margin}`;
    case 'error':
      return `ошибка ${ev.code}: ${ev.message}`;
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
  const api = apiIndex >= 0 ? argv[apiIndex + 1] : (process.env.API_BASE ?? 'http://127.0.0.1:8787');
  const appKey = process.env.APP_KEY;
  if (!appKey) {
    console.error('[X] chat: нужен APP_KEY в .env');
    process.exit(2);
  }

  const client = createClient({ baseUrl: api, appKey });
  const { session, livekit } = await client.createSession();
  console.log(`[OK] сессия ${session.id}, комната ${session.room}, агент ${process.env.AGENT_NAME ?? 'goko'}`);

  const sent = new Set();
  let gameId = session.currentGameId;
  const room = new Room();
  room.registerTextStreamHandler('lk.transcription', async (reader, info) => {
    let text = '';
    for await (const chunk of reader) text += chunk;
    const attrs = reader.info.attributes ?? {};
    if (attrs['lk.transcription_final'] === 'false') return;
    if (sent.has(text)) return; // эхо нашей же реплики из lk.chat
    console.log(`[${info.identity}] ${text}`);
  });
  room.on(RoomEvent.ParticipantConnected, (p) => console.log(`[OK] в комнате: ${p.identity}`));
  room.on(RoomEvent.ParticipantDisconnected, (p) => console.log(`[!] вышел: ${p.identity}`));
  room.on(RoomEvent.Disconnected, () => {
    console.log('[!] комната закрыта');
    process.exit(0);
  });
  await room.connect(livekit.url, livekit.token, { autoSubscribe: true, dynacast: false });
  console.log(`[OK] вошёл как ${room.localParticipant?.identity}; жду агента...`);

  const abort = new AbortController();
  void (async () => {
    try {
      for await (const ev of client.events({ sessionId: session.id }, abort.signal)) {
        if (ev.type === 'session.game') gameId = ev.gameId;
        console.log(`[event] ${describeEvent(ev)}`);
      }
    } catch (e) {
      if (!abort.signal.aborted) console.log(`[!] SSE оборвался: ${e.message}`);
    }
  })();

  const stop = async () => {
    abort.abort();
    await room.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log('[OK] пиши фразы («давай партию», «дэ четыре», «кто впереди»); /board — доска; Ctrl+C — выход');
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    if (text === '/board') {
      if (!gameId) console.log('[!] партии ещё нет');
      else console.log(await client.ascii(gameId));
      continue;
    }
    sent.add(text);
    await room.localParticipant.sendText(text, { topic: 'lk.chat' });
  }
  await stop();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[X] chat: ${e.message}`);
    process.exit(1);
  });
}
```

Если `sendText` в установленной версии `@livekit/rtc-node` отсутствует — стадия 0 (`spike/chat.mjs`) уже нашла рабочий путь; повторить его здесь (`publishData` с `topic: 'lk.chat'`).

- [ ] **Step 4: Корневой `package.json`**

В `"scripts"` добавить `"chat": "node scripts/chat.mjs"`. В `"devDependencies"` добавить `"@livekit/rtc-node": "^0.13.34"` (нужен только скрипту; воркер тянет свою копию через `@livekit/agents`). Затем `npm install`.

- [ ] **Step 5: Тест и прогон**

Run: `npx vitest run scripts/chat.test.ts`
Expected: PASS.

Run (нужны `.env` с `LIVEKIT_*`, `OPENAI_API_KEY`, `APP_KEY`; в одном терминале `npm run dev`): `npm run chat`
Expected: `[OK] сессия ...`, `[OK] вошёл как phone-<id>`, через 1–3 с `[OK] в комнате: <identity агента>` и приветствие `[<identity агента>] ...`. Ввести `давай партию` → `[event] партия g...`, `[event] new by human via voice ...`, реплика агента; `дэ четыре` → `[event] play by human via voice: ход 1 B D4 ...`, `[event] engine by engine: ход 2 W ...`, агент называет ход; `/board` печатает ascii-доску с двумя камнями; `кто впереди` → `[event]`-строк нет (analyze событий не шлёт), агент отвечает без лучшего хода. Без VPS шаг пропускается и отмечается в `docs/NOW.md` как `[TODO founder]` проверка.

- [ ] **Step 6: Commit**

```bash
git add scripts/chat.mjs scripts/chat.test.ts package.json package-lock.json
git commit -m "scripts: chat — текстовый диалог с Гоко в комнате LiveKit"
```

---
### Task 6: `web` — каркас Vite, геометрия доски, лента, поток событий, тексты

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/vite-env.d.ts`, `apps/web/src/geometry.ts`, `apps/web/src/transcript.ts`, `apps/web/src/stream.ts`, `apps/web/src/text.ts`
- Modify: `package.json` (корень: `typecheck` с веб-конфигом, скрипт `build:web`)
- Test: `apps/web/src/geometry.test.ts`, `apps/web/src/transcript.test.ts`, `apps/web/src/stream.test.ts`, `apps/web/src/text.test.ts`

**Interfaces:**
- Consumes: `formatCoord`, `type Point` из `@goko/go-core`; `ApiError`, `GameEvent`, `GameState`, `GokoClient`, `Color`, `seatColor` из `@goko/protocol`.
- Produces: `VIEW = 1000`; `type Layout = { size; step; margin }`; `layout(size): Layout`; `x(l, col)`, `y(l, row)`; `pointAt(l, px, py): Point | null`; `coordAt(p): string`; `hoshi(size): Point[]`; `type Stone = { col; row; color }`; `stones(board, size): Stone[]`; `indexOf(p, size): number`. `type Who = 'me' | 'goko'`; `type Line = { id; who; text; final }`; `MAX_LINES = 200`; `upsertLine(lines, line): Line[]`; `whoOf(attrs, myTrackSids, senderIdentity, myIdentity): Who`; `lineId(attrs, streamId): string`. `streamEvents(client, sessionId, signal, handlers, sleep?)`, `RETRY_MS = [1000, 2000, 5000]`, `type StreamHandlers = { onEvent; onConnected?; onLost }`. `describeError(e): string`; `humanColorOf(g): Color`; `resultText(g): string`; `statusText(g, thinking): string`; `capturesText(g)`, `rankText(g)`.

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

Корневой `package.json`: `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p apps/web/tsconfig.json --noEmit"`, добавить `"build:web": "npm run build --workspace apps/web"`. Затем `npm install`.

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
import { type Line, MAX_LINES, lineId, upsertLine, whoOf } from './transcript.ts';

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
```

`apps/web/src/stream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError, type GameEvent } from '@goko/protocol';
import { RETRY_MS, streamEvents } from './stream.ts';

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
        yield { type: 'engine.thinking', color: 'W' };
        abort.abort();
      },
    };
    const got: string[] = [];
    const conn: boolean[] = [];
    const slept: number[] = [];
    await streamEvents(client, 's1', abort.signal, { onEvent: (ev) => got.push(ev.type), onConnected: (c) => conn.push(c), onLost: () => got.push('LOST') }, async (ms) => void slept.push(ms));
    expect(got).toEqual(['session.game', 'engine.thinking']);
    expect(conn).toEqual([true, false, true]);
    expect(slept).toEqual([RETRY_MS[0]]);
    expect(connects).toBe(2);
  });
  it('растит паузу и сбрасывает после успешного подключения', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects < 4) throw new Error('down');
        yield { type: 'engine.thinking', color: 'B' };
        abort.abort();
      },
    };
    const slept: number[] = [];
    await streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, async (ms) => void slept.push(ms));
    expect(slept).toEqual([1000, 2000, 5000]);
  });
  it('not_found — сессия истекла: onLost и выход без повторов', async () => {
    const abort = new AbortController();
    const client = {
      // eslint-disable-next-line require-yield
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        throw new ApiError('not_found', 'сессии нет');
      },
    };
    let lost = 0;
    await streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => lost++ }, async () => {});
    expect(lost).toBe(1);
  });
});
```

`apps/web/src/text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError, type GameState } from '@goko/protocol';
import { capturesText, describeError, rankText, resultText, statusText } from './text.ts';

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
    expect(describeError(new ApiError('not_your_turn', 'сейчас ходит Гоко'))).toBe('сейчас ходит Гоко');
    expect(describeError(new TypeError('Failed to fetch'))).toBe('нет связи с сервером');
  });
  it('statusText', () => {
    expect(statusText(null, false)).toBe('Партии нет: скажи «давай партию» или нажми «Новая партия»');
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
});
```

- [ ] **Step 3: Запустить тесты, убедиться, что падают**

Run: `npx vitest run apps/web`
Expected: FAIL — четыре модуля не найдены.

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
  const col = Math.round((px - l.margin) / l.step);
  const row = l.size - 1 - Math.round((py - l.margin) / l.step);
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
```

- [ ] **Step 6: `apps/web/src/stream.ts`**

```ts
// Поток событий сессии с переподключением. После обрыва сервер первым сообщением шлёт session.game и sync
// с полным состоянием — это и есть «get_game при переподключении» из раздела 10 спеки.
import { ApiError, type GameEvent, type GokoClient } from '@goko/protocol';

export type StreamHandlers = {
  onEvent: (ev: GameEvent) => void;
  onConnected?: (connected: boolean) => void;
  onLost: () => void; // сессия истекла (not_found): нужна новая
};

export const RETRY_MS = [1000, 2000, 5000] as const;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function streamEvents(
  client: Pick<GokoClient, 'events'>,
  sessionId: string,
  signal: AbortSignal,
  handlers: StreamHandlers,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      let first = true;
      for await (const ev of client.events({ sessionId }, signal)) {
        if (first) {
          first = false;
          attempt = 0;
          handlers.onConnected?.(true);
        }
        handlers.onEvent(ev);
      }
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError && e.code === 'not_found') {
        handlers.onLost();
        return;
      }
    }
    if (signal.aborted) return;
    handlers.onConnected?.(false);
    await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 5000);
    attempt++;
  }
}
```

- [ ] **Step 7: `apps/web/src/text.ts`**

```ts
// Тексты статуса и ошибок на экране. Позицию не интерпретируем: только поля состояния.
import { ApiError, type Color, type GameState, seatColor } from '@goko/protocol';

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'нет связи с сервером';
}

export function humanColorOf(g: GameState): Color {
  return seatColor(g.seats, 'human') ?? 'B';
}

const colorName = (c: Color) => (c === 'B' ? 'чёрные' : 'белые');
const margin = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

export function resultText(g: GameState): string {
  const r = g.result;
  if (!r) return 'Партия окончена';
  const who = r.winner === humanColorOf(g) ? 'Победа твоя' : 'Победа Гоко';
  return r.reason === 'resign' ? `${who}: сдача` : `${who}: +${margin(r.margin ?? 0)}`;
}

export function statusText(g: GameState | null, thinking: boolean): string {
  if (!g) return 'Партии нет: скажи «давай партию» или нажми «Новая партия»';
  if (g.status === 'finished') return resultText(g);
  const whose = g.toPlay === humanColorOf(g) ? 'твой ход' : thinking ? 'Гоко думает' : 'ход Гоко';
  return `Ход ${g.moves.length + 1}, ${whose} (${colorName(g.toPlay)})`;
}

export const capturesText = (g: GameState): string => `Пленные: чёрные ${g.captures.B}, белые ${g.captures.W}`;

export function rankText(g: GameState): string {
  const engine = seatColor(g.seats, 'engine');
  const rank = engine ? g.seats[engine].rank : undefined;
  return rank ? `Гоко ${rank}` : 'Гоко';
}
```

- [ ] **Step 8: Тесты и typecheck зелёные**

Run: `npx vitest run apps/web && npm run typecheck`
Expected: все четыре файла тестов проходят; `tsc -p apps/web/tsconfig.json` без ошибок (пока в `src` только эти модули; `main.tsx` появится в Task 8).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/src/vite-env.d.ts apps/web/src/geometry.ts apps/web/src/geometry.test.ts apps/web/src/transcript.ts apps/web/src/transcript.test.ts apps/web/src/stream.ts apps/web/src/stream.test.ts apps/web/src/text.ts apps/web/src/text.test.ts
git commit -m "web: каркас Vite, геометрия доски, лента, поток событий, тексты статуса"
```

---

### Task 7: `web` — клиент, `useSession`, `useGame`

**Files:**
- Create: `apps/web/src/api.ts`, `apps/web/src/hooks/useSession.ts`, `apps/web/src/hooks/useGame.ts`

**Interfaces:**
- Consumes: `createClient`, `CreateSessionResponse`, `GameState`, `NewGameRequest` из `@goko/protocol`; `Room`, `RoomEvent`, `Track` из `livekit-client`; `upsertLine`, `whoOf`, `lineId`, `Line` (Task 6); `streamEvents`; `describeError`, `humanColorOf`.
- Produces: `client: GokoClient`; `useSession(): { session: Session | null; lines: Line[]; mic: MicState; error: string | null; clearError(): void; enableMic(): Promise<void>; reset(): void }`, `type MicState = 'off' | 'connecting' | 'on' | 'failed'`; `useGame(sessionId: string | null, onLost: () => void): { state: GameState | null; gameId: string | null; thinking: boolean; connected: boolean; message: string | null; play(coord): Promise<void>; pass(); resign(); undo(); newGame() }`; `DEFAULT_NEW_GAME: NewGameRequest`.

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

```ts
// Сессия Гоко на телефоне: создание через game-server (хранится в sessionStorage, чтобы перезагрузка страницы
// не плодила сессии), комната LiveKit по токену сессии, микрофон по первому касанию, лента транскриптов.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { CreateSessionResponse } from '@goko/protocol';
import { client } from '../api.ts';
import { describeError } from '../text.ts';
import { type Line, lineId, upsertLine, whoOf } from '../transcript.ts';

const STORAGE_KEY = 'goko.session';

export type MicState = 'off' | 'connecting' | 'on' | 'failed';

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

export function useSession() {
  const [info, setInfo] = useState<CreateSessionResponse | null>(loadStored);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [mic, setMic] = useState<MicState>('off');
  const roomRef = useRef<Room | null>(null);
  const creating = useRef(false);

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
    void roomRef.current?.disconnect();
    roomRef.current = null;
    setMic('off');
    setLines([]);
    setInfo(null);
  }, []);

  const enableMic = useCallback(async () => {
    if (!info || roomRef.current) return;
    setMic('connecting');
    const room = new Room();
    roomRef.current = room;
    const audioHost = document.getElementById('audio') ?? document.body;
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) audioHost.appendChild(track.attach());
    });
    room.on(RoomEvent.Disconnected, () => {
      roomRef.current = null;
      setMic('off');
    });
    // Регистрировать до connect: первые реплики агента приходят сразу после входа.
    room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
      const attrs = reader.info.attributes ?? {};
      const id = lineId(attrs, reader.info.id);
      const mySids = new Set(room.localParticipant.getTrackPublications().map((p) => p.trackSid));
      const who = whoOf(attrs, mySids, participant?.identity ?? '', room.localParticipant.identity);
      let text = '';
      for await (const chunk of reader) {
        text += chunk;
        setLines((ls) => upsertLine(ls, { id, who, text, final: false }));
      }
      setLines((ls) => upsertLine(ls, { id, who, text, final: attrs['lk.transcription_final'] !== 'false' }));
    });
    try {
      await room.connect(info.livekit.url, info.livekit.token);
      await room.startAudio(); // iOS: воспроизведение только после жеста пользователя
      await room.localParticipant.setMicrophoneEnabled(true);
      setMic('on');
    } catch (e) {
      setMic('failed');
      setError(describeError(e) === 'нет связи с сервером' ? 'не удалось подключить микрофон' : describeError(e));
      roomRef.current = null;
    }
  }, [info]);

  const clearError = useCallback(() => setError(null), []);

  return { session: info?.session ?? null, lines, mic, error, clearError, enableMic, reset };
}
```

- [ ] **Step 3: `apps/web/src/hooks/useGame.ts`**

```ts
// Партия на экране: состояние из SSE сессии, действия тапами через тот же протокол, что и голос.
// Проверка «чей ход» — только по полям состояния; правил го здесь нет.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameState, NewGameRequest } from '@goko/protocol';
import { client } from '../api.ts';
import { streamEvents } from '../stream.ts';
import { describeError, humanColorOf } from '../text.ts';

export const DEFAULT_NEW_GAME: NewGameRequest = {
  black: { controller: 'human' },
  white: { controller: 'engine', rank: '10k' },
  settings: { komi: 7.5 },
};

const MESSAGE_MS = 3000;

export function useGame(sessionId: string | null, onLost: () => void) {
  const [state, setState] = useState<GameState | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((text: string) => {
    setMessage(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), MESSAGE_MS);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const abort = new AbortController();
    void streamEvents(client, sessionId, abort.signal, {
      onConnected: setConnected,
      onLost,
      onEvent: (ev) => {
        switch (ev.type) {
          case 'session.game':
            setGameId(ev.gameId);
            break;
          case 'state.updated':
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
            flash(ev.message);
            break;
        }
      },
    });
    return () => abort.abort();
  }, [sessionId, onLost, flash]);

  const guard = useCallback((): string | null => {
    if (!gameId || !state) return 'партии ещё нет';
    if (state.status === 'finished') return 'партия окончена';
    return null;
  }, [gameId, state]);

  const humanTurn = Boolean(state && state.status === 'playing' && state.toPlay === humanColorOf(state) && !state.pendingEngineMove);

  const act = useCallback(
    async (fn: () => Promise<unknown>, needTurn: boolean) => {
      const g = guard();
      if (g) return flash(g);
      if (needTurn && !humanTurn) return flash('сейчас ход Гоко');
      try {
        await fn();
      } catch (e) {
        flash(describeError(e));
      }
    },
    [guard, humanTurn, flash],
  );

  const play = useCallback(
    (coord: string) => act(() => client.play(gameId!, { coord, via: 'tap', expectedRevision: state!.revision, waitForReply: false }), true),
    [act, gameId, state],
  );
  const pass = useCallback(() => act(() => client.pass(gameId!, { via: 'tap', expectedRevision: state!.revision, waitForReply: false }), true), [act, gameId, state]);
  const undo = useCallback(() => act(() => client.undo(gameId!, { via: 'tap' }), false), [act, gameId]);
  const resign = useCallback(() => act(() => client.resign(gameId!, { color: humanColorOf(state!), via: 'tap' }), false), [act, gameId, state]);

  // «Новая партия» — с настройками текущей (цвета, ранг, коми), иначе по умолчанию. Ответ движка ждать не надо:
  // придёт событием, а Гоко прокомментирует новую партию сам (session.game + state.updated/new).
  const newGame = useCallback(async () => {
    if (!sessionId) return;
    const req: NewGameRequest = state
      ? { black: state.seats.B, white: state.seats.W, settings: { boardSize: state.settings.boardSize, komi: state.settings.komi } }
      : DEFAULT_NEW_GAME;
    try {
      await client.newGame(sessionId, { ...req, waitForReply: false });
    } catch (e) {
      flash(describeError(e));
    }
  }, [sessionId, state, flash]);

  return { state, gameId, thinking, connected, message, play, pass, undo, resign, newGame };
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: без ошибок. Если у `livekit-client` 2.22 метод `getTrackPublications()` называется иначе — взять список публикаций локального участника из типа `LocalParticipant` (нужны `trackSid` аудиотреков).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/hooks/useSession.ts apps/web/src/hooks/useGame.ts
git commit -m "web: клиент протокола, useSession (комната, микрофон, лента), useGame (SSE, действия тапами)"
```

---

### Task 8: `web` — компоненты, страница, стили, проверка в браузере

**Files:**
- Create: `apps/web/src/components/Board.tsx`, `apps/web/src/components/Transcript.tsx`, `apps/web/src/components/StatusBar.tsx`, `apps/web/src/components/Controls.tsx`, `apps/web/src/App.tsx`, `apps/web/src/main.tsx`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `geometry.ts`, `transcript.ts`, `text.ts`, хуки Task 7; `parseCoord` из `@goko/go-core`; `GameState` из `@goko/protocol`.
- Produces: `Board({ state, size, onTap })`, `Transcript({ lines })`, `StatusBar({ state, thinking, message, connected })`, `Controls({ mic, canAct, onMic, onPass, onResign, onUndo, onNewGame })`, `App()`; сборка `npm run build:web` → `apps/web/dist`.

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

- [ ] **Step 2: `apps/web/src/components/Transcript.tsx`, `StatusBar.tsx`, `Controls.tsx`**

```tsx
// Transcript.tsx — лента реплик обеих сторон, автопрокрутка к последней.
import { useEffect, useRef } from 'react';
import type { Line } from '../transcript.ts';

export function Transcript({ lines }: { lines: Line[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div ref={ref} className="transcript" aria-live="polite">
      {lines.length === 0 && <p className="muted">Лента диалога появится после включения микрофона.</p>}
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
// StatusBar.tsx — чей ход, номер хода, ранг, пленные; при finished — результат; сообщения на 3 с.
import type { GameState } from '@goko/protocol';
import { capturesText, rankText, statusText } from '../text.ts';

type Props = { state: GameState | null; thinking: boolean; message: string | null; connected: boolean };

export function StatusBar({ state, thinking, message, connected }: Props) {
  return (
    <div className="status">
      <div className="status-main">{message ?? statusText(state, thinking)}</div>
      <div className="status-sub muted">
        {state ? `${rankText(state)} · ${capturesText(state)}` : ''}
        {!connected && state ? ' · нет связи, переподключаюсь' : ''}
      </div>
    </div>
  );
}
```

```tsx
// Controls.tsx — «Микрофон» крупно (первое касание: разрешение и startAudio), остальные мелко. Цели ≥ 44 px.
import { useEffect, useState } from 'react';
import type { MicState } from '../hooks/useSession.ts';

type Props = {
  mic: MicState;
  canAct: boolean;
  onMic: () => void;
  onPass: () => void;
  onResign: () => void;
  onUndo: () => void;
  onNewGame: () => void;
};

const MIC_LABEL: Record<MicState, string> = { off: 'Микрофон', connecting: 'Подключаю…', on: 'Микрофон включён', failed: 'Микрофон: ещё раз' };

export function Controls({ mic, canAct, onMic, onPass, onResign, onUndo, onNewGame }: Props) {
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
      <button className="btn btn-mic" onClick={onMic} disabled={mic === 'connecting' || mic === 'on'}>
        {MIC_LABEL[mic]}
      </button>
      <div className="controls-row">
        <button className="btn" onClick={onPass} disabled={!canAct}>Пас</button>
        <button className="btn" onClick={resign} disabled={!canAct}>{armed ? 'Точно?' : 'Сдаться'}</button>
        <button className="btn" onClick={onUndo} disabled={!canAct}>Отменить</button>
        <button className="btn" onClick={onNewGame}>Новая партия</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `apps/web/src/App.tsx`, `apps/web/src/main.tsx`, `apps/web/src/styles.css`**

```tsx
// App.tsx — одна страница: статус, доска, кнопки, лента. Без агента в комнате всё, кроме ленты, работает тапами.
import { Board } from './components/Board.tsx';
import { Controls } from './components/Controls.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Transcript } from './components/Transcript.tsx';
import { useGame } from './hooks/useGame.ts';
import { useSession } from './hooks/useSession.ts';

export function App() {
  const s = useSession();
  const g = useGame(s.session?.id ?? null, s.reset);
  const size = g.state?.settings.boardSize ?? 13;
  return (
    <div className="app">
      <StatusBar state={g.state} thinking={g.thinking} message={g.message ?? s.error} connected={g.connected} />
      <Board state={g.state} size={size} onTap={(coord) => void g.play(coord)} />
      <Controls
        mic={s.mic}
        canAct={g.state?.status === 'playing'}
        onMic={() => void s.enableMic()}
        onPass={() => void g.pass()}
        onResign={() => void g.resign()}
        onUndo={() => void g.undo()}
        onNewGame={() => void g.newGame()}
      />
      <Transcript lines={s.lines} />
      <div id="audio" hidden />
    </div>
  );
}
```

```tsx
// main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/web/src/styles.css`:

```css
/* Несколько переменных, две темы по prefers-color-scheme, никаких библиотек (раздел 10 спеки). */
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
.status { padding: 6px 4px 0; }
.status-main { font-size: 18px; font-weight: 600; min-height: 26px; }
.status-sub { font-size: 14px; min-height: 20px; }
.muted { color: var(--muted); }
.board { width: min(100%, calc(100dvh - 300px)); max-width: 100%; aspect-ratio: 1; align-self: center; touch-action: manipulation; user-select: none; }
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
.transcript { flex: 1; min-height: 80px; overflow-y: auto; background: var(--panel); border-radius: 10px; padding: 8px 10px; }
.line { margin: 0 0 6px; }
.line .who { font-weight: 600; color: var(--muted); }
.line-me .who { color: var(--accent); }
.line-partial { opacity: 0.6; }
```

- [ ] **Step 4: Typecheck и сборка**

Run: `npm run typecheck && npm run build:web`
Expected: без ошибок; `apps/web/dist/index.html` и `apps/web/dist/assets/*.js` созданы. `dist/` уже в `.gitignore`.

- [ ] **Step 5: Проверка в браузере на ПК** (без агента и без VPS: `npm run dev` с фейковым движком; `.env` с `APP_KEY` и фиктивными `LIVEKIT_*` достаточно)

Run: `npm run dev`, открыть `http://127.0.0.1:5173` (браузерная панель агента-разработчика или обычный браузер).
Expected, по шагам:
1. Статус «Партии нет: скажи «давай партию» или нажми «Новая партия»», пустая доска 13×13 с координатами A–N и 1–13, кнопки.
2. «Новая партия» → статус «Ход 1, твой ход (чёрные)», подпись «Гоко 10k · Пленные: чёрные 0, белые 0».
3. Тап на D4 → чёрный камень на D4 с меткой, через долю секунды белый ответ движка, статус «Ход 3, твой ход (чёрные)».
4. Тап в занятый пункт → сообщение «точка занята» на 3 с; тап сразу после своего хода, пока думает движок, → «сейчас ход Гоко».
5. «Отменить» → оба камня исчезают. «Пас», затем ещё «Пас» (движок фейковый пасует в ответ) → статус «Победа …: +N», на доске заливка территории.
6. «Новая партия» → новая пустая доска с теми же настройками. «Сдаться» → «Точно?» → второе касание → «Победа Гоко: сдача».
7. Перезагрузка страницы → та же сессия (sessionStorage), состояние партии пришло первым событием.
8. «Микрофон» без настоящего LiveKit → статус «Микрофон: ещё раз» и сообщение об ошибке, страница живёт дальше.

В консоли браузера — без ошибок, кроме отказа LiveKit на шаге 8. На телефоне у доски проверяет founder после деплоя (Task 10).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components apps/web/src/App.tsx apps/web/src/main.tsx apps/web/src/styles.css
git commit -m "web: доска SVG, лента, статус, кнопки, страница"
```

---
### Task 9: Контейнеры game-server, go-engine, voice-agent; сервисы compose; деплой статики

**Files:**
- Create: `apps/game-server/Dockerfile`, `apps/voice-agent/Dockerfile`, `.dockerignore`
- Modify: `apps/go-engine/Dockerfile` (добавить стадию `engine`), `infra/docker-compose.yml` (три сервиса), `infra/.env.example` (`ENGINE_CPUS`, `KATAGO_ASSET`), `infra/scripts/deploy.sh` (`--build-web`, исключение `apps/go-engine/bin`)

**Interfaces:**
- Consumes: `infra/docker-compose.yml`, `infra/Caddyfile` (`API_UPSTREAM`), `infra/scripts/deploy.sh [--host goko] [--web-dir DIR]` из плана стадии 0; переменные `main.ts` game-server (`APP_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `AGENT_NAME`, `ENGINE_URL`, `ENGINE_KEY`, `DATA_DIR`, `MAX_SESSIONS`, `SESSION_TTL_MS`, `PORT`, `HOST`) и go-engine (`KATAGO_BIN`, `KATAGO_MODEL`, `KATAGO_HUMAN_MODEL`, `KATAGO_CONFIG`, `ENGINE_KEY`, `ENGINE_PORT`, `ENGINE_HOST`) из плана ядра; voice-agent (`LIVEKIT_*`, `OPENAI_API_KEY`, `APP_KEY`, `API_BASE`, `AGENT_NAME`, `VOICE_MODE`) из Task 4; `apps/web/dist` из Task 8.
- Produces: образы `goko-game-server`, `goko-go-engine`, `goko-voice-agent` (Node 22 запускает `.ts` напрямую, без сборки); сервисы compose `game-server` (порт `127.0.0.1:8787`, снапшоты в `/opt/goko/data`), `go-engine` (внутренняя сеть, `cpus`), `voice-agent`; `deploy.sh [--host goko] [--web-dir DIR] [--build-web]`.

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
# npm ci по workspace'у ставит только его зависимости; package.json всех workspace'ов нужны для lock-файла.
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

Стадию `katago` из плана стадии 0 оставить как есть (заменить только последнюю строку `CMD` — она больше не нужна). После неё дописать:

```dockerfile
# Стадия engine: Node 22 с обёрткой поверх бинарника и сетей из стадии katago.
FROM node:22-slim AS engine
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends libzip4 && rm -rf /var/lib/apt/lists/*
COPY --from=katago /opt/katago /opt/katago
WORKDIR /app
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
    KATAGO_MODEL=/opt/katago/models/main.bin.gz \
    KATAGO_HUMAN_MODEL=/opt/katago/models/human.bin.gz \
    KATAGO_CONFIG=/opt/katago/analysis.cfg \
    ENGINE_HOST=0.0.0.0 ENGINE_PORT=8788
EXPOSE 8788
USER node
CMD ["node", "apps/go-engine/src/main.ts"]
```

Проверить, что в стадии `katago` бинарник и сети доступны на чтение всем (`chmod -R a+rX /opt/katago` перед `CMD`, если релизный zip кладёт файлы с правами `600`): сервис работает под `node`.

- [ ] **Step 5: `infra/docker-compose.yml` — три сервиса** (после `livekit`, перед `volumes:`)

```yaml
  game-server:
    build:
      context: ..
      dockerfile: apps/game-server/Dockerfile
    restart: unless-stopped
    ports:
      - "127.0.0.1:8787:8787"
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
    volumes:
      - /opt/goko/data:/data
    depends_on:
      - go-engine

  go-engine:
    build:
      context: ..
      dockerfile: apps/go-engine/Dockerfile
      args:
        KATAGO_ASSET: ${KATAGO_ASSET:-katago-v1.18.1-eigenavx2-linux-x64.zip}
    restart: unless-stopped
    cpus: ${ENGINE_CPUS:-1.5}
    environment:
      ENGINE_KEY: ${ENGINE_KEY}

  voice-agent:
    build:
      context: ..
      dockerfile: apps/voice-agent/Dockerfile
    restart: unless-stopped
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

Почему так: `caddy` и `livekit` в `network_mode: host`, поэтому `API_UPSTREAM=127.0.0.1:8787` из плана стадии 0 попадает в опубликованный порт `game-server`; `go-engine` наружу не публикуется, `game-server` ходит к нему по имени сервиса; `voice-agent` ходит в LiveKit по публичному `LIVEKIT_URL` (`wss://<LK_HOST>`, тот же адрес, что у телефона) и в `game-server` по имени сервиса (`API_BASE` задан в образе). Секретов в файле нет — только подстановки из `/opt/goko/.env`.

- [ ] **Step 6: `infra/.env.example`** (в конец)

```
ENGINE_CPUS=1.5                    # лимит CPU контейнера go-engine, чтобы LiveKit и Caddy не голодали во время analyze
KATAGO_ASSET=katago-v1.18.1-eigenavx2-linux-x64.zip   # без AVX2 на VPS: katago-v1.18.1-eigen-linux-x64.zip
```

- [ ] **Step 7: `infra/scripts/deploy.sh`**

Заменить разбор аргументов и rsync на:

```bash
# Использование: infra/scripts/deploy.sh [--host goko] [--web-dir apps/web/dist] [--build-web]
#   --build-web: собрать apps/web (npm run build:web) и выложить apps/web/dist как статику
set -euo pipefail
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

rsync -az --delete \
  --exclude .git --exclude node_modules --exclude data --exclude '.env' --exclude '.env.*' \
  --exclude 'apps/go-engine/models' --exclude 'apps/go-engine/bin' --exclude 'apps/web/dist' \
  "$ROOT/" "$HOST:/opt/goko/src/"
```

Остальное (статика по `WEB_DIR`, удалённый блок с `docker compose up -d --build`) без изменений. `APP_KEY` в бандл берётся из `.env` на ПК: он должен совпадать с `APP_KEY` в `/opt/goko/.env`, иначе телефон получит `401 unauthorized`.

- [ ] **Step 8: Проверка на ПК**

Run: `cd infra && WEB_HOST=goko.example.org LK_HOST=goko-lk.example.org LIVEKIT_API_KEY=k LIVEKIT_API_SECRET=s APP_KEY=a ENGINE_KEY=e OPENAI_API_KEY=o LIVEKIT_URL=wss://goko-lk.example.org docker compose config >/dev/null && echo "[OK] compose"`
Expected: `[OK] compose` (значения подстановок в вывод не печатать: `config` их раскрывает, поэтому `>/dev/null`).

Run (если на ПК есть Docker; go-engine собирать не нужно — образ тянет KataGo и сети): `docker build -f apps/game-server/Dockerfile -t goko-game-server . && docker build -f apps/voice-agent/Dockerfile -t goko-voice-agent .`
Expected: оба образа собираются; `docker run --rm goko-game-server` завершается с `[X] game-server: нужна переменная APP_KEY` и кодом 2 (переменные не заданы — это ожидаемо и подтверждает, что `.ts` запускается).

Run: `bash -n infra/scripts/deploy.sh && echo "[OK] deploy.sh"`
Expected: `[OK] deploy.sh`. Сам деплой не запускать: только по явной просьбе founder'а (правило 5 `CLAUDE.md`).

- [ ] **Step 9: Commit**

```bash
git add .dockerignore apps/game-server/Dockerfile apps/voice-agent/Dockerfile apps/go-engine/Dockerfile infra/docker-compose.yml infra/.env.example infra/scripts/deploy.sh
git commit -m "infra: контейнеры game-server, go-engine, voice-agent; сервисы compose; deploy --build-web"
```

---

### Task 10: Runbook VPS, доки, `NOW.md`, финальная проверка

**Files:**
- Create: `docs/runbooks/vps.md`
- Modify: `docs/README.md` (строка `runbooks/`), `CLAUDE.md` (строка стадии, раздел команд), `README.md` (статус, раздел «Запуск»), `docs/NOW.md`

**Interfaces:**
- Consumes: команды из Task 5 (`npm run chat`), Task 8 (`npm run build:web`), Task 9 (`deploy.sh --build-web`, сервисы compose); `infra/README.md` из плана стадии 0 (первичная настройка).
- Produces: `docs/runbooks/vps.md` — эксплуатация после деплоя; доки со статусом «стадия 1 готова».

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
| `livekit` | комнаты, TURN | 7880, 7881/tcp, 3478/udp, 50000–60000/udp (host) |
| `game-server` | сессии, партии, SSE, токены | `127.0.0.1:8787` |
| `go-engine` | KataGo: genmove / analyze / score | внутренняя сеть, `go-engine:8788` |
| `voice-agent` | воркер LiveKit Agents `goko` | портов нет |

Снапшоты партий — `/opt/goko/data/games` (bind-mount в `game-server`).

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
dc logs --tail=20 voice-agent | grep -c "registered worker"   # 1 — воркер зарегистрирован
```

## Перезапуск и обновление одного сервиса

```bash
dc restart voice-agent                  # без пересборки
dc up -d --build voice-agent            # пересобрать после правки кода (после rsync через deploy.sh)
dc up -d --build go-engine              # то же для движка; партии в это время получат engine_unavailable
```

`game-server` при рестарте загружает снапшоты из `/opt/goko/data/games`;
сессии и комнаты LiveKit при этом теряются — телефон создаст новую сессию сам.

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

## Откат

```bash
# на ПК: вернуть рабочий коммит и задеплоить его
git checkout <commit> && infra/scripts/deploy.sh --build-web && git checkout main
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

`## Следующий шаг` заменить на:

```
Приёмка у доски (после деплоя по явной просьбе founder'а): партия голосом
на 13×13 против Гоко 10k, тапы с экрана, «кто впереди», конец партии.
Результаты и цену партии — в `docs/research/`. Затем brainstorming стадии 2
(место `external`, `mcp-server`).
```

В `## Сделано` добавить строку: `- <дата>: стадия 1, голос и веб: voice-agent (девять инструментов, промпт, события, realtime/pipeline), chat из консоли, web (доска, лента, микрофон), контейнеры и compose, runbook VPS.`

В `## Открытые вопросы founder'у` добавить пункт: `7. **Проверка на телефоне** после деплоя: микрофон в Safari/Chrome, задержка ответа, разборчивость координат; realtime или pipeline по цене партии.`

- [ ] **Step 6: Полная проверка**

Run: `npm run check && npm run smoke`
Expected: typecheck (корень и `apps/web`), все unit-тесты (`go-core`, `protocol`, `go-engine`, `game-server`, `voice-agent`, `web`, `scripts`) и smoke — `[OK]`, код 0. `agent.eval.test.ts` — `skipped` без `RUN_AGENT_EVALS`.

- [ ] **Step 7: Commit**

```bash
git add docs/runbooks/vps.md docs/README.md CLAUDE.md README.md docs/NOW.md
git commit -m "docs: runbook VPS, команды и статус стадии 1, NOW"
```

---

## Самопроверка плана

- **Покрытие спеки.** Раздел 3 (поток хода: голос → инструмент → game-server → событие → реплика; тап → `via: 'tap'` → событие → реплика) — Task 2 (инструменты), Task 3 (`handleEvent`: тап при `pendingEngineMove` копится в `lastTap` и озвучивается вместе с ответом движка), Task 7 (`useGame.play`). Раздел 5 (события `session.game`, `state.updated` с `cause/by/via`, `engine.thinking`, `game.finished`, `error`) — Task 3 и Task 7 читают все пять типов; `not_found` на SSE → новая сессия (Task 6 `streamEvents`, Task 7 `useSession.reset`). Раздел 9: таблица инструментов один в один — Task 2 (`createTools`); результаты для модели с `myMoveSpoken`, `note` при таймауте ответа, `finished/result` — Task 2; `get_assessment` без лучшего хода в тексте — правило в `INSTRUCTIONS` (Task 4) и eval; озвучивание событий — Task 3; промпт с произношением координат и правилами инструментов — Task 4; `realtime`/`pipeline` по `VOICE_MODE`, серверный VAD, транскрипция входа `ru` — Task 4 `voice.ts`; приветствие в `onEnter` — Task 4 `agent.ts`; `sessionId` из метаданных диспетчеризации — Task 4 `metadata.ts`. Раздел 10: одна страница, SVG-доска, тап = ближайший пункт, «сейчас ход Гоко» без запроса, лента из `lk.transcription`, микрофон по касанию со `startAudio`, кнопки ≥ 44 px, темы, статус, результат с территорией и мёртвыми камнями, работа без агента — Task 6–8; сессия в `sessionStorage` — Task 7. Раздел 11: контейнеры `game-server`, `go-engine` (`cpus`), `voice-agent`; порты только на `127.0.0.1`; `API_UPSTREAM` prod/dev и `docker compose up -d caddy`; `AGENT_NAME` `goko`/`goko-dev`; деплой статики — Task 9, runbook — Task 10. Раздел 12: замоканный клиент для `voice-agent` (Task 2, 3), evals по флагу (Task 4), unit для веб-геометрии/ленты/потока/текстов (Task 6), `chat.mjs` (Task 5), ручная приёмка у доски — `NOW.md` (Task 10). Раздел 18: все проверки — командами с кодом возврата; секреты — только через `.env`.
- **Заглушек нет.** Все файлы приведены целиком; условные ветки — только на отсутствие VPS/ключей (`chat` и evals пропускаются с пометкой в `NOW.md`), на имя метода публикаций в `livekit-client` (Task 7, Step 4) и на флаг `npm ci` (Task 9, Step 2).
- **Типы.** `ToolClient` (Task 2) — `Pick<GokoClient, ...>` по именам методов клиента из плана ядра (`newGame`, `play`, `correct`, `pass`, `resign`, `undo`, `getGame`, `ascii`, `analyze`, `setRank`, `events`); `seatColor` объявлена в Task 1 и используется в Task 2, 6, 7; `AgentState` (Task 1) — поля, которые читают Task 2 и Task 3 (`gameId`, `humanColor`, `rank`, `komi`, `toolGames`, `announcedFinish`, `awaitingReply`, `lastTap`, `lastErrorAt`); `handleEvent`/`watchSession` (Task 3) вызываются из `main.ts` (Task 4) с теми же сигнатурами; `GokoAgent(tools, { greet })` (Task 4) — в `main.ts` и eval; `describeEvent` (Task 5) — только в тесте и `chat.mjs`; `layout/x/y/pointAt/coordAt/hoshi/stones/indexOf` (Task 6) — в `Board.tsx` (Task 8); `upsertLine/whoOf/lineId` (Task 6) — в `useSession` (Task 7); `streamEvents(client, sessionId, signal, handlers, sleep?)` (Task 6) — в `useGame` (Task 7); `describeError/humanColorOf/resultText/statusText/capturesText/rankText` (Task 6) — в Task 7 и 8; `MicState` (Task 7) — в `Controls.tsx` (Task 8); `useSession().reset` передаётся в `useGame(sessionId, onLost)` (Task 8 `App.tsx`). Переменные окружения контейнеров (Task 9) — по спискам `main.ts` плана ядра и Task 4.
