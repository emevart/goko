// Инструменты Гоко (таблица раздела 9 спеки). createToolFns — чистые функции над клиентом протокола,
// их тестируем с фейковым клиентом; createTools заворачивает их в llm.tool() со схемами zod.
// Никакой позиции в памяти: всё берётся из ответов game-server.
import { llm } from '@livekit/agents';
import { z } from 'zod';
import { coordToIndex, toAscii } from '@goko/go-core';
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
import { type AgentState, forgetFinishIfReopened, noteFinishRevision } from './state.ts';
import { IntentLedger, type MutationIntent } from './intent.ts';

export type ToolClient = Pick<
  GokoClient,
  'newGame' | 'play' | 'correct' | 'pass' | 'resign' | 'undo' | 'redo' | 'getGame' | 'ascii' | 'analyze' | 'setRank'
>;

export type ToolDeps = {
  awareness?: import('./board-awareness.ts').BoardAwareness;
  client: ToolClient;
  state: AgentState;
  signal?: AbortSignal; // сигнал сеанса воркера: уходит в каждый вызов клиента, долгоживущий — это можно (раздел 5 спеки)
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  intent?: IntentLedger;
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
// Хвост отказа хода, паса или поправки после таймаута или обрыва (sendMove): запрос мог дойти до сервера,
// поэтому модель не повторяет его сама. Слово — «пас» для паса, «ход» для хода и поправки, во всех трёх ветках.
// WAIT_NEXT — сказать человеку и ждать его слов: ревизия та же, хода в партии пока нет (notAppliedText), или
// перечитать партию не вышло, и записан ли ход, неизвестно (catch перечитывания в sendMove).
// LOOK_NEXT — сначала посмотреть позицию: партия изменилась, а хода в конце нет, что в ней — модель не знает
// (changedText).
const WAIT_NEXT = 'скажи человеку и дождись его слов';
const LOOK_NEXT = 'посмотри позицию и скажи человеку';
const noRepeatTail = (coord: string, next: string): string => `Не повторяй ${coord === 'pass' ? 'пас' : 'ход'} сам: ${next}`;
// Отмена после таймаута или обрыва не перечитывается: могла пройти, модель смотрит позицию.
const UNDO_UNKNOWN_TEXT = 'отмена могла пройти. Не повторяй отмену сам: посмотри позицию и скажи человеку';
const REDO_UNKNOWN_TEXT = 'возврат мог пройти. Не повторяй возврат сам: посмотри позицию и скажи человеку';
const STALE_GAME_TEXT = 'партия уже сменилась: посмотри текущую позицию и скажи человеку';
const STARTING_GAME_TEXT = 'новая партия уже создаётся: дождись результата';

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

// Сеть оборвалась или ответ пришёл не по протоколу (например, страница прокси). Факты undici в Node 22:
// соединение не открылось или закрылось до заголовков — TypeError 'fetch failed', оборвалось посреди тела
// ответа — TypeError 'terminated'. Остальные TypeError — баги кода.
function isNetworkError(e: unknown): boolean {
  return e instanceof HttpError || (e instanceof TypeError && (e.message === 'fetch failed' || e.message === 'terminated'));
}

// Ход человека coord в конце перечитанной партии после таймаута или обрыва: последним (ответа Гоко ещё нет
// или Гоко в партии нет) или предпоследним, а за ним ход Гоко. Иначе null: хода нет или после него были
// другие ходы. Пас человека перед ходом Гоко бывает и старым (пас, Гоко ответил, пас не дошёл), поэтому
// такой пас засчитывается, только если ходов стало не меньше чем на два больше, чем в последнем своём
// ответе по этой партии (known; null — своих ответов не было). Любой пас засчитывается, только если он
// цвета known.humanColor (humanColorOf последнего своего ответа): в партии двух людей (D-0005) пас бывает у
// обоих, а сервер пасует за того, чей ход. Ход по координате так не путается: чужой камень на ту же точку
// в конце партии не встанет.
function appliedMove(g: GameState, coord: string, known: { moves: number; humanColor: Color } | null): PlayResponse | null {
  // Не предикат типа: ложный ответ предиката сузил бы last до undefined, хотя ход там есть, просто чужой.
  const byHuman = (m: Move): boolean =>
    m.coord === coord && g.seats[m.color].controller === 'human' && (coord !== 'pass' || m.color === known?.humanColor);
  const last = g.moves.at(-1);
  const prev = g.moves.at(-2);
  if (last && byHuman(last)) return { state: g, move: last, ...(g.pendingEngineMove ? { replyTimedOut: true } : {}) };
  const newEnough = coord !== 'pass' || (known !== null && g.moves.length >= known.moves + 2);
  if (prev && last && byHuman(prev) && g.seats[last.color].controller === 'engine' && newEnough) return { state: g, move: prev, reply: last };
  return null;
}

const turnText = (g: GameState): string => (g.status === 'finished' ? 'партия окончена' : `сейчас ход: ${turnOf(g)}`);

// Ревизия та же: хода в партии пока нет. Запрос мог ещё дойти до сервера, поэтому модель не повторяет ход сама.
// prefix — причина отказа исходного вызова («сервер не отвечает» или «нет связи с сервером»).
function notAppliedText(prefix: string, g: GameState, coord: string): string {
  const what = coord === 'pass' ? 'паса' : `хода ${coord}`;
  return `${prefix}: ${what} в партии пока нет, ${turnText(g)}. ${noRepeatTail(coord, WAIT_NEXT)}`;
}

// Ревизия другая, а хода в конце партии нет: записан ли он, неизвестно — модель сначала смотрит позицию.
function changedText(prefix: string, g: GameState, coord: string): string {
  const what = coord === 'pass' ? 'паса в конце партии не видно' : `хода ${coord} в конце партии нет`;
  return `${prefix}, а партия за это время изменилась: ${what}, ${turnText(g)}. ${noRepeatTail(coord, LOOK_NEXT)}`;
}

export function createToolFns(deps: ToolDeps) {
  const { client, state, signal } = deps;
  const sleep = deps.sleep ?? abortableSleep;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const opts = { signal };

  const gameIsCurrent = (gameId: string, generation: number): boolean =>
    state.gameId === gameId && state.gameGeneration === generation;
  const resultIsCurrent = (gameId: string, generation: number, revision: number): boolean => {
    if (!gameIsCurrent(gameId, generation)) return false;
    const observed = state.observedRevision;
    return observed?.gameId !== gameId || observed.revision <= revision;
  };
  const staleGame = (): Fail => fail(STALE_GAME_TEXT);

  // Пауза, которую обрывает сигнал сеанса: ожидание итога не держит закрытый сеанс до FINISH_WAIT_MS.
  // Слушатель снимается после паузы: сигнал живёт весь сеанс, а пауз за одно ожидание — до 88.
  function abortableSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Отказ -> { ok: false, reason } по-русски (D-0007): message сервера английский и модели не отдаётся.
  // Три класса различаются: ответ сервера по протоколу, «сервер не отвечает» (таймаут клиента) и
  // «нет связи» (isNetworkError). Остальное — баг или отмена сигналом сеанса: пробрасываем в лог воркера,
  // человеку это не озвучивается.
  function reasonOf(e: unknown): Fail {
    if (e instanceof ApiError) {
      if (e.code === 'rate_limited') state.blockedUntil = Math.max(state.blockedUntil, now() + retryAfterMs(e.details));
      return fail(humanText(e.code, e.details));
    }
    if (e instanceof ClientTimeoutError) return fail(humanText(e.code));
    if (isNetworkError(e)) return fail(NETWORK_TEXT);
    throw e;
  }

  // Таймаут или обрыв: запрос мог дойти до сервера и выполниться, хотя ответа нет.
  const maybeDone = (e: unknown): boolean => e instanceof ClientTimeoutError || isNetworkError(e);

  // Retry-After ещё не прошёл: к серверу не идём (D-0012), модель получает ту же фразу, что на сам отказ.
  function blocked(): Fail | null {
    return now() < state.blockedUntil ? fail(humanText('rate_limited')) : null;
  }
  // Общее начало инструментов партии: партии нет или Retry-After не прошёл — готовый отказ; иначе id партии,
  // один на весь вызов (раньше resign и прочие перечитывали state.gameId перед каждым запросом).
  function gameGuard(): string | Fail {
    if (!state.gameId) return fail(NO_GAME);
    return blocked() ?? state.gameId;
  }

  // Последняя ревизия партии и число ходов в ней из ответов сервера инструментам. События потока сюда не
  // пишутся: state.updated о записанном ходе приходит раньше таймаута, и сверка в sendMove приняла бы
  // записанный ход за незаписанный.
  // humanColor — за кого пасовал бы инструмент по этой партии: в партии двух людей тот, чей ход, иначе человек.
  let seen: { gameId: string; revision: number; moves: number; humanColor: Color } | null = null;
  function note(g: GameState): GameState {
    if (!seen || seen.gameId !== g.id || seen.revision < g.revision) {
      seen = { gameId: g.id, revision: g.revision, moves: g.moves.length, humanColor: humanColorOf(g) };
    }
    return g;
  }

  // Ход, пас или поправка. Таймаут клиента или обрыв связи не значат, что хода нет: сервер мог записать его,
  // а ответ не дошёл. Повтор вслепую поставил бы камень второй раз или спасовал бы за человека, поэтому
  // партия перечитывается: та же ревизия — хода нет; иначе ход ищется в конце партии (appliedMove), а не
  // нашёлся — партия менялась, и модель сначала смотрит позицию.
  async function sendMove(gameId: string, generation: number, coord: string, call: () => Promise<PlayResponse>): Promise<PlayResponse | Fail> {
    const before = seen?.gameId === gameId ? { revision: seen.revision, moves: seen.moves, humanColor: seen.humanColor } : null;
    let prefix: string;
    try {
      const res = await call();
      if (!resultIsCurrent(gameId, generation, res.state.revision)) return staleGame();
      note(res.state);
      return res;
    } catch (e) {
      if (!gameIsCurrent(gameId, generation)) return staleGame();
      if (!maybeDone(e)) return reasonOf(e);
      prefix = reasonOf(e).reason;
    }
    let g: GameState;
    try {
      g = note(await client.getGame(gameId, opts));
      if (!resultIsCurrent(gameId, generation, g.revision)) return staleGame();
    } catch (e) {
      // Партию не видно: ход мог и дойти, модель всё равно его не повторяет.
      return fail(`${reasonOf(e).reason}. ${noRepeatTail(coord, WAIT_NEXT)}`);
    }
    if (g.revision === before?.revision) return fail(notAppliedText(prefix, g, coord));
    return appliedMove(g, coord, before) ?? fail(changedText(prefix, g, coord));
  }

  async function revisionFor(gameId: string, generation: number): Promise<number | Fail> {
    try {
      const g = await client.getGame(gameId, opts);
      if (!resultIsCurrent(gameId, generation, g.revision)) return staleGame();
      return note(g).revision;
    } catch (e) {
      if (!gameIsCurrent(gameId, generation)) return staleGame();
      return reasonOf(e);
    }
  }

  function moveResult(res: PlayResponse) {
    const { state: g, move, reply } = res;
    const finished = g.status === 'finished';
    state.awaitingReply = Boolean(res.replyTimedOut) && !finished;
    if (finished) {
      state.announcedFinish = g.id;
      noteFinishRevision(state, g.id, g.revision);
    }
    return {
      ok: true as const,
      yourMove: move.coord,
      yourMoveSpoken: speakMove(move.coord),
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
  // не больше 8 за FINISH_WAIT_MS. Отмена сеанса обрывает ожидание с причиной отмены: и паузу, и ожидание
  // Retry-After, в котором к серверу не ходим и сигнал клиента не срабатывает.
  async function waitFinished(g0: GameState, generation: number): Promise<GameState | Fail> {
    const gameId = g0.id;
    let g = g0;
    const started = now();
    let lastPoll = started;
    state.awaitingFinish = gameId;
    try {
      for (;;) {
        signal?.throwIfAborted();
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
        if (!resultIsCurrent(gameId, generation, g.revision)) return staleGame();
      }
    } finally {
      if (gameIsCurrent(gameId, generation) && state.awaitingFinish === gameId) state.awaitingFinish = null;
    }
  }

  return {
    async startGame(args: { my_color?: 'black' | 'white'; rank?: string; komi?: number }) {
      if (state.startingGame) return fail(STARTING_GAME_TEXT);
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
      const generation = state.gameGeneration;
      state.startingGame = true;
      try {
        const res = await client.newGame(
          state.sessionId,
          {
            black: human === 'B' ? humanSeat : engine,
            white: human === 'W' ? humanSeat : engine,
            settings: { komi },
            waitForReply: true,
            via: 'voice',
          },
          opts,
        );
        if (state.gameGeneration !== generation && state.gameId !== res.state.id) return staleGame();
        const observed = state.observedRevision;
        if (observed?.gameId === res.state.id && observed.revision > res.state.revision) return staleGame();
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
        if (state.gameGeneration !== generation) return staleGame();
        return reasonOf(e);
      } finally {
        state.startingGame = false;
      }
    },

    async playMove({ coord }: { coord: string }) {
      const gameId = gameGuard();
      if (typeof gameId !== 'string') return gameId;
      const generation = state.gameGeneration;
      const res = await sendMove(gameId, generation, coord, () => client.play(gameId, { coord, via: 'voice' }, opts));
      return 'state' in res ? moveResult(res) : res;
    },

    async correctLastMove({ coord }: { coord: string }) {
      const gameId = gameGuard();
      if (typeof gameId !== 'string') return gameId;
      const generation = state.gameGeneration;
      const res = await sendMove(gameId, generation, coord, () => client.correct(gameId, { coord, via: 'voice' }, opts));
      return 'state' in res ? moveResult(res) : res;
    },

    async pass() {
      const gameId = gameGuard();
      if (typeof gameId !== 'string') return gameId;
      const generation = state.gameGeneration;
      // Прежний итог этой партии устарел до отправки: пас принимается только в идущей партии, а итог нового
      // счёта может прийти из потока раньше ответа. Ревизии до ответа нет — забываем без сверки (null).
      forgetFinishIfReopened(state, gameId, null);
      const res = await sendMove(gameId, generation, 'pass', () => client.pass(gameId, { via: 'voice' }, opts));
      if (!('state' in res)) return res;
      let g = res.state;
      // Два паса подряд: сервер считает очки в фоне; итог ждём из потока, опрос — запасной путь.
      // Отказы опроса waitFinished разбирает сам; наружу из него идут только баг и отмена сигналом.
      const scoring = res.reply?.coord === 'pass' && g.status !== 'finished';
      if (scoring) {
        const waited = await waitFinished(g, generation);
        if (!('id' in waited)) return waited;
        g = waited;
      }
      if (!gameIsCurrent(gameId, generation)) return staleGame();
      const finished = g.status === 'finished';
      if (finished) {
        state.announcedFinish = g.id;
        noteFinishRevision(state, g.id, g.revision);
      }
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
      const gameId = gameGuard();
      if (typeof gameId !== 'string') return gameId;
      const generation = state.gameGeneration;
      try {
        // Цвет сдающегося — до хода: в партии двух людей это тот, чей ход (humanColorOf).
        const current = note(await client.getGame(gameId, opts));
        if (!resultIsCurrent(gameId, generation, current.revision)) return staleGame();
        const color = humanColorOf(current);
        const res = await client.resign(gameId, { color, via: 'voice' }, opts);
        if (!resultIsCurrent(gameId, generation, res.state.revision)) return staleGame();
        note(res.state);
        state.announcedFinish = res.state.id;
        noteFinishRevision(state, res.state.id, res.state.revision);
        state.awaitingReply = false;
        const who = hasEngine(current) ? color : null;
        return { ok: true as const, result: res.state.result ? describeResult(res.state.result, who) : 'партия сдана' };
      } catch (e) {
        if (!gameIsCurrent(gameId, generation)) return staleGame();
        return reasonOf(e);
      }
    },

    async undo() {
      const gameId = gameGuard();
      if (typeof gameId !== 'string') return gameId;
      const generation = state.gameGeneration;
      try {
        const revision = await revisionFor(gameId, generation);
        if (typeof revision !== 'number') return revision;
        const res = await client.undo(gameId, { via: 'voice', expectedRevision: revision }, opts);
        if (!resultIsCurrent(gameId, generation, res.state.revision)) return staleGame();
        note(res.state);
        // Удачная отмена возвращает партию в игру: итог, известный на ревизии старше ответа, устарел.
        forgetFinishIfReopened(state, gameId, res.state.revision);
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
        if (!gameIsCurrent(gameId, generation)) return staleGame();
        // Отмена могла пройти: перечитывание не скажет, чья она (две отмены подряд неотличимы), повтор снял бы
        // лишние ходы.
        const failed = reasonOf(e);
        return maybeDone(e) ? fail(`${failed.reason}: ${UNDO_UNKNOWN_TEXT}`) : failed;
      }
    },

    async redo() {
      const gameId = gameGuard();
      if (typeof gameId !== 'string') return gameId;
      const generation = state.gameGeneration;
      try {
        const revision = await revisionFor(gameId, generation);
        if (typeof revision !== 'number') return revision;
        const res = await client.redo(gameId, { via: 'voice', expectedRevision: revision }, opts);
        if (!resultIsCurrent(gameId, generation, res.state.revision)) return staleGame();
        const g = note(res.state);
        state.awaitingReply = false;
        state.awaitingFinish = null;
        state.lastTap = null;
        if (g.status === 'finished' && g.result) {
          state.announcedFinish = g.id;
          state.finished = { gameId: g.id, result: g.result };
          noteFinishRevision(state, g.id, g.revision);
        } else {
          forgetFinishIfReopened(state, g.id, g.revision);
        }
        return {
          ok: true as const,
          restored: res.restored.map((m) => m.coord),
          restoredSpoken: res.restored.map((m) => speakMove(m.coord)),
          toPlay: g.toPlay,
          status: g.status,
          ...finishedFields(g),
        };
      } catch (e) {
        if (!gameIsCurrent(gameId, generation)) return staleGame();
        const failed = reasonOf(e);
        return maybeDone(e) ? fail(`${failed.reason}: ${REDO_UNKNOWN_TEXT}`) : failed;
      }
    },

    async getPosition(): Promise<string> {
      const gameId = gameGuard();
      if (typeof gameId !== 'string') return gameId.reason;
      const generation = state.gameGeneration;
      let g: GameState;
      try {
        g = await client.getGame(gameId, opts);
      } catch (e) {
        if (!gameIsCurrent(gameId, generation)) return STALE_GAME_TEXT;
        return reasonOf(e).reason;
      }
      if (!resultIsCurrent(gameId, generation, g.revision)) return STALE_GAME_TEXT;
      note(g);
      const board = toAscii({
        size: g.settings.boardSize,
        board: g.board,
        ko: g.ko === null ? null : coordToIndex(g.ko, g.settings.boardSize),
        captures: g.captures,
      }, { lastMove: g.moves.at(-1)?.coord ?? null });
      const last = g.moves
        .slice(-6)
        .map((m) => `${m.n}. ${colorName(m.color)} ${m.coord === 'pass' ? 'пас' : m.coord}`)
        .join('; ');
      const turn = g.status === 'finished' ? 'партия окончена' : turnOf(g);
      // humanFallback приходит только событием state.updated хода движка (events.ts запоминает номер хода).
      const fallback = state.fallbackMove === null ? undefined : g.moves.find((m) => m.n === state.fallbackMove);
      return [
        `Ориентация: доска ${g.settings.boardSize} на ${g.settings.boardSize}; строки идут сверху от ${g.settings.boardSize} вниз до 1, столбцы слева направо A–N без I.`,
        `# ${g.id} rev ${g.revision} ${g.status} toPlay ${g.toPlay} moves ${g.moves.length}`,
        board.trimEnd(),
        `Последние ходы: ${last || 'нет'}`,
        `Пленные: чёрные сняли ${g.captures.B}, белые сняли ${g.captures.W}`,
        ...(fallback
          ? [`Ход ${fallback.n} (${colorName(fallback.color)} ${fallback.coord}) Гоко взял из основного поиска, а не из человеческой сети уровня: по силе он может отличаться от заявленного ранга`]
          : []),
        `Ход: ${turn}`,
      ].join('\n');
    },

    async getAssessment() {
      const gameId = gameGuard();
      if (typeof gameId !== 'string') return gameId;
      const generation = state.gameGeneration;
      let revisionController: AbortController | null = null;
      try {
        const g = await client.getGame(gameId, opts);
        if (!resultIsCurrent(gameId, generation, g.revision)) return staleGame();
        state.analysisAbort?.controller.abort(new Error('newer analysis started'));
        revisionController = new AbortController();
        const onSessionAbort = () => revisionController?.abort(signal?.reason);
        signal?.addEventListener('abort', onSessionAbort, { once: true });
        state.analysisAbort = { gameId, revision: g.revision, controller: revisionController };
        let a;
        try {
          a = deps.awareness?.cached(g) ?? await client.analyze(gameId, { maxVisits: ASSESSMENT_VISITS, expectedRevision: g.revision }, { signal: revisionController.signal });
        } finally {
          signal?.removeEventListener('abort', onSessionAbort);
          if (state.analysisAbort?.controller === revisionController) state.analysisAbort = null;
        }
        if (a.gameId !== gameId || a.revision !== g.revision || !resultIsCurrent(gameId, generation, a.revision)) return staleGame();
        note(g);
        const lead = a.scoreLeadB;
        // Одно округление до половины очка для обоих знаков; «поровну» — ровно когда округлённый отрыв 0.
        const marginPoints = Math.round(Math.abs(lead) * 2) / 2;
        const leaderColor: Color | null = marginPoints === 0 ? null : lead > 0 ? 'B' : 'W';
        const weak = a.groups.filter((gr) => gr.status !== 'safe');
        const statusText = (s: string) => (s === 'dead' ? 'мертва' : 'неустойчива');
        // Координаты и рядом их произношение: модель читает вслух *Spoken, а не латиницу.
        const place = (stones: string[]) => {
          const stonesSpoken = stones.map(speakMove);
          return { where: stones.join(', '), whereSpoken: stonesSpoken.join(', '), stones, stonesSpoken };
        };
        const top = a.topMoves.slice(0, 3);
        const bestMoves = top.map((m) => m.coord);
        const bestMovesSpoken = bestMoves.map(speakMove);
        const bestCandidates = top.map((m) => ({
          coord: m.coord,
          coordSpoken: speakMove(m.coord),
          winrateBlack: Math.round(m.winrateB * 100),
          scoreLeadBlack: m.scoreLeadB,
          visits: m.visits,
        }));
        const decision = state.engineDecision?.gameId === g.id ? state.engineDecision : null;
        const lastEngineDecision = decision ? {
          ...(decision.playerChoice ? {playerChoice: decision.playerChoice} : {}),
          moveN: decision.moveN,
          basedOnRevision: decision.basedOnRevision,
          rankCandidates: decision.rankCandidates.map((candidate) => ({ ...candidate, coordSpoken: speakMove(candidate.coord) })),
          continuations: decision.candidateAnalysis.map((candidate) => ({ ...candidate, coordSpoken: speakMove(candidate.coord), pvSpoken: candidate.pv.map(speakMove) })),
        } : undefined;
        if (!hasEngine(g)) {
          // Партия двух людей (D-0005): «ты» и «я» здесь не значат ничего, говорим цветами.
          return {
            leader: leaderColor === null ? ('even' as const) : colorKey(leaderColor),
            marginPoints,
            winrateBlack: Math.round(a.winrateB * 100),
            weakGroups: weak.map((gr) => ({ color: colorKey(gr.color), ...place(gr.stones), liberties: gr.liberties, status: statusText(gr.status) })),
            bestMoves,
            bestMovesSpoken,
            bestCandidates,
            ...(lastEngineDecision ? { lastEngineDecision } : {}),
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
            ...place(gr.stones),
            liberties: gr.liberties,
            status: statusText(gr.status),
          })),
          bestMoves,
          bestMovesSpoken,
          bestCandidates,
          ...(lastEngineDecision ? { lastEngineDecision } : {}),
          toPlay: g.toPlay === human ? ('you' as const) : ('me' as const),
        };
      } catch (e) {
        if (revisionController?.signal.aborted && !signal?.aborted) return staleGame();
        if (!gameIsCurrent(gameId, generation)) return staleGame();
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
      const gameId = gameGuard();
      if (typeof gameId !== 'string') return gameId;
      const generation = state.gameGeneration;
      try {
        const g = note(await client.getGame(gameId, opts));
        if (!resultIsCurrent(gameId, generation, g.revision)) return staleGame();
        if (!hasEngine(g)) {
          state.rank = parsed;
          return { ok: true as const, rank: speakRank(parsed), note: 'в этой партии нет Гоко: уровень применится к следующей' };
        }
        await client.setRank(gameId, { color: engineColorOf(g), rank: parsed }, opts);
        if (!gameIsCurrent(gameId, generation)) return staleGame();
        state.rank = parsed;
        return { ok: true as const, rank: speakRank(parsed) };
      } catch (e) {
        if (!gameIsCurrent(gameId, generation)) return staleGame();
        return reasonOf(e);
      }
    },
  };
}

export type ToolFns = ReturnType<typeof createToolFns>;

// Обёртки для модели. Описания — часть промпта: модель читает их при выборе инструмента.
export function createTools(deps: ToolDeps) {
  const fns = createToolFns(deps);
  const ledger = deps.intent ?? new IntentLedger();
  const guarded = <T extends { user_utterance: string }, R>(intent: MutationIntent, run: (args: Omit<T, 'user_utterance'>) => Promise<R>) => async (args: T) => {
    const { user_utterance: _utterance, ...rest } = args;
    const permit = await ledger.consume(intent, args.user_utterance, rest, 1_500, deps.signal);
    if (!permit.ok) return permit;
    return run(rest as Omit<T, 'user_utterance'>);
  };
  const utterance = z.string().min(1).describe('Полная дословная последняя реплика человека, вызвавшая это действие');
  return {
    start_game: llm.tool({
      description:
        'Начать новую партию 13x13. my_color — цвет человека: black (чёрные, ходит первым) или white (белые; тогда Гоко ходит первым, его ход в firstMove). rank — уровень Гоко, например «10 кю» или «2 дан»; без него — прежний. komi — число с половиной от 0.5 до 13.5, по умолчанию 7.5.',
      parameters: z.object({
        my_color: z.enum(['black', 'white']).optional(),
        rank: z.string().optional(),
        komi: z.number().optional(),
        user_utterance: utterance,
      }),
      execute: guarded('start_game', (args) => fns.startGame({ ...args, rank: args.rank?.trim() || undefined })),
    }),
    play_move: llm.tool({
      description: 'Применить ход человека. coord — латиницей: буква столбца A–N без I и число 1–13, например D4. Ответный ход Гоко приходит в myMove.',
      parameters: z.object({ coord: z.string().describe('Например D4'), user_utterance: utterance }),
      execute: guarded('play_move', (args) => fns.playMove(args)),
    }),
    correct_last_move: llm.tool({
      description: 'Человек поправил свой последний ход («нет, дэ пять»): заменить его на coord. Ответ как у play_move.',
      parameters: z.object({ coord: z.string().describe('Например D5'), user_utterance: utterance }),
      execute: guarded('correct_last_move', (args) => fns.correctLastMove(args)),
    }),
    pass: llm.tool({
      description: 'Человек пасует. Если Гоко тоже пасует, партия завершается и приходит result.',
      parameters: z.object({ user_utterance: utterance }),
      execute: guarded('pass', () => fns.pass()),
    }),
    resign: llm.tool({
      description: 'Человек сдаётся (в партии двух людей — тот, чей сейчас ход). Возвращает result.',
      parameters: z.object({ user_utterance: utterance }),
      execute: guarded('resign', () => fns.resign()),
    }),
    undo: llm.tool({
      description: 'Отменить последний ход человека и ответ Гоко («отмени», «верни ход»).',
      parameters: z.object({ user_utterance: utterance }),
      execute: guarded('undo', () => fns.undo()),
    }),
    redo: llm.tool({
      description: 'Вернуть ровно последнюю отменённую порцию ходов («верни отменённое», «вперёд»). Если восстановлен итог, объявить result; иначе сказать, чей ход.',
      parameters: z.object({ user_utterance: utterance }),
      execute: guarded('redo', () => fns.redo()),
    }),
    get_position: llm.tool({
      description: 'Текущая позиция: размер и ориентация ASCII-доски, последние ходы, пленные, чей ход. Зови, когда спрашивают о доске или ты не уверен, что было.',
      execute: () => fns.getPosition(),
    }),
    get_assessment: llm.tool({
      description: 'Оценка позиции: кто впереди и на сколько, слабые группы со всеми камнями и свободами, кандидаты с оценками. Кандидаты и оценки называй только по прямой просьбе подсказать ход.',
      execute: () => fns.getAssessment(),
    }),
    set_rank: llm.tool({
      description: 'Сменить уровень Гоко: rank словами человека, например «5 кю», «1 дан».',
      parameters: z.object({ rank: z.string(), user_utterance: utterance }),
      execute: guarded('set_rank', (args) => fns.setRank(args)),
    }),
  };
}

export type GokoTools = ReturnType<typeof createTools>;
