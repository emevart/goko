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
  // Не предикат типа: ложный ответ предиката сузил бы last до undefined, хотя ход там есть, просто чужой.
  const byHuman = (m: Move): boolean => m.coord === coord && g.seats[m.color].controller === 'human';
  const last = g.moves.at(-1);
  const prev = g.moves.at(-2);
  if (last && byHuman(last)) return { state: g, move: last, ...(g.pendingEngineMove ? { replyTimedOut: true } : {}) };
  if (prev && last && byHuman(prev) && g.seats[last.color].controller === 'engine') return { state: g, move: prev, reply: last };
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
