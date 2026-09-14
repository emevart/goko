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
          // Подключение оборвали, пока шла реплика (humanSpoke, остановка): следующего события старого потока
          // не ждём — источник мог ещё не заметить отмену, и цикл висел бы на нём.
          if (current.signal.aborted) break;
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
