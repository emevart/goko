# Гоко, стадия 1, ядро: `go-core`, `protocol`, `go-engine`, `game-server` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ядро, через которое любой клиент (веб, голосовой агент, будущий MCP, агент-разработчик из CLI) играет полную партию человек против KataGo на ранге: правила го, протокол со схемами и клиентом, обёртка над KataGo, game-server с сессиями, событиями SSE и токенами LiveKit, плюс `npm run smoke` и `npm run dev`.

**Architecture:** Четыре пакета поверх каркаса стадии 0. `packages/go-core` — чистые функции правил (позиция всегда переигрывается из списка ходов). `packages/protocol` — zod-схемы операций, ошибок, событий и движка плюс типизированный HTTP-клиент с разбором SSE; им пользуются все клиенты. `apps/go-engine` — Hono-сервис, держит один процесс `katago analysis`, очередь запросов, перезапуск с паузой, выбор хода по `humanPolicy`. `apps/game-server` — Hono-сервис: чистые переходы состояния партии (`game.ts`), сервис с мьютексом на партию, автоматикой мест `engine`, ожиданием ответа и автосчётом (`service.ts`), снапшоты в JSON, шина событий, сессии и токены LiveKit. Фейковый движок (`FAKE_ENGINE=1`) даёт полную партию без KataGo.

**Tech Stack:** Node 22.22 (нативный запуск `.ts`, `erasableSyntaxOnly`), npm workspaces, TypeScript 5.9, vitest 5, zod 4.5, Hono 4.13 + `@hono/node-server` 2.1, `livekit-server-sdk` 2.18 + `@livekit/protocol` 1.51, KataGo v1.18.1 (analysis engine, JSON по stdin/stdout), человеческая сеть `b18c384nbt-humanv0.bin.gz`.

**Spec:** `docs/superpowers/specs/2026-09-07-goko-voice-go-opponent-design.md` — разделы 4 (модель партии), 5 (протокол, ошибки, события), 6 (`go-core`), 7 (`game-server`), 8 (`go-engine`), 11 (локальная разработка), 12 (тестирование), 18 (AI-first). Предполагается выполненный план стадии 0 (`2026-09-07-goko-stage0-spike.md`): каркас монорепы, `scripts/doctor.mjs`, `infra/`, `apps/go-engine/{Dockerfile,config/analysis.cfg,models/README.md}`.

## Global Constraints

- Node `>=22.18`; импорты внутри пакетов с расширением `.ts`; между пакетами — по имени `@goko/go-core`, `@goko/protocol` (`exports` указывает на `src/index.ts`); `tsconfig.base.json` стадии 0: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (типы только через `import type`), `erasableSyntaxOnly` (никаких `enum`, `namespace`, parameter properties).
- Доска: столбцы `A B C D E F G H J K L M N` (без `I`), строки `1–13` снизу; `board` — строка длины `size*size` из `.`, `B`, `W`, индекс `(row - 1) * size + col`, `col` от `A = 0`. Разбор координат принимает `D4`, `d4`, `D 4`, кириллические двойники `А→A, В→B, С→C, Е→E, Н→H, К→K, М→M`; отвергает `I` и выход за размер ошибкой `invalid_coord`.
- Правила: китайские, коми `7.5`, простое ко, самоубийство запрещено, счёт по площади; мёртвые камни — владение против своего цвета сильнее `0.6`; `unsettled` при |владение| < `0.3`.
- Протокол (раздел 5 спеки): маршруты, тела и коды ошибок ровно как в таблице; статусы: 400 `invalid_coord | illegal_move | unsupported_controller | bad_request`, 401 `unauthorized`, 404 `not_found`, 409 `not_your_turn | game_finished | nothing_to_undo | revision_conflict`, 429 `limit_reached`, 500 `internal`, 503 `engine_busy | engine_unavailable`. Ошибка — `{ error: { code, message, details? } }`.
- `play`/`pass`/`correct` с `waitForReply: true` (по умолчанию) ждут ответ движка до 8 с, иначе `replyTimedOut: true`. Движок сдаётся после 60-го хода при winrate < 3 % и отставании > 25 очков. Таймауты клиента движка: genmove 10 с, analyze 15 с, score 30 с, один повтор.
- Заголовки: `X-App-Key` на всех `/api/*`, `X-Engine-Key` на `/v1/*` движка. Значения — из `.env`, в логи и доки не печатать.
- Порты dev: game-server `8787`, go-engine `8788`. KataGo на ПК — `KATAGO_BIN` (OpenCL-сборка для Windows).
- Язык доков, комментариев, коммитов — русский; код и идентификаторы — английский; без эмодзи; маркеры `[OK] [!] [FIX] [X] [WIP] [TODO]`; коммиты `<область>: <что сделано>`.
- Все проверки из CLI и с кодом возврата: `npm run check` (typecheck + vitest), `npm run smoke`, `npm run doctor`.

---

## Файловая структура стадии 1 (ядро)

```
packages/go-core/package.json         @goko/go-core, без зависимостей
packages/go-core/src/index.ts         реэкспорт
packages/go-core/src/coords.ts        parseCoord/formatCoord/toIndex/fromIndex/speakCoord, InvalidCoordError
packages/go-core/src/board.ts         Position, Color, neighbors, groupAt, allGroups, withCells
packages/go-core/src/rules.ts         play (захваты, простое ко, самоубийство), IllegalMoveError
packages/go-core/src/replay.ts        replay(size, moves) -> Position
packages/go-core/src/score.ts         areaScore, resultFromArea
packages/go-core/src/groups.ts        groupsWithOwnership, deadStones
packages/go-core/src/sgf.ts           toSgf/fromSgf
packages/go-core/src/ascii.ts         toAscii
packages/go-core/src/testing.ts       positionFromRows (для тестов всех пакетов)
packages/go-core/src/*.test.ts        unit + property-тест случайных партий

packages/protocol/package.json        @goko/protocol, зависимость zod
packages/protocol/src/index.ts
packages/protocol/src/game.ts         GameSettings, Rank, Seat, Move, Result, GameState, GameSummary, Session, Via, By
packages/protocol/src/errors.ts       ERROR_CODES, ERROR_STATUS, ErrorBody, ApiError, HttpError
packages/protocol/src/ops.ts          схемы запросов/ответов всех операций, Analysis
packages/protocol/src/events.ts       GameEvent (discriminated union по type)
packages/protocol/src/engine.ts       схемы go-engine: genmove/analyze/score/health
packages/protocol/src/sse.ts          parseSseStream
packages/protocol/src/client.ts       createClient({ baseUrl, appKey }) -> GokoClient
packages/protocol/src/*.test.ts

apps/go-engine/package.json           @goko/go-engine: hono, @hono/node-server, zod, @goko/*
apps/go-engine/src/mapping.ts         индексация KataGo -> наша, rankToProfile
apps/go-engine/src/sampling.ts        chooseMove по humanPolicy
apps/go-engine/src/katago.ts          класс KataGo: процесс, очередь, таймауты, перезапуск
apps/go-engine/src/app.ts             createEngineApp(deps): /health, /v1/genmove|analyze|score
apps/go-engine/src/main.ts            запуск из env
apps/go-engine/src/*.test.ts          unit с фейковым процессом; katago.contract.test.ts при KATAGO_BIN

apps/game-server/package.json         @goko/game-server: hono, @hono/node-server, zod, livekit-server-sdk, @livekit/protocol, @goko/*
apps/game-server/src/ids.ts           newId()
apps/game-server/src/game.ts          чистые переходы: newGame, applyMove, undo, resign, finishByScore, setRank, rebuild, positionOf
apps/game-server/src/store.ts         GameStore: атомарные снапшоты data/games/<id>.json
apps/game-server/src/events.ts        EventBus по каналам game:<id>, session:<id>
apps/game-server/src/engine-client.ts интерфейс Engine + createEngineClient (HTTP, таймауты, повтор)
apps/game-server/src/fake-engine.ts   createFakeEngine (легальные ходы, сценарий, задержка)
apps/game-server/src/service.ts       GameService: мьютекс, автоматика движка, ожидание ответа, автосчёт, analyze/score/ascii/sgf
apps/game-server/src/sessions.ts      SessionManager: лимит, TTL, комната
apps/game-server/src/livekit.ts       mintToken с диспетчеризацией агента
apps/game-server/src/app.ts           createApp(deps): маршруты, X-App-Key, ошибки, SSE
apps/game-server/src/main.ts          запуск из env, FAKE_ENGINE
apps/game-server/src/*.test.ts

scripts/smoke.mjs                     поднимает game-server (+ движок при --real), играет сценарий по HTTP, печатает ascii
scripts/dev.mjs                       game-server + go-engine (+ web, voice-agent, если есть) одной командой
package.json                          скрипты smoke, dev
infra/.env.example                    новые переменные (ENGINE_URL, KATAGO_MODEL, ...)
CLAUDE.md, docs/NOW.md                команды больше не [WIP]
```

Каждый пакет — `"type": "module"`, `"private": true`, `"exports": { ".": "./src/index.ts" }` (для приложений `exports` не нужен). Зависимости между workspace'ами — `"@goko/go-core": "*"`.

---

### Task 1: `go-core` — координаты

**Files:**
- Create: `packages/go-core/package.json`, `packages/go-core/src/coords.ts`, `packages/go-core/src/index.ts`
- Test: `packages/go-core/src/coords.test.ts`

**Interfaces:**
- Produces: `COLUMN_LETTERS = 'ABCDEFGHJKLMNOPQRST'`; `type Point = { col: number; row: number }` (0-based, `row 0` = строка «1»); `parseCoord(text: string, size: number): Point | 'pass'` (бросает `InvalidCoordError`); `formatCoord(p: Point): string`; `toIndex(p, size): number`; `fromIndex(i, size): Point`; `coordToIndex(coord: string, size): number` (бросает на `pass`); `indexToCoord(i, size): string`; `speakCoord(coord: string): string` («дэ четыре», «пас»); `normalizeCoordText(text): string`.

- [ ] **Step 1: `packages/go-core/package.json`**

```json
{
  "name": "@goko/go-core",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

Затем `npm install` в корне (workspace появляется в `node_modules/@goko/go-core` как симлинк; Node снимает типы с реального пути, поэтому `.ts` из симлинка запускается).

- [ ] **Step 2: Тест `packages/go-core/src/coords.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  InvalidCoordError,
  coordToIndex,
  formatCoord,
  fromIndex,
  indexToCoord,
  parseCoord,
  speakCoord,
  toIndex,
} from './coords.ts';

describe('parseCoord', () => {
  it('принимает латиницу в любом регистре и с пробелом', () => {
    expect(parseCoord('D4', 13)).toEqual({ col: 3, row: 3 });
    expect(parseCoord('d4', 13)).toEqual({ col: 3, row: 3 });
    expect(parseCoord('D 4', 13)).toEqual({ col: 3, row: 3 });
    expect(parseCoord(' k10 ', 13)).toEqual({ col: 9, row: 9 });
  });

  it('пропускает I: J — десятый столбец', () => {
    expect(parseCoord('J1', 13)).toEqual({ col: 8, row: 0 });
    expect(parseCoord('N13', 13)).toEqual({ col: 12, row: 12 });
  });

  it('заменяет кириллические двойники', () => {
    expect(parseCoord('В4', 13)).toEqual({ col: 1, row: 3 }); // кириллическая В
    expect(parseCoord('к10', 13)).toEqual({ col: 9, row: 9 }); // кириллическая к
    expect(parseCoord('Е7', 13)).toEqual({ col: 4, row: 6 }); // кириллическая Е
  });

  it('распознаёт пас', () => {
    expect(parseCoord('pass', 13)).toBe('pass');
    expect(parseCoord('Пас', 13)).toBe('pass');
  });

  it('отвергает I, выход за доску и мусор', () => {
    expect(() => parseCoord('I5', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('D14', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('D0', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('O1', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('Z9', 19)).toThrow(InvalidCoordError);
    expect(() => parseCoord('foo', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('', 13)).toThrow(InvalidCoordError);
  });
});

describe('индексация', () => {
  it('A1 = 0, B1 = 1, A2 = size, N13 = 168 на 13x13', () => {
    expect(coordToIndex('A1', 13)).toBe(0);
    expect(coordToIndex('B1', 13)).toBe(1);
    expect(coordToIndex('A2', 13)).toBe(13);
    expect(coordToIndex('N13', 13)).toBe(168);
  });

  it('туда и обратно', () => {
    for (let i = 0; i < 169; i++) {
      expect(coordToIndex(indexToCoord(i, 13), 13)).toBe(i);
      expect(toIndex(fromIndex(i, 13), 13)).toBe(i);
    }
    expect(formatCoord(parseCoord('K10', 13) as { col: number; row: number })).toBe('K10');
  });

  it('coordToIndex не принимает пас', () => {
    expect(() => coordToIndex('pass', 13)).toThrow(InvalidCoordError);
  });
});

describe('speakCoord', () => {
  it('называет столбец по-русски и число словом', () => {
    expect(speakCoord('D4')).toBe('дэ четыре');
    expect(speakCoord('K10')).toBe('ка десять');
    expect(speakCoord('N13')).toBe('эн тринадцать');
    expect(speakCoord('A1')).toBe('а один');
    expect(speakCoord('pass')).toBe('пас');
  });
});
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `npx vitest run packages/go-core/src/coords.test.ts`
Expected: FAIL — `Failed to resolve import "./coords.ts"`.

- [ ] **Step 4: Реализация `packages/go-core/src/coords.ts`**

```ts
// Координаты доски: столбцы A..T без I, строки 1..size снизу вверх.
// Внутренняя индексация: row * size + col, где row 0 — строка «1».

export const COLUMN_LETTERS = 'ABCDEFGHJKLMNOPQRST';

export type Point = { col: number; row: number };

export class InvalidCoordError extends Error {
  readonly text: string;

  constructor(text: string, reason: string) {
    super(`invalid coord "${text}": ${reason}`);
    this.name = 'InvalidCoordError';
    this.text = text;
  }
}

// Кириллические буквы, которые выглядят как латинские: транскрипт речи их путает.
const CYRILLIC_TO_LATIN: Record<string, string> = {
  А: 'A',
  В: 'B',
  С: 'C',
  Е: 'E',
  Н: 'H',
  К: 'K',
  М: 'M',
  О: 'O',
  Р: 'P',
  Т: 'T',
};

export function normalizeCoordText(text: string): string {
  return text
    .trim()
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/[АВСЕНКМОРТ]/g, (ch) => CYRILLIC_TO_LATIN[ch] ?? ch);
}

export function parseCoord(text: string, size: number): Point | 'pass' {
  const lower = text.trim().toLowerCase();
  if (lower === 'pass' || lower === 'пас') return 'pass';
  const norm = normalizeCoordText(text);
  const m = /^([A-Z])(\d{1,2})$/.exec(norm);
  if (!m) throw new InvalidCoordError(text, 'expected a letter and a number, e.g. D4');
  const letter = m[1] ?? '';
  if (letter === 'I') throw new InvalidCoordError(text, 'column I does not exist');
  const col = COLUMN_LETTERS.indexOf(letter);
  const row = Number(m[2]) - 1;
  if (col < 0 || col >= size) throw new InvalidCoordError(text, `column is outside the ${size}x${size} board`);
  if (row < 0 || row >= size) throw new InvalidCoordError(text, `row is outside the ${size}x${size} board`);
  return { col, row };
}

export function formatCoord(p: Point): string {
  return `${COLUMN_LETTERS.charAt(p.col)}${p.row + 1}`;
}

export function toIndex(p: Point, size: number): number {
  return p.row * size + p.col;
}

export function fromIndex(index: number, size: number): Point {
  return { col: index % size, row: Math.floor(index / size) };
}

export function coordToIndex(coord: string, size: number): number {
  const p = parseCoord(coord, size);
  if (p === 'pass') throw new InvalidCoordError(coord, 'pass has no index');
  return toIndex(p, size);
}

export function indexToCoord(index: number, size: number): string {
  return formatCoord(fromIndex(index, size));
}

// Произношение для промпта и озвучивания: столбцы по спеке, числа словами.
export const COLUMN_NAMES_RU: Record<string, string> = {
  A: 'а',
  B: 'бэ',
  C: 'цэ',
  D: 'дэ',
  E: 'е',
  F: 'эф',
  G: 'гэ',
  H: 'аш',
  J: 'джей',
  K: 'ка',
  L: 'эль',
  M: 'эм',
  N: 'эн',
  O: 'о',
  P: 'пэ',
  Q: 'ку',
  R: 'эр',
  S: 'эс',
  T: 'тэ',
};

const NUMBERS_RU = [
  '',
  'один',
  'два',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
];

export function speakCoord(coord: string): string {
  const p = parseCoord(coord, 19);
  if (p === 'pass') return 'пас';
  const letter = COLUMN_LETTERS.charAt(p.col);
  return `${COLUMN_NAMES_RU[letter] ?? letter.toLowerCase()} ${NUMBERS_RU[p.row + 1] ?? String(p.row + 1)}`;
}
```

`packages/go-core/src/index.ts` (пока только координаты; дальнейшие задачи дописывают строки):

```ts
export * from './coords.ts';
```

- [ ] **Step 5: Тесты и typecheck зелёные**

Run: `npx vitest run packages/go-core && npm run typecheck`
Expected: все тесты `coords.test.ts` PASS; typecheck без ошибок.

- [ ] **Step 6: Commit**

```bash
git add packages/go-core package-lock.json
git commit -m "go-core: координаты, разбор с кириллическими двойниками, произношение"
```

---

### Task 2: `go-core` — доска, правила, переигрывание, property-тест

**Files:**
- Create: `packages/go-core/src/board.ts`, `packages/go-core/src/rules.ts`, `packages/go-core/src/replay.ts`, `packages/go-core/src/testing.ts`
- Modify: `packages/go-core/src/index.ts`
- Test: `packages/go-core/src/rules.test.ts`, `packages/go-core/src/random-games.test.ts`

**Interfaces:**
- Consumes: `parseCoord`, `toIndex`, `formatCoord` из Task 1.
- Produces: `type Color = 'B' | 'W'`; `type Cell = '.' | 'B' | 'W'`; `type Position = { size: number; board: string; ko: number | null; captures: { B: number; W: number } }`; `type Group = { color: Color; stones: number[]; liberties: number[] }`; `emptyPosition(size)`, `opposite(color)`, `cellAt(pos, idx)`, `neighbors(idx, size)`, `groupAt(pos, idx): Group | null`, `allGroups(pos): Group[]`, `withCells(board, changes: Array<[number, Cell]>): string`; `type IllegalReason = 'occupied' | 'ko' | 'suicide'`; `class IllegalMoveError { reason; coord }`; `play(pos, color, coord: string): { position: Position; captured: number }` (`coord` может быть `'pass'`); `type MoveInput = { color: Color; coord: string }`; `replay(size, moves: readonly MoveInput[]): Position`; `positionFromRows(rows: string[]): Position` (строки сверху вниз, `X` чёрные, `O` белые, `.` пусто, пробелы игнорируются).

- [ ] **Step 1: `packages/go-core/src/testing.ts`** (нужен тестам, поэтому первым)

```ts
// Помощник для тестов: позиция из строк сверху вниз. 'X' чёрные, 'O' белые, '.' пусто.
import type { Position } from './board.ts';

export function positionFromRows(rows: string[]): Position {
  const size = rows.length;
  const cells: string[] = [];
  // rows[0] — верхняя строка доски (row = size - 1); во внутренней строке первой идёт нижняя.
  for (let r = size - 1; r >= 0; r--) {
    const line = (rows[r] ?? '').replace(/\s+/g, '');
    if (line.length !== size) throw new Error(`row ${r} has ${line.length} cells, expected ${size}`);
    for (const ch of line) cells.push(ch === 'X' ? 'B' : ch === 'O' ? 'W' : '.');
  }
  return { size, board: cells.join(''), ko: null, captures: { B: 0, W: 0 } };
}
```

- [ ] **Step 2: Тест `packages/go-core/src/rules.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { allGroups, cellAt, groupAt, neighbors } from './board.ts';
import { coordToIndex } from './coords.ts';
import { replay } from './replay.ts';
import { IllegalMoveError, play } from './rules.ts';
import { positionFromRows } from './testing.ts';

const at = (coord: string, size = 5) => coordToIndex(coord, size);

describe('board', () => {
  it('neighbors у края и в углу', () => {
    expect(neighbors(at('A1'), 5).sort()).toEqual([at('B1'), at('A2')].sort());
    expect(neighbors(at('C1'), 5)).toHaveLength(3);
    expect(neighbors(at('C3'), 5)).toHaveLength(4);
  });

  it('groupAt собирает камни и дыхания', () => {
    const pos = positionFromRows(['.....', '.....', '.XX..', '.X...', '.....']);
    const g = groupAt(pos, at('B2'));
    expect(g?.color).toBe('B');
    expect(g?.stones).toHaveLength(3);
    expect(g?.liberties).toHaveLength(7);
    expect(groupAt(pos, at('E5'))).toBeNull();
  });
});

describe('play: захваты', () => {
  it('одиночный камень в центре', () => {
    const pos = positionFromRows(['.....', '..X..', '.XOX.', '.....', '.....']);
    const { position, captured } = play(pos, 'B', 'C2');
    expect(captured).toBe(1);
    expect(cellAt(position, at('C3'))).toBe('.');
    expect(position.captures).toEqual({ B: 1, W: 0 });
  });

  it('группа у края', () => {
    const pos = positionFromRows(['.....', '.....', '.....', 'XX...', 'OO...']);
    const { position, captured } = play(pos, 'B', 'C1');
    expect(captured).toBe(2);
    expect(cellAt(position, at('A1'))).toBe('.');
    expect(cellAt(position, at('B1'))).toBe('.');
  });

  it('камень в углу', () => {
    const pos = positionFromRows(['.....', '.....', '.....', 'X....', 'O....']);
    expect(play(pos, 'B', 'B1').captured).toBe(1);
  });

  it('ход без своих дыханий легален, если снимает камни соперника', () => {
    // Белые A3, B2; чёрные A2, B1. Белые ставят A1: дыханий нет, но A2 снимается.
    const pos = positionFromRows(['.....', '.....', 'O....', 'XO...', '.X...']);
    const { position, captured } = play(pos, 'W', 'A1');
    expect(captured).toBe(1);
    expect(cellAt(position, at('A2'))).toBe('.');
    expect(groupAt(position, at('A1'))?.liberties).toEqual([at('A2')]);
  });
});

describe('play: запреты', () => {
  it('занятая точка', () => {
    const pos = positionFromRows(['.....', '.....', '..X..', '.....', '.....']);
    expect(() => play(pos, 'W', 'C3')).toThrow(IllegalMoveError);
    try {
      play(pos, 'W', 'C3');
    } catch (e) {
      expect((e as IllegalMoveError).reason).toBe('occupied');
    }
  });

  it('самоубийство без захвата', () => {
    const pos = positionFromRows(['.....', '.....', '.....', 'O....', '.O...']);
    expect(() => play(pos, 'B', 'A1')).toThrow(/suicide/);
  });

  it('ко: сразу забрать нельзя, после хода в другом месте можно', () => {
    // Чёрные: B2, C1, C3, D2. Белые: A2, B1, B3. Белые ставят C2 и снимают B2.
    const pos = positionFromRows(['.....', '.....', '.OX..', 'OX.X.', '.OX..']);
    const afterWhite = play(pos, 'W', 'C2');
    expect(afterWhite.captured).toBe(1);
    expect(afterWhite.position.ko).toBe(at('B2'));
    expect(() => play(afterWhite.position, 'B', 'B2')).toThrow(/ko/);

    const elsewhere = play(afterWhite.position, 'B', 'E5').position;
    expect(elsewhere.ko).toBeNull();
    const whiteElsewhere = play(elsewhere, 'W', 'E4').position;
    const retake = play(whiteElsewhere, 'B', 'B2');
    expect(retake.captured).toBe(1);
    expect(cellAt(retake.position, at('C2'))).toBe('.');
  });

  it('пас сбрасывает ко и ничего не меняет на доске', () => {
    const pos = positionFromRows(['.....', '.....', '.OX..', 'OX.X.', '.OX..']);
    const afterWhite = play(pos, 'W', 'C2').position;
    const passed = play(afterWhite, 'B', 'pass');
    expect(passed.captured).toBe(0);
    expect(passed.position.ko).toBeNull();
    expect(passed.position.board).toBe(afterWhite.board);
  });

  it('захват многих камней не создаёт ко', () => {
    const pos = positionFromRows(['.....', '.....', '.....', 'XX...', 'OO...']);
    expect(play(pos, 'B', 'C1').position.ko).toBeNull();
  });
});

describe('replay', () => {
  it('позиция — функция от списка ходов', () => {
    const pos = replay(5, [
      { color: 'B', coord: 'C3' },
      { color: 'W', coord: 'C4' },
      { color: 'B', coord: 'pass' },
      { color: 'W', coord: 'B3' },
      { color: 'B', coord: 'pass' },
      { color: 'W', coord: 'D3' },
      { color: 'B', coord: 'pass' },
      { color: 'W', coord: 'C2' },
    ]);
    expect(cellAt(pos, at('C3'))).toBe('.');
    expect(pos.captures).toEqual({ B: 0, W: 1 });
    expect(allGroups(pos)).toHaveLength(4);
    expect(pos.ko).toBeNull(); // у C2 четыре дыхания, ко нет
  });

  it('нелегальный ход в списке — ошибка', () => {
    expect(() => replay(5, [{ color: 'B', coord: 'C3' }, { color: 'W', coord: 'C3' }])).toThrow(IllegalMoveError);
  });
});
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `npx vitest run packages/go-core/src/rules.test.ts`
Expected: FAIL — не найден `./board.ts`.

- [ ] **Step 4: `packages/go-core/src/board.ts`**

```ts
// Доска как строка из '.', 'B', 'W'. Индекс row * size + col, row 0 — нижняя строка.

export type Color = 'B' | 'W';
export type Cell = '.' | 'B' | 'W';

export type Position = {
  size: number;
  board: string;
  ko: number | null; // пункт, запрещённый для ближайшего хода (простое ко)
  captures: { B: number; W: number }; // сколько камней снял каждый цвет
};

export type Group = { color: Color; stones: number[]; liberties: number[] };

export function emptyPosition(size: number): Position {
  return { size, board: '.'.repeat(size * size), ko: null, captures: { B: 0, W: 0 } };
}

export function opposite(color: Color): Color {
  return color === 'B' ? 'W' : 'B';
}

export function cellAt(pos: Position, index: number): Cell {
  return pos.board.charAt(index) as Cell;
}

export function withCells(board: string, changes: Array<[number, Cell]>): string {
  const cells = board.split('');
  for (const [index, cell] of changes) cells[index] = cell;
  return cells.join('');
}

export function neighbors(index: number, size: number): number[] {
  const col = index % size;
  const row = Math.floor(index / size);
  const out: number[] = [];
  if (col > 0) out.push(index - 1);
  if (col < size - 1) out.push(index + 1);
  if (row > 0) out.push(index - size);
  if (row < size - 1) out.push(index + size);
  return out;
}

export function groupAt(pos: Position, index: number): Group | null {
  const color = cellAt(pos, index);
  if (color === '.') return null;
  const stones: number[] = [];
  const liberties = new Set<number>();
  const seen = new Set<number>([index]);
  const stack = [index];
  while (stack.length) {
    const i = stack.pop()!;
    stones.push(i);
    for (const n of neighbors(i, pos.size)) {
      const c = cellAt(pos, n);
      if (c === '.') liberties.add(n);
      else if (c === color && !seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return {
    color,
    stones: stones.sort((a, b) => a - b),
    liberties: [...liberties].sort((a, b) => a - b),
  };
}

export function allGroups(pos: Position): Group[] {
  const seen = new Set<number>();
  const out: Group[] = [];
  for (let i = 0; i < pos.board.length; i++) {
    if (seen.has(i) || cellAt(pos, i) === '.') continue;
    const g = groupAt(pos, i)!;
    for (const s of g.stones) seen.add(s);
    out.push(g);
  }
  return out;
}
```

- [ ] **Step 5: `packages/go-core/src/rules.ts`**

```ts
// Правила хода: захваты, простое ко, запрет самоубийства. Чистая функция над Position.
import { type Cell, type Color, type Position, cellAt, groupAt, neighbors, opposite, withCells } from './board.ts';
import { formatCoord, parseCoord, toIndex } from './coords.ts';

export type IllegalReason = 'occupied' | 'ko' | 'suicide';

export class IllegalMoveError extends Error {
  readonly reason: IllegalReason;
  readonly coord: string;

  constructor(reason: IllegalReason, coord: string) {
    super(`illegal move ${coord}: ${reason}`);
    this.name = 'IllegalMoveError';
    this.reason = reason;
    this.coord = coord;
  }
}

export type PlayResult = { position: Position; captured: number };

export function play(pos: Position, color: Color, coord: string): PlayResult {
  const point = parseCoord(coord, pos.size);
  if (point === 'pass') return { position: { ...pos, ko: null }, captured: 0 };
  const index = toIndex(point, pos.size);
  const normalized = formatCoord(point);
  if (cellAt(pos, index) !== '.') throw new IllegalMoveError('occupied', normalized);
  if (pos.ko === index) throw new IllegalMoveError('ko', normalized);

  const enemy = opposite(color);
  let board = withCells(pos.board, [[index, color]]);
  const placed: Position = { ...pos, board };

  // Снять группы соперника, оставшиеся без дыханий.
  const removed: number[] = [];
  const checked = new Set<number>();
  for (const n of neighbors(index, pos.size)) {
    if (cellAt(placed, n) !== enemy || checked.has(n)) continue;
    const g = groupAt(placed, n)!;
    for (const s of g.stones) checked.add(s);
    if (g.liberties.length === 0) removed.push(...g.stones);
  }
  if (removed.length) board = withCells(board, removed.map((i) => [i, '.'] as [number, Cell]));

  const after: Position = {
    ...pos,
    board,
    ko: null,
    captures: { ...pos.captures, [color]: pos.captures[color] + removed.length },
  };
  const own = groupAt(after, index)!;
  if (own.liberties.length === 0) throw new IllegalMoveError('suicide', normalized);

  // Простое ко: одиночный камень снял ровно один камень и сам имеет одно дыхание.
  if (removed.length === 1 && own.stones.length === 1 && own.liberties.length === 1) after.ko = removed[0] ?? null;
  return { position: after, captured: removed.length };
}
```

- [ ] **Step 6: `packages/go-core/src/replay.ts`**

```ts
// Позиция всегда переигрывается из списка ходов: undo и correct в правилах не нужны.
import { type Color, type Position, emptyPosition } from './board.ts';
import { play } from './rules.ts';

export type MoveInput = { color: Color; coord: string };

export function replay(size: number, moves: readonly MoveInput[]): Position {
  let pos = emptyPosition(size);
  for (const m of moves) pos = play(pos, m.color, m.coord).position;
  return pos;
}
```

`packages/go-core/src/index.ts` дополнить:

```ts
export * from './coords.ts';
export * from './board.ts';
export * from './rules.ts';
export * from './replay.ts';
export * from './testing.ts';
```

- [ ] **Step 7: Тесты правил зелёные**

Run: `npx vitest run packages/go-core/src/rules.test.ts`
Expected: PASS все.

- [ ] **Step 8: Property-тест `packages/go-core/src/random-games.test.ts`**

```ts
// Случайные легальные партии: после каждого хода ни у одной группы нет нуля дыханий.
import { describe, expect, it } from 'vitest';
import { allGroups, emptyPosition, type Position } from './board.ts';
import { indexToCoord } from './coords.ts';
import { IllegalMoveError, play } from './rules.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGame(seed: number, size: number, maxMoves: number): Position {
  const rnd = mulberry32(seed);
  let pos = emptyPosition(size);
  let color: 'B' | 'W' = 'B';
  for (let n = 0; n < maxMoves; n++) {
    let played = false;
    for (let attempt = 0; attempt < 10 && !played; attempt++) {
      const index = Math.floor(rnd() * size * size);
      try {
        pos = play(pos, color, indexToCoord(index, size)).position;
        played = true;
      } catch (e) {
        if (!(e instanceof IllegalMoveError)) throw e;
      }
    }
    if (!played) pos = play(pos, color, 'pass').position;
    for (const g of allGroups(pos)) {
      expect(g.liberties.length, `seed ${seed} move ${n}: group without liberties`).toBeGreaterThan(0);
    }
    expect(pos.board).toHaveLength(size * size);
    color = color === 'B' ? 'W' : 'B';
  }
  return pos;
}

describe('случайные партии', () => {
  it('30 партий на 9x9 по 150 ходов без групп без дыханий', () => {
    for (let seed = 1; seed <= 30; seed++) randomGame(seed, 9, 150);
  });

  it('пленные не отрицательны и не больше числа ходов', () => {
    const pos = randomGame(42, 13, 200);
    expect(pos.captures.B).toBeGreaterThanOrEqual(0);
    expect(pos.captures.W).toBeGreaterThanOrEqual(0);
    expect(pos.captures.B + pos.captures.W).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 9: Всё зелёное**

Run: `npm run check`
Expected: typecheck чистый, все тесты go-core PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/go-core
git commit -m "go-core: доска, правила с захватами, ко и самоубийством, replay, property-тест"
```

---

### Task 3: `go-core` — счёт, группы по владению, SGF, ASCII

**Files:**
- Create: `packages/go-core/src/score.ts`, `packages/go-core/src/groups.ts`, `packages/go-core/src/sgf.ts`, `packages/go-core/src/ascii.ts`
- Modify: `packages/go-core/src/index.ts`
- Test: `packages/go-core/src/score.test.ts`, `packages/go-core/src/groups.test.ts`, `packages/go-core/src/sgf.test.ts`, `packages/go-core/src/ascii.test.ts`

**Interfaces:**
- Consumes: `Position`, `allGroups`, `neighbors`, `cellAt`, `coordToIndex`, `indexToCoord`, `parseCoord`, `formatCoord`, `MoveInput`.
- Produces: `type AreaScore = { areaB: number; areaW: number; komi: number; dead: string[] }`; `areaScore(pos, dead: string[], komi): AreaScore`; `resultFromArea(a): { winner: Color; margin: number }`; `type GroupStatus = 'safe' | 'unsettled' | 'dead'`; `type GroupInfo = { color: Color; stones: string[]; liberties: number; ownershipAvg: number; status: GroupStatus }`; `groupsWithOwnership(pos, ownership: readonly number[]): GroupInfo[]`; `deadStones(pos, ownership): string[]`; `DEAD_THRESHOLD = 0.6`, `UNSETTLED_THRESHOLD = 0.3`; `type SgfGame = { size; komi; rules?; black?; white?; result?; moves: MoveInput[] }`; `toSgf(g): string`; `fromSgf(text): SgfGame`; `toAscii(pos, opts?: { lastMove?: string | null }): string`.

- [ ] **Step 1: Тесты**

`packages/go-core/src/score.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { areaScore, resultFromArea } from './score.ts';
import { positionFromRows } from './testing.ts';

describe('areaScore', () => {
  // Чёрная стена B1..B5, белая стена D1..D5, чёрный камень E3.
  const pos = positionFromRows(['.X.O.', '.X.O.', '.X.OX', '.X.O.', '.X.O.']);

  it('считает камни и окружённые пустые точки, столбец C ничей', () => {
    const s = areaScore(pos, [], 7.5);
    expect(s.areaB).toBe(11); // 5 стена + 5 столбец A + E3
    expect(s.areaW).toBe(5); // столбец E спорный из-за E3
  });

  it('мёртвый камень отдаёт свою точку сопернику', () => {
    const s = areaScore(pos, ['E3'], 7.5);
    expect(s.areaB).toBe(10);
    expect(s.areaW).toBe(10);
    expect(s.dead).toEqual(['E3']);
  });

  it('пустая доска — ничья по площади, белые выигрывают коми', () => {
    const s = areaScore(positionFromRows(['...', '...', '...']), [], 7.5);
    expect(s).toMatchObject({ areaB: 0, areaW: 0 });
    expect(resultFromArea(s)).toEqual({ winner: 'W', margin: 7.5 });
  });
});

describe('resultFromArea', () => {
  it('чёрные впереди на разницу минус коми', () => {
    expect(resultFromArea({ areaB: 91, areaW: 78, komi: 7.5, dead: [] })).toEqual({ winner: 'B', margin: 5.5 });
    expect(resultFromArea({ areaB: 80, areaW: 80, komi: 7.5, dead: [] })).toEqual({ winner: 'W', margin: 7.5 });
  });
});
```

`packages/go-core/src/groups.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { coordToIndex } from './coords.ts';
import { deadStones, groupsWithOwnership } from './groups.ts';
import { positionFromRows } from './testing.ts';

describe('groupsWithOwnership', () => {
  const pos = positionFromRows(['.....', '.XX..', '.....', '...O.', '.....']);
  const ownership = new Array<number>(25).fill(0);
  ownership[coordToIndex('B4', 5)] = 0.9;
  ownership[coordToIndex('C4', 5)] = 0.8;
  ownership[coordToIndex('D2', 5)] = 0.7; // белый камень, но владение чёрное: мёртв

  it('статусы по владению против своего цвета', () => {
    const groups = groupsWithOwnership(pos, ownership);
    const black = groups.find((g) => g.color === 'B');
    const white = groups.find((g) => g.color === 'W');
    expect(black).toMatchObject({ stones: ['B4', 'C4'], liberties: 6, status: 'safe' });
    expect(black?.ownershipAvg).toBeCloseTo(0.85);
    expect(white).toMatchObject({ stones: ['D2'], status: 'dead' });
  });

  it('unsettled при слабом владении, deadStones возвращает только мёртвые', () => {
    const weak = [...ownership];
    weak[coordToIndex('D2', 5)] = -0.1;
    expect(groupsWithOwnership(pos, weak).find((g) => g.color === 'W')?.status).toBe('unsettled');
    expect(deadStones(pos, ownership)).toEqual(['D2']);
    expect(deadStones(pos, weak)).toEqual([]);
  });
});
```

`packages/go-core/src/sgf.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fromSgf, toSgf } from './sgf.ts';

describe('sgf', () => {
  const game = {
    size: 13,
    komi: 7.5,
    rules: 'Chinese',
    black: 'Human',
    white: 'Goko 10k',
    result: 'B+5.5',
    moves: [
      { color: 'B' as const, coord: 'D4' },
      { color: 'W' as const, coord: 'K10' },
      { color: 'B' as const, coord: 'pass' },
      { color: 'W' as const, coord: 'A13' },
    ],
  };

  it('пишет заголовок и ходы в координатах SGF (строки сверху)', () => {
    expect(toSgf(game)).toBe('(;FF[4]GM[1]CA[UTF-8]SZ[13]KM[7.5]RU[Chinese]PB[Human]PW[Goko 10k]RE[B+5.5];B[dj];W[jd];B[];W[aa])');
  });

  it('туда и обратно', () => {
    expect(fromSgf(toSgf(game))).toEqual(game);
  });

  it('экранирует ] и \\ в значениях', () => {
    const s = toSgf({ ...game, black: 'a]b\\c', moves: [] });
    expect(s).toContain('PB[a\\]b\\\\c]');
    expect(fromSgf(s).black).toBe('a]b\\c');
  });
});
```

`packages/go-core/src/ascii.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toAscii } from './ascii.ts';
import { positionFromRows } from './testing.ts';

describe('toAscii', () => {
  it('рисует строки сверху вниз, буквы снизу, последний ход в скобках', () => {
    const pos = positionFromRows(['...', 'XO.', '...']);
    const text = toAscii(pos, { lastMove: 'B2' });
    expect(text.split('\n')).toEqual([
      ' 3  .  .  . ',
      ' 2  X (O) . ',
      ' 1  .  .  . ',
      '     A  B  C ',
      'X чёрные, O белые, () последний ход; пленные: X 0, O 0',
    ]);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run packages/go-core`
Expected: четыре новых файла FAIL на импортах.

- [ ] **Step 3: `packages/go-core/src/score.ts`**

```ts
// Счёт по площади (китайские правила): камни на доске + окружённые только своим цветом пустые точки.
import { type Cell, type Color, type Position, cellAt, neighbors } from './board.ts';
import { coordToIndex } from './coords.ts';

export type AreaScore = { areaB: number; areaW: number; komi: number; dead: string[] };

export function areaScore(pos: Position, dead: string[], komi: number): AreaScore {
  const deadIndex = new Set(dead.map((c) => coordToIndex(c, pos.size)));
  const cell = (i: number): Cell => (deadIndex.has(i) ? '.' : cellAt(pos, i));
  const total = pos.size * pos.size;
  let areaB = 0;
  let areaW = 0;
  const seen = new Set<number>();
  for (let i = 0; i < total; i++) {
    const c = cell(i);
    if (c === 'B') {
      areaB++;
      continue;
    }
    if (c === 'W') {
      areaW++;
      continue;
    }
    if (seen.has(i)) continue;
    // Пустая область целиком: кому принадлежит её граница.
    const region: number[] = [];
    const stack = [i];
    seen.add(i);
    let touchesB = false;
    let touchesW = false;
    while (stack.length) {
      const j = stack.pop()!;
      region.push(j);
      for (const k of neighbors(j, pos.size)) {
        const ck = cell(k);
        if (ck === 'B') touchesB = true;
        else if (ck === 'W') touchesW = true;
        else if (!seen.has(k)) {
          seen.add(k);
          stack.push(k);
        }
      }
    }
    if (touchesB && !touchesW) areaB += region.length;
    else if (touchesW && !touchesB) areaW += region.length;
  }
  return { areaB, areaW, komi, dead };
}

export function resultFromArea(a: AreaScore): { winner: Color; margin: number } {
  const diff = a.areaB - a.areaW - a.komi;
  return { winner: diff > 0 ? 'B' : 'W', margin: Math.abs(diff) };
}
```

- [ ] **Step 4: `packages/go-core/src/groups.ts`**

```ts
// Группы с оценкой владения от движка: safe / unsettled / dead.
import { type Color, type Position, allGroups } from './board.ts';
import { indexToCoord } from './coords.ts';

export type GroupStatus = 'safe' | 'unsettled' | 'dead';
export type GroupInfo = {
  color: Color;
  stones: string[];
  liberties: number;
  ownershipAvg: number; // -1 белые .. +1 чёрные, среднее по камням группы
  status: GroupStatus;
};

export const DEAD_THRESHOLD = 0.6;
export const UNSETTLED_THRESHOLD = 0.3;

export function groupsWithOwnership(pos: Position, ownership: readonly number[]): GroupInfo[] {
  return allGroups(pos).map((g) => {
    const avg = g.stones.reduce((sum, i) => sum + (ownership[i] ?? 0), 0) / g.stones.length;
    const own = g.color === 'B' ? avg : -avg; // владение в пользу своего цвета
    const status: GroupStatus = own < -DEAD_THRESHOLD ? 'dead' : Math.abs(own) < UNSETTLED_THRESHOLD ? 'unsettled' : 'safe';
    return {
      color: g.color,
      stones: g.stones.map((i) => indexToCoord(i, pos.size)),
      liberties: g.liberties.length,
      ownershipAvg: avg,
      status,
    };
  });
}

export function deadStones(pos: Position, ownership: readonly number[]): string[] {
  return groupsWithOwnership(pos, ownership)
    .filter((g) => g.status === 'dead')
    .flatMap((g) => g.stones);
}
```

- [ ] **Step 5: `packages/go-core/src/sgf.ts`**

```ts
// Минимальный SGF: одна ветка, заголовок и ходы. Координаты SGF: буквы a.., строки сверху.
import { formatCoord, parseCoord } from './coords.ts';
import type { MoveInput } from './replay.ts';

export type SgfGame = {
  size: number;
  komi: number;
  rules?: string;
  black?: string;
  white?: string;
  result?: string;
  moves: MoveInput[];
};

const SGF_LETTERS = 'abcdefghijklmnopqrs';

export function toSgfPoint(coord: string, size: number): string {
  const p = parseCoord(coord, size);
  if (p === 'pass') return '';
  return SGF_LETTERS.charAt(p.col) + SGF_LETTERS.charAt(size - 1 - p.row);
}

export function fromSgfPoint(text: string, size: number): string {
  if (text === '' || (size < 20 && text === 'tt')) return 'pass';
  const col = SGF_LETTERS.indexOf(text.charAt(0));
  const rowFromTop = SGF_LETTERS.indexOf(text.charAt(1));
  if (col < 0 || rowFromTop < 0) throw new Error(`bad sgf point "${text}"`);
  return formatCoord({ col, row: size - 1 - rowFromTop });
}

function escapeValue(s: string): string {
  return s.replace(/[\]\\]/g, (c) => `\\${c}`);
}

export function toSgf(g: SgfGame): string {
  const head = ['FF[4]', 'GM[1]', 'CA[UTF-8]', `SZ[${g.size}]`, `KM[${g.komi}]`, `RU[${escapeValue(g.rules ?? 'Chinese')}]`];
  if (g.black) head.push(`PB[${escapeValue(g.black)}]`);
  if (g.white) head.push(`PW[${escapeValue(g.white)}]`);
  if (g.result) head.push(`RE[${escapeValue(g.result)}]`);
  const moves = g.moves.map((m) => `;${m.color}[${toSgfPoint(m.coord, g.size)}]`).join('');
  return `(;${head.join('')}${moves})`;
}

export function fromSgf(text: string): SgfGame {
  const game: SgfGame = { size: 19, komi: 7.5, moves: [] };
  const re = /([A-Z]+)((?:\[(?:\\.|[^\]])*\])+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const id = m[1] ?? '';
    const values = [...(m[2] ?? '').matchAll(/\[((?:\\.|[^\]])*)\]/g)].map((v) => (v[1] ?? '').replace(/\\(.)/g, '$1'));
    const v = values[0] ?? '';
    switch (id) {
      case 'SZ':
        game.size = Number(v);
        break;
      case 'KM':
        game.komi = Number(v);
        break;
      case 'RU':
        game.rules = v;
        break;
      case 'PB':
        game.black = v;
        break;
      case 'PW':
        game.white = v;
        break;
      case 'RE':
        game.result = v;
        break;
      case 'B':
      case 'W':
        game.moves.push({ color: id, coord: fromSgfPoint(v, game.size) });
        break;
      default:
        break;
    }
  }
  return game;
}
```

- [ ] **Step 6: `packages/go-core/src/ascii.ts`**

```ts
// Текстовая доска для агентов из CLI и для инструмента get_position.
import { type Position, cellAt } from './board.ts';
import { COLUMN_LETTERS, coordToIndex } from './coords.ts';

export function toAscii(pos: Position, opts: { lastMove?: string | null } = {}): string {
  const last = opts.lastMove && opts.lastMove !== 'pass' ? coordToIndex(opts.lastMove, pos.size) : -1;
  const lines: string[] = [];
  for (let row = pos.size - 1; row >= 0; row--) {
    const cells: string[] = [];
    for (let col = 0; col < pos.size; col++) {
      const i = row * pos.size + col;
      const c = cellAt(pos, i);
      const sym = c === 'B' ? 'X' : c === 'W' ? 'O' : '.';
      cells.push(i === last ? `(${sym})` : ` ${sym} `);
    }
    lines.push(`${String(row + 1).padStart(2)} ${cells.join('')}`);
  }
  lines.push(`   ${[...COLUMN_LETTERS.slice(0, pos.size)].map((l) => ` ${l} `).join('')}`);
  lines.push(`X чёрные, O белые, () последний ход; пленные: X ${pos.captures.B}, O ${pos.captures.W}`);
  return lines.join('\n');
}
```

`packages/go-core/src/index.ts` — итоговый вид:

```ts
export * from './coords.ts';
export * from './board.ts';
export * from './rules.ts';
export * from './replay.ts';
export * from './score.ts';
export * from './groups.ts';
export * from './sgf.ts';
export * from './ascii.ts';
export * from './testing.ts';
```

- [ ] **Step 7: Всё зелёное**

Run: `npm run check`
Expected: PASS; typecheck чистый.

- [ ] **Step 8: Commit**

```bash
git add packages/go-core
git commit -m "go-core: счёт по площади, группы по владению, SGF, ascii-доска"
```

---
### Task 4: `protocol` — схемы партии, операций, ошибок, событий, движка

**Files:**
- Create: `packages/protocol/package.json`, `packages/protocol/src/game.ts`, `packages/protocol/src/errors.ts`, `packages/protocol/src/ops.ts`, `packages/protocol/src/events.ts`, `packages/protocol/src/engine.ts`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/schemas.test.ts`

**Interfaces:**
- Produces (все — zod-схемы с одноимёнными типами через `z.infer`; типы запросов — `z.input`, чтобы поля с `default` были необязательны у клиента):
  - `game.ts`: `BoardSize`, `GameSettings`, `RANKS`, `Rank`, `Color`, `Controller`, `Seat`, `Move`, `Score`, `Result`, `GameStatus`, `GameState`, `GameSummary`, `Session`, `Via`, `By`.
  - `errors.ts`: `ERROR_CODES`, `type ErrorCode`, `ERROR_STATUS: Record<ErrorCode, number>`, `ErrorBody`, `class ApiError extends Error { code; status; details?; toBody() }`, `class HttpError extends Error { status; body? }`.
  - `ops.ts`: `NewGameRequest/NewGameResponse`, `PlayRequest/PlayResponse`, `PassRequest`, `ResignRequest`, `StateResponse`, `UndoRequest/UndoResponse`, `CorrectRequest`, `SetRankRequest`, `AnalyzeRequest`, `GroupInfo`, `Analysis`, `CreateSessionResponse`, `ListGamesResponse`.
  - `events.ts`: `StateCause`, `GameEvent` (union по `type`: `session.game | state.updated | engine.thinking | game.finished | error`).
  - `engine.ts`: `EngineMove`, `EnginePositionRequest`, `EngineGenmoveRequest/Response`, `EngineAnalyzeRequest/Response`, `EngineMoveInfo`, `EngineScoreRequest/Response`, `EngineHealth`.

- [ ] **Step 1: `packages/protocol/package.json`**

```json
{
  "name": "@goko/protocol",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "zod": "^4.5.4"
  }
}
```

`npm install` в корне.

- [ ] **Step 2: Тест `packages/protocol/src/schemas.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { EngineGenmoveRequest, EngineScoreResponse } from './engine.ts';
import { ApiError, ERROR_CODES, ERROR_STATUS, ErrorBody } from './errors.ts';
import { GameEvent } from './events.ts';
import { GameSettings, GameState, RANKS, Rank, Seat } from './game.ts';
import { NewGameRequest, PlayRequest, PlayResponse } from './ops.ts';

const state = {
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
};

describe('схемы партии', () => {
  it('GameSettings подставляет умолчания', () => {
    expect(GameSettings.parse({})).toEqual({ boardSize: 13, rules: 'chinese', komi: 7.5 });
    expect(() => GameSettings.parse({ boardSize: 12 })).toThrow();
  });

  it('ранги 20k..1k, 1d..9d', () => {
    expect(RANKS).toHaveLength(29);
    expect(Rank.parse('10k')).toBe('10k');
    expect(() => Rank.parse('10d')).toThrow();
    expect(Seat.parse({ controller: 'engine', rank: '5k' })).toEqual({ controller: 'engine', rank: '5k' });
  });

  it('GameState принимает полное состояние и отвергает мусор', () => {
    expect(GameState.parse(state)).toEqual(state);
    expect(() => GameState.parse({ ...state, toPlay: 'X' })).toThrow();
  });
});

describe('операции', () => {
  it('PlayRequest: waitForReply и via по умолчанию', () => {
    expect(PlayRequest.parse({ coord: 'D4' })).toEqual({ coord: 'D4', waitForReply: true, via: 'api' });
    expect(() => PlayRequest.parse({})).toThrow();
  });

  it('NewGameRequest: места обязательны, настройки частичные', () => {
    const r = NewGameRequest.parse({ black: { controller: 'human' }, white: { controller: 'engine', rank: '10k' }, settings: { komi: 6.5 } });
    expect(r.waitForReply).toBe(true);
    expect(r.settings).toEqual({ komi: 6.5 });
  });

  it('PlayResponse допускает replyTimedOut только true', () => {
    const move = { n: 1, color: 'B', coord: 'D4', captured: 0, at: state.createdAt };
    expect(PlayResponse.parse({ state, move, replyTimedOut: true }).replyTimedOut).toBe(true);
    expect(() => PlayResponse.parse({ state, move, replyTimedOut: false })).toThrow();
  });
});

describe('ошибки', () => {
  it('у каждого кода есть HTTP-статус', () => {
    for (const code of ERROR_CODES) expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(ERROR_STATUS.illegal_move).toBe(400);
    expect(ERROR_STATUS.unauthorized).toBe(401);
    expect(ERROR_STATUS.not_found).toBe(404);
    expect(ERROR_STATUS.revision_conflict).toBe(409);
    expect(ERROR_STATUS.limit_reached).toBe(429);
    expect(ERROR_STATUS.internal).toBe(500);
    expect(ERROR_STATUS.engine_busy).toBe(503);
  });

  it('ApiError превращается в тело ответа', () => {
    const e = new ApiError('illegal_move', 'точка занята', { reason: 'occupied' });
    expect(e.status).toBe(400);
    expect(ErrorBody.parse(e.toBody())).toEqual({ error: { code: 'illegal_move', message: 'точка занята', details: { reason: 'occupied' } } });
  });
});

describe('события', () => {
  it('discriminated union по type', () => {
    expect(GameEvent.parse({ type: 'engine.thinking', color: 'W' })).toEqual({ type: 'engine.thinking', color: 'W' });
    expect(GameEvent.parse({ type: 'state.updated', state, cause: 'sync', by: 'system' }).type).toBe('state.updated');
    expect(() => GameEvent.parse({ type: 'state.updated', state, cause: 'tap', by: 'human' })).toThrow();
    expect(() => GameEvent.parse({ type: 'nope' })).toThrow();
  });
});

describe('движок', () => {
  it('genmove: maxVisits по умолчанию 10, ходы — пары', () => {
    const r = EngineGenmoveRequest.parse({ boardSize: 13, rules: 'chinese', komi: 7.5, moves: [['B', 'D4']], rank: '10k' });
    expect(r.maxVisits).toBe(10);
    expect(() => EngineGenmoveRequest.parse({ ...r, moves: [['X', 'D4']] })).toThrow();
  });

  it('score response', () => {
    const s = EngineScoreResponse.parse({ ownership: [0.1], dead: [], areaB: 1, areaW: 0, scoreLeadB: -6.5, winner: 'W', margin: 6.5 });
    expect(s.winner).toBe('W');
  });
});
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `npx vitest run packages/protocol`
Expected: FAIL на импортах.

- [ ] **Step 4: `packages/protocol/src/game.ts`**

```ts
// Модель партии (раздел 4 спеки). Схемы zod — источник типов для всех клиентов.
import { z } from 'zod';

export const BoardSize = z.union([z.literal(9), z.literal(13), z.literal(19)]);
export type BoardSize = z.infer<typeof BoardSize>;

export const GameSettings = z.object({
  boardSize: BoardSize.default(13),
  rules: z.literal('chinese').default('chinese'),
  komi: z.number().default(7.5),
});
export type GameSettings = z.infer<typeof GameSettings>;

export const RANKS = [
  '20k', '19k', '18k', '17k', '16k', '15k', '14k', '13k', '12k', '11k',
  '10k', '9k', '8k', '7k', '6k', '5k', '4k', '3k', '2k', '1k',
  '1d', '2d', '3d', '4d', '5d', '6d', '7d', '8d', '9d',
] as const;
export const Rank = z.enum(RANKS);
export type Rank = z.infer<typeof Rank>;

export const Color = z.enum(['B', 'W']);
export type Color = z.infer<typeof Color>;

export const Controller = z.enum(['human', 'engine', 'external']);
export type Controller = z.infer<typeof Controller>;

export const Seat = z.object({
  controller: Controller,
  rank: Rank.optional(),
  label: z.string().max(40).optional(),
});
export type Seat = z.infer<typeof Seat>;

export const Move = z.object({
  n: z.number().int().min(1),
  color: Color,
  coord: z.string(), // 'D4' | 'pass'
  captured: z.number().int().min(0),
  at: z.string(), // ISO-время
});
export type Move = z.infer<typeof Move>;

export const Score = z.object({
  areaB: z.number(),
  areaW: z.number(),
  komi: z.number(),
  dead: z.array(z.string()),
  ownership: z.array(z.number()),
});
export type Score = z.infer<typeof Score>;

export const Result = z.object({
  winner: Color,
  margin: z.number().optional(),
  reason: z.enum(['score', 'resign']),
  score: Score.optional(),
});
export type Result = z.infer<typeof Result>;

export const GameStatus = z.enum(['playing', 'finished']);
export type GameStatus = z.infer<typeof GameStatus>;

export const GameState = z.object({
  id: z.string(),
  createdAt: z.string(),
  revision: z.number().int().min(0),
  settings: GameSettings,
  seats: z.object({ B: Seat, W: Seat }),
  status: GameStatus,
  toPlay: Color,
  moves: z.array(Move),
  board: z.string(),
  captures: z.object({ B: z.number().int().min(0), W: z.number().int().min(0) }),
  ko: z.string().nullable(),
  consecutivePasses: z.number().int().min(0),
  pendingEngineMove: z.boolean(),
  result: Result.optional(),
});
export type GameState = z.infer<typeof GameState>;

export const GameSummary = z.object({
  id: z.string(),
  createdAt: z.string(),
  status: GameStatus,
  moveCount: z.number().int().min(0),
  seats: z.object({ B: Seat, W: Seat }),
  result: Result.optional(),
});
export type GameSummary = z.infer<typeof GameSummary>;

export const Session = z.object({
  id: z.string(),
  room: z.string(),
  currentGameId: z.string().nullable(),
  createdAt: z.string(),
});
export type Session = z.infer<typeof Session>;

export const Via = z.enum(['voice', 'tap', 'api']);
export type Via = z.infer<typeof Via>;

export const By = z.enum(['human', 'engine', 'external', 'system']);
export type By = z.infer<typeof By>;
```

- [ ] **Step 5: `packages/protocol/src/errors.ts`**

```ts
// Коды ошибок и HTTP-статусы (раздел 5 спеки). Одна таблица на сервер и клиентов.
import { z } from 'zod';

export const ERROR_CODES = [
  'invalid_coord',
  'illegal_move',
  'not_your_turn',
  'game_finished',
  'nothing_to_undo',
  'revision_conflict',
  'engine_busy',
  'engine_unavailable',
  'unsupported_controller',
  'not_found',
  'bad_request',
  'limit_reached',
  'unauthorized',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_coord: 400,
  illegal_move: 400,
  unsupported_controller: 400,
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  not_your_turn: 409,
  game_finished: 409,
  nothing_to_undo: 409,
  revision_conflict: 409,
  limit_reached: 429,
  internal: 500,
  engine_busy: 503,
  engine_unavailable: 503,
};

export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

// Ответ не по протоколу (прокси, падение): статус и сырое тело.
export class HttpError extends Error {
  readonly status: number;
  readonly body?: string;

  constructor(status: number, body?: string) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}
```

- [ ] **Step 6: `packages/protocol/src/ops.ts`**

```ts
// Операции протокола (таблица раздела 5 спеки): тела запросов и ответов.
import { z } from 'zod';
import { BoardSize, Color, GameState, GameSummary, Move, Rank, Result, Seat, Session, Via } from './game.ts';

// settings описаны явно как optional, а не GameSettings.partial(): в zod 4 partial() сохраняет default,
// и тогда клиент не смог бы отличить «не прислали» от «прислали 13».
export const NewGameRequest = z.object({
  black: Seat,
  white: Seat,
  settings: z
    .object({ boardSize: BoardSize.optional(), rules: z.literal('chinese').optional(), komi: z.number().optional() })
    .optional(),
  waitForReply: z.boolean().default(true),
});
export type NewGameRequest = z.input<typeof NewGameRequest>;

export const NewGameResponse = z.object({
  state: GameState,
  firstMove: Move.optional(),
  replyTimedOut: z.literal(true).optional(),
});
export type NewGameResponse = z.infer<typeof NewGameResponse>;

export const PlayRequest = z.object({
  coord: z.string().min(1),
  color: Color.optional(),
  expectedRevision: z.number().int().optional(),
  waitForReply: z.boolean().default(true),
  via: Via.default('api'),
});
export type PlayRequest = z.input<typeof PlayRequest>;

export const PassRequest = PlayRequest.omit({ coord: true });
export type PassRequest = z.input<typeof PassRequest>;

export const PlayResponse = z.object({
  state: GameState,
  move: Move,
  reply: Move.optional(),
  replyTimedOut: z.literal(true).optional(),
});
export type PlayResponse = z.infer<typeof PlayResponse>;

export const ResignRequest = z.object({ color: Color, via: Via.default('api') });
export type ResignRequest = z.input<typeof ResignRequest>;

export const StateResponse = z.object({ state: GameState });
export type StateResponse = z.infer<typeof StateResponse>;

export const UndoRequest = z.object({ expectedRevision: z.number().int().optional(), via: Via.default('api') });
export type UndoRequest = z.input<typeof UndoRequest>;

export const UndoResponse = z.object({ state: GameState, removed: z.array(Move) });
export type UndoResponse = z.infer<typeof UndoResponse>;

export const CorrectRequest = z.object({
  coord: z.string().min(1),
  waitForReply: z.boolean().default(true),
  via: Via.default('api'),
});
export type CorrectRequest = z.input<typeof CorrectRequest>;

export const SetRankRequest = z.object({ color: Color, rank: Rank });
export type SetRankRequest = z.input<typeof SetRankRequest>;

export const AnalyzeRequest = z.object({ maxVisits: z.number().int().min(1).max(1000).default(50) });
export type AnalyzeRequest = z.input<typeof AnalyzeRequest>;

export const GroupInfo = z.object({
  color: Color,
  stones: z.array(z.string()),
  liberties: z.number().int(),
  ownershipAvg: z.number(),
  status: z.enum(['safe', 'unsettled', 'dead']),
});
export type GroupInfo = z.infer<typeof GroupInfo>;

export const Analysis = z.object({
  visits: z.number().int(),
  winrateB: z.number(),
  scoreLeadB: z.number(),
  topMoves: z.array(z.object({ coord: z.string(), winrateB: z.number(), scoreLeadB: z.number(), visits: z.number().int() })),
  ownership: z.array(z.number()),
  groups: z.array(GroupInfo),
});
export type Analysis = z.infer<typeof Analysis>;

export const CreateSessionResponse = z.object({
  session: Session,
  livekit: z.object({ url: z.string(), token: z.string() }),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const ListGamesResponse = z.object({ games: z.array(GameSummary) });
export type ListGamesResponse = z.infer<typeof ListGamesResponse>;

// Ответ score — Result из game.ts (без завершения партии).
```

- [ ] **Step 7: `packages/protocol/src/events.ts`**

```ts
// События SSE (раздел 5 спеки). На проводе: `event: <type>` и `data: <JSON всего объекта>`.
import { z } from 'zod';
import { By, Color, GameState, Result, Via } from './game.ts';

export const StateCause = z.enum(['play', 'pass', 'undo', 'correct', 'rank', 'engine', 'resign', 'new', 'sync']);
export type StateCause = z.infer<typeof StateCause>;

export const GameEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.game'), gameId: z.string() }),
  z.object({ type: z.literal('state.updated'), state: GameState, cause: StateCause, by: By, via: Via.optional() }),
  z.object({ type: z.literal('engine.thinking'), color: Color }),
  z.object({ type: z.literal('game.finished'), result: Result }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type GameEvent = z.infer<typeof GameEvent>;
```

- [ ] **Step 8: `packages/protocol/src/engine.ts`**

```ts
// Внутренний протокол game-server -> go-engine (раздел 8 спеки). Всё с точки зрения чёрных.
import { z } from 'zod';
import { Color, Rank } from './game.ts';

export const EngineMove = z.tuple([Color, z.string()]);
export type EngineMove = z.infer<typeof EngineMove>;

export const EnginePositionRequest = z.object({
  boardSize: z.number().int().min(5).max(19),
  rules: z.literal('chinese'),
  komi: z.number(),
  moves: z.array(EngineMove),
});
export type EnginePositionRequest = z.infer<typeof EnginePositionRequest>;

export const EngineGenmoveRequest = EnginePositionRequest.extend({
  rank: Rank,
  maxVisits: z.number().int().min(1).max(1000).default(10),
});
export type EngineGenmoveRequest = z.input<typeof EngineGenmoveRequest>;

export const EngineGenmoveResponse = z.object({
  move: z.string(),
  winrateB: z.number(),
  scoreLeadB: z.number(),
  humanPolicyTop: z.array(z.object({ coord: z.string(), prob: z.number() })),
  ms: z.number(),
});
export type EngineGenmoveResponse = z.infer<typeof EngineGenmoveResponse>;

export const EngineAnalyzeRequest = EnginePositionRequest.extend({
  maxVisits: z.number().int().min(1).max(1000).default(50),
  includeOwnership: z.boolean().default(true),
});
export type EngineAnalyzeRequest = z.input<typeof EngineAnalyzeRequest>;

export const EngineMoveInfo = z.object({
  coord: z.string(),
  winrateB: z.number(),
  scoreLeadB: z.number(),
  visits: z.number().int(),
  order: z.number().int(),
});
export type EngineMoveInfo = z.infer<typeof EngineMoveInfo>;

export const EngineAnalyzeResponse = z.object({
  visits: z.number().int(),
  winrateB: z.number(),
  scoreLeadB: z.number(),
  moveInfos: z.array(EngineMoveInfo),
  ownership: z.array(z.number()).optional(),
});
export type EngineAnalyzeResponse = z.infer<typeof EngineAnalyzeResponse>;

export const EngineScoreRequest = EnginePositionRequest;
export type EngineScoreRequest = z.input<typeof EngineScoreRequest>;

export const EngineScoreResponse = z.object({
  ownership: z.array(z.number()),
  dead: z.array(z.string()),
  areaB: z.number(),
  areaW: z.number(),
  scoreLeadB: z.number(),
  winner: Color,
  margin: z.number(),
});
export type EngineScoreResponse = z.infer<typeof EngineScoreResponse>;

export const EngineHealth = z.object({
  ok: z.boolean(),
  models: z.object({ main: z.string(), human: z.string() }),
  queue: z.number().int(),
  restarts: z.number().int(),
});
export type EngineHealth = z.infer<typeof EngineHealth>;
```

`packages/protocol/src/index.ts`:

```ts
export * from './game.ts';
export * from './errors.ts';
export * from './ops.ts';
export * from './events.ts';
export * from './engine.ts';
```

- [ ] **Step 9: Тесты зелёные**

Run: `npx vitest run packages/protocol && npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/protocol package-lock.json
git commit -m "protocol: zod-схемы партии, операций, ошибок, событий и движка"
```

---

### Task 5: `protocol` — разбор SSE и HTTP-клиент

**Files:**
- Create: `packages/protocol/src/sse.ts`, `packages/protocol/src/client.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/sse.test.ts`, `packages/protocol/src/client.test.ts`

**Interfaces:**
- Consumes: схемы Task 4.
- Produces: `parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string>` (отдаёт склеенные `data:` каждого блока); `createClient({ baseUrl, appKey, fetch? }): GokoClient` с методами `createSession()`, `newGame(sessionId, req)`, `createGame(req)`, `getGame(id)`, `listGames()`, `play(id, req)`, `pass(id, req?)`, `resign(id, req)`, `undo(id, req?)`, `correct(id, req)`, `setRank(id, req)`, `analyze(id, req?)`, `score(id)`, `ascii(id)`, `sgf(id)`, `events(target: { sessionId } | { gameId }, signal?): AsyncGenerator<GameEvent>`; ошибки протокола — `ApiError`, прочие — `HttpError`; `type GokoClient = ReturnType<typeof createClient>`.

- [ ] **Step 1: Тесты**

`packages/protocol/src/sse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSseStream } from './sse.ts';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of parseSseStream(stream)) out.push(d);
  return out;
}

describe('parseSseStream', () => {
  it('склеивает блоки, разорванные между чанками, и пропускает комментарии', async () => {
    const data = await collect(streamOf(['event: state.updated\ndata: {"a":', '1}\n\n: ping\n\nevent: x\ndata: {"b":2}\n\n']));
    expect(data).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('несколько строк data в одном блоке и CRLF', async () => {
    const data = await collect(streamOf(['data: one\r\ndata: two\r\n\r\n']));
    expect(data).toEqual(['one\ntwo']);
  });
});
```

`packages/protocol/src/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError, HttpError, createClient } from './index.ts';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetch: fetchFn as unknown as typeof fetch };
}

const state = {
  id: 'g1',
  createdAt: '2026-09-07T10:00:00.000Z',
  revision: 1,
  settings: { boardSize: 13, rules: 'chinese', komi: 7.5 },
  seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } },
  status: 'playing',
  toPlay: 'W',
  moves: [{ n: 1, color: 'B', coord: 'D4', captured: 0, at: '2026-09-07T10:00:01.000Z' }],
  board: '.'.repeat(169),
  captures: { B: 0, W: 0 },
  ko: null,
  consecutivePasses: 0,
  pendingEngineMove: true,
};

describe('createClient', () => {
  it('шлёт X-App-Key, JSON и разбирает ответ схемой', async () => {
    const f = fakeFetch(() => Response.json({ state, move: state.moves[0] }));
    const client = createClient({ baseUrl: 'http://api.test/', appKey: 'k', fetch: f.fetch });
    const res = await client.play('g1', { coord: 'D4', via: 'voice' });
    expect(res.move.coord).toBe('D4');
    expect(f.calls[0]?.url).toBe('http://api.test/api/games/g1/play');
    expect(f.calls[0]?.init.method).toBe('POST');
    expect((f.calls[0]?.init.headers as Record<string, string>)['x-app-key']).toBe('k');
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ coord: 'D4', via: 'voice' });
  });

  it('ошибка протокола -> ApiError с кодом', async () => {
    const f = fakeFetch(() => Response.json({ error: { code: 'illegal_move', message: 'занято', details: { reason: 'occupied' } } }, { status: 400 }));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    await expect(client.play('g1', { coord: 'D4' })).rejects.toMatchObject({ name: 'ApiError', code: 'illegal_move', status: 400, details: { reason: 'occupied' } });
  });

  it('не-протокольный ответ -> HttpError', async () => {
    const f = fakeFetch(() => new Response('bad gateway', { status: 502 }));
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    const err = await client.getGame('g1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
  });

  it('ascii и sgf — текст, events — разобранные события', async () => {
    const f = fakeFetch((call) => {
      if (call.url.endsWith('/ascii')) return new Response(' 1  .  .', { headers: { 'content-type': 'text/plain' } });
      const body = `event: state.updated\ndata: ${JSON.stringify({ type: 'state.updated', state, cause: 'sync', by: 'system' })}\n\nevent: engine.thinking\ndata: {"type":"engine.thinking","color":"W"}\n\n`;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    expect(await client.ascii('g1')).toBe(' 1  .  .');
    const events = [];
    for await (const ev of client.events({ gameId: 'g1' })) events.push(ev.type);
    expect(events).toEqual(['state.updated', 'engine.thinking']);
    expect(f.calls[1]?.url).toBe('http://api.test/api/games/g1/events');
  });

  it('createSession и score по нужным маршрутам', async () => {
    const f = fakeFetch((call) => {
      if (call.url.endsWith('/api/sessions')) return Response.json({ session: { id: 's1', room: 'goko-s1', currentGameId: null, createdAt: state.createdAt }, livekit: { url: 'wss://lk', token: 't' } });
      return Response.json({ winner: 'W', margin: 7.5, reason: 'score' });
    });
    const client = createClient({ baseUrl: 'http://api.test', appKey: 'k', fetch: f.fetch });
    expect((await client.createSession()).session.room).toBe('goko-s1');
    expect((await client.score('g1')).winner).toBe('W');
    expect(f.calls[1]?.url).toBe('http://api.test/api/games/g1/score');
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run packages/protocol`
Expected: FAIL — нет `./sse.ts`, нет `createClient`.

- [ ] **Step 3: `packages/protocol/src/sse.ts`**

```ts
// Разбор text/event-stream: отдаёт содержимое data каждого блока. Комментарии (": ping") пропускает.
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 4: `packages/protocol/src/client.ts`**

```ts
// Типизированный клиент game-server. Им пользуются voice-agent, web, mcp-server и scripts/.
import type { z } from 'zod';
import { ApiError, ErrorBody, HttpError } from './errors.ts';
import { GameEvent } from './events.ts';
import { GameState, Result } from './game.ts';
import {
  Analysis,
  type AnalyzeRequest,
  type CorrectRequest,
  CreateSessionResponse,
  ListGamesResponse,
  type NewGameRequest,
  NewGameResponse,
  type PassRequest,
  type PlayRequest,
  PlayResponse,
  type ResignRequest,
  type SetRankRequest,
  StateResponse,
  type UndoRequest,
  UndoResponse,
} from './ops.ts';
import { parseSseStream } from './sse.ts';

export type ClientOptions = {
  baseUrl: string; // https://<WEB_HOST> или http://127.0.0.1:8787
  appKey: string;
  fetch?: typeof globalThis.fetch;
};

export type EventsTarget = { sessionId: string } | { gameId: string };

async function toError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(text));
    if (parsed.success) return new ApiError(parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
  } catch {
    // не JSON — ниже HttpError
  }
  return new HttpError(res.status, text);
}

export function createClient(opts: ClientOptions) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const enc = encodeURIComponent;

  async function call<T extends z.ZodType>(method: 'GET' | 'POST', path: string, schema: T, body?: unknown): Promise<z.output<T>> {
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-app-key': opts.appKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await toError(res);
    return schema.parse(await res.json());
  }

  async function text(path: string): Promise<string> {
    const res = await fetchFn(`${base}${path}`, { headers: { 'x-app-key': opts.appKey } });
    if (!res.ok) throw await toError(res);
    return res.text();
  }

  async function* events(target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
    const path = 'sessionId' in target ? `/api/sessions/${enc(target.sessionId)}/events` : `/api/games/${enc(target.gameId)}/events`;
    const res = await fetchFn(`${base}${path}`, { headers: { 'x-app-key': opts.appKey, accept: 'text/event-stream' }, signal });
    if (!res.ok) throw await toError(res);
    if (!res.body) throw new HttpError(res.status, 'empty SSE body');
    for await (const data of parseSseStream(res.body)) {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      const parsed = GameEvent.safeParse(json);
      if (parsed.success) yield parsed.data;
    }
  }

  return {
    createSession: () => call('POST', '/api/sessions', CreateSessionResponse, {}),
    newGame: (sessionId: string, req: NewGameRequest) => call('POST', `/api/sessions/${enc(sessionId)}/games`, NewGameResponse, req),
    createGame: (req: NewGameRequest) => call('POST', '/api/games', NewGameResponse, req),
    getGame: (id: string) => call('GET', `/api/games/${enc(id)}`, GameState),
    listGames: () => call('GET', '/api/games', ListGamesResponse),
    play: (id: string, req: PlayRequest) => call('POST', `/api/games/${enc(id)}/play`, PlayResponse, req),
    pass: (id: string, req: PassRequest = {}) => call('POST', `/api/games/${enc(id)}/pass`, PlayResponse, req),
    resign: (id: string, req: ResignRequest) => call('POST', `/api/games/${enc(id)}/resign`, StateResponse, req),
    undo: (id: string, req: UndoRequest = {}) => call('POST', `/api/games/${enc(id)}/undo`, UndoResponse, req),
    correct: (id: string, req: CorrectRequest) => call('POST', `/api/games/${enc(id)}/correct`, PlayResponse, req),
    setRank: (id: string, req: SetRankRequest) => call('POST', `/api/games/${enc(id)}/rank`, StateResponse, req),
    analyze: (id: string, req: AnalyzeRequest = {}) => call('POST', `/api/games/${enc(id)}/analyze`, Analysis, req),
    score: (id: string) => call('POST', `/api/games/${enc(id)}/score`, Result, {}),
    ascii: (id: string) => text(`/api/games/${enc(id)}/ascii`),
    sgf: (id: string) => text(`/api/games/${enc(id)}/sgf`),
    events,
  };
}

export type GokoClient = ReturnType<typeof createClient>;
```

`packages/protocol/src/index.ts` дополнить:

```ts
export * from './sse.ts';
export * from './client.ts';
```

- [ ] **Step 5: Тесты зелёные**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol
git commit -m "protocol: разбор SSE и типизированный HTTP-клиент"
```

---
### Task 6: `go-engine` — индексация KataGo и выбор хода по `humanPolicy`

**Files:**
- Create: `apps/go-engine/src/mapping.ts`, `apps/go-engine/src/sampling.ts`
- Modify: `apps/go-engine/package.json` (стадия 0 оставила только имя)
- Test: `apps/go-engine/src/mapping.test.ts`, `apps/go-engine/src/sampling.test.ts`

**Interfaces:**
- Consumes: `indexToCoord` из `@goko/go-core`.
- Produces: `kataIndexToOurs(kataIndex, size): number`; `kataIndexToCoord(kataIndex, size): string` (`size*size` → `'pass'`); `reorderFromKata(values: readonly number[], size): number[]`; `rankToProfile(rank): string` (`'10k'` → `'rank_10k'`); `type Candidate = { coord: string; prob: number }`; `chooseMove({ humanPolicy, size, bestMove, tailCutoff?, random? }): { move: string; top: Candidate[]; fallback: boolean }`; `TAIL_CUTOFF = 0.005`.

- [ ] **Step 1: `apps/go-engine/package.json`**

```json
{
  "name": "@goko/go-engine",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "start": "node --env-file-if-exists=../../.env src/main.ts"
  },
  "dependencies": {
    "@goko/go-core": "*",
    "@goko/protocol": "*",
    "@hono/node-server": "^2.1.1",
    "hono": "^4.13.7",
    "zod": "^4.5.4"
  }
}
```

`npm install` в корне.

- [ ] **Step 2: Тесты**

`apps/go-engine/src/mapping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { coordToIndex } from '@goko/go-core';
import { kataIndexToCoord, kataIndexToOurs, rankToProfile, reorderFromKata } from './mapping.ts';

describe('mapping', () => {
  it('KataGo идёт строками сверху: индекс 0 — A13, индекс 168 — N1', () => {
    expect(kataIndexToCoord(0, 13)).toBe('A13');
    expect(kataIndexToCoord(12, 13)).toBe('N13');
    expect(kataIndexToCoord(156, 13)).toBe('A1');
    expect(kataIndexToCoord(168, 13)).toBe('N1');
    expect(kataIndexToCoord(169, 13)).toBe('pass');
    expect(kataIndexToOurs(0, 13)).toBe(coordToIndex('A13', 13));
  });

  it('reorderFromKata перекладывает массив в нашу индексацию', () => {
    const kata = new Array<number>(169).fill(0);
    kata[0] = 1; // A13
    kata[168] = -1; // N1
    const ours = reorderFromKata(kata, 13);
    expect(ours[coordToIndex('A13', 13)]).toBe(1);
    expect(ours[coordToIndex('N1', 13)]).toBe(-1);
    expect(ours[coordToIndex('A1', 13)]).toBe(0);
    expect(ours).toHaveLength(169);
  });

  it('rankToProfile', () => {
    expect(rankToProfile('10k')).toBe('rank_10k');
    expect(rankToProfile('3d')).toBe('rank_3d');
  });
});
```

`apps/go-engine/src/sampling.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { coordToIndex } from '@goko/go-core';
import { chooseMove } from './sampling.ts';

const SIZE = 9;
const PASS = SIZE * SIZE;
function policy(entries: Record<string, number>, pass = 0): number[] {
  const p = new Array<number>(PASS + 1).fill(0);
  for (const [coord, prob] of Object.entries(entries)) p[coordToIndex(coord, SIZE)] = prob;
  p[PASS] = pass;
  return p;
}

describe('chooseMove', () => {
  it('единственный кандидат выбирается всегда', () => {
    const r = chooseMove({ humanPolicy: policy({ D4: 0.9 }), size: SIZE, bestMove: 'E5', random: () => 0.99 });
    expect(r).toEqual({ move: 'D4', top: [{ coord: 'D4', prob: 0.9 }], fallback: false });
  });

  it('нелегальные (-1) и хвост ниже 0.5 % отбрасываются', () => {
    const p = policy({ D4: 0.6, E5: 0.004 });
    p[coordToIndex('C3', SIZE)] = -1;
    const r = chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'C3', random: () => 0.999 });
    expect(r.move).toBe('D4');
    expect(r.top.map((c) => c.coord)).toEqual(['D4']);
  });

  it('пас отбрасывается, если лучший ход поиска — не пас', () => {
    expect(chooseMove({ humanPolicy: policy({ D4: 0.1 }, 0.9), size: SIZE, bestMove: 'D4', random: () => 0.5 }).move).toBe('D4');
    expect(chooseMove({ humanPolicy: policy({ D4: 0.1 }, 0.9), size: SIZE, bestMove: 'pass', random: () => 0.5 }).move).toBe('pass');
  });

  it('если всё обнулилось — лучший ход поиска', () => {
    expect(chooseMove({ humanPolicy: policy({}), size: SIZE, bestMove: 'E5' })).toEqual({ move: 'E5', top: [], fallback: true });
    expect(chooseMove({ humanPolicy: [], size: SIZE, bestMove: 'E5' }).move).toBe('E5');
  });

  it('сэмплирует пропорционально вероятности при температуре 1', () => {
    const p = policy({ D4: 0.75, E5: 0.25 });
    const counts = { D4: 0, E5: 0 };
    for (let i = 0; i < 1000; i++) {
      const move = chooseMove({ humanPolicy: p, size: SIZE, bestMove: 'D4', random: () => (i + 0.5) / 1000 }).move as 'D4' | 'E5';
      counts[move]++;
    }
    expect(counts.D4).toBe(750);
    expect(counts.E5).toBe(250);
  });

  it('top — до пяти кандидатов по убыванию', () => {
    const r = chooseMove({ humanPolicy: policy({ A1: 0.1, B2: 0.2, C3: 0.3, D4: 0.05, E5: 0.15, F6: 0.2 }), size: SIZE, bestMove: 'C3', random: () => 0 });
    expect(r.top).toHaveLength(5);
    expect(r.top[0]?.coord).toBe('C3');
  });
});
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `npx vitest run apps/go-engine`
Expected: FAIL на импортах.

- [ ] **Step 4: `apps/go-engine/src/mapping.ts`**

```ts
// KataGo отдаёт policy/ownership строками сверху вниз (A13..N13, ..., A1..N1); наша индексация — снизу.
import { indexToCoord } from '@goko/go-core';

export function kataIndexToOurs(kataIndex: number, size: number): number {
  const rowFromTop = Math.floor(kataIndex / size);
  const col = kataIndex % size;
  return (size - 1 - rowFromTop) * size + col;
}

export function kataIndexToCoord(kataIndex: number, size: number): string {
  if (kataIndex === size * size) return 'pass';
  return indexToCoord(kataIndexToOurs(kataIndex, size), size);
}

export function reorderFromKata(values: readonly number[], size: number): number[] {
  const out = new Array<number>(size * size).fill(0);
  for (let k = 0; k < size * size; k++) out[kataIndexToOurs(k, size)] = values[k] ?? 0;
  return out;
}

export function rankToProfile(rank: string): string {
  return `rank_${rank}`;
}
```

- [ ] **Step 5: `apps/go-engine/src/sampling.ts`**

```ts
// Выбор хода на ранге (раздел 8 спеки): humanPolicy без нелегальных, без паса (если поиск не пасует),
// без хвоста < 0.5 %, сэмплирование при температуре 1; если ничего не осталось — лучший ход поиска.
import { kataIndexToCoord } from './mapping.ts';

export type Candidate = { coord: string; prob: number };

export type ChooseMoveInput = {
  humanPolicy: readonly number[]; // size*size + 1, -1 = нелегально, последний = пас
  size: number;
  bestMove: string; // moveInfos[0].move основного поиска
  tailCutoff?: number;
  random?: () => number;
};

export type ChooseMoveResult = { move: string; top: Candidate[]; fallback: boolean };

export const TAIL_CUTOFF = 0.005;

export function chooseMove(input: ChooseMoveInput): ChooseMoveResult {
  const cutoff = input.tailCutoff ?? TAIL_CUTOFF;
  const random = input.random ?? Math.random;
  const passIndex = input.size * input.size;
  const candidates: Candidate[] = [];
  for (let k = 0; k < input.humanPolicy.length; k++) {
    const prob = input.humanPolicy[k] ?? -1;
    if (prob <= 0) continue;
    if (k === passIndex && input.bestMove !== 'pass') continue;
    if (prob < cutoff) continue;
    candidates.push({ coord: kataIndexToCoord(k, input.size), prob });
  }
  const top = [...candidates].sort((a, b) => b.prob - a.prob).slice(0, 5);
  if (candidates.length === 0) return { move: input.bestMove, top, fallback: true };
  const total = candidates.reduce((sum, c) => sum + c.prob, 0);
  let r = random() * total;
  for (const c of candidates) {
    r -= c.prob;
    if (r < 0) return { move: c.coord, top, fallback: false };
  }
  return { move: candidates[candidates.length - 1]!.coord, top, fallback: false };
}
```

- [ ] **Step 6: Тесты зелёные**

Run: `npx vitest run apps/go-engine && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/go-engine package-lock.json
git commit -m "go-engine: индексация KataGo и выбор хода по humanPolicy"
```

---

### Task 7: `go-engine` — процесс KataGo: очередь, таймауты, перезапуск

**Files:**
- Create: `apps/go-engine/src/katago.ts`
- Test: `apps/go-engine/src/katago.test.ts`

**Interfaces:**
- Produces: `type KataProcess = { stdin: Writable; stdout: Readable; stderr: Readable | null; kill(): void; on(event: 'exit', cb: (code: number | null) => void): void }`; `type KataGoOptions = { bin; model; humanModel; config; maxConcurrent?: number = 1; backoffMs?: number[] = [1000, 2000, 4000, 8000, 16000, 30000]; spawn?: (bin, args) => KataProcess; log?: (line) => void }`; `type KataQuery = Record<string, unknown>`; `type KataResponse = Record<string, unknown> & { id: string }`; `class KataGoError extends Error { kind: 'crashed' | 'timeout' | 'rejected' }`; `class KataGo { start(); query(q, timeoutMs = 30000): Promise<KataResponse>; stop(): Promise<void>; get alive; get queueLength; get restarts }`.

- [ ] **Step 1: Тест `apps/go-engine/src/katago.test.ts`**

```ts
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { KataGo, KataGoError, type KataProcess } from './katago.ts';

type Handler = (query: Record<string, unknown>, reply: (r: unknown) => void) => void;

// Фейковый процесс KataGo: читает JSON-строки из stdin, отвечает через handler в stdout.
function fakeSpawner(handler: Handler) {
  const spawned: Array<{ proc: KataProcess; exit: (code: number) => void; written: string[] }> = [];
  const spawn = (): KataProcess => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const listeners: Array<(code: number | null) => void> = [];
    const written: string[] = [];
    readline.createInterface({ input: stdin }).on('line', (line) => {
      written.push(line);
      handler(JSON.parse(line) as Record<string, unknown>, (r) => stdout.write(`${JSON.stringify(r)}\n`));
    });
    const proc: KataProcess = {
      stdin,
      stdout,
      stderr: null,
      kill: () => listeners.forEach((l) => l(0)),
      on: (_event, cb) => listeners.push(cb),
    };
    const entry = { proc, exit: (code: number) => listeners.forEach((l) => l(code)), written };
    spawned.push(entry);
    return proc;
  };
  return { spawn, spawned };
}

const opts = { bin: 'katago', model: 'main', humanModel: 'human', config: 'cfg', backoffMs: [0] };

describe('KataGo', () => {
  it('запрос получает id и ответ с тем же id', async () => {
    const f = fakeSpawner((q, reply) => reply({ id: q.id, rootInfo: { winrate: 0.5 }, echo: q.maxVisits }));
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    const r = await k.query({ maxVisits: 7 });
    expect(r.id).toBe('q1');
    expect(r.echo).toBe(7);
    expect(JSON.parse(f.spawned[0]!.written[0]!)).toEqual({ id: 'q1', maxVisits: 7 });
    expect(f.spawned[0]!.written).toHaveLength(1);
    await k.stop();
  });

  it('ответ с error отклоняет запрос, warning — нет', async () => {
    const f = fakeSpawner((q, reply) => {
      if (q.bad) reply({ id: q.id, error: 'bad field', field: 'moves' });
      else {
        reply({ id: q.id, warning: 'meh', field: 'rules' });
        reply({ id: q.id, rootInfo: {} });
      }
    });
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    await expect(k.query({ bad: true })).rejects.toMatchObject({ kind: 'rejected' });
    await expect(k.query({})).resolves.toMatchObject({ id: 'q2' });
    await k.stop();
  });

  it('не более maxConcurrent запросов в полёте, остальные ждут', async () => {
    const pending: Array<() => void> = [];
    const f = fakeSpawner((q, reply) => pending.push(() => reply({ id: q.id })));
    const k = new KataGo({ ...opts, spawn: f.spawn, maxConcurrent: 1 });
    k.start();
    const a = k.query({ n: 1 });
    const b = k.query({ n: 2 });
    await new Promise((r) => setTimeout(r, 10));
    expect(f.spawned[0]!.written).toHaveLength(1);
    expect(k.queueLength).toBe(2);
    pending.shift()!();
    await a;
    await new Promise((r) => setTimeout(r, 10));
    expect(f.spawned[0]!.written).toHaveLength(2);
    pending.shift()!();
    await b;
    expect(k.queueLength).toBe(0);
    await k.stop();
  });

  it('таймаут отклоняет запрос и шлёт terminate', async () => {
    const f = fakeSpawner(() => undefined);
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    await expect(k.query({}, 20)).rejects.toBeInstanceOf(KataGoError);
    await new Promise((r) => setTimeout(r, 5));
    expect(f.spawned[0]!.written.some((l) => l.includes('"action":"terminate"'))).toBe(true);
    await k.stop();
  });

  it('падение процесса отклоняет запросы в полёте и перезапускает процесс', async () => {
    const f = fakeSpawner((q, reply) => {
      if (f.spawned.length > 1) reply({ id: q.id, ok: true });
    });
    const k = new KataGo({ ...opts, spawn: f.spawn });
    k.start();
    const p = k.query({});
    await new Promise((r) => setTimeout(r, 5));
    f.spawned[0]!.exit(137);
    await expect(p).rejects.toMatchObject({ kind: 'crashed' });
    await new Promise((r) => setTimeout(r, 10));
    expect(f.spawned).toHaveLength(2);
    expect(k.restarts).toBe(1);
    expect(k.alive).toBe(true);
    await expect(k.query({})).resolves.toMatchObject({ ok: true });
    await k.stop();
    expect(k.alive).toBe(false);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx vitest run apps/go-engine/src/katago.test.ts`
Expected: FAIL — нет `./katago.ts`.

- [ ] **Step 3: `apps/go-engine/src/katago.ts`**

```ts
// Один процесс `katago analysis`: JSON-строки в stdin, ответы из stdout по id. Очередь с лимитом
// параллельности, таймауты с terminate, перезапуск с экспоненциальной паузой при падении.
import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type KataProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  kill: () => void;
  on: (event: 'exit', cb: (code: number | null) => void) => void;
};

export type KataGoOptions = {
  bin: string;
  model: string;
  humanModel: string;
  config: string;
  maxConcurrent?: number;
  backoffMs?: number[];
  spawn?: (bin: string, args: string[]) => KataProcess;
  log?: (line: string) => void;
};

export type KataQuery = Record<string, unknown>;
export type KataResponse = Record<string, unknown> & { id: string };

export class KataGoError extends Error {
  readonly kind: 'crashed' | 'timeout' | 'rejected';

  constructor(kind: 'crashed' | 'timeout' | 'rejected', message: string) {
    super(message);
    this.name = 'KataGoError';
    this.kind = kind;
  }
}

type Pending = {
  id: string;
  query: KataQuery;
  timeoutMs: number;
  resolve: (r: KataResponse) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
};

function defaultSpawn(bin: string, args: string[]): KataProcess {
  const child = nodeSpawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      child.kill();
    },
    on: (event, cb) => {
      child.on(event, cb);
    },
  };
}

export class KataGo {
  private proc: KataProcess | null = null;
  private readonly queue: Pending[] = [];
  private readonly inFlight = new Map<string, Pending>();
  private seq = 0;
  private restartCount = 0;
  private crashStreak = 0;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly opts: KataGoOptions;
  private readonly maxConcurrent: number;
  private readonly backoffMs: number[];

  constructor(opts: KataGoOptions) {
    this.opts = opts;
    this.maxConcurrent = opts.maxConcurrent ?? 1;
    this.backoffMs = opts.backoffMs ?? [1000, 2000, 4000, 8000, 16000, 30000];
  }

  get alive(): boolean {
    return this.proc !== null;
  }

  get queueLength(): number {
    return this.queue.length + this.inFlight.size;
  }

  get restarts(): number {
    return this.restartCount;
  }

  start(): void {
    if (this.proc || this.stopped) return;
    const spawnFn = this.opts.spawn ?? defaultSpawn;
    const args = ['analysis', '-config', this.opts.config, '-model', this.opts.model, '-human-model', this.opts.humanModel];
    const proc = spawnFn(this.opts.bin, args);
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr?.on('data', (chunk: Buffer) => this.opts.log?.(`[katago] ${String(chunk).trimEnd()}`));
    proc.on('exit', (code) => this.onExit(proc, code));
    this.pump();
  }

  query(query: KataQuery, timeoutMs = 30_000): Promise<KataResponse> {
    return new Promise((resolve, reject) => {
      const id = `q${++this.seq}`;
      this.queue.push({ id, query, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    proc.stdin.end();
    proc.kill();
    const err = new KataGoError('crashed', 'katago stopped');
    for (const p of [...this.inFlight.values(), ...this.queue]) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.inFlight.clear();
    this.queue.length = 0;
  }

  private pump(): void {
    while (this.proc && this.inFlight.size < this.maxConcurrent && this.queue.length) {
      const p = this.queue.shift()!;
      this.inFlight.set(p.id, p);
      p.timer = setTimeout(() => this.onTimeout(p), p.timeoutMs);
      this.proc.stdin.write(`${JSON.stringify({ id: p.id, ...p.query })}\n`);
    }
  }

  private onTimeout(p: Pending): void {
    if (!this.inFlight.delete(p.id)) return;
    this.proc?.stdin.write(`${JSON.stringify({ id: `t-${p.id}`, action: 'terminate', terminateId: p.id })}\n`);
    p.reject(new KataGoError('timeout', `katago query ${p.id} timed out after ${p.timeoutMs} ms`));
    this.pump();
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.opts.log?.(`[katago] non-json: ${line.slice(0, 200)}`);
      return;
    }
    const id = typeof msg.id === 'string' ? msg.id : undefined;
    if (!id) {
      if (msg.error) this.opts.log?.(`[katago] error: ${String(msg.error)}`);
      return;
    }
    if (msg.action === 'terminate') return; // эхо нашего terminate
    if (msg.isDuringSearch === true) return;
    const p = this.inFlight.get(id);
    if (!p) return; // ответ на уже отклонённый (таймаут) запрос
    if (msg.warning !== undefined && msg.error === undefined) {
      this.opts.log?.(`[katago] warning ${id}: ${String(msg.warning)} (${String(msg.field ?? '')})`);
      return; // предупреждение не завершает запрос: ответ придёт следом
    }
    this.inFlight.delete(id);
    clearTimeout(p.timer);
    this.crashStreak = 0;
    if (msg.error !== undefined) {
      p.reject(new KataGoError('rejected', `katago rejected ${id}: ${String(msg.error)}${msg.field ? ` (${String(msg.field)})` : ''}`));
    } else {
      p.resolve({ ...msg, id });
    }
    this.pump();
  }

  private onExit(proc: KataProcess, code: number | null): void {
    if (this.proc !== proc) return;
    this.proc = null;
    const err = new KataGoError('crashed', `katago exited with code ${code}`);
    for (const p of this.inFlight.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.inFlight.clear();
    if (this.stopped) return;
    const delay = this.backoffMs[Math.min(this.crashStreak, this.backoffMs.length - 1)] ?? 1000;
    this.crashStreak++;
    this.restartCount++;
    this.opts.log?.(`[!] katago exited (${code}); restart #${this.restartCount} in ${delay} ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `npx vitest run apps/go-engine && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/go-engine/src/katago.ts apps/go-engine/src/katago.test.ts
git commit -m "go-engine: процесс KataGo с очередью, таймаутами и перезапуском"
```

---

### Task 8: `go-engine` — HTTP-обёртка, запуск, контрактный тест с настоящим KataGo

**Files:**
- Create: `apps/go-engine/src/app.ts`, `apps/go-engine/src/main.ts`
- Modify: `infra/.env.example` (переменные движка)
- Test: `apps/go-engine/src/app.test.ts`, `apps/go-engine/src/katago.contract.test.ts`

**Interfaces:**
- Consumes: `KataGo`, `KataGoError`, `chooseMove`, `reorderFromKata`, `rankToProfile`; схемы `Engine*` из `@goko/protocol`; `replay`, `deadStones`, `areaScore`, `resultFromArea` из `@goko/go-core`.
- Produces: `type EngineDeps = { katago: Pick<KataGo, 'query' | 'queueLength' | 'restarts' | 'alive'>; engineKey: string; models: { main: string; human: string }; random?; maxQueue?: number = 8; timeouts?: { genmove; analyze; score } = { 20000, 30000, 60000 }; log? }`; `createEngineApp(deps): Hono` с маршрутами `GET /health`, `POST /v1/genmove`, `POST /v1/analyze`, `POST /v1/score` (все `/v1/*` требуют `X-Engine-Key`); `SCORE_VISITS = 400`. Переменные окружения `main.ts`: `KATAGO_BIN`, `KATAGO_MODEL`, `KATAGO_HUMAN_MODEL`, `KATAGO_CONFIG`, `ENGINE_KEY`, `ENGINE_PORT = 8788`, `ENGINE_HOST = 127.0.0.1`.

- [ ] **Step 1: Тест `apps/go-engine/src/app.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { COLUMN_LETTERS, coordToIndex } from '@goko/go-core';
import { createEngineApp } from './app.ts';
import type { KataQuery, KataResponse } from './katago.ts';

function fakeKatago(reply: (q: KataQuery) => Partial<KataResponse>, extra: { alive?: boolean; queueLength?: number } = {}) {
  const calls: KataQuery[] = [];
  return {
    calls,
    alive: extra.alive ?? true,
    queueLength: extra.queueLength ?? 0,
    restarts: 0,
    async query(q: KataQuery): Promise<KataResponse> {
      calls.push(q);
      return { id: 'q', ...reply(q) };
    },
  };
}

const KEY = 'engine-secret';
const headers = { 'content-type': 'application/json', 'x-engine-key': KEY };
const base = { boardSize: 13, rules: 'chinese', komi: 7.5 };

// Чёрная стена на строке blackRow, белая — на whiteRow; ходы чередуются, всё легально.
function walls(blackRow: number, whiteRow: number): [string, string][] {
  const moves: [string, string][] = [];
  for (let c = 0; c < 13; c++) {
    moves.push(['B', `${COLUMN_LETTERS.charAt(c)}${blackRow}`]);
    moves.push(['W', `${COLUMN_LETTERS.charAt(c)}${whiteRow}`]);
  }
  return moves;
}

// Ownership в порядке KataGo (строки сверху): строки выше границы белые (-1), ниже — чёрные (+1).
function kataOwnership(blackRowsFromBottom: number): number[] {
  const out: number[] = [];
  for (let rowFromTop = 0; rowFromTop < 13; rowFromTop++) {
    const row = 13 - rowFromTop; // 13..1
    for (let c = 0; c < 13; c++) out.push(row <= blackRowsFromBottom ? 1 : -1);
  }
  return out;
}

describe('createEngineApp', () => {
  it('без ключа — 401, при полной очереди — 503 engine_busy, без процесса — engine_unavailable', async () => {
    const app = createEngineApp({ katago: fakeKatago(() => ({})), engineKey: KEY, models: { main: 'm', human: 'h' } });
    const noKey = await app.request('/v1/genmove', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(noKey.status).toBe(401);
    const busy = createEngineApp({ katago: fakeKatago(() => ({}), { queueLength: 8 }), engineKey: KEY, models: { main: 'm', human: 'h' } });
    const busyRes = await busy.request('/v1/genmove', { method: 'POST', body: '{}', headers });
    expect(busyRes.status).toBe(503);
    expect((await busyRes.json()).error.code).toBe('engine_busy');
    const dead = createEngineApp({ katago: fakeKatago(() => ({}), { alive: false }), engineKey: KEY, models: { main: 'm', human: 'h' } });
    expect((await (await dead.request('/v1/analyze', { method: 'POST', body: '{}', headers })).json()).error.code).toBe('engine_unavailable');
  });

  it('health без ключа', async () => {
    const app = createEngineApp({ katago: fakeKatago(() => ({})), engineKey: KEY, models: { main: 'main.bin.gz', human: 'human.bin.gz' } });
    const res = await app.request('/health');
    expect(await res.json()).toEqual({ ok: true, models: { main: 'main.bin.gz', human: 'human.bin.gz' }, queue: 0, restarts: 0 });
  });

  it('genmove: humanSLProfile, includePolicy, выбор по humanPolicy', async () => {
    const policy = new Array<number>(170).fill(0);
    policy[169] = 0.5; // пас — отбрасывается, лучший ход не пас
    policy[0] = 0.4; // A13 в порядке KataGo
    const katago = fakeKatago(() => ({ rootInfo: { winrate: 0.61, scoreLead: 3.2, visits: 10 }, moveInfos: [{ move: 'D4', order: 0, winrate: 0.6, scoreLead: 3, visits: 9 }], humanPolicy: policy }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await app.request('/v1/genmove', { method: 'POST', headers, body: JSON.stringify({ ...base, moves: [['B', 'D4']], rank: '10k' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ move: 'A13', winrateB: 0.61, scoreLeadB: 3.2, humanPolicyTop: [{ coord: 'A13', prob: 0.4 }] });
    expect(typeof body.ms).toBe('number');
    expect(katago.calls[0]).toMatchObject({
      rules: 'chinese',
      komi: 7.5,
      boardXSize: 13,
      boardYSize: 13,
      moves: [['B', 'D4']],
      maxVisits: 10,
      includePolicy: true,
      overrideSettings: { humanSLProfile: 'rank_10k' },
    });
  });

  it('genmove без humanPolicy — лучший ход поиска', async () => {
    const app = createEngineApp({ katago: fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0 }, moveInfos: [{ move: 'K10', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }] })), engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await app.request('/v1/genmove', { method: 'POST', headers, body: JSON.stringify({ ...base, moves: [], rank: '1d' }) });
    expect((await res.json()).move).toBe('K10');
  });

  it('analyze: ownership перекладывается в нашу индексацию, moveInfos по order', async () => {
    const ownership = new Array<number>(169).fill(0);
    ownership[0] = 0.9; // A13 у KataGo
    const katago = fakeKatago(() => ({ rootInfo: { winrate: 0.4, scoreLead: -2, visits: 50 }, ownership, moveInfos: [{ move: 'C3', order: 1, winrate: 0.39, scoreLead: -2.5, visits: 10 }, { move: 'D4', order: 0, winrate: 0.41, scoreLead: -1.5, visits: 30 }] }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await app.request('/v1/analyze', { method: 'POST', headers, body: JSON.stringify({ ...base, moves: [] }) });
    const body = await res.json();
    expect(body.ownership[coordToIndex('A13', 13)]).toBe(0.9);
    expect(body.ownership[coordToIndex('A1', 13)]).toBe(0);
    expect(body.moveInfos.map((m: { coord: string }) => m.coord)).toEqual(['D4', 'C3']);
    expect(katago.calls[0]).toMatchObject({ maxVisits: 50, includeOwnership: true });
  });

  it('score: мёртвые по владению, площадь через go-core, winner и margin', async () => {
    // Чёрные строки 1..7 (стена на 7), белые 8..13; плюс чёрный камень M12 в белой зоне, ownership там белое.
    const moves: [string, string][] = [...walls(7, 8), ['B', 'M12'], ['W', 'pass']];
    const katago = fakeKatago(() => ({ rootInfo: { winrate: 0.7, scoreLead: 5.5, visits: 400 }, ownership: kataOwnership(7) }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await app.request('/v1/score', { method: 'POST', headers, body: JSON.stringify({ ...base, moves }) });
    const body = await res.json();
    expect(body).toMatchObject({ dead: ['M12'], areaB: 91, areaW: 78, scoreLeadB: 5.5, winner: 'B', margin: 5.5 });
    expect(body.ownership[coordToIndex('A1', 13)]).toBe(1);
    expect(body.ownership[coordToIndex('A13', 13)]).toBe(-1);
    expect(katago.calls[0]).toMatchObject({ maxVisits: 400, includeOwnership: true });
  });

  it('тело не по схеме — 400 bad_request', async () => {
    const app = createEngineApp({ katago: fakeKatago(() => ({})), engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await app.request('/v1/genmove', { method: 'POST', headers, body: JSON.stringify({ ...base, moves: [], rank: '99k' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx vitest run apps/go-engine/src/app.test.ts`
Expected: FAIL — нет `./app.ts`.

- [ ] **Step 3: `apps/go-engine/src/app.ts`**

```ts
// HTTP-обёртка над KataGo (раздел 8 спеки). Всё с точки зрения чёрных, индексация — наша.
import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { areaScore, deadStones, replay, resultFromArea } from '@goko/go-core';
import {
  ERROR_STATUS,
  EngineAnalyzeRequest,
  EngineAnalyzeResponse,
  EngineGenmoveRequest,
  EngineGenmoveResponse,
  EngineHealth,
  EngineScoreRequest,
  EngineScoreResponse,
  type ErrorCode,
} from '@goko/protocol';
import { type KataGo, KataGoError, type KataQuery, type KataResponse } from './katago.ts';
import { rankToProfile, reorderFromKata } from './mapping.ts';
import { chooseMove } from './sampling.ts';

export type EngineDeps = {
  katago: Pick<KataGo, 'query' | 'queueLength' | 'restarts' | 'alive'>;
  engineKey: string;
  models: { main: string; human: string };
  random?: () => number;
  maxQueue?: number;
  timeouts?: { genmove: number; analyze: number; score: number };
  log?: (line: string) => void;
};

export const SCORE_VISITS = 400;

type KataRoot = { winrate?: number; scoreLead?: number; visits?: number };
type KataMoveInfo = { move: string; winrate: number; scoreLead: number; visits: number; order: number };

function baseQuery(req: { boardSize: number; rules: string; komi: number; moves: [string, string][] }): KataQuery {
  return { rules: req.rules, komi: req.komi, boardXSize: req.boardSize, boardYSize: req.boardSize, moves: req.moves };
}

function rootOf(r: KataResponse): Required<KataRoot> {
  const root = (r.rootInfo ?? {}) as KataRoot;
  return { winrate: root.winrate ?? 0.5, scoreLead: root.scoreLead ?? 0, visits: root.visits ?? 0 };
}

function moveInfosOf(r: KataResponse): KataMoveInfo[] {
  return Array.isArray(r.moveInfos) ? (r.moveInfos as KataMoveInfo[]) : [];
}

function numbersOf(value: unknown): number[] {
  return Array.isArray(value) ? (value as number[]) : [];
}

export function createEngineApp(deps: EngineDeps): Hono {
  const app = new Hono();
  const timeouts = deps.timeouts ?? { genmove: 20_000, analyze: 30_000, score: 60_000 };
  const maxQueue = deps.maxQueue ?? 8;
  const fail = (c: Context, code: ErrorCode, message: string) =>
    c.json({ error: { code, message } }, ERROR_STATUS[code] as ContentfulStatusCode);

  app.get('/health', (c) =>
    c.json(EngineHealth.parse({ ok: deps.katago.alive, models: deps.models, queue: deps.katago.queueLength, restarts: deps.katago.restarts })),
  );

  app.use('/v1/*', async (c, next) => {
    if (c.req.header('x-engine-key') !== deps.engineKey) return fail(c, 'unauthorized', 'нет или неверный X-Engine-Key');
    if (!deps.katago.alive) return fail(c, 'engine_unavailable', 'процесс KataGo не запущен');
    if (deps.katago.queueLength >= maxQueue) return fail(c, 'engine_busy', `очередь заполнена (${deps.katago.queueLength})`);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof KataGoError) return fail(c, err.kind === 'timeout' ? 'engine_busy' : 'engine_unavailable', err.message);
    if (err instanceof ZodError) return fail(c, 'bad_request', err.message);
    deps.log?.(`[X] engine: ${err.stack ?? err.message}`);
    return fail(c, 'internal', err.message);
  });

  app.post('/v1/genmove', async (c) => {
    const req = EngineGenmoveRequest.parse(await c.req.json());
    const t0 = performance.now();
    const r = await deps.katago.query(
      { ...baseQuery(req), maxVisits: req.maxVisits, includePolicy: true, overrideSettings: { humanSLProfile: rankToProfile(req.rank) } },
      timeouts.genmove,
    );
    const root = rootOf(r);
    const infos = moveInfosOf(r);
    const bestMove = infos.find((m) => m.order === 0)?.move ?? infos[0]?.move ?? 'pass';
    const humanPolicy = numbersOf(r.humanPolicy);
    if (humanPolicy.length === 0) deps.log?.('[!] humanPolicy отсутствует: проверить -human-model');
    const chosen = chooseMove({ humanPolicy, size: req.boardSize, bestMove, random: deps.random });
    return c.json(
      EngineGenmoveResponse.parse({
        move: chosen.move,
        winrateB: root.winrate,
        scoreLeadB: root.scoreLead,
        humanPolicyTop: chosen.top,
        ms: Math.round(performance.now() - t0),
      }),
    );
  });

  app.post('/v1/analyze', async (c) => {
    const req = EngineAnalyzeRequest.parse(await c.req.json());
    const r = await deps.katago.query({ ...baseQuery(req), maxVisits: req.maxVisits, includeOwnership: req.includeOwnership }, timeouts.analyze);
    const root = rootOf(r);
    const moveInfos = moveInfosOf(r)
      .sort((a, b) => a.order - b.order)
      .slice(0, 5)
      .map((m) => ({ coord: m.move, winrateB: m.winrate, scoreLeadB: m.scoreLead, visits: m.visits, order: m.order }));
    const ownership = Array.isArray(r.ownership) ? reorderFromKata(numbersOf(r.ownership), req.boardSize) : undefined;
    return c.json(EngineAnalyzeResponse.parse({ visits: root.visits, winrateB: root.winrate, scoreLeadB: root.scoreLead, moveInfos, ownership }));
  });

  app.post('/v1/score', async (c) => {
    const req = EngineScoreRequest.parse(await c.req.json());
    const r = await deps.katago.query({ ...baseQuery(req), maxVisits: SCORE_VISITS, includeOwnership: true }, timeouts.score);
    const root = rootOf(r);
    const ownership = reorderFromKata(numbersOf(r.ownership), req.boardSize);
    const pos = replay(req.boardSize, req.moves.map(([color, coord]) => ({ color, coord })));
    const dead = deadStones(pos, ownership);
    const area = areaScore(pos, dead, req.komi);
    const { winner, margin } = resultFromArea(area);
    return c.json(EngineScoreResponse.parse({ ownership, dead, areaB: area.areaB, areaW: area.areaW, scoreLeadB: root.scoreLead, winner, margin }));
  });

  return app;
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `npx vitest run apps/go-engine/src/app.test.ts`
Expected: PASS.

- [ ] **Step 5: `apps/go-engine/src/main.ts`**

```ts
// Запуск обёртки: KataGo из KATAGO_BIN, сети и конфиг из env или из apps/go-engine/{models,config}.
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createEngineApp } from './app.ts';
import { KataGo } from './katago.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const env = process.env;
const log = (line: string) => console.error(line);

const bin = env.KATAGO_BIN;
const engineKey = env.ENGINE_KEY;
if (!bin || !engineKey) {
  console.error('[X] go-engine: нужны KATAGO_BIN и ENGINE_KEY (см. infra/.env.example)');
  process.exit(2);
}
const model = env.KATAGO_MODEL ?? path.join(root, 'apps/go-engine/models/kata1-b10c128-s1141046784-d204142634.bin.gz');
const humanModel = env.KATAGO_HUMAN_MODEL ?? path.join(root, 'apps/go-engine/models/b18c384nbt-humanv0.bin.gz');
const config = env.KATAGO_CONFIG ?? path.join(root, 'apps/go-engine/config/analysis.cfg');
const port = Number(env.ENGINE_PORT ?? 8788);
const hostname = env.ENGINE_HOST ?? '127.0.0.1';

const katago = new KataGo({ bin, model, humanModel, config, log });
katago.start();
const app = createEngineApp({ katago, engineKey, models: { main: path.basename(model), human: path.basename(humanModel) }, log });
const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[OK] go-engine на http://${info.address}:${info.port}; сети ${path.basename(model)} + ${path.basename(humanModel)}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void katago.stop().finally(() => process.exit(0));
  });
}
```

- [ ] **Step 6: Контрактный тест `apps/go-engine/src/katago.contract.test.ts`** (выполняется только при `KATAGO_BIN`; на ПК founder'а — OpenCL-сборка, сети по `apps/go-engine/models/README.md`)

```ts
// Настоящий KataGo: сторона winrate, порядок ownership, легальность ходов, счёт известной позиции.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLUMN_LETTERS, coordToIndex, parseCoord, play, replay } from '@goko/go-core';
import { createEngineApp } from './app.ts';
import { KataGo } from './katago.ts';

const BIN = process.env.KATAGO_BIN;
const root = path.resolve(import.meta.dirname, '../../..');
const MODEL = process.env.KATAGO_MODEL ?? path.join(root, 'apps/go-engine/models/kata1-b10c128-s1141046784-d204142634.bin.gz');
const HUMAN = process.env.KATAGO_HUMAN_MODEL ?? path.join(root, 'apps/go-engine/models/b18c384nbt-humanv0.bin.gz');
const CONFIG = process.env.KATAGO_CONFIG ?? path.join(root, 'apps/go-engine/config/analysis.cfg');
const KEY = 'contract';
const headers = { 'content-type': 'application/json', 'x-engine-key': KEY };
const base = { boardSize: 13, rules: 'chinese', komi: 7.5 };

function walls(blackRow: number, whiteRow: number): [string, string][] {
  const moves: [string, string][] = [];
  for (let c = 0; c < 13; c++) {
    moves.push(['B', `${COLUMN_LETTERS.charAt(c)}${blackRow}`]);
    moves.push(['W', `${COLUMN_LETTERS.charAt(c)}${whiteRow}`]);
  }
  return moves;
}

describe.skipIf(!BIN)('KataGo contract', () => {
  const katago = new KataGo({ bin: BIN ?? '', model: MODEL, humanModel: HUMAN, config: CONFIG, log: (l) => console.error(l) });
  const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'main', human: 'human' } });
  const post = async (route: string, body: unknown) => {
    const res = await app.request(route, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    katago.start();
    await katago.query({ ...base, boardXSize: 13, boardYSize: 13, moves: [], maxVisits: 1 }, 300_000); // прогрев, OpenCL тюнит ядра
  }, 320_000);

  afterAll(async () => {
    await katago.stop();
  });

  it('genmove на пустой доске: не пас, легально, humanPolicy есть', async () => {
    const r = await post('/v1/genmove', { ...base, moves: [], rank: '10k' });
    expect(r.move).not.toBe('pass');
    expect(parseCoord(r.move, 13)).not.toBe('pass');
    expect(r.humanPolicyTop.length).toBeGreaterThan(0);
  }, 60_000);

  it('genmove в середине партии легален по go-core', async () => {
    const moves: [string, string][] = [['B', 'D4'], ['W', 'K10'], ['B', 'K4'], ['W', 'D10'], ['B', 'G7']];
    const r = await post('/v1/genmove', { ...base, moves, rank: '5k' });
    const pos = replay(13, moves.map(([color, coord]) => ({ color: color as 'B' | 'W', coord })));
    expect(() => play(pos, 'W', r.move)).not.toThrow();
  }, 60_000);

  it('score известной позиции: стены 7/8 -> B+5.5', async () => {
    const r = await post('/v1/score', { ...base, moves: walls(7, 8) });
    expect(r).toMatchObject({ areaB: 91, areaW: 78, winner: 'B', margin: 5.5, dead: [] });
  }, 120_000);

  it('winrate с точки зрения чёрных независимо от стороны на ходу', async () => {
    const strong = walls(8, 9); // чёрные 104 против 65: явный перевес чёрных
    const blackToPlay = await post('/v1/analyze', { ...base, moves: strong, maxVisits: 20 });
    const whiteToPlay = await post('/v1/analyze', { ...base, moves: [...strong, ['B', 'pass']], maxVisits: 20 });
    expect(blackToPlay.winrateB).toBeGreaterThan(0.5);
    expect(whiteToPlay.winrateB).toBeGreaterThan(0.5);
    expect(blackToPlay.scoreLeadB).toBeGreaterThan(0);
    expect(whiteToPlay.scoreLeadB).toBeGreaterThan(0);
  }, 120_000);

  it('ownership лежит в правильных клетках: низ чёрный, верх белый', async () => {
    const r = await post('/v1/analyze', { ...base, moves: walls(8, 9), maxVisits: 20 });
    expect(r.ownership[coordToIndex('A1', 13)]).toBeGreaterThan(0.5);
    expect(r.ownership[coordToIndex('N4', 13)]).toBeGreaterThan(0.5);
    expect(r.ownership[coordToIndex('A13', 13)]).toBeLessThan(-0.5);
    expect(r.ownership[coordToIndex('G12', 13)]).toBeLessThan(-0.5);
  }, 120_000);
});
```

- [ ] **Step 7: `infra/.env.example` — добавить переменные движка и game-server** (после строки `KATAGO_BIN=`)

```
KATAGO_MODEL=                      # путь к основной сети; по умолчанию apps/go-engine/models/kata1-b10c128-...bin.gz
KATAGO_HUMAN_MODEL=                # путь к человеческой сети; по умолчанию apps/go-engine/models/b18c384nbt-humanv0.bin.gz
KATAGO_CONFIG=                     # по умолчанию apps/go-engine/config/analysis.cfg
ENGINE_PORT=8788                   # go-engine слушает ENGINE_HOST:ENGINE_PORT
ENGINE_HOST=127.0.0.1              # в контейнере 0.0.0.0
ENGINE_URL=http://127.0.0.1:8788   # куда game-server ходит за ходами; в контейнере http://go-engine:8788
FAKE_ENGINE=                       # 1 — game-server без KataGo (легальные случайные ходы), для тестов и smoke
PORT=8787                          # game-server
HOST=127.0.0.1                     # в контейнере 0.0.0.0; в dev-режиме через Tailscale — адрес tailscale-интерфейса ПК
DATA_DIR=                          # снапшоты партий; по умолчанию data/games
MAX_SESSIONS=3                     # лимит активных сессий
SESSION_TTL_MS=7200000             # 2 часа без событий — сессия закрывается
```

- [ ] **Step 8: Запуск и контракт** (если на ПК есть `KATAGO_BIN` и сети; иначе шаг пропускается и контракт-тест `skipped`)

Run: `npm run doctor` — `[OK] KATAGO_BIN найден`.
Run: `npx vitest run apps/go-engine/src/katago.contract.test.ts`
Expected: 5 passed (первый запуск может идти минуты из-за тюнинга OpenCL). Расхождение в `score` или `ownership` означает перепутанную сторону или порядок строк — чинить в `mapping.ts`/`analysis.cfg`, не в тесте.

Run: `node --env-file-if-exists=.env apps/go-engine/src/main.ts` в одном терминале и `curl -s http://127.0.0.1:8788/health` в другом.
Expected: `{"ok":true,"models":{...},"queue":0,"restarts":0}`.

- [ ] **Step 9: Commit**

```bash
git add apps/go-engine infra/.env.example
git commit -m "go-engine: HTTP-обёртка genmove/analyze/score, запуск, контрактный тест с KataGo"
```

---
### Task 9: `game-server` — чистые переходы партии, снапшоты, шина событий

**Files:**
- Create: `apps/game-server/package.json`, `apps/game-server/src/ids.ts`, `apps/game-server/src/game.ts`, `apps/game-server/src/store.ts`, `apps/game-server/src/events.ts`
- Test: `apps/game-server/src/game.test.ts`, `apps/game-server/src/store.test.ts`, `apps/game-server/src/events.test.ts`

**Interfaces:**
- Consumes: `replay`, `play`, `IllegalMoveError`, `InvalidCoordError`, `parseCoord`, `formatCoord`, `indexToCoord`, `opposite`, `type Position` из `@goko/go-core`; `GameState`, `GameSettings`, `Move`, `Seat`, `Color`, `Rank`, `Result`, `ApiError`, `type GameEvent` из `@goko/protocol`.
- Produces: `newId(): string`; `type NewGameParams = { id: string; createdAt: string; settings: GameSettings; seats: { B: Seat; W: Seat } }`; `newGame(input: NewGameParams): GameState`; `positionOf(state): Position`; `applyMove(state, color, coord, at: string): { state: GameState; move: Move }`; `illegalMessage(reason): string`; `resign(state, color): GameState`; `finishByScore(state, result: Result): GameState`; `setRank(state, color, rank): GameState`; `undo(state): { state: GameState; removed: Move[] }`; `rebuild(state, moves: Move[]): GameState`; `class GameStore { constructor(dir: string); init(): Promise<void>; load(): Promise<GameState[]>; save(state): Promise<void> }`; `class EventBus { subscribe(channel: string, listener: (e: GameEvent) => void): () => void; emit(channel, e): void; count(channel): number }`; каналы `game:<id>` и `session:<id>`.

- [ ] **Step 1: `apps/game-server/package.json`**

```json
{
  "name": "@goko/game-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --env-file-if-exists=../../.env src/main.ts"
  },
  "dependencies": {
    "@goko/go-core": "*",
    "@goko/protocol": "*",
    "@hono/node-server": "^2.1.1",
    "@livekit/protocol": "^1.51.0",
    "hono": "^4.13.7",
    "livekit-server-sdk": "^2.18.0",
    "zod": "^4.5.4"
  }
}
```

Run: `npm install`
Expected: `package-lock.json` обновлён, `node_modules/@goko/game-server` — симлинк.

- [ ] **Step 2: Тест `apps/game-server/src/game.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { ApiError, GameState } from '@goko/protocol';
import { applyMove, finishByScore, newGame, positionOf, rebuild, resign, setRank, undo } from './game.ts';

const T = '2026-09-07T10:00:00.000Z';

// Ошибка синхронного вызова как значение: проверяем code и details через toMatchObject.
function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('ожидалась ошибка');
}

function fresh(overrides: Partial<Parameters<typeof newGame>[0]> = {}): GameState {
  return newGame({
    id: 'g1',
    createdAt: T,
    settings: { boardSize: 9, rules: 'chinese', komi: 7.5 },
    seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } },
    ...overrides,
  });
}

// Последовательность ходов через applyMove; цвет берётся из toPlay.
function playAll(state: GameState, coords: string[]): GameState {
  let s = state;
  for (const c of coords) s = applyMove(s, s.toPlay, c, T).state;
  return s;
}

describe('newGame', () => {
  it('пустая доска, ход чёрных, движок на ходу только если чёрные — engine', () => {
    const s = fresh();
    expect(s.board).toBe('.'.repeat(81));
    expect(s).toMatchObject({ revision: 0, status: 'playing', toPlay: 'B', moves: [], ko: null, consecutivePasses: 0, pendingEngineMove: false, captures: { B: 0, W: 0 } });
    const e = fresh({ seats: { B: { controller: 'engine', rank: '5k' }, W: { controller: 'human' } } });
    expect(e.pendingEngineMove).toBe(true);
  });
});

describe('applyMove', () => {
  it('ставит камень, нумерует ход, меняет очередь, поднимает revision, нормализует координату', () => {
    const { state, move } = applyMove(fresh(), 'B', 'д 4', T);
    expect(move).toEqual({ n: 1, color: 'B', coord: 'D4', captured: 0, at: T });
    expect(state.board.charAt(3 * 9 + 3)).toBe('B');
    expect(state).toMatchObject({ toPlay: 'W', revision: 1, pendingEngineMove: true, consecutivePasses: 0 });
    expect(state.moves).toHaveLength(1);
  });

  it('pass считает подряд идущие пасы и не трогает доску', () => {
    const s1 = applyMove(fresh(), 'B', 'pass', T).state;
    expect(s1.consecutivePasses).toBe(1);
    const s2 = applyMove(s1, 'W', 'pass', T).state;
    expect(s2.consecutivePasses).toBe(2);
    expect(s2.board).toBe('.'.repeat(81));
    // Партия не завершается здесь: это делает сервис после счёта.
    expect(s2.status).toBe('playing');
  });

  it('ошибки: не твой ход, партия окончена, плохая координата, занято', () => {
    const s = fresh();
    expect(errorOf(() => applyMove(s, 'W', 'D4', T))).toMatchObject({ code: 'not_your_turn', status: 409 });
    expect(errorOf(() => applyMove(s, 'B', 'I4', T))).toMatchObject({ code: 'invalid_coord', status: 400 });
    const s1 = applyMove(s, 'B', 'D4', T).state;
    expect(errorOf(() => applyMove(s1, 'W', 'D4', T))).toMatchObject({ code: 'illegal_move', details: { reason: 'occupied', coord: 'D4' } });
    const done = resign(s1, 'W');
    expect(errorOf(() => applyMove(done, 'B', 'E5', T))).toMatchObject({ code: 'game_finished', status: 409 });
  });

  it('захват записывается в ход и в captures, ко попадает в состояние строкой', () => {
    // 9×9: чёрные D5 E6 F5 вокруг E5, белые D4 E3 F4 вокруг E4; W E4 -> B E5 снимает E4 и создаёт ко.
    const s = playAll(fresh(), ['D5', 'D4', 'E6', 'E3', 'F5', 'F4', 'A1', 'E4', 'E5']);
    // Последний ход чёрных E5 снял белый E4: одиночный камень с одним дыханием.
    const last = s.moves.at(-1)!;
    expect(last).toMatchObject({ coord: 'E5', captured: 1 });
    expect(s.captures).toEqual({ B: 1, W: 0 });
    expect(s.ko).toBe('E4');
    expect(positionOf(s).ko).toBe(3 * 9 + 4);
    expect(errorOf(() => applyMove(s, 'W', 'E4', T))).toMatchObject({ code: 'illegal_move', details: { reason: 'ko', coord: 'E4' } });
  });
});

describe('resign / finishByScore / setRank', () => {
  it('resign завершает партию победой соперника', () => {
    const s = resign(fresh(), 'B');
    expect(s).toMatchObject({ status: 'finished', result: { winner: 'W', reason: 'resign' }, pendingEngineMove: false });
    expect(s.revision).toBe(1);
  });

  it('finishByScore кладёт результат и снимает pendingEngineMove', () => {
    const two = playAll(fresh(), ['pass', 'pass']);
    const s = finishByScore(two, { winner: 'W', margin: 7.5, reason: 'score' });
    expect(s.status).toBe('finished');
    expect(s.result?.margin).toBe(7.5);
    expect(s.pendingEngineMove).toBe(false);
  });

  it('setRank меняет ранг места и revision', () => {
    const s = setRank(fresh(), 'W', '3k');
    expect(s.seats.W.rank).toBe('3k');
    expect(s.revision).toBe(1);
  });
});

describe('undo', () => {
  it('человек против движка: снимает два хода, очередь снова у человека', () => {
    const s = playAll(fresh(), ['D4', 'E5', 'F6', 'G7']); // B, W, B, W; движок ответил, ход чёрных
    expect(s.pendingEngineMove).toBe(false);
    const { state, removed } = undo(s);
    expect(removed.map((m) => m.coord)).toEqual(['G7', 'F6']);
    expect(state.moves).toHaveLength(2);
    expect(state.toPlay).toBe('B');
    expect(state.pendingEngineMove).toBe(false);
    expect(state.board.charAt(5 * 9 + 5)).toBe('.');
    expect(state.revision).toBe(s.revision + 1);
  });

  it('движок ходил первым и один ход в партии: снимается его ход, очередь снова у движка', () => {
    const s = applyMove(fresh({ seats: { B: { controller: 'engine', rank: '10k' }, W: { controller: 'human' } } }), 'B', 'C3', T).state;
    const { state, removed } = undo(s);
    expect(removed.map((m) => m.coord)).toEqual(['C3']);
    expect(state).toMatchObject({ toPlay: 'B', pendingEngineMove: true, moves: [] });
  });

  it('движок ещё думает: снимает один ход человека', () => {
    const s = playAll(fresh(), ['D4', 'E5', 'F6']); // после F6 pendingEngineMove = true
    expect(s.pendingEngineMove).toBe(true);
    const { state, removed } = undo(s);
    expect(removed.map((m) => m.coord)).toEqual(['F6']);
    expect(state.toPlay).toBe('B');
    expect(state.pendingEngineMove).toBe(false);
  });

  it('один ход человека, движок думает: снимает его', () => {
    const s = applyMove(fresh(), 'B', 'D4', T).state;
    expect(s.pendingEngineMove).toBe(true);
    const { state, removed } = undo(s);
    expect(removed).toHaveLength(1);
    expect(state.moves).toEqual([]);
    expect(state).toMatchObject({ toPlay: 'B', pendingEngineMove: false });
  });

  it('нет ходов — nothing_to_undo; после сдачи — game_finished', () => {
    expect(errorOf(() => undo(fresh()))).toMatchObject({ code: 'nothing_to_undo', status: 409 });
    expect(errorOf(() => undo(resign(fresh(), 'B')))).toMatchObject({ code: 'game_finished', status: 409 });
  });

  it('finished по счёту: снимает оба паса и возвращает playing', () => {
    const two = playAll(fresh(), ['D4', 'pass', 'pass']);
    const done = finishByScore(two, { winner: 'B', margin: 88.5, reason: 'score' });
    const { state, removed } = undo(done);
    expect(removed.map((m) => m.coord)).toEqual(['pass', 'pass']);
    expect(state).toMatchObject({ status: 'playing', consecutivePasses: 0, toPlay: 'W', pendingEngineMove: true });
    expect(state.result).toBeUndefined();
    expect(state.moves).toHaveLength(1);
  });
});

describe('rebuild', () => {
  it('переигрывает список ходов и восстанавливает захваты, очередь и пасы', () => {
    const s = playAll(fresh(), ['D5', 'D4', 'E6', 'E3', 'F5', 'F4', 'A1', 'E4', 'E5', 'pass']);
    const r = rebuild(fresh(), s.moves);
    expect(r.board).toBe(s.board);
    expect(r.captures).toEqual({ B: 1, W: 0 });
    expect(r.toPlay).toBe('B');
    expect(r.consecutivePasses).toBe(1);
    expect(r.ko).toBeNull(); // pass снимает ко
  });
});
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `npx vitest run apps/game-server/src/game.test.ts`
Expected: FAIL — нет `./game.ts`.

- [ ] **Step 4: `apps/game-server/src/ids.ts` и `apps/game-server/src/game.ts`**

`apps/game-server/src/ids.ts`:

```ts
import { randomBytes } from 'node:crypto';

// Короткий идентификатор, сортируемый по времени: base36 времени + 6 hex случайных.
export function newId(): string {
  return Date.now().toString(36) + randomBytes(3).toString('hex');
}
```

`apps/game-server/src/game.ts`:

```ts
// Чистые переходы состояния партии (раздел 4 спеки). Позиция — функция от moves (go-core.replay).
import {
  type IllegalReason,
  IllegalMoveError,
  InvalidCoordError,
  type Position,
  formatCoord,
  indexToCoord,
  opposite,
  parseCoord,
  play,
  replay,
} from '@goko/go-core';
import { ApiError, type Color, type GameSettings, type GameState, type Move, type Rank, type Result, type Seat } from '@goko/protocol';

export type NewGameParams = { id: string; createdAt: string; settings: GameSettings; seats: { B: Seat; W: Seat } };

function pending(state: Pick<GameState, 'status' | 'consecutivePasses' | 'seats' | 'toPlay'>): boolean {
  return state.status === 'playing' && state.consecutivePasses < 2 && state.seats[state.toPlay].controller === 'engine';
}

export function newGame(input: NewGameParams): GameState {
  const base = {
    id: input.id,
    createdAt: input.createdAt,
    revision: 0,
    settings: input.settings,
    seats: input.seats,
    status: 'playing' as const,
    toPlay: 'B' as const,
    moves: [],
    board: '.'.repeat(input.settings.boardSize * input.settings.boardSize),
    captures: { B: 0, W: 0 },
    ko: null,
    consecutivePasses: 0,
  };
  return { ...base, pendingEngineMove: pending(base) };
}

export function positionOf(state: GameState): Position {
  return replay(state.settings.boardSize, state.moves);
}

export function illegalMessage(reason: IllegalReason): string {
  switch (reason) {
    case 'occupied':
      return 'точка занята';
    case 'ko':
      return 'ко: сразу забрать нельзя';
    case 'suicide':
      return 'самоубийство: у камня не будет дыханий';
  }
}

function normalizeCoord(coord: string, size: number): string {
  try {
    const p = parseCoord(coord, size);
    return p === 'pass' ? 'pass' : formatCoord(p);
  } catch (e) {
    if (e instanceof InvalidCoordError) throw new ApiError('invalid_coord', `не понял координату «${coord}»`, { coord });
    throw e;
  }
}

export function applyMove(state: GameState, color: Color, coord: string, at: string): { state: GameState; move: Move } {
  if (state.status !== 'playing') throw new ApiError('game_finished', 'партия окончена');
  if (state.toPlay !== color) throw new ApiError('not_your_turn', `сейчас ходят ${color === 'B' ? 'белые' : 'чёрные'}`, { toPlay: state.toPlay });
  const size = state.settings.boardSize;
  const normalized = normalizeCoord(coord, size);
  let played: ReturnType<typeof play>;
  try {
    played = play(positionOf(state), color, normalized);
  } catch (e) {
    if (e instanceof IllegalMoveError) throw new ApiError('illegal_move', illegalMessage(e.reason), { reason: e.reason, coord: e.coord });
    throw e;
  }
  const move: Move = { n: state.moves.length + 1, color, coord: normalized, captured: played.captured, at };
  const next: GameState = {
    ...state,
    revision: state.revision + 1,
    toPlay: opposite(color),
    moves: [...state.moves, move],
    board: played.position.board,
    captures: played.position.captures,
    ko: played.position.ko === null ? null : indexToCoord(played.position.ko, size),
    consecutivePasses: normalized === 'pass' ? state.consecutivePasses + 1 : 0,
    pendingEngineMove: false,
  };
  next.pendingEngineMove = pending(next);
  return { state: next, move };
}

export function resign(state: GameState, color: Color): GameState {
  if (state.status !== 'playing') throw new ApiError('game_finished', 'партия окончена');
  return { ...state, revision: state.revision + 1, status: 'finished', pendingEngineMove: false, result: { winner: opposite(color), reason: 'resign' } };
}

export function finishByScore(state: GameState, result: Result): GameState {
  return { ...state, revision: state.revision + 1, status: 'finished', pendingEngineMove: false, result };
}

export function setRank(state: GameState, color: Color, rank: Rank): GameState {
  return { ...state, revision: state.revision + 1, seats: { ...state.seats, [color]: { ...state.seats[color], rank } } };
}

// Переигрывает список ходов; статус всегда playing (вызывающий решает, что делать с result).
export function rebuild(state: GameState, moves: Move[]): GameState {
  const size = state.settings.boardSize;
  const pos = replay(size, moves);
  const last = moves.at(-1);
  let passes = 0;
  for (let i = moves.length - 1; i >= 0 && moves[i]?.coord === 'pass'; i--) passes++;
  const rest: GameState = { ...state };
  delete rest.result;
  const next: GameState = {
    ...rest,
    revision: state.revision + 1,
    status: 'playing',
    toPlay: last ? opposite(last.color) : 'B',
    moves,
    board: pos.board,
    captures: pos.captures,
    ko: pos.ko === null ? null : indexToCoord(pos.ko, size),
    consecutivePasses: passes,
    pendingEngineMove: false,
  };
  next.pendingEngineMove = pending(next);
  return next;
}

// Откат до предыдущего хода того же места (раздел 5 спеки):
// finished по счёту — два паса; движок думает — один ход человека; иначе два хода (или один, если он единственный).
export function undo(state: GameState): { state: GameState; removed: Move[] } {
  if (state.status === 'finished' && state.result?.reason === 'resign') throw new ApiError('game_finished', 'после сдачи откат невозможен');
  if (state.moves.length === 0) throw new ApiError('nothing_to_undo', 'ходов ещё не было');
  const count = state.status === 'finished' ? 2 : state.pendingEngineMove ? 1 : Math.min(2, state.moves.length);
  const kept = state.moves.slice(0, state.moves.length - count);
  const removed = state.moves.slice(state.moves.length - count).reverse();
  return { state: rebuild(state, kept), removed };
}
```

`[!]` `pendingEngineMove` после `undo` считается заново из очереди хода (`rebuild`): в обычных случаях очередь возвращается человеку и флаг `false`; если после отката на ходу движок (снят его первый ход, или сняты два паса и очередь его), флаг `true`, и сервис (Task 10, `kick`) ставит ход движка заново. Ответ движка, который думал над откаченной ревизией, сервис отбрасывает по несовпадению `revision`.

- [ ] **Step 5: Тест зелёный**

Run: `npx vitest run apps/game-server/src/game.test.ts`
Expected: PASS.

- [ ] **Step 6: Тесты `store.test.ts` и `events.test.ts`**

`apps/game-server/src/store.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newGame } from './game.ts';
import { GameStore } from './store.ts';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goko-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const T = '2026-09-07T10:00:00.000Z';
const state = () =>
  newGame({ id: 'g1', createdAt: T, settings: { boardSize: 13, rules: 'chinese', komi: 7.5 }, seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } } });

describe('GameStore', () => {
  it('save пишет JSON в <dir>/<id>.json, load возвращает партии', async () => {
    const store = new GameStore(path.join(dir, 'games'));
    await store.init();
    await store.save(state());
    expect(JSON.parse(await readFile(path.join(dir, 'games', 'g1.json'), 'utf8')).id).toBe('g1');
    const loaded = await new GameStore(path.join(dir, 'games')).load();
    expect(loaded.map((g) => g.id)).toEqual(['g1']);
  });

  it('битый файл пропускается, остальные загружаются', async () => {
    const store = new GameStore(dir);
    await store.init();
    await store.save(state());
    await writeFile(path.join(dir, 'broken.json'), '{not json', 'utf8');
    await writeFile(path.join(dir, 'wrong.json'), JSON.stringify({ id: 'x' }), 'utf8');
    const loaded = await store.load();
    expect(loaded.map((g) => g.id)).toEqual(['g1']);
  });

  it('повторный save перезаписывает атомарно (нет .tmp после записи)', async () => {
    const store = new GameStore(dir);
    await store.init();
    const s = state();
    await store.save(s);
    await store.save({ ...s, revision: 5 });
    const loaded = await store.load();
    expect(loaded[0]?.revision).toBe(5);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
```

`apps/game-server/src/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@goko/protocol';
import { EventBus } from './events.ts';

describe('EventBus', () => {
  it('доставляет по каналу, отписка работает, count считает слушателей', () => {
    const bus = new EventBus();
    const got: GameEvent[] = [];
    const off = bus.subscribe('game:g1', (e) => got.push(e));
    bus.subscribe('game:g2', () => {
      throw new Error('не тот канал');
    });
    bus.emit('game:g1', { type: 'engine.thinking', color: 'W' });
    expect(got).toEqual([{ type: 'engine.thinking', color: 'W' }]);
    expect(bus.count('game:g1')).toBe(1);
    off();
    bus.emit('game:g1', { type: 'engine.thinking', color: 'B' });
    expect(got).toHaveLength(1);
    expect(bus.count('game:g1')).toBe(0);
  });

  it('исключение слушателя не ломает остальных', () => {
    const bus = new EventBus();
    let delivered = 0;
    bus.subscribe('game:g1', () => {
      throw new Error('boom');
    });
    bus.subscribe('game:g1', () => delivered++);
    bus.emit('game:g1', { type: 'session.game', gameId: 'g1' });
    expect(delivered).toBe(1);
  });
});
```

- [ ] **Step 7: Убедиться, что тесты падают**

Run: `npx vitest run apps/game-server/src/store.test.ts apps/game-server/src/events.test.ts`
Expected: FAIL — нет модулей.

- [ ] **Step 8: `apps/game-server/src/store.ts` и `apps/game-server/src/events.ts`**

`apps/game-server/src/store.ts`:

```ts
// Снапшоты партий: data/games/<id>.json, запись через временный файл и rename.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GameState } from '@goko/protocol';

export class GameStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async load(): Promise<GameState[]> {
    await this.init();
    const out: GameState[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      try {
        const parsed = GameState.safeParse(JSON.parse(await readFile(file, 'utf8')));
        if (parsed.success) out.push(parsed.data);
        else console.error(`[!] store: ${name} не по схеме, пропущен`);
      } catch {
        console.error(`[!] store: ${name} не читается, пропущен`);
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async save(state: GameState): Promise<void> {
    const file = path.join(this.dir, `${state.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, file);
  }
}
```

`apps/game-server/src/events.ts`:

```ts
// Шина событий в памяти: каналы game:<id> и session:<id>; SSE-обработчики подписываются здесь.
import type { GameEvent } from '@goko/protocol';

export type Listener = (event: GameEvent) => void;

export class EventBus {
  private readonly channels = new Map<string, Set<Listener>>();

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.channels.delete(channel);
    };
  }

  emit(channel: string, event: GameEvent): void {
    for (const listener of [...(this.channels.get(channel) ?? [])]) {
      try {
        listener(event);
      } catch (e) {
        console.error(`[!] events: слушатель ${channel} упал: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  count(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}
```

- [ ] **Step 9: Тесты зелёные**

Run: `npx vitest run apps/game-server && npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/game-server package-lock.json
git commit -m "game-server: чистые переходы партии, снапшоты в JSON, шина событий"
```

---

### Task 10: `game-server` — клиент движка, фейковый движок, `GameService`

**Files:**
- Create: `apps/game-server/src/engine-client.ts`, `apps/game-server/src/fake-engine.ts`, `apps/game-server/src/service.ts`
- Test: `apps/game-server/src/engine-client.test.ts`, `apps/game-server/src/fake-engine.test.ts`, `apps/game-server/src/service.test.ts`

**Interfaces:**
- Consumes: Task 9 целиком; `Engine*` схемы из `@goko/protocol`; `groupsWithOwnership`, `deadStones`, `areaScore`, `resultFromArea`, `toAscii`, `toSgf`, `replay`, `play`, `indexToCoord` из `@goko/go-core`.
- Produces: `interface Engine { genmove(req: EngineGenmoveRequest): Promise<EngineGenmoveResponse>; analyze(req: EngineAnalyzeRequest): Promise<EngineAnalyzeResponse>; score(req: EngineScoreRequest): Promise<EngineScoreResponse> }`; `createEngineClient({ baseUrl, engineKey, fetch?, timeouts? = { genmove: 10000, analyze: 15000, score: 30000 }, retryDelayMs? = 200 }): Engine`; `createFakeEngine({ script?: string[]; delayMs?: number; random?: () => number; passAfterPass?: boolean = true }): Engine & { calls: { genmove: number; analyze: number; score: number } }`; `class GameService` с методами `init()`, `close()`, `list(): GameSummary[]`, `get(id): GameState`, `create(req: NewGameInput, opts?: { sessionId?: string }): Promise<NewGameResponse>`, `play(id, req: PlayInput, by?: By): Promise<PlayResponse>`, `pass(id, req: PassInput): Promise<PlayResponse>`, `resign(id, req: ResignInput): Promise<StateResponse>`, `undo(id, req: UndoInput): Promise<UndoResponse>`, `correct(id, req: CorrectInput): Promise<PlayResponse>`, `setRank(id, req: SetRankInput): Promise<StateResponse>`, `analyze(id, req: AnalyzeInput): Promise<Analysis>`, `score(id): Promise<Result>`, `ascii(id): string`, `sgf(id): string`; типы `*Input` — `z.output` соответствующих схем `ops.ts`; константы `REPLY_TIMEOUT_MS = 8000`, `ENGINE_RESIGN_AFTER_MOVE = 60`, `ENGINE_RESIGN_WINRATE = 0.03`, `ENGINE_RESIGN_LEAD = -25`, `GENMOVE_VISITS = 10`.

- [ ] **Step 1: Тест `apps/game-server/src/engine-client.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createEngineClient } from './engine-client.ts';

type Call = { url: string; init: RequestInit };

function fakeFetch(handlers: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)]!;
    return h(call);
  };
  return { calls, fetch: fetchFn as unknown as typeof fetch };
}

const req = { boardSize: 13, rules: 'chinese' as const, komi: 7.5, moves: [], rank: '10k' as const };
const ok = { move: 'D4', winrateB: 0.5, scoreLeadB: 0, humanPolicyTop: [], ms: 12 };

describe('createEngineClient', () => {
  it('шлёт X-Engine-Key на /v1/genmove и разбирает ответ', async () => {
    const f = fakeFetch([() => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test/', engineKey: 'ek', fetch: f.fetch });
    const res = await engine.genmove(req);
    expect(res.move).toBe('D4');
    expect(f.calls[0]?.url).toBe('http://engine.test/v1/genmove');
    expect((f.calls[0]?.init.headers as Record<string, string>)['x-engine-key']).toBe('ek');
  });

  it('один повтор при сетевой ошибке и при 503, затем успех', async () => {
    const f = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      () => Response.json(ok),
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    expect((await engine.genmove(req)).move).toBe('D4');
    expect(f.calls).toHaveLength(2);

    const g = fakeFetch([() => Response.json({ error: { code: 'engine_busy', message: 'очередь' } }, { status: 503 }), () => Response.json(ok)]);
    const engine2 = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: g.fetch, retryDelayMs: 1 });
    expect((await engine2.genmove(req)).move).toBe('D4');
    expect(g.calls).toHaveLength(2);
  });

  it('две неудачи подряд -> ApiError engine_unavailable (сеть) или код движка (503)', async () => {
    const f = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    await expect(engine.genmove(req)).rejects.toMatchObject({ name: 'ApiError', code: 'engine_unavailable' });
    expect(f.calls).toHaveLength(2);

    const g = fakeFetch([() => Response.json({ error: { code: 'engine_busy', message: 'очередь' } }, { status: 503 })]);
    const engine2 = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: g.fetch, retryDelayMs: 1 });
    await expect(engine2.analyze({ ...req })).rejects.toMatchObject({ code: 'engine_busy' });
  });

  it('4xx не повторяется и отдаётся как ApiError', async () => {
    const f = fakeFetch([() => Response.json({ error: { code: 'bad_request', message: 'схема' } }, { status: 400 })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    await expect(engine.score({ boardSize: 13, rules: 'chinese', komi: 7.5, moves: [] })).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.calls).toHaveLength(1);
  });

  it('таймаут -> engine_busy после повтора', async () => {
    const f = fakeFetch([
      (call) =>
        new Promise((_, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(call.init.signal?.reason ?? new Error('aborted')));
        }),
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1, timeouts: { genmove: 20, analyze: 20, score: 20 } });
    await expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_busy' });
    expect(f.calls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx vitest run apps/game-server/src/engine-client.test.ts`
Expected: FAIL — нет `./engine-client.ts`.

- [ ] **Step 3: `apps/game-server/src/engine-client.ts`**

```ts
// Клиент go-engine (раздел 7 спеки): таймауты genmove 10 с, analyze 15 с, score 30 с; один повтор.
import type { z } from 'zod';
import {
  ApiError,
  type EngineAnalyzeRequest,
  EngineAnalyzeResponse,
  type EngineGenmoveRequest,
  EngineGenmoveResponse,
  type EngineScoreRequest,
  EngineScoreResponse,
  ErrorBody,
} from '@goko/protocol';

export interface Engine {
  genmove(req: EngineGenmoveRequest): Promise<EngineGenmoveResponse>;
  analyze(req: EngineAnalyzeRequest): Promise<EngineAnalyzeResponse>;
  score(req: EngineScoreRequest): Promise<EngineScoreResponse>;
}

export type EngineClientOptions = {
  baseUrl: string;
  engineKey: string;
  fetch?: typeof globalThis.fetch;
  timeouts?: { genmove: number; analyze: number; score: number };
  retryDelayMs?: number;
};

export const ENGINE_TIMEOUTS = { genmove: 10_000, analyze: 15_000, score: 30_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Ошибка одной попытки: retry — стоит ли повторять.
class AttemptError extends Error {
  readonly retry: boolean;
  readonly api?: ApiError;

  constructor(message: string, retry: boolean, api?: ApiError) {
    super(message);
    this.retry = retry;
    this.api = api;
  }
}

export function createEngineClient(opts: EngineClientOptions): Engine {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeouts = opts.timeouts ?? ENGINE_TIMEOUTS;
  const retryDelay = opts.retryDelayMs ?? 200;

  async function attempt<T extends z.ZodType>(path: string, body: unknown, timeoutMs: number, schema: T): Promise<z.output<T>> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-engine-key': opts.engineKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      throw new AttemptError(timeout ? `движок не ответил за ${timeoutMs} мс` : `движок недоступен: ${e instanceof Error ? e.message : String(e)}`, true, new ApiError(timeout ? 'engine_busy' : 'engine_unavailable', timeout ? 'движок не успел ответить' : 'движок недоступен'));
    }
    if (res.ok) return schema.parse(await res.json());
    const text = await res.text().catch(() => '');
    let api: ApiError | undefined;
    try {
      const parsed = ErrorBody.safeParse(JSON.parse(text));
      if (parsed.success) api = new ApiError(parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
    } catch {
      // не JSON
    }
    api ??= new ApiError('engine_unavailable', `движок ответил ${res.status}`);
    throw new AttemptError(api.message, res.status >= 500, api);
  }

  async function withRetry<T extends z.ZodType>(path: string, body: unknown, timeoutMs: number, schema: T): Promise<z.output<T>> {
    try {
      return await attempt(path, body, timeoutMs, schema);
    } catch (e) {
      if (!(e instanceof AttemptError)) throw e;
      if (!e.retry) throw e.api ?? new ApiError('engine_unavailable', e.message);
      await sleep(retryDelay);
      try {
        return await attempt(path, body, timeoutMs, schema);
      } catch (e2) {
        if (e2 instanceof AttemptError) throw e2.api ?? new ApiError('engine_unavailable', e2.message);
        throw e2;
      }
    }
  }

  return {
    genmove: (req) => withRetry('/v1/genmove', req, timeouts.genmove, EngineGenmoveResponse),
    analyze: (req) => withRetry('/v1/analyze', req, timeouts.analyze, EngineAnalyzeResponse),
    score: (req) => withRetry('/v1/score', req, timeouts.score, EngineScoreResponse),
  };
}
```

- [ ] **Step 4: Тест зелёный**

Run: `npx vitest run apps/game-server/src/engine-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Тест `apps/game-server/src/fake-engine.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { replay } from '@goko/go-core';
import { createFakeEngine } from './fake-engine.ts';

const base = { boardSize: 9, rules: 'chinese' as const, komi: 7.5 };
const engine = createFakeEngine();

describe('createFakeEngine', () => {
  it('сценарий отдаёт ходы по порядку, потом случайные легальные', async () => {
    const engine = createFakeEngine({ script: ['E5', 'pass'] });
    expect((await engine.genmove({ ...base, moves: [['B', 'D4']], rank: '10k' })).move).toBe('E5');
    expect((await engine.genmove({ ...base, moves: [['B', 'D4'], ['W', 'E5'], ['B', 'C3']], rank: '10k' })).move).toBe('pass');
    const third = await engine.genmove({ ...base, moves: [['B', 'D4'], ['W', 'E5'], ['B', 'C3'], ['W', 'pass'], ['B', 'C4']], rank: '10k' });
    expect(third.move).not.toBe('pass');
    expect(() => replay(9, [{ color: 'B', coord: 'D4' }, { color: 'W', coord: 'E5' }, { color: 'B', coord: 'C3' }, { color: 'W', coord: 'pass' }, { color: 'B', coord: 'C4' }, { color: 'W', coord: third.move }])).not.toThrow();
    expect(engine.calls.genmove).toBe(3);
  });

  it('после паса соперника пасует сам (passAfterPass)', async () => {
    const engine = createFakeEngine();
    expect((await engine.genmove({ ...base, moves: [['B', 'D4'], ['W', 'E5'], ['B', 'pass']], rank: '10k' })).move).toBe('pass');
    const stubborn = createFakeEngine({ passAfterPass: false });
    expect((await stubborn.genmove({ ...base, moves: [['B', 'pass']], rank: '10k' })).move).not.toBe('pass');
  });

  it('score считает площадь по наивному владению: камни +-1, пустые точки по флуд-филлу go-core', async () => {
    const moves: [string, string][] = [];
    for (const c of 'ABCDEFGHJ') moves.push(['B', `${c}4`], ['W', `${c}5`]);
    const r = await engine.score({ ...base, moves });
    expect(r).toMatchObject({ areaB: 36, areaW: 45, winner: 'W', margin: 16.5, dead: [] });
    expect(r.ownership).toHaveLength(81);
  });

  it('analyze возвращает winrate 0.5 и ownership по камням; delayMs задерживает ответ', async () => {
    const engine = createFakeEngine({ delayMs: 30 });
    const t0 = Date.now();
    const a = await engine.analyze({ ...base, moves: [['B', 'D4']] });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(a.winrateB).toBe(0.5);
    expect(a.ownership?.[3 * 9 + 3]).toBe(1);
    expect(a.moveInfos.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Убедиться, что тест падает**

Run: `npx vitest run apps/game-server/src/fake-engine.test.ts`
Expected: FAIL — нет `./fake-engine.ts`.

- [ ] **Step 7: `apps/game-server/src/fake-engine.ts`**

```ts
// Фейковый движок для тестов и smoke без KataGo: легальные ходы, сценарий, задержка, наивный счёт.
import { areaScore, deadStones, indexToCoord, neighbors, play, replay, resultFromArea, type Color, type Position } from '@goko/go-core';
import type { EngineAnalyzeRequest, EngineAnalyzeResponse, EngineGenmoveRequest, EngineScoreRequest, EngineScoreResponse } from '@goko/protocol';
import type { Engine } from './engine-client.ts';

export type FakeEngineOptions = {
  script?: string[]; // ходы по порядку вызовов genmove; когда кончились — случайные легальные
  delayMs?: number;
  random?: () => number;
  passAfterPass?: boolean; // пасовать, если последний ход соперника — пас (по умолчанию да)
};

export type FakeEngine = Engine & { calls: { genmove: number; analyze: number; score: number } };

function sideToMove(moves: readonly [Color, string][]): Color {
  const last = moves.at(-1);
  return last ? (last[0] === 'B' ? 'W' : 'B') : 'B';
}

function positionOf(req: { boardSize: number; moves: [Color, string][] }): Position {
  return replay(req.boardSize, req.moves.map(([color, coord]) => ({ color, coord })));
}

// Случайный легальный ход; не заполняет собственные глаза (точка, где все соседи свои), чтобы партия кончалась.
function randomLegal(pos: Position, color: Color, random: () => number): string {
  const size = pos.size;
  const candidates: number[] = [];
  for (let i = 0; i < size * size; i++) {
    if (pos.board.charAt(i) !== '.') continue;
    const coord = indexToCoord(i, size);
    try {
      play(pos, color, coord);
    } catch {
      continue;
    }
    const eye = neighbors(i, size).every((n) => pos.board.charAt(n) === color);
    if (!eye) candidates.push(i);
  }
  if (candidates.length === 0) return 'pass';
  return indexToCoord(candidates[Math.floor(random() * candidates.length)]!, size);
}

function naiveOwnership(pos: Position): number[] {
  const own: number[] = [];
  for (let i = 0; i < pos.size * pos.size; i++) {
    const c = pos.board.charAt(i);
    own.push(c === 'B' ? 1 : c === 'W' ? -1 : 0);
  }
  return own;
}

export function createFakeEngine(opts: FakeEngineOptions = {}): FakeEngine {
  const script = [...(opts.script ?? [])];
  const random = opts.random ?? Math.random;
  const passAfterPass = opts.passAfterPass ?? true;
  const calls = { genmove: 0, analyze: 0, score: 0 };
  const wait = () => (opts.delayMs ? new Promise<void>((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());

  return {
    calls,
    async genmove(req: EngineGenmoveRequest) {
      calls.genmove++;
      await wait();
      const t0 = performance.now();
      const color = sideToMove(req.moves);
      let move = script.shift();
      if (move === undefined) {
        const lastCoord = req.moves.at(-1)?.[1];
        move = passAfterPass && lastCoord === 'pass' ? 'pass' : randomLegal(positionOf(req), color, random);
      }
      return { move, winrateB: 0.5, scoreLeadB: 0, humanPolicyTop: [{ coord: move, prob: 1 }], ms: Math.round(performance.now() - t0) };
    },
    async analyze(req: EngineAnalyzeRequest): Promise<EngineAnalyzeResponse> {
      calls.analyze++;
      await wait();
      const pos = positionOf(req);
      const color = sideToMove(req.moves);
      const best = randomLegal(pos, color, random);
      return {
        visits: req.maxVisits ?? 50,
        winrateB: 0.5,
        scoreLeadB: 0,
        moveInfos: [{ coord: best, winrateB: 0.5, scoreLeadB: 0, visits: 1, order: 0 }],
        ownership: req.includeOwnership === false ? undefined : naiveOwnership(pos),
      };
    },
    async score(req: EngineScoreRequest): Promise<EngineScoreResponse> {
      calls.score++;
      await wait();
      const pos = positionOf(req);
      const ownership = naiveOwnership(pos);
      const dead = deadStones(pos, ownership);
      const area = areaScore(pos, dead, req.komi);
      const { winner, margin } = resultFromArea(area);
      const scoreLeadB = area.areaB - area.areaW - req.komi;
      return { ownership, dead, areaB: area.areaB, areaW: area.areaW, scoreLeadB, winner, margin };
    },
  };
}
```

`[!]` В тесте `score` ожидания `areaB: 36, areaW: 45`: на 9×9 чёрная линия на строке 4 и белая на 5 — чёрным строки 1–4 (36 точек), белым 5–9 (45 точек); `margin = 45 + 7.5 - 36 = 16.5`. Если `areaScore` считает иначе — ошибка в `go-core`, не в фейке.

- [ ] **Step 8: Тест зелёный**

Run: `npx vitest run apps/game-server/src/fake-engine.test.ts`
Expected: PASS.

- [ ] **Step 9: Тест `apps/game-server/src/service.test.ts`** — сценарии раздела 12 спеки

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameEvent } from '@goko/protocol';
import type { Engine } from './engine-client.ts';
import { EventBus } from './events.ts';
import { createFakeEngine } from './fake-engine.ts';
import { GameService } from './service.ts';
import { GameStore } from './store.ts';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goko-service-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HUMAN_BLACK = { black: { controller: 'human' as const }, white: { controller: 'engine' as const, rank: '10k' as const } };
const ENGINE_BLACK = { black: { controller: 'engine' as const, rank: '10k' as const }, white: { controller: 'human' as const } };
const S9 = { settings: { boardSize: 9 as const } };

async function make(engine: Engine, extra: Partial<ConstructorParameters<typeof GameService>[0]> = {}) {
  const bus = new EventBus();
  const store = new GameStore(dir);
  const service = new GameService({ store, engine, bus, replyTimeoutMs: 500, engineRetryMs: 20, ...extra });
  await service.init();
  return { service, bus, store };
}

function record(bus: EventBus, channel: string): GameEvent[] {
  const out: GameEvent[] = [];
  bus.subscribe(channel, (e) => out.push(e));
  return out;
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('таймаут ожидания');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('GameService: партия человек против движка', () => {
  it('create -> play с ответом движка -> события -> снапшот', async () => {
    const engine = createFakeEngine({ script: ['E5'] });
    const { service, bus, store } = await make(engine);
    const created = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    expect(created.state.toPlay).toBe('B');
    expect(created.firstMove).toBeUndefined();
    const events = record(bus, `game:${created.state.id}`);

    const res = await service.play(created.state.id, { coord: 'D4', waitForReply: true, via: 'voice' });
    expect(res.move).toMatchObject({ n: 1, color: 'B', coord: 'D4' });
    expect(res.reply).toMatchObject({ n: 2, color: 'W', coord: 'E5' });
    expect(res.replyTimedOut).toBeUndefined();
    expect(res.state.moves).toHaveLength(2);
    expect(res.state.pendingEngineMove).toBe(false);
    expect(res.state.toPlay).toBe('B');

    expect(events.map((e) => e.type)).toEqual(['state.updated', 'engine.thinking', 'state.updated']);
    expect(events[0]).toMatchObject({ type: 'state.updated', cause: 'play', by: 'human', via: 'voice' });
    expect(events[2]).toMatchObject({ type: 'state.updated', cause: 'engine', by: 'engine' });
    const saved = await store.load();
    expect(saved[0]?.moves).toHaveLength(2);
  });

  it('движок ходит первым: create ждёт firstMove', async () => {
    const { service } = await make(createFakeEngine({ script: ['C3'] }));
    const created = await service.create({ ...ENGINE_BLACK, ...S9, waitForReply: true });
    expect(created.firstMove).toMatchObject({ n: 1, color: 'B', coord: 'C3' });
    expect(created.state.toPlay).toBe('W');
  });

  it('два паса -> счёт -> finished, game.finished, result.reason score', async () => {
    const engine = createFakeEngine();
    const { service, bus } = await make(engine);
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    const res = await service.pass(g.state.id, { waitForReply: true, via: 'api' });
    expect(res.reply?.coord).toBe('pass');
    await until(() => service.get(g.state.id).status === 'finished');
    const state = service.get(g.state.id);
    expect(state.result).toMatchObject({ reason: 'score', winner: 'W', margin: 7.5 });
    expect(state.result?.score).toMatchObject({ areaB: 0, areaW: 0, komi: 7.5, dead: [] });
    expect(engine.calls.score).toBe(1);
    expect(events.some((e) => e.type === 'game.finished')).toBe(true);
    await expect(service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' })).rejects.toMatchObject({ code: 'game_finished' });
  });

  it('undo снимает пару ходов; при думающем движке — один и отменяет ответ', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5', 'F6'], delayMs: 150 }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    await service.play(id, { coord: 'D4', waitForReply: true, via: 'api' }); // B D4, W E5
    const u1 = await service.undo(id, { via: 'api' });
    expect(u1.removed.map((m) => m.coord)).toEqual(['E5', 'D4']);
    expect(u1.state.moves).toEqual([]);

    // Движок думает 150 мс, откат раньше: снимается только ход человека, ответ не применяется.
    const p = await service.play(id, { coord: 'C3', waitForReply: false, via: 'api' });
    expect(p.state.pendingEngineMove).toBe(true);
    const u2 = await service.undo(id, { via: 'api' });
    expect(u2.removed.map((m) => m.coord)).toEqual(['C3']);
    await new Promise((r) => setTimeout(r, 250));
    expect(service.get(id).moves).toEqual([]);
    expect(service.get(id).pendingEngineMove).toBe(false);
  });

  it('undo в finished по счёту возвращает playing и снова ждёт движок, если его ход', async () => {
    const { service } = await make(createFakeEngine({ script: ['pass', 'E5'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    // По сценарию ответ движка на D4 — pass; затем пас человека даёт два паса подряд.
    await until(() => service.get(g.state.id).moves.length === 2);
    await service.pass(g.state.id, { waitForReply: false, via: 'api' });
    await until(() => service.get(g.state.id).status === 'finished');
    const u = await service.undo(g.state.id, { via: 'api' });
    expect(u.removed.map((m) => m.coord)).toEqual(['pass', 'pass']);
    expect(u.state.status).toBe('playing');
    expect(u.state.toPlay).toBe('W');
    // Ход движка после отката: ставится заново, по сценарию E5.
    await until(() => service.get(g.state.id).moves.length === 2);
    expect(service.get(g.state.id).moves[1]?.coord).toBe('E5');
  });

  it('correct атомарен: откат пары, новый ход, новый ответ, одно событие correct', async () => {
    const { service, bus } = await make(createFakeEngine({ script: ['E5', 'F6'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'voice' });
    const events = record(bus, `game:${g.state.id}`);
    const res = await service.correct(g.state.id, { coord: 'D5', waitForReply: true, via: 'voice' });
    expect(res.move).toMatchObject({ n: 1, coord: 'D5' });
    expect(res.reply).toMatchObject({ n: 2, coord: 'F6' });
    expect(res.state.moves.map((m) => m.coord)).toEqual(['D5', 'F6']);
    expect(events.filter((e) => e.type === 'state.updated').map((e) => (e as { cause: string }).cause)).toEqual(['correct', 'engine']);
  });

  it('waitForReply с медленным движком: replyTimedOut, ход приходит событием', async () => {
    const { service, bus } = await make(createFakeEngine({ script: ['E5'], delayMs: 200 }), { replyTimeoutMs: 50 });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    const res = await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    expect(res.replyTimedOut).toBe(true);
    expect(res.reply).toBeUndefined();
    await until(() => service.get(g.state.id).moves.length === 2);
    expect(events.at(-1)).toMatchObject({ type: 'state.updated', cause: 'engine' });
  });

  it('revision_conflict при устаревшей expectedRevision', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    const rev = service.get(g.state.id).revision;
    await expect(service.play(g.state.id, { coord: 'C3', expectedRevision: rev - 1, waitForReply: true, via: 'api' })).rejects.toMatchObject({ code: 'revision_conflict', details: { revision: rev } });
  });

  it('рестарт: партии загружаются из снапшотов, ожидающий ход движка доигрывается', async () => {
    const slow = createFakeEngine({ script: ['E5'], delayMs: 100 });
    const first = await make(slow);
    const g = await first.service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await first.service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await first.service.close(); // ответ движка не успел

    const second = await make(createFakeEngine({ script: ['G7'] }));
    expect(second.service.get(g.state.id).moves.map((m) => m.coord)).toEqual(['D4']);
    await until(() => second.service.get(g.state.id).moves.length === 2);
    expect(second.service.get(g.state.id).moves[1]?.coord).toBe('G7');
    expect(second.service.list()[0]).toMatchObject({ id: g.state.id, moveCount: 2, status: 'playing' });
  });

  it('движок недоступен: событие error, партия не портится, потом ход всё же приходит', async () => {
    let fail = 2;
    const inner = createFakeEngine({ script: ['E5'] });
    const flaky: Engine = {
      ...inner,
      genmove: async (req) => {
        if (fail-- > 0) throw new Error('fetch failed');
        return inner.genmove(req);
      },
    };
    const { service, bus } = await make(flaky, { engineRetryMs: 10 });
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const events = record(bus, `game:${g.state.id}`);
    const res = await service.play(g.state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    expect(res.replyTimedOut).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    await until(() => service.get(g.state.id).moves.length === 2);
    expect(service.get(g.state.id).moves[1]?.coord).toBe('E5');
  });

  it('движок сдаётся после 60-го хода при winrate < 3 % и отставании > 25', async () => {
    const inner = createFakeEngine();
    const losing: Engine = { ...inner, genmove: async (req) => ({ ...(await inner.genmove(req)), winrateB: 0.99, scoreLeadB: 40 }) };
    const { service } = await make(losing);
    const g = await service.create({ ...HUMAN_BLACK, settings: { boardSize: 13 }, waitForReply: true });
    const id = g.state.id;
    // Ходы человека берём у второго фейкового движка: они легальны и не пасы (пас вёл бы к автосчёту).
    const human = createFakeEngine({ passAfterPass: false });
    for (let i = 0; i < 40; i++) {
      const s = service.get(id);
      if (s.status === 'finished') break;
      const mv = await human.genmove({ boardSize: 13, rules: 'chinese', komi: 7.5, moves: s.moves.map((m) => [m.color, m.coord] as ['B' | 'W', string]), rank: '10k' });
      await service.play(id, { coord: mv.move, waitForReply: true, via: 'api' });
    }
    const state = service.get(id);
    expect(state.status).toBe('finished');
    expect(state.result).toMatchObject({ winner: 'B', reason: 'resign' });
    expect(state.moves.length).toBeGreaterThanOrEqual(60);
  });

  it('not_your_turn для хода за движок, unsupported_controller для external', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'], delayMs: 100 }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    await service.play(g.state.id, { coord: 'D4', waitForReply: false, via: 'api' });
    await expect(service.play(g.state.id, { coord: 'C3', color: 'W', waitForReply: false, via: 'api' })).rejects.toMatchObject({ code: 'not_your_turn' });
    await expect(service.create({ black: { controller: 'external' }, white: { controller: 'engine', rank: '10k' }, waitForReply: true })).rejects.toMatchObject({ code: 'unsupported_controller' });
  });

  it('analyze, score, ascii, sgf, setRank', async () => {
    const { service } = await make(createFakeEngine({ script: ['E5'] }));
    const g = await service.create({ ...HUMAN_BLACK, ...S9, waitForReply: true });
    const id = g.state.id;
    await service.play(id, { coord: 'D4', waitForReply: true, via: 'api' });
    const a = await service.analyze(id, { maxVisits: 50 });
    expect(a.ownership).toHaveLength(81);
    expect(a.groups.map((x) => x.stones)).toEqual([['D4'], ['E5']]);
    expect(a.groups[0]).toMatchObject({ color: 'B', liberties: 4, status: 'safe' });
    const sc = await service.score(id);
    expect(sc).toMatchObject({ reason: 'score', score: { areaB: 1, areaW: 1 } });
    expect(service.get(id).status).toBe('playing');
    const ascii = service.ascii(id);
    expect(ascii.split('\n')[0]).toMatch(/^# \w+ rev \d+ playing toPlay B moves 2$/);
    expect(ascii).toContain('(O)');
    expect(service.sgf(id)).toBe('(;FF[4]GM[1]CA[UTF-8]SZ[9]KM[7.5]RU[Chinese]PB[Human]PW[Goko 10k];B[df];W[ee])');
    const r = await service.setRank(id, { color: 'W', rank: '5k' });
    expect(r.state.seats.W.rank).toBe('5k');
    expect(service.sgf(id)).toContain('PW[Goko 5k]');
  });
});
```

`[!]` Ожидания SGF: на 9×9 `D4` → столбец `d`, строка снизу 4 → сверху `9 - 4 = 5` → буква `f`; `E5` → `ee`. `ascii` содержит `(O)` — последний ход белых в скобках.

- [ ] **Step 10: Убедиться, что тест падает**

Run: `npx vitest run apps/game-server/src/service.test.ts`
Expected: FAIL — нет `./service.ts`.

- [ ] **Step 11: `apps/game-server/src/service.ts`**

```ts
// Сервис партий (раздел 7 спеки): мьютекс на партию, автоматика мест engine, ожидание ответа,
// автосчёт после двух пасов, снапшоты и события. Единственное место, где меняется GameState.
import type { z } from 'zod';
import { groupsWithOwnership, toAscii, toSgf } from '@goko/go-core';
import {
  type Analysis,
  type AnalyzeRequest,
  ApiError,
  type By,
  type Color,
  type CorrectRequest,
  type GameEvent,
  type GameState,
  type GameSummary,
  GameSettings,
  type Move,
  type NewGameRequest,
  type NewGameResponse,
  type PassRequest,
  type PlayRequest,
  type PlayResponse,
  type ResignRequest,
  type Result,
  type SetRankRequest,
  type StateCause,
  type StateResponse,
  type UndoRequest,
  type UndoResponse,
  type Via,
} from '@goko/protocol';
import type { Engine } from './engine-client.ts';
import type { EventBus } from './events.ts';
import { applyMove, finishByScore, newGame, positionOf, resign as resignGame, setRank as setRankGame, undo as undoGame } from './game.ts';
import { newId } from './ids.ts';
import type { GameStore } from './store.ts';

// Входы операций — уже разобранные схемой тела (z.output): defaults подставлены.
export type NewGameInput = z.output<typeof NewGameRequest>;
export type PlayInput = z.output<typeof PlayRequest>;
export type PassInput = z.output<typeof PassRequest>;
export type ResignInput = z.output<typeof ResignRequest>;
export type UndoInput = z.output<typeof UndoRequest>;
export type CorrectInput = z.output<typeof CorrectRequest>;
export type SetRankInput = z.output<typeof SetRankRequest>;
export type AnalyzeInput = z.output<typeof AnalyzeRequest>;

export const REPLY_TIMEOUT_MS = 8000;
export const ENGINE_RESIGN_AFTER_MOVE = 60;
export const ENGINE_RESIGN_WINRATE = 0.03;
export const ENGINE_RESIGN_LEAD = -25;
export const GENMOVE_VISITS = 10;
export const DEFAULT_RANK = '10k' as const;

export type GameServiceDeps = {
  store: GameStore;
  engine: Engine;
  bus: EventBus;
  now?: () => Date;
  replyTimeoutMs?: number;
  engineRetryMs?: number;
  log?: (line: string) => void;
};

// Ожидающий ответа движка на состояние с ревизией revision.
type Waiter = { revision: number; resolve: (move: Move | null) => void };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class GameService {
  private readonly deps: GameServiceDeps;
  private readonly games = new Map<string, GameState>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly sessionsByGame = new Map<string, string>();
  private readonly engineTasks = new Map<string, Promise<void>>();
  private readonly scoringTasks = new Map<string, Promise<void>>();
  private closed = false;

  constructor(deps: GameServiceDeps) {
    this.deps = deps;
  }

  async init(): Promise<void> {
    for (const state of await this.deps.store.load()) this.games.set(state.id, state);
    for (const state of this.games.values()) this.kick(state);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const list of this.waiters.values()) for (const w of list) w.resolve(null);
    this.waiters.clear();
    await Promise.allSettled([...this.engineTasks.values(), ...this.scoringTasks.values()]);
  }

  list(): GameSummary[] {
    return [...this.games.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((g) => ({ id: g.id, createdAt: g.createdAt, status: g.status, moveCount: g.moves.length, seats: g.seats, ...(g.result ? { result: g.result } : {}) }));
  }

  get(id: string): GameState {
    const state = this.games.get(id);
    if (!state) throw new ApiError('not_found', `партии ${id} нет`);
    return state;
  }

  async create(req: NewGameInput, opts: { sessionId?: string } = {}): Promise<NewGameResponse> {
    for (const seat of [req.black, req.white]) {
      if (seat.controller === 'external') throw new ApiError('unsupported_controller', 'место external появится на стадии 2');
    }
    const withRank = (seat: NewGameInput['black']) => (seat.controller === 'engine' && !seat.rank ? { ...seat, rank: DEFAULT_RANK } : seat);
    const id = newId();
    const state = newGame({
      id,
      createdAt: this.now(),
      settings: GameSettings.parse(req.settings ?? {}),
      seats: { B: withRank(req.black), W: withRank(req.white) },
    });
    if (opts.sessionId) {
      // session.game идёт раньше событий партии (раздел 5 спеки).
      this.sessionsByGame.set(id, opts.sessionId);
      this.deps.bus.emit(`session:${opts.sessionId}`, { type: 'session.game', gameId: id });
    }
    const waiter = state.pendingEngineMove && req.waitForReply ? this.registerWaiter(id, state.revision) : null;
    await this.commit(state, 'new', 'system');
    if (!waiter) return { state: this.get(id) };
    const firstMove = await this.waitForReply(waiter);
    const latest = this.get(id);
    if (firstMove) return { state: latest, firstMove };
    return latest.revision > state.revision ? { state: latest } : { state: latest, replyTimedOut: true };
  }

  async play(id: string, req: PlayInput, by: By = 'human'): Promise<PlayResponse> {
    const { state, move, waiter } = await this.locked(id, async () => {
      const prev = this.get(id);
      this.checkRevision(prev, req.expectedRevision);
      const color = req.color ?? prev.toPlay;
      this.checkSeat(prev, color, by);
      const next = applyMove(prev, color, req.coord, this.now());
      const waiter = req.waitForReply && next.state.pendingEngineMove ? this.registerWaiter(id, next.state.revision) : null;
      await this.commit(next.state, next.move.coord === 'pass' ? 'pass' : 'play', by, req.via);
      return { ...next, waiter };
    });
    return this.withReply(id, state, move, waiter);
  }

  pass(id: string, req: PassInput, by: By = 'human'): Promise<PlayResponse> {
    return this.play(id, { ...req, coord: 'pass' }, by);
  }

  async resign(id: string, req: ResignInput, by: By = 'human'): Promise<StateResponse> {
    return this.locked(id, async () => {
      const next = resignGame(this.get(id), req.color);
      await this.commit(next, 'resign', by, req.via);
      return { state: next };
    });
  }

  async undo(id: string, req: UndoInput, by: By = 'human'): Promise<UndoResponse> {
    return this.locked(id, async () => {
      const prev = this.get(id);
      this.checkRevision(prev, req.expectedRevision);
      const rolled = undoGame(prev);
      await this.commit(rolled.state, 'undo', by, req.via);
      return { state: this.get(id), removed: rolled.removed };
    });
  }

  // Атомарно: откат пары, новый ход человека, новый ответ движка. Одно событие state.updated cause 'correct'.
  async correct(id: string, req: CorrectInput, by: By = 'human'): Promise<PlayResponse> {
    const { state, move, waiter } = await this.locked(id, async () => {
      const rolled = undoGame(this.get(id));
      const color = rolled.state.toPlay;
      this.checkSeat(rolled.state, color, by);
      const next = applyMove(rolled.state, color, req.coord, this.now());
      const waiter = req.waitForReply && next.state.pendingEngineMove ? this.registerWaiter(id, next.state.revision) : null;
      await this.commit(next.state, 'correct', by, req.via);
      return { ...next, waiter };
    });
    return this.withReply(id, state, move, waiter);
  }

  async setRank(id: string, req: SetRankInput): Promise<StateResponse> {
    return this.locked(id, async () => {
      const next = setRankGame(this.get(id), req.color, req.rank);
      await this.commit(next, 'rank', 'human');
      return { state: next };
    });
  }

  async analyze(id: string, req: AnalyzeInput): Promise<Analysis> {
    const state = this.get(id);
    const r = await this.deps.engine.analyze({ ...this.engineRequest(state), maxVisits: req.maxVisits, includeOwnership: true });
    const ownership = r.ownership ?? new Array<number>(state.board.length).fill(0);
    return {
      visits: r.visits,
      winrateB: r.winrateB,
      scoreLeadB: r.scoreLeadB,
      topMoves: r.moveInfos.slice(0, 5).map((m) => ({ coord: m.coord, winrateB: m.winrateB, scoreLeadB: m.scoreLeadB, visits: m.visits })),
      ownership,
      groups: groupsWithOwnership(positionOf(state), ownership),
    };
  }

  // Счёт без завершения партии («кто впереди по площади»); автосчёт после двух пасов использует его же.
  async score(id: string): Promise<Result> {
    const state = this.get(id);
    const r = await this.deps.engine.score(this.engineRequest(state));
    return {
      winner: r.winner,
      margin: r.margin,
      reason: 'score',
      score: { areaB: r.areaB, areaW: r.areaW, komi: state.settings.komi, dead: r.dead, ownership: r.ownership },
    };
  }

  ascii(id: string): string {
    const state = this.get(id);
    const header = `# ${state.id} rev ${state.revision} ${state.status} toPlay ${state.toPlay} moves ${state.moves.length}`;
    return `${header}\n${toAscii(positionOf(state), { lastMove: state.moves.at(-1)?.coord ?? null })}`;
  }

  sgf(id: string): string {
    const state = this.get(id);
    const label = (color: Color): string => {
      const seat = state.seats[color];
      if (seat.controller === 'engine') return `Goko ${seat.rank ?? DEFAULT_RANK}`;
      return seat.label ?? (seat.controller === 'human' ? 'Human' : 'External');
    };
    const result = state.result ? `${state.result.winner}+${state.result.reason === 'resign' ? 'R' : String(state.result.margin ?? '')}` : undefined;
    return toSgf({
      size: state.settings.boardSize,
      komi: state.settings.komi,
      rules: 'Chinese',
      black: label('B'),
      white: label('W'),
      ...(result ? { result } : {}),
      moves: state.moves.map((m) => ({ color: m.color, coord: m.coord })),
    });
  }

  // ---- внутреннее ----

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private engineRequest(state: GameState) {
    return {
      boardSize: state.settings.boardSize,
      rules: 'chinese' as const,
      komi: state.settings.komi,
      moves: state.moves.map((m) => [m.color, m.coord] as [Color, string]),
    };
  }

  private checkRevision(state: GameState, expected: number | undefined): void {
    if (expected !== undefined && expected !== state.revision) {
      throw new ApiError('revision_conflict', `партия уже изменилась: ревизия ${state.revision}`, { revision: state.revision });
    }
  }

  private checkSeat(state: GameState, color: Color, by: By): void {
    const seat = state.seats[color];
    if (seat.controller === 'external') throw new ApiError('unsupported_controller', 'место external появится на стадии 2');
    if (seat.controller === 'engine' && by !== 'engine') throw new ApiError('not_your_turn', 'сейчас ходит Гоко', { toPlay: state.toPlay });
  }

  // Мьютекс на партию: операции над одной партией выполняются по очереди.
  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  // Фиксирует новое состояние: снапшот, событие, пробуждение ожидающих, запуск движка или счёта.
  private async commit(next: GameState, cause: StateCause, by: By, via?: Via): Promise<void> {
    const prev = this.games.get(next.id);
    this.games.set(next.id, next);
    await this.deps.store.save(next);
    this.emitGame(next.id, { type: 'state.updated', state: next, cause, by, ...(via ? { via } : {}) });
    if (next.status === 'finished' && prev?.status !== 'finished' && next.result) this.emitGame(next.id, { type: 'game.finished', result: next.result });
    this.settleWaiters(next, cause, prev);
    this.kick(next);
  }

  private emitGame(id: string, event: GameEvent): void {
    this.deps.bus.emit(`game:${id}`, event);
    const sessionId = this.sessionsByGame.get(id);
    if (sessionId) this.deps.bus.emit(`session:${sessionId}`, event);
  }

  private registerWaiter(id: string, revision: number): Promise<Move | null> {
    return new Promise<Move | null>((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push({ revision, resolve });
      this.waiters.set(id, list);
    });
  }

  // Ожидающий ревизии R получает ход движка, если движок ответил ровно на R; любое другое изменение
  // после R (undo, второй ход, сдача) отдаёт null. Коммит самой ревизии R (или более ранней) его не трогает.
  private settleWaiters(next: GameState, cause: StateCause, prev: GameState | undefined): void {
    const list = this.waiters.get(next.id);
    if (!list?.length) return;
    this.waiters.set(
      next.id,
      list.filter((w) => {
        if (next.revision <= w.revision) return true;
        const engineReply = cause === 'engine' && prev?.revision === w.revision ? (next.moves.at(-1) ?? null) : null;
        w.resolve(engineReply);
        return false;
      }),
    );
  }

  private async waitForReply(waiter: Promise<Move | null>): Promise<Move | null> {
    const timeoutMs = this.deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([waiter, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async withReply(id: string, state: GameState, move: Move, waiter: Promise<Move | null> | null): Promise<PlayResponse> {
    if (!waiter) return { state, move };
    const reply = await this.waitForReply(waiter);
    const latest = this.get(id);
    if (reply) return { state: latest, move, reply };
    // Партия успела измениться иначе (undo, сдача движка) — это не таймаут.
    return latest.revision > state.revision ? { state: latest, move } : { state: latest, move, replyTimedOut: true };
  }

  // Запускает задачу движка или счёта, если она нужна и ещё не идёт. Повторная задача на ту же ревизию не ставится.
  private kick(state: GameState): void {
    if (this.closed || state.status !== 'playing') return;
    if (state.consecutivePasses >= 2) {
      if (!this.scoringTasks.has(state.id)) this.scoringTasks.set(state.id, this.runScoring(state.id).finally(() => this.scoringTasks.delete(state.id)));
      return;
    }
    if (state.pendingEngineMove && !this.engineTasks.has(state.id)) {
      this.engineTasks.set(state.id, this.runEngine(state.id).finally(() => this.engineTasks.delete(state.id)));
    }
  }

  // Цикл хода движка: думает вне мьютекса, применяет под мьютексом только если ревизия не изменилась.
  private async runEngine(id: string): Promise<void> {
    while (!this.closed) {
      const state = this.games.get(id);
      if (!state || state.status !== 'playing' || !state.pendingEngineMove) return;
      const color = state.toPlay;
      const rank = state.seats[color].rank ?? DEFAULT_RANK;
      this.emitGame(id, { type: 'engine.thinking', color });
      let reply: Awaited<ReturnType<Engine['genmove']>>;
      try {
        reply = await this.deps.engine.genmove({ ...this.engineRequest(state), rank, maxVisits: GENMOVE_VISITS });
      } catch (e) {
        await this.onEngineFailure(id, e);
        continue;
      }
      const applied = await this.locked(id, async () => {
        const current = this.games.get(id);
        if (this.closed || !current || current.revision !== state.revision) return false; // партия изменилась, пока движок думал
        const engineWinrate = color === 'B' ? reply.winrateB : 1 - reply.winrateB;
        const engineLead = color === 'B' ? reply.scoreLeadB : -reply.scoreLeadB;
        if (current.moves.length >= ENGINE_RESIGN_AFTER_MOVE && engineWinrate < ENGINE_RESIGN_WINRATE && engineLead < ENGINE_RESIGN_LEAD) {
          await this.commit(resignGame(current, color), 'resign', 'engine');
          return true;
        }
        let next: ReturnType<typeof applyMove>;
        try {
          next = applyMove(current, color, reply.move, this.now());
        } catch (e) {
          this.deps.log?.(`[!] движок предложил нелегальный ход ${reply.move}: ${e instanceof Error ? e.message : String(e)}; пас`);
          next = applyMove(current, color, 'pass', this.now());
        }
        await this.commit(next.state, 'engine', 'engine');
        return true;
      });
      if (applied) return;
    }
  }

  // Движок недоступен: событие error, ожидающие получают null (клиент увидит replyTimedOut), пауза, повтор.
  private async onEngineFailure(id: string, e: unknown): Promise<void> {
    const message = e instanceof Error ? e.message : String(e);
    const code = e instanceof ApiError ? e.code : 'engine_unavailable';
    const retryMs = this.deps.engineRetryMs ?? 5000;
    this.deps.log?.(`[!] движок: ${message}; повтор через ${retryMs} мс`);
    this.emitGame(id, { type: 'error', code, message });
    for (const w of this.waiters.get(id) ?? []) w.resolve(null);
    this.waiters.delete(id);
    await sleep(retryMs);
  }

  // Два паса: счёт и завершение. При недоступности движка — повтор, партия остаётся playing.
  private async runScoring(id: string): Promise<void> {
    while (!this.closed) {
      const state = this.games.get(id);
      if (!state || state.status !== 'playing' || state.consecutivePasses < 2) return;
      let result: Result;
      try {
        result = await this.score(id);
      } catch (e) {
        await this.onEngineFailure(id, e);
        continue;
      }
      await this.locked(id, async () => {
        const current = this.games.get(id);
        if (this.closed || !current || current.revision !== state.revision) return;
        await this.commit(finishByScore(current, result), 'pass', 'system');
      });
      return;
    }
  }
}
```

`[!]` Тонкое место — `settleWaiters`: ожидающий регистрируется на ревизию хода человека (`next.state.revision`) до `commit` этого же хода; коммит с той же ревизией его не трогает (`next.revision <= w.revision`). Следующий коммит с `cause 'engine'` и `prev.revision === w.revision` отдаёт ход; любой другой (undo, второй ход, сдача движка) — `null`, и `withReply` вернёт состояние без `replyTimedOut`, потому что `latest.revision > state.revision`. Для `create` то же: ожидающий на ревизию `0` переживает коммит `'new'` (ревизия `0`) и получает первый ход движка.

- [ ] **Step 12: Тесты зелёные**

Run: `npx vitest run apps/game-server && npm run typecheck`
Expected: PASS. Тест «движок сдаётся» может идти до 2 с (30 пар ходов с фейковым движком).

- [ ] **Step 13: Commit**

```bash
git add apps/game-server
git commit -m "game-server: клиент движка, фейковый движок, GameService с автоматикой мест и автосчётом"
```

---

### Task 11: `game-server` — сессии и токены LiveKit

**Files:**
- Create: `apps/game-server/src/sessions.ts`, `apps/game-server/src/livekit.ts`
- Test: `apps/game-server/src/sessions.test.ts`, `apps/game-server/src/livekit.test.ts`

**Interfaces:**
- Consumes: `Session`, `ApiError` из `@goko/protocol`; `newId`.
- Produces: `class SessionManager { constructor(opts: { max: number; ttlMs: number; now?: () => number }); create(): Session; get(id): Session; setGame(id, gameId): Session; touch(id): void; list(): Session[]; sweep(): number }`; `mintToken(opts: { apiKey; apiSecret; room; identity; agentName; sessionId; ttlSeconds? = 14400 }): Promise<string>`; `roomName(sessionId) = 'goko-' + sessionId`.

- [ ] **Step 1: Тесты**

`apps/game-server/src/sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ApiError } from '@goko/protocol';
import { SessionManager, roomName } from './sessions.ts';

function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('ожидалась ошибка');
}

describe('SessionManager', () => {
  it('создаёт сессию с комнатой goko-<id>, лимит -> limit_reached', () => {
    const m = new SessionManager({ max: 2, ttlMs: 1000 });
    const a = m.create();
    expect(a.room).toBe(roomName(a.id));
    expect(a.currentGameId).toBeNull();
    m.create();
    expect(errorOf(() => m.create())).toMatchObject({ code: 'limit_reached', status: 429 });
    expect(m.list()).toHaveLength(2);
  });

  it('setGame переключает партию, get неизвестной -> not_found', () => {
    const m = new SessionManager({ max: 2, ttlMs: 1000 });
    const a = m.create();
    expect(m.setGame(a.id, 'g1').currentGameId).toBe('g1');
    expect(m.get(a.id).currentGameId).toBe('g1');
    expect(errorOf(() => m.get('nope'))).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('TTL: сессия без событий истекает, touch продлевает, место освобождается', () => {
    let t = 0;
    const m = new SessionManager({ max: 1, ttlMs: 100, now: () => t });
    const a = m.create();
    t = 90;
    m.touch(a.id);
    t = 150;
    expect(m.get(a.id).id).toBe(a.id); // прожила: touch на 90 + 100 = 190
    t = 200;
    expect(errorOf(() => m.get(a.id))).toMatchObject({ code: 'not_found' });
    expect(m.create().id).not.toBe(a.id);
  });
});
```

`apps/game-server/src/livekit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TokenVerifier } from 'livekit-server-sdk';
import { mintToken } from './livekit.ts';

describe('mintToken', () => {
  it('гранты на комнату, roomCreate, и диспетчеризация агента с sessionId в metadata', async () => {
    const token = await mintToken({ apiKey: 'devkey', apiSecret: 'secret-of-at-least-32-characters-long', room: 'goko-s1', identity: 'phone-s1', agentName: 'goko', sessionId: 's1' });
    const claims = await new TokenVerifier('devkey', 'secret-of-at-least-32-characters-long').verify(token);
    expect(claims.sub).toBe('phone-s1');
    expect(claims.video).toMatchObject({ roomJoin: true, roomCreate: true, room: 'goko-s1', canPublish: true, canSubscribe: true, canPublishData: true });
    const agents = (claims.roomConfig as { agents: Array<{ agentName: string; metadata: string }> }).agents;
    expect(agents[0]?.agentName).toBe('goko');
    expect(JSON.parse(agents[0]?.metadata ?? '{}')).toEqual({ sessionId: 's1' });
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx vitest run apps/game-server/src/sessions.test.ts apps/game-server/src/livekit.test.ts`
Expected: FAIL — нет модулей.

- [ ] **Step 3: `apps/game-server/src/sessions.ts` и `apps/game-server/src/livekit.ts`**

`apps/game-server/src/sessions.ts`:

```ts
// Сессии (раздел 4 спеки): комната LiveKit + указатель на текущую партию; лимит и TTL без событий.
import { ApiError, type Session } from '@goko/protocol';
import { newId } from './ids.ts';

export type SessionManagerOptions = { max: number; ttlMs: number; now?: () => number };

export function roomName(sessionId: string): string {
  return `goko-${sessionId}`;
}

type Entry = { session: Session; lastSeen: number };

export class SessionManager {
  private readonly opts: SessionManagerOptions;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  sweep(): number {
    const cutoff = this.now() - this.opts.ttlMs;
    let removed = 0;
    for (const [id, e] of this.entries) {
      if (e.lastSeen < cutoff) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  create(): Session {
    this.sweep();
    if (this.entries.size >= this.opts.max) throw new ApiError('limit_reached', `уже ${this.opts.max} активных сессий`, { max: this.opts.max });
    const id = newId();
    const session: Session = { id, room: roomName(id), currentGameId: null, createdAt: new Date(this.now()).toISOString() };
    this.entries.set(id, { session, lastSeen: this.now() });
    return session;
  }

  get(id: string): Session {
    this.sweep();
    const e = this.entries.get(id);
    if (!e) throw new ApiError('not_found', `сессии ${id} нет`);
    e.lastSeen = this.now();
    return e.session;
  }

  touch(id: string): void {
    const e = this.entries.get(id);
    if (e) e.lastSeen = this.now();
  }

  setGame(id: string, gameId: string): Session {
    const e = this.entries.get(id);
    if (!e) throw new ApiError('not_found', `сессии ${id} нет`);
    e.session = { ...e.session, currentGameId: gameId };
    e.lastSeen = this.now();
    return e.session;
  }

  list(): Session[] {
    this.sweep();
    return [...this.entries.values()].map((e) => e.session);
  }
}
```

`apps/game-server/src/livekit.ts`:

```ts
// Токен участника с диспетчеризацией агента (раздел 7 спеки). roomCreate обязателен: в livekit.yaml
// auto_create=false, комнату создаёт первый вход с этим правом, и вместе с ней стартует агент из roomConfig.
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { AccessToken } from 'livekit-server-sdk';

export type MintTokenOptions = {
  apiKey: string;
  apiSecret: string;
  room: string;
  identity: string;
  agentName: string;
  sessionId: string;
  ttlSeconds?: number;
};

export async function mintToken(opts: MintTokenOptions): Promise<string> {
  const at = new AccessToken(opts.apiKey, opts.apiSecret, { identity: opts.identity, ttl: opts.ttlSeconds ?? 4 * 3600 });
  at.addGrant({ roomJoin: true, roomCreate: true, room: opts.room, canPublish: true, canSubscribe: true, canPublishData: true });
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: opts.agentName, metadata: JSON.stringify({ sessionId: opts.sessionId }) })],
  });
  return at.toJwt();
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `npx vitest run apps/game-server && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/game-server
git commit -m "game-server: сессии с лимитом и TTL, токены LiveKit с диспетчеризацией агента"
```

---

### Task 12: `game-server` — HTTP-приложение, SSE, запуск

**Files:**
- Create: `apps/game-server/src/app.ts`, `apps/game-server/src/main.ts`
- Test: `apps/game-server/src/app.test.ts`

**Interfaces:**
- Consumes: `GameService`, `SessionManager`, `EventBus`, `mintToken`, `createEngineClient`, `createFakeEngine`, `GameStore`; схемы `ops.ts` и `ApiError`, `ERROR_STATUS` из `@goko/protocol`.
- Produces: `createApp(deps: AppDeps): Hono`, где `AppDeps = { service: GameService; sessions: SessionManager; bus: EventBus; appKey: string; livekit: { url: string; apiKey: string; apiSecret: string; agentName: string }; heartbeatMs? = 15000; log? }`; маршруты ровно по таблице раздела 5 спеки; переменные `main.ts`: `APP_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `AGENT_NAME = goko`, `FAKE_ENGINE`, `ENGINE_URL`, `ENGINE_KEY`, `DATA_DIR = data/games`, `MAX_SESSIONS = 3`, `SESSION_TTL_MS = 7200000`, `PORT = 8787`, `HOST = 127.0.0.1`.

- [ ] **Step 1: Тест `apps/game-server/src/app.test.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenVerifier } from 'livekit-server-sdk';
import { createClient, parseSseStream } from '@goko/protocol';
import { createApp } from './app.ts';
import { EventBus } from './events.ts';
import { createFakeEngine } from './fake-engine.ts';
import { GameService } from './service.ts';
import { SessionManager } from './sessions.ts';
import { GameStore } from './store.ts';

const KEY = 'app-secret';
const LK = { url: 'wss://lk.test', apiKey: 'devkey', apiSecret: 'secret-of-at-least-32-characters-long', agentName: 'goko-dev' };
const HUMAN_BLACK = { black: { controller: 'human' as const }, white: { controller: 'engine' as const, rank: '10k' as const }, settings: { boardSize: 9 as const } };

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goko-app-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function make(opts: { script?: string[]; delayMs?: number; maxSessions?: number } = {}) {
  const bus = new EventBus();
  const service = new GameService({ store: new GameStore(dir), engine: createFakeEngine({ script: opts.script, delayMs: opts.delayMs }), bus, replyTimeoutMs: 500 });
  await service.init();
  const sessions = new SessionManager({ max: opts.maxSessions ?? 3, ttlMs: 60_000 });
  const app = createApp({ service, sessions, bus, appKey: KEY, livekit: LK, heartbeatMs: 20 });
  // Клиент протокола поверх app.request: без сети.
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => app.request(String(input).replace('http://app.test', ''), init)) as unknown as typeof fetch;
  const client = createClient({ baseUrl: 'http://app.test', appKey: KEY, fetch: fetchFn });
  return { app, service, bus, client };
}

describe('createApp', () => {
  it('без X-App-Key — 401 unauthorized; /health открыт', async () => {
    const { app } = await make();
    const res = await app.request('/api/games');
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect((await app.request('/health')).status).toBe(200);
  });

  it('создание сессии: токен с roomCreate и диспетчеризацией, партия в сессии, session.game', async () => {
    const { client, app } = await make({ script: ['E5'] });
    const { session, livekit } = await client.createSession();
    expect(livekit.url).toBe(LK.url);
    const claims = await new TokenVerifier(LK.apiKey, LK.apiSecret).verify(livekit.token);
    expect(claims.video).toMatchObject({ room: session.room, roomJoin: true, roomCreate: true });
    expect(claims.sub).toBe(`phone-${session.id}`);

    const created = await client.newGame(session.id, HUMAN_BLACK);
    expect(created.state.status).toBe('playing');

    // Поток сессии: первым session.game, затем state.updated cause sync.
    const ac = new AbortController();
    const res = await app.request(`/api/sessions/${session.id}/events`, { headers: { 'x-app-key': KEY }, signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const got: string[] = [];
    for await (const data of parseSseStream(res.body!)) {
      got.push(JSON.parse(data).type);
      if (got.length === 2) break;
    }
    ac.abort();
    expect(got).toEqual(['session.game', 'state.updated']);
  });

  it('play по HTTP возвращает ход и ответ; ошибки протокола со статусами', async () => {
    const { client } = await make({ script: ['E5'] });
    const { state } = await client.createGame(HUMAN_BLACK);
    const res = await client.play(state.id, { coord: 'd4', via: 'tap' });
    expect(res.move.coord).toBe('D4');
    expect(res.reply?.coord).toBe('E5');
    await expect(client.play(state.id, { coord: 'E5' })).rejects.toMatchObject({ code: 'illegal_move', status: 400 });
    await expect(client.play(state.id, { coord: 'I5' })).rejects.toMatchObject({ code: 'invalid_coord', status: 400 });
    await expect(client.play(state.id, { coord: 'C3', expectedRevision: 0 })).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
    await expect(client.getGame('nope')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(client.setRank(state.id, { color: 'W', rank: '99k' as never })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    const state2 = await client.getGame(state.id);
    expect(state2.moves).toHaveLength(2);
    expect((await client.listGames()).games[0]?.moveCount).toBe(2);
  });

  it('лимит сессий — 429 limit_reached', async () => {
    const { client } = await make({ maxSessions: 1 });
    await client.createSession();
    await expect(client.createSession()).rejects.toMatchObject({ code: 'limit_reached', status: 429 });
  });

  it('поток партии: sync первым, затем события; при обрыве подписка снимается', async () => {
    const { app, client, bus, service } = await make({ script: ['E5'] });
    const { state } = await client.createGame(HUMAN_BLACK);
    const ac = new AbortController();
    const res = await app.request(`/api/games/${state.id}/events`, { headers: { 'x-app-key': KEY }, signal: ac.signal });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('event: state.updated');
    expect(JSON.parse(first.split('data: ')[1]!.trim())).toMatchObject({ type: 'state.updated', cause: 'sync', by: 'system' });
    expect(bus.count(`game:${state.id}`)).toBe(1);

    await service.play(state.id, { coord: 'D4', waitForReply: true, via: 'api' });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain('"cause":"play"');

    ac.abort();
    await reader.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(bus.count(`game:${state.id}`)).toBe(0);
  });

  it('undo, correct, pass, resign, analyze, score, ascii, sgf по маршрутам', async () => {
    const { client } = await make({ script: ['E5', 'F6', 'pass'] });
    const { state } = await client.createGame(HUMAN_BLACK);
    const id = state.id;
    await client.play(id, { coord: 'D4' });
    expect((await client.undo(id)).removed).toHaveLength(2);
    await client.play(id, { coord: 'C3' });
    expect((await client.correct(id, { coord: 'C4' })).reply?.coord).toBe('pass');
    expect((await client.analyze(id)).groups.length).toBeGreaterThan(0);
    expect((await client.score(id)).reason).toBe('score');
    expect(await client.ascii(id)).toContain('toPlay B');
    expect(await client.sgf(id)).toContain('SZ[9]');
    expect((await client.resign(id, { color: 'B', via: 'voice' })).state.result).toMatchObject({ winner: 'W', reason: 'resign' });
    await expect(client.pass(id)).rejects.toMatchObject({ code: 'game_finished', status: 409 });
  });
});
```

`[!]` Сценарий `['E5', 'F6', 'pass']`: ответ на `D4` — `E5`; после `undo` оба сняты; на `C3` движок отвечает `F6`; `correct` откатывает `C3`+`F6` и ставит `C4`, ответ — `pass` (третий элемент сценария). После `correct` на ходу чёрные, `ascii` содержит `toPlay B`.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx vitest run apps/game-server/src/app.test.ts`
Expected: FAIL — нет `./app.ts`.

- [ ] **Step 3: `apps/game-server/src/app.ts`**

```ts
// HTTP-приложение game-server (раздел 5 спеки): маршруты, X-App-Key, ошибки по таблице, SSE.
import { type Context, Hono } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import {
  AnalyzeRequest,
  ApiError,
  CorrectRequest,
  ERROR_STATUS,
  type ErrorCode,
  type GameEvent,
  NewGameRequest,
  PassRequest,
  PlayRequest,
  ResignRequest,
  SetRankRequest,
  UndoRequest,
} from '@goko/protocol';
import type { EventBus } from './events.ts';
import { mintToken } from './livekit.ts';
import type { GameService } from './service.ts';
import type { SessionManager } from './sessions.ts';

export type AppDeps = {
  service: GameService;
  sessions: SessionManager;
  bus: EventBus;
  appKey: string;
  livekit: { url: string; apiKey: string; apiSecret: string; agentName: string };
  heartbeatMs?: number;
  log?: (line: string) => void;
};

// Пустое тело (POST без JSON) — это {}: схемы подставят defaults.
async function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { service, sessions, bus } = deps;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const fail = (c: Context, code: ErrorCode, message: string, details?: Record<string, unknown>) =>
    c.json({ error: { code, message, ...(details ? { details } : {}) } }, ERROR_STATUS[code] as ContentfulStatusCode);

  app.get('/health', (c) => c.json({ ok: true, games: service.list().length, sessions: sessions.list().length }));

  app.use('/api/*', async (c, next) => {
    if (c.req.header('x-app-key') !== deps.appKey) return fail(c, 'unauthorized', 'нет или неверный X-App-Key');
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as ContentfulStatusCode);
    if (err instanceof ZodError) return fail(c, 'bad_request', 'тело запроса не по схеме', { issues: err.issues });
    deps.log?.(`[X] game-server: ${err.stack ?? err.message}`);
    return fail(c, 'internal', 'внутренняя ошибка сервера');
  });

  app.notFound((c) => fail(c, 'not_found', `нет маршрута ${c.req.method} ${c.req.path}`));

  // Поток SSE: initial уходит первым, дальше события канала, между ними heartbeat-комментарии.
  // onAbort и слушатель сигнала регистрируются ДО первой записи: запись блокируется, пока клиент
  // не прочитает, а отмена может прийти раньше.
  function sse(c: Context, channel: string, initial: GameEvent[]): Response {
    return streamSSE(c, async (stream: SSEStreamingApi) => {
      let open = true;
      let wake: (() => void) | null = null;
      const queue: GameEvent[] = [];
      const unsubscribe = bus.subscribe(channel, (event) => {
        queue.push(event);
        wake?.();
      });
      const stop = () => {
        open = false;
        unsubscribe();
        wake?.();
      };
      stream.onAbort(stop);
      c.req.raw.signal.addEventListener('abort', stop);
      try {
        for (const event of initial) await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        while (open && !stream.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              const timer = setTimeout(resolve, heartbeatMs);
              timer.unref();
            });
            wake = null;
          }
          if (!open || stream.aborted) break;
          const event = queue.shift();
          if (event) await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          else await stream.write(': ping\n\n');
        }
      } catch (e) {
        if (open && !stream.aborted) throw e; // запись в уже закрытое соединение — не ошибка
      } finally {
        stop();
      }
    });
  }

  const syncEvent = (gameId: string): GameEvent => ({ type: 'state.updated', state: service.get(gameId), cause: 'sync', by: 'system' });

  // ---- сессии ----
  app.post('/api/sessions', async (c) => {
    const session = sessions.create();
    const token = await mintToken({
      apiKey: deps.livekit.apiKey,
      apiSecret: deps.livekit.apiSecret,
      room: session.room,
      identity: `phone-${session.id}`,
      agentName: deps.livekit.agentName,
      sessionId: session.id,
    });
    return c.json({ session, livekit: { url: deps.livekit.url, token } });
  });

  app.post('/api/sessions/:sid/games', async (c) => {
    const sid = c.req.param('sid');
    sessions.get(sid);
    const req = NewGameRequest.parse(await body(c));
    const res = await service.create(req, { sessionId: sid });
    sessions.setGame(sid, res.state.id);
    return c.json(res);
  });

  app.get('/api/sessions/:sid/events', (c) => {
    const sid = c.req.param('sid');
    const session = sessions.get(sid);
    const gameId = session.currentGameId;
    return sse(c, `session:${sid}`, gameId ? [{ type: 'session.game', gameId }, syncEvent(gameId)] : []);
  });

  // ---- партии ----
  app.post('/api/games', async (c) => c.json(await service.create(NewGameRequest.parse(await body(c)))));
  app.get('/api/games', (c) => c.json({ games: service.list() }));
  app.get('/api/games/:id', (c) => c.json(service.get(c.req.param('id'))));
  app.post('/api/games/:id/play', async (c) => c.json(await service.play(c.req.param('id'), PlayRequest.parse(await body(c)))));
  app.post('/api/games/:id/pass', async (c) => c.json(await service.pass(c.req.param('id'), PassRequest.parse(await body(c)))));
  app.post('/api/games/:id/resign', async (c) => c.json(await service.resign(c.req.param('id'), ResignRequest.parse(await body(c)))));
  app.post('/api/games/:id/undo', async (c) => c.json(await service.undo(c.req.param('id'), UndoRequest.parse(await body(c)))));
  app.post('/api/games/:id/correct', async (c) => c.json(await service.correct(c.req.param('id'), CorrectRequest.parse(await body(c)))));
  app.post('/api/games/:id/rank', async (c) => c.json(await service.setRank(c.req.param('id'), SetRankRequest.parse(await body(c)))));
  app.post('/api/games/:id/analyze', async (c) => c.json(await service.analyze(c.req.param('id'), AnalyzeRequest.parse(await body(c)))));
  app.post('/api/games/:id/score', async (c) => c.json(await service.score(c.req.param('id'))));
  app.get('/api/games/:id/ascii', (c) => c.text(service.ascii(c.req.param('id'))));
  app.get('/api/games/:id/sgf', (c) => new Response(service.sgf(c.req.param('id')), { status: 200, headers: { 'content-type': 'application/x-go-sgf; charset=utf-8' } }));
  app.get('/api/games/:id/events', (c) => {
    const id = c.req.param('id');
    return sse(c, `game:${id}`, [syncEvent(id)]);
  });

  return app;
}
```

- [ ] **Step 4: Тест зелёный**

Run: `npx vitest run apps/game-server/src/app.test.ts`
Expected: PASS. Если тест «поток партии» виснет — `onAbort` зарегистрирован после первой записи или `stop()` не вызывает `unsubscribe`; если `count` после обрыва не `0` — не подписан слушатель `c.req.raw.signal`.

- [ ] **Step 5: `apps/game-server/src/main.ts`**

```ts
// Запуск game-server из env. FAKE_ENGINE=1 — без KataGo (тесты, smoke, разработка веба).
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { createEngineClient } from './engine-client.ts';
import { EventBus } from './events.ts';
import { createFakeEngine } from './fake-engine.ts';
import { GameService } from './service.ts';
import { SessionManager } from './sessions.ts';
import { GameStore } from './store.ts';

const env = process.env;
const root = path.resolve(import.meta.dirname, '../../..');
const log = (line: string) => console.error(line);

function need(name: string): string {
  const v = env[name];
  if (!v) {
    console.error(`[X] game-server: нужна переменная ${name} (см. infra/.env.example)`);
    process.exit(2);
  }
  return v;
}

const appKey = need('APP_KEY');
const livekit = { url: need('LIVEKIT_URL'), apiKey: need('LIVEKIT_API_KEY'), apiSecret: need('LIVEKIT_API_SECRET'), agentName: env.AGENT_NAME ?? 'goko' };
const fake = env.FAKE_ENGINE === '1';
const engine = fake ? createFakeEngine() : createEngineClient({ baseUrl: env.ENGINE_URL ?? 'http://127.0.0.1:8788', engineKey: need('ENGINE_KEY') });
if (fake) log('[!] game-server: FAKE_ENGINE=1, ходы случайные, KataGo не используется');

const bus = new EventBus();
const store = new GameStore(env.DATA_DIR ?? path.join(root, 'data/games'));
const service = new GameService({ store, engine, bus, log });
await service.init();
const sessions = new SessionManager({ max: Number(env.MAX_SESSIONS ?? 3), ttlMs: Number(env.SESSION_TTL_MS ?? 2 * 3600 * 1000) });
const app = createApp({ service, sessions, bus, appKey, livekit, log });

const port = Number(env.PORT ?? 8787);
const hostname = env.HOST ?? '127.0.0.1';
const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[OK] game-server на http://${info.address}:${info.port}; партий ${service.list().length}; движок ${fake ? 'fake' : env.ENGINE_URL ?? 'http://127.0.0.1:8788'}; агент ${livekit.agentName}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void service.close().finally(() => process.exit(0));
  });
}
```

Каталог `data/` уже в `.gitignore`.

- [ ] **Step 6: Ручной запуск**

Run: `FAKE_ENGINE=1 APP_KEY=dev LIVEKIT_URL=wss://lk.example LIVEKIT_API_KEY=k LIVEKIT_API_SECRET=secret-of-at-least-32-characters-long node apps/game-server/src/main.ts` (в PowerShell — через `$env:...` перед запуском или `--env-file=.env`).
Expected: `[!] ... FAKE_ENGINE=1` и `[OK] game-server на http://127.0.0.1:8787; ...`.

Run в другом терминале: `curl -s -X POST http://127.0.0.1:8787/api/games -H "x-app-key: dev" -H "content-type: application/json" -d "{\"black\":{\"controller\":\"human\"},\"white\":{\"controller\":\"engine\"}}"`
Expected: JSON со `state.status: "playing"`; после `Ctrl+C` сервер завершается, `data/games/<id>.json` на месте.

- [ ] **Step 7: Полная проверка и commit**

Run: `npm run check`
Expected: PASS по всем workspace'ам.

```bash
git add apps/game-server
git commit -m "game-server: HTTP-приложение по таблице протокола, SSE, запуск из env"
```

---
### Task 13: `npm run smoke`, `npm run dev`, документация команд

**Files:**
- Create: `scripts/smoke.mjs`, `scripts/dev.mjs`
- Modify: `package.json` (корень: скрипты `smoke`, `dev`), `CLAUDE.md` (строка «Стадия» и раздел «Команды»), `README.md` (раздел «Запуск»), `docs/README.md` (строка `superpowers/plans/`), `docs/NOW.md`

**Interfaces:**
- Consumes: `createClient` из `@goko/protocol`; `apps/game-server/src/main.ts` и `apps/go-engine/src/main.ts` с их переменными окружения (Task 8, Task 12).
- Produces: `npm run smoke [-- --real]` — код возврата 0 и строки `[OK]` на каждый шаг, ascii-доска; `npm run dev` — game-server `:8787`, go-engine `:8788` (или `FAKE_ENGINE=1` без `KATAGO_BIN`), плюс `web` и `voice-agent`, если есть `apps/web/package.json` и `apps/voice-agent/package.json` (их команды фиксирует план голоса и веба: `npm run dev --workspace apps/web` и `node apps/voice-agent/src/main.ts dev` с `AGENT_NAME=goko-dev`). Оба скрипта читают `.env` из корня через `process.loadEnvFile`.

- [ ] **Step 1: `scripts/smoke.mjs`**

```js
#!/usr/bin/env node
// Сценарная партия по HTTP против game-server: по умолчанию фейковый движок, с --real — go-engine + KataGo.
// Печатает [OK]/[X] на каждый шаг и ascii-доску; код возврата 0 только если все шаги прошли.
// Это глаза агента-разработчика: экран телефона он не видит.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@goko/protocol';

const root = path.resolve(import.meta.dirname, '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const real = process.argv.includes('--real');
const PORT = Number(process.env.SMOKE_PORT ?? 18787);
const ENGINE_PORT = Number(process.env.SMOKE_ENGINE_PORT ?? 18788);
const APP_KEY = 'smoke';
const children = [];
let stopping = false;
let failed = 0;

const ok = (msg) => console.log(`[OK] ${msg}`);
const fail = (msg) => {
  failed++;
  console.log(`[X] ${msg}`);
};
const check = (cond, msg) => {
  (cond ? ok : fail)(msg);
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) if (line) console.log(`  [${name}] ${line}`);
    });
  }
  child.on('exit', (code) => {
    if (!stopping) fail(`${name} завершился с кодом ${code}`);
  });
  children.push(child);
}

function stopAll() {
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
}

async function waitFor(pred, ms, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(step);
  }
  return false;
}

async function waitHealth(url, ms, pred = () => true) {
  return waitFor(async () => {
    try {
      const res = await fetch(url);
      return res.ok && pred(await res.json());
    } catch {
      return false;
    }
  }, ms, 300);
}

const dataDir = await mkdtemp(path.join(tmpdir(), 'goko-smoke-'));
try {
  if (real) {
    for (const name of ['KATAGO_BIN', 'ENGINE_KEY']) if (!process.env[name]) throw new Error(`--real: нужна переменная ${name} в .env`);
    start('go-engine', ['apps/go-engine/src/main.ts'], { ENGINE_PORT: String(ENGINE_PORT), ENGINE_HOST: '127.0.0.1' });
    if (!check(await waitHealth(`http://127.0.0.1:${ENGINE_PORT}/health`, 180_000, (h) => h.ok === true), 'go-engine: /health ok (KataGo запущен)')) throw new Error('движок не поднялся');
  }
  start('game-server', ['apps/game-server/src/main.ts'], {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    APP_KEY,
    DATA_DIR: dataDir,
    FAKE_ENGINE: real ? '' : '1',
    ENGINE_URL: `http://127.0.0.1:${ENGINE_PORT}`,
    ENGINE_KEY: process.env.ENGINE_KEY ?? 'unused',
    LIVEKIT_URL: process.env.LIVEKIT_URL ?? 'wss://lk.invalid',
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY ?? 'smoke',
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET ?? 'smoke-secret-of-at-least-32-characters',
  });
  if (!check(await waitHealth(`http://127.0.0.1:${PORT}/health`, 30_000), `game-server: /health на :${PORT} (движок ${real ? 'KataGo' : 'fake'})`)) throw new Error('game-server не поднялся');

  const client = createClient({ baseUrl: `http://127.0.0.1:${PORT}`, appKey: APP_KEY });
  const seats = { black: { controller: 'human' }, white: { controller: 'engine', rank: '10k' } };
  // Если ответ движка не уложился в 8 с (replyTimedOut), дожидаемся его по состоянию.
  const settled = async (id, res) => {
    if (!res.replyTimedOut) return res.state;
    let state = res.state;
    const done = await waitFor(async () => {
      state = await client.getGame(id);
      return !state.pendingEngineMove;
    }, 60_000);
    if (!done) throw new Error('движок так и не ответил');
    return state;
  };

  // --- партия 1: ход, исправление, откат, оценка, счёт, сдача ---
  const g1 = await client.createGame(seats);
  const id = g1.state.id;
  check(g1.state.status === 'playing' && g1.state.toPlay === 'B', `партия ${id} создана, ход чёрных`);

  const p1 = await client.play(id, { coord: 'D4' });
  let s = await settled(id, p1);
  check(p1.move.coord === 'D4' && s.moves.length === 2, `D4 сыгран, ответ Гоко ${s.moves[1]?.coord}`);

  const p2 = await client.play(id, { coord: 'K10' });
  s = await settled(id, p2);
  check(p2.move.n === 3 && s.moves.length === 4, `K10 сыгран, ответ ${s.moves[3]?.coord}`);

  const c1 = await client.correct(id, { coord: 'K4' });
  s = await settled(id, c1);
  check(c1.move.n === 3 && c1.move.coord === 'K4' && s.moves.length === 4 && s.moves[2]?.coord === 'K4', `correct K10 -> K4, новый ответ ${s.moves[3]?.coord}`);

  const u1 = await client.undo(id);
  check(u1.removed.length === 2 && u1.state.moves.length === 2 && u1.state.toPlay === 'B', 'undo снял пару ходов, ход чёрных');

  const a = await client.analyze(id);
  check(a.ownership.length === 169 && a.groups.length >= 1, `analyze: winrateB ${a.winrateB.toFixed(2)}, lead ${a.scoreLeadB.toFixed(1)}, групп ${a.groups.length}, topMoves ${a.topMoves.map((m) => m.coord).join(' ')}`);

  const sc = await client.score(id);
  const afterScore = await client.getGame(id);
  check(sc.reason === 'score' && sc.score !== undefined && afterScore.status === 'playing', `score без завершения: ${sc.winner}+${sc.margin}`);

  const r = await client.resign(id, { color: 'B', via: 'api' });
  check(r.state.status === 'finished' && r.state.result?.reason === 'resign' && r.state.result?.winner === 'W', 'resign: W+R');
  try {
    await client.play(id, { coord: 'E5' });
    fail('ход после сдачи прошёл');
  } catch (e) {
    check(e.code === 'game_finished' && e.status === 409, 'ход после сдачи -> 409 game_finished');
  }
  try {
    await client.play(id, { coord: 'I5' });
    fail('координата I5 принята');
  } catch (e) {
    check(e.code === 'invalid_coord' || e.code === 'game_finished', `I5 отвергнута (${e.code})`);
  }

  // --- партия 2: SSE, пасы, автосчёт ---
  const g2 = await client.createGame(seats);
  const id2 = g2.state.id;
  const ac = new AbortController();
  const events = [];
  const listening = (async () => {
    try {
      for await (const e of client.events({ gameId: id2 }, ac.signal)) events.push(e);
    } catch {
      // обрыв по abort
    }
  })();
  check(await waitFor(() => events.length >= 1, 3000), 'SSE: поток партии открыт');
  check(events[0]?.type === 'state.updated' && events[0]?.cause === 'sync', 'SSE: первым пришло состояние (sync)');

  const pp = await client.pass(id2, { via: 'api' });
  s = await settled(id2, pp);
  const engineReply = s.moves[1];
  check(engineReply !== undefined, `пас сыгран, ответ Гоко ${engineReply?.coord}`);
  if (engineReply?.coord === 'pass') {
    const finished = await waitFor(async () => (await client.getGame(id2)).status === 'finished', 60_000);
    const final = await client.getGame(id2);
    check(finished && final.result?.reason === 'score', `два паса -> автосчёт: ${final.result?.winner}+${final.result?.margin}`);
    check(await waitFor(() => events.some((e) => e.type === 'game.finished'), 3000), 'SSE: пришло game.finished');
  } else {
    ok(`Гоко на пас ответил ${engineReply?.coord}; доигрывать не будем, сдаёмся`);
    await client.resign(id2, { color: 'B', via: 'api' });
    check((await client.getGame(id2)).status === 'finished', 'resign завершил партию 2');
  }
  const updates = events.filter((e) => e.type === 'state.updated').length;
  check(updates >= 3, `SSE: событий state.updated ${updates}`);
  ac.abort();
  await listening;

  // --- текстовые представления первой партии ---
  console.log(await client.ascii(id));
  const sgf = await client.sgf(id);
  check(sgf.startsWith('(;FF[4]GM[1]') && sgf.includes('RE[W+R]') && sgf.includes(';B[dj]'), 'sgf первой партии: W+R, первый ход D4 = dj');
  check((await client.listGames()).games.length === 2, 'list_games: две партии');
} catch (e) {
  fail(`сценарий прерван: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  stopAll();
  await sleep(300);
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
console.log(failed ? `[X] smoke: ошибок ${failed}` : '[OK] smoke: все шаги прошли');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Корневой `package.json` — скрипты**

В `"scripts"` добавить:

```json
    "smoke": "node scripts/smoke.mjs",
    "dev": "node scripts/dev.mjs"
```

- [ ] **Step 3: Запустить smoke с фейковым движком**

Run: `npm run smoke`
Expected: все строки `[OK]`, в конце ascii-доска с `# <id> rev N finished toPlay ... moves 2` и `[OK] smoke: все шаги прошли`, код возврата 0. Проверка кода: `echo $LASTEXITCODE` (PowerShell) или `echo $?` (bash) — `0`.

Если `[X] game-server завершился с кодом 2` — не хватает переменной, текст подскажет какой (smoke подставляет заглушки `LIVEKIT_*`, но не `APP_KEY`, тот задан).

- [ ] **Step 4: Запустить smoke с настоящим KataGo** (только если `KATAGO_BIN` в `.env`)

Run: `npm run smoke -- --real`
Expected: `[OK] go-engine: /health ok`, дальше те же шаги; на пас Гоко на ранге 10k обычно отвечает ходом — ветка «доигрывать не будем, сдаёмся» тоже `[OK]`. Первый запуск может ждать тюнинг OpenCL до трёх минут.

- [ ] **Step 5: `scripts/dev.mjs`**

```js
#!/usr/bin/env node
// Локальная разработка одной командой: game-server :8787, go-engine :8788 (без KATAGO_BIN — FAKE_ENGINE=1),
// web :5173 и voice-agent goko-dev, если их каталоги уже есть. Логи с префиксом, Ctrl+C гасит всех.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const env = process.env;
const win = process.platform === 'win32';
const agentName = env.AGENT_NAME ?? 'goko-dev';
const procs = [];

function run(name, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], shell: win && cmd === 'npm' });
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) if (line) console.log(`[${name}] ${line}`);
    });
  }
  child.on('exit', (code, signal) => {
    console.log(`[${name}] завершился (${signal ?? code})`);
    if (code === 2) console.log(`[!] ${name}: не хватает переменных окружения, см. npm run doctor и infra/.env.example`);
  });
  procs.push({ name, child });
}

const hasKatago = Boolean(env.KATAGO_BIN);
if (hasKatago) run('go-engine', process.execPath, ['apps/go-engine/src/main.ts']);
else console.log('[!] KATAGO_BIN не задан: game-server с FAKE_ENGINE=1, ходы случайные');
run('game-server', process.execPath, ['apps/game-server/src/main.ts'], { AGENT_NAME: agentName, ...(hasKatago ? {} : { FAKE_ENGINE: '1' }) });

if (existsSync(path.join(root, 'apps/web/package.json'))) run('web', 'npm', ['run', 'dev', '--workspace', 'apps/web']);
else console.log('[!] apps/web ещё нет: веб не запускаем');
if (existsSync(path.join(root, 'apps/voice-agent/package.json'))) run('voice-agent', process.execPath, ['apps/voice-agent/src/main.ts', 'dev'], { AGENT_NAME: agentName });
else console.log('[!] apps/voice-agent ещё нет: агента не запускаем');

console.log(`[OK] dev: запущено ${procs.map((p) => p.name).join(', ')}; агент диспетчеризуется как ${agentName}; Ctrl+C останавливает всё`);

function stopAll() {
  for (const { child } of procs) {
    if (child.exitCode !== null) continue;
    // На Windows kill() не достаёт до внуков (npm -> vite): гасим дерево.
    if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[..] останавливаю');
    stopAll();
    setTimeout(() => process.exit(0), 800);
  });
}
```

- [ ] **Step 6: Проверить dev**

Run: `npm run dev` в одном терминале.
Expected: `[game-server] [OK] game-server на http://127.0.0.1:8787; ...; агент goko-dev`, при `KATAGO_BIN` — `[go-engine] [OK] go-engine на http://127.0.0.1:8788; ...`, две строки `[!] ... ещё нет`.

Run в другом: `curl -s http://127.0.0.1:8787/health` и (при движке) `curl -s http://127.0.0.1:8788/health`.
Expected: `{"ok":true,...}` от обоих. `Ctrl+C` в первом терминале — все процессы завершены, порты свободны (`curl` отвечает ошибкой соединения).

- [ ] **Step 7: `CLAUDE.md`**

Строку `- Стадия: 0 (спайк) не начата; кода ещё нет `[WIP]`` заменить на:

```
- Стадия: 1, ядро готово (`go-core`, `protocol`, `go-engine`, `game-server`, `smoke`, `dev`); голос и веб — план `docs/superpowers/plans/2026-09-07-goko-stage1-voice-web.md` `[WIP]`
```

Раздел `## Команды `[WIP]` (появятся на стадии 1, имена зафиксированы спекой)` заменить целиком на:

````
## Команды

```bash
npm run doctor   # Node, KATAGO_BIN, сети, env без печати значений
npm run check    # typecheck + unit (vitest по всем workspace'ам; линтера в v1 нет)
npm run smoke    # game-server с фейковым движком, сценарная партия по HTTP, ascii-доска; -- --real: с KataGo
npm run dev      # game-server :8787, go-engine :8788 (без KATAGO_BIN — FAKE_ENGINE=1), web :5173 и voice-agent goko-dev, если есть
node scripts/chat.mjs   # текстовый диалог с Гоко в комнате LiveKit (появится вместе с voice-agent)
```

Все проверки заканчиваются кодом возврата и печатают `[OK]`/`[X]`. Экран
телефона агент не видит: доверять только этим командам и тестам.
Контрактный тест движка (`apps/go-engine/src/katago.contract.test.ts`)
выполняется только при `KATAGO_BIN`, иначе `skipped`.
````

- [ ] **Step 8: `README.md` и `docs/README.md`**

В `README.md` строку `Статус: `[WIP]` спека написана, код ещё не начат. Стадии и критерии — в спеке.` заменить на `Статус: `[WIP]` стадия 1 — ядро (правила, протокол, движок, game-server) готово, партия играется по HTTP; голос и веб в работе. Стадии и критерии — в спеке.`

Раздел `## Запуск `[WIP]`` заменить на:

````
## Запуск

```bash
cp infra/.env.example .env   # заполнить APP_KEY, ENGINE_KEY, LIVEKIT_*; KATAGO_BIN — если KataGo есть на ПК
npm install
npm run doctor
npm run check
npm run smoke                # партия против фейкового движка по HTTP; npm run smoke -- --real — с KataGo
npm run dev                  # game-server :8787 (+ go-engine :8788 при KATAGO_BIN)
```

Для голоса нужен VPS с LiveKit (`infra/README.md`), ключ OpenAI и
voice-agent (план голоса и веба). KataGo и сети — `apps/go-engine/models/README.md`.
````

В `docs/README.md` строку таблицы `| `superpowers/plans/` | планы реализации (writing-plans) | `[WIP]` |` заменить на `| `superpowers/plans/` | планы реализации (writing-plans) | стадия 0, стадия 1 ядро, стадия 1 голос и веб |`.

- [ ] **Step 9: `docs/NOW.md`**

В `## Фокус` первый абзац заменить на:

```
Стадия 1. Ядро готово: `go-core`, `protocol`, `go-engine`, `game-server`,
`npm run smoke` и `npm run dev` зелёные (план
`superpowers/plans/2026-09-07-goko-stage1-core.md` выполнен). Следующий
план — голос и веб: `superpowers/plans/2026-09-07-goko-stage1-voice-web.md`.
```

В `## Следующий шаг` текст заменить на:

```
Выполнить план голоса и веба: voice-agent (инструменты, промпт, события,
`scripts/chat.mjs`), web (доска, лента, микрофон), Dockerfile'ы и сервисы
compose, `deploy.sh` со статикой, runbook. Затем приёмка founder'ом у доски.
```

В `## Сделано` добавить строку с сегодняшней датой: `- <дата>: стадия 1, ядро: правила и счёт, протокол и клиент, обёртка KataGo, game-server с сессиями и SSE, smoke и dev.`

- [ ] **Step 10: Полная проверка и commit**

Run: `npm run check && npm run smoke`
Expected: оба `[OK]`, код 0.

```bash
git add scripts/smoke.mjs scripts/dev.mjs package.json CLAUDE.md README.md docs/README.md docs/NOW.md
git commit -m "scripts: smoke и dev одной командой; доки: команды стадии 1"
```

---

## Самопроверка плана

- **Покрытие спеки.** Раздел 4 (модель партии, места, сессия) — Task 4 схемы, Task 9 переходы, Task 11 сессии. Раздел 5: таблица операций — Task 12 маршруты один в один, тела и ответы — Task 4, коды и статусы ошибок — `errors.ts` (Task 4) и `onError` (Task 8, Task 12); семантика `waitForReply`/`replyTimedOut`, `revision`/`expectedRevision`, `via`, правила `undo`, атомарный `correct`, два паса → автосчёт, сдача движка после 60-го хода — Task 10 (`GameService`, тесты `service.test.ts`); `Analysis` и `groups` — Task 3 (`groupsWithOwnership`) + Task 10 (`analyze`); события и порядок в потоке сессии (`session.game`, затем `sync`) — Task 12. Раздел 6 (`go-core`) — Task 1–3, включая `speakCoord`, кириллические двойники, отказ на `I`. Раздел 7 (`game-server`) — Task 9–12: `Map` + мьютекс, атомарная запись снапшотов, загрузка при старте, автоматика мест `engine` без повторной задачи на ту же ревизию, клиент движка с таймаутами 10/15/30 с и одним повтором, токены с `roomConfig.agents`, `X-App-Key`, лимит сессий и TTL. Раздел 8 (`go-engine`) — Task 6–8: один процесс analysis, очередь, перезапуск с паузой, `humanSLProfile` по рангу, выбор по `humanPolicy`, ownership в нашей индексации, счёт через `go-core`, `X-Engine-Key`, контрактный тест при `KATAGO_BIN`. Раздел 11 (локальная разработка) — Task 13 `dev.mjs`, `AGENT_NAME=goko-dev`. Раздел 12 (тестирование): все перечисленные сценарии `go-core`, `game-server`, `go-engine` есть в тестах соответствующих задач; `npm run check`/`smoke`/`doctor` с кодами возврата — Task 13 и план стадии 0. Не в этом плане (намеренно): `voice-agent`, `web`, `scripts/chat.mjs`, Dockerfile'ы приложений и compose-сервисы, runbook — план «стадия 1, голос и веб».
- **Заглушек нет.** Все файлы приведены целиком; «если» в шагах — только ветки на случай отсутствия `KATAGO_BIN` (контракт `skipped`, `dev` с `FAKE_ENGINE=1`) и обрыва соединения SSE.
- **Согласованность имён и типов.** `Position.ko: number | null` (индекс) в `go-core` и `GameState.ko: string | null` (координата) в протоколе — перевод в `applyMove`/`rebuild` (Task 9). `play(pos, color, coord)` возвращает `{ position, captured }`; `replay(size, moves)`; `IllegalMoveError.reason` → `details.reason` ошибки `illegal_move`. Схемы `Engine*` (Task 4) — единственный контракт между `go-engine` (Task 8) и `engine-client`/`fake-engine` (Task 10): `EngineGenmoveRequest.maxVisits` по умолчанию 10 = `GENMOVE_VISITS`; `EngineScoreResponse.ownership` в нашей индексации. `chooseMove` и `reorderFromKata` только в `go-engine`. `createClient` (Task 5) и маршруты `createApp` (Task 12) совпадают путями и телами; `smoke.mjs` (Task 13) вызывает только методы клиента из Task 5. `mintToken` (Task 11) выдаёт `roomJoin`, `roomCreate`, `room`, `roomConfig.agents[0].{agentName, metadata}`; `createSession` (Task 12) кладёт `identity = phone-<sessionId>`. Переменные окружения `main.ts` обоих приложений перечислены в `infra/.env.example` (Task 8 Step 7) и читаются `smoke.mjs`/`dev.mjs` из `.env`. Тайм-ауты: клиент движка 10/15/30 с (Task 10) короче серверных 20/30/60 с (Task 8) — клиент сдаётся первым, движок дорабатывает запрос без утечки.
