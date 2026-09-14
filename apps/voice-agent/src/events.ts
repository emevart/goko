// Озвучивание событий SSE (раздел 9 спеки). handleEvent — чистая функция: событие + память агента ->
// текст события для реплики или null. Текст — факт (D-0013): что уже на доске и что сказать вслух. Он уходит
// в историю разговора сообщением «Событие с экрана» (event-speech.ts), ответ модели — без инструментов.
// Просьб «назови ход» и формулировок, похожих на ход человека, который надо применить, в тексте нет:
// модель ставила такой ход сама через play_move. watchSession — цикл чтения потока сессии с переподключением
// и переоткрытием после retries_exhausted (D-0006).
// Паузы переподключения (RETRY_MS, STABLE_CONNECTION_MS, retryAfterMs) — общие с вебом, из @goko/protocol (задача 1).
import {
  ApiError,
  type GameEvent,
  type GameState,
  type GokoClient,
  type Move,
  RETRY_MS,
  STABLE_CONNECTION_MS,
  hasEngine,
  humanColorOf,
  humanText,
  retryAfterMs,
  seatColor,
} from '@goko/protocol';
import { colorName, colorNameInstrumental, describeResult, speakMove, speakRank } from './phrases.ts';
import { type AgentState, forgetFinishIfReopened, noteFinishRevision } from './state.ts';

export const ERROR_REPEAT_MS = 30_000;
export const SESSION_EXPIRED_INSTRUCTIONS =
  'Сессия на сервере закончилась: истекла или сервер перезапущен. Скажи одной фразой, что эту игру отсюда не продолжить и нужно перезагрузить страницу.';

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
// Конец каждого текста события: дословная реплика. Кавычки внутри реплики не ставим.
const sayOnly = (phrase: string): string => `Скажи вслух только: «${phrase}».`;

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

// Чей ход вслух: «твой ход» человеку, «мой ход» — ход Гоко, в партии двух людей — цвет.
function turnSpoken(g: GameState): string {
  if (!hasEngine(g)) return `ходят ${colorName(g.toPlay)}`;
  return g.toPlay === humanColorOf(g) ? 'твой ход' : 'мой ход';
}

// Ход человека тапом — уже на доске: «Человек тапом на экране сыграл дэ четыре, ход уже на доске.»
function tapFact(coord: string): string {
  return coord === 'pass' ? 'Человек тапом на экране спасовал, пас уже записан.' : `Человек тапом на экране сыграл ${speakMove(coord)}, ход уже на доске.`;
}

// Ход Гоко вслух: «Ка десять», «Пас».
const moveSpoken = (coord: string): string => capitalize(speakMove(coord));

// Ход движка, которого ждали: после тапа — оба хода, после таймаута инструмента — только ход Гоко. Флаги снимаются.
// Не ждали (ответ на голосовой ход уже вернул инструмент) — null. Общая фраза для события engine и для sync,
// в разрыве перед которым движок сходил. Ход человека — по позиции (prev, предпоследний ход): в разрыве потока
// человек мог тапнуть ещё раз, и запомненный тап устарел. Без предыдущего хода — по запомненному тапу.
function engineReplyText(state: AgentState, last: Move, prev: Move | undefined): string | null {
  const tap = state.lastTap;
  const awaiting = state.awaitingReply;
  resetTurnFlags(state);
  const said = sayOnly(moveSpoken(last.coord));
  if (tap) {
    const reply = last.coord === 'pass' ? 'Твой ответ — пас, он уже сделан.' : `Твой ответ ${speakMove(last.coord)} уже на доске.`;
    return `${tapFact((prev ?? tap).coord)} ${reply} ${said}`;
  }
  if (awaiting) return `${last.coord === 'pass' ? 'Твой ход — пас, он уже сделан.' : `Твой ход ${speakMove(last.coord)} уже на доске.`} ${said}`;
  return null;
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
  // Последний ход, который поток уже показывал по этой партии; null — не показывал (или только другую партию).
  const seen = state.seenMove?.gameId === g.id ? state.seenMove.n : null;
  state.seenMove = { gameId: g.id, n: last?.n ?? 0 };
  // Последний ход новее показанного: сделан в разрыве потока. Не знаем, что показывали, — считаем новым.
  const madeInGap = seen === null || (last?.n ?? 0) > seen;

  // Партия снова идёт: отмена (кнопкой на экране или инструментом — via не важен) или снимок нового подключения
  // (отмена могла случиться в разрыве). Итог, известный на ревизии не новее, устарел (state.ts). Только undo и
  // sync: запоздавшее событие хода после resign инструментом тоже приходит с идущей партией.
  if (g.status === 'playing' && (ev.cause === 'undo' || ev.cause === 'sync')) forgetFinishIfReopened(state, g.id, g.revision);

  if (g.status === 'finished') {
    noteFinishRevision(state, g.id, g.revision); // следом придёт game.finished: ревизия его итога
    resetTurnFlags(state);
    return null; // объявит game.finished
  }

  switch (ev.cause) {
    case 'sync':
      if (fresh) {
        resetTurnFlags(state);
        return `Продолжаем партию, позиция уже на доске: ${seatsText(g)}, сделано ходов: ${g.moves.length}, ${whoseTurn(g)}. Ходов не называй. ${sayOnly(`Продолжаем партию, ${turnSpoken(g)}`)}`;
      }
      // Переподключение к знакомой партии: сверяем ожидание хода движка с присланной позицией (I1).
      // Движок ещё думает — ответ впереди. Прежнее ожидание остаётся. Без него ждём, только если ход человека
      // сделан в разрыве: ход, который поток уже показал, был голосовым, и ответ на него вернёт инструмент.
      if (g.pendingEngineMove) {
        if (madeInGap && !state.lastTap) state.awaitingReply = true;
        return null;
      }
      // Ждали ответа, и последний ход — новый ход движка: он случился в разрыве, называем его той же фразой.
      // Иначе ответа ждать нечего (в разрыве сходил человек, отменили ход движка, партия двух людей): флаги
      // снимаем молча, чтобы старый ход не прозвучал как новый, а старый тап не приклеился к следующему ответу.
      if (last && madeInGap && (state.lastTap || state.awaitingReply) && last.color === seatColor(g.seats, 'engine')) {
        return engineReplyText(state, last, g.moves.at(-2));
      }
      resetTurnFlags(state);
      return null;
    case 'new': {
      resetTurnFlags(state);
      // У сервера new всегда by 'system' без via: отличить кнопку на экране от start_game можно только
      // по памяти агента. Событие обгоняет ответ HTTP, поэтому смотрим и на идущий start_game.
      if (state.startingGame) state.toolGames.add(g.id);
      if (state.toolGames.has(g.id)) return null;
      const engineColor = seatColor(g.seats, 'engine');
      if (engineColor === null) {
        return `Человек начал с экрана новую партию двух людей, она уже на доске: ты в ней не играешь, только комментируешь и выполняешь просьбы за того, чей ход. ${sayOnly(`Новая партия, ${turnSpoken(g)}`)}`;
      }
      const engineSeat = g.seats[engineColor];
      const rank = engineSeat.rank ? speakRank(engineSeat.rank) : null;
      state.awaitingReply = g.pendingEngineMove;
      const spoken = `Новая партия: ты играешь ${colorNameInstrumental(humanColorOf(g))}${rank ? `, я — ${rank}` : ''}, ${g.pendingEngineMove ? 'мой ход первый' : 'твой ход'}`;
      return `Человек начал новую партию с экрана, она уже на доске: ${seatsText(g)}, Гоко — ${rank ?? 'без ранга'}. ${g.pendingEngineMove ? 'Первый ход твой, его назовёт следующее событие: пока не выдумывай.' : 'Первый ход человека.'} ${sayOnly(spoken)}`;
    }
    case 'play':
    case 'pass':
    case 'correct': {
      if (ev.by === 'external' && last) {
        const fact = last.coord === 'pass' ? 'Соперник спасовал, пас уже записан.' : `Соперник сыграл ${speakMove(last.coord)}, ход уже на доске.`;
        return `${fact} ${sayOnly(`Соперник: ${speakMove(last.coord)}`)}`;
      }
      if (ev.via !== 'tap' || !last) return null; // голосовой ход уже вернул инструмент
      if (g.pendingEngineMove) {
        state.lastTap = { cause: ev.cause, coord: last.coord };
        return null;
      }
      return `${tapFact(last.coord)} ${sayOnly(moveSpoken(last.coord))}`;
    }
    case 'undo':
      resetTurnFlags(state);
      if (ev.via !== 'tap') return null;
      // Ход Гоко после отмены назовёт событие хода движка: вслух — только «Ход отменён».
      return `Человек отменил последний ход кнопкой на экране, отмена уже на доске, ${whoseTurn(g)}. ${sayOnly(hasEngine(g) && g.toPlay !== humanColorOf(g) ? 'Ход отменён' : `Ход отменён, ${turnSpoken(g)}`)}`;
    case 'engine': {
      if (!last) return null;
      // humanFallback есть только здесь (D-0007): get_position скажет о таком ходе, пока он на доске.
      // Ход с тем же или меньшим номером без признака значит, что прежний ход сняли или заменили.
      if (ev.humanFallback) state.fallbackMove = last.n;
      else if (state.fallbackMove !== null && last.n <= state.fallbackMove) state.fallbackMove = null;
      return engineReplyText(state, last, g.moves.at(-2));
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
      // Партия сменилась (подключение агента к идущей партии, новая партия): следующий sync о ней — «Продолжаем»,
      // флаги прежней партии сброшены. Переподключение к уже знакомой партии флаги не трогает: ожидание хода
      // движка и fallbackMove переживают обрыв и переоткрытие после retries_exhausted, sync сверит их с позицией.
      if (ev.gameId !== state.gameId) {
        state.announceSync = ev.gameId;
        resetTurnFlags(state);
        state.fallbackMove = null;
      }
      state.gameId = ev.gameId;
      state.retriesExhausted = false; // открытие потока перезапускает серию повторов (D-0006)
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
      const result = describeResult(ev.result, state.humanColor);
      return `Партия окончена, итог уже записан: ${result}. ${sayOnly(`Партия окончена: ${result}`)}`;
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
        const reason = humanText(ev.code);
        return `Сервер перестал повторять попытки: ${reason}; следующая реплика человека сама запустит новую попытку. ${sayOnly(`${capitalize(reason.split(',')[0] ?? reason)}. Скажи или напиши что-нибудь, и я попробую снова`)}`;
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
  speak: (text: string) => Promise<void> | void; // текст события; реплику строит event-speech.ts
  signal: AbortSignal;
  log?: (line: string) => void;
  delaysMs?: readonly number[]; // паузы по попыткам, последняя — потолок; по умолчанию RETRY_MS
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type WatchHandle = {
  done: Promise<void>; // завершается по opts.signal (и при зависшей реплике) или после not_found (сессии больше нет)
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

  // Реплику ждём, пока сеанс не остановлен: зависший generateReply (сессия LiveKit закрывается) не держит done.
  // Отказ реплики ловится и после остановки — иначе он стал бы unhandled rejection.
  const say = async (instructions: string) => {
    const reply = (async () => opts.speak(instructions))().catch((e: unknown) => {
      log(`[!] voice-agent: generateReply не удался: ${failureText(e)}`);
    });
    let wake: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      wake = resolve;
      if (opts.signal.aborted) resolve();
      else opts.signal.addEventListener('abort', wake, { once: true });
    });
    try {
      await Promise.race([reply, stopped]);
    } finally {
      opts.signal.removeEventListener('abort', wake);
    }
  };

  // Сбой обработчика на одном событии — не обрыв потока: событие пропускаем, чтение продолжаем.
  const react = (ev: GameEvent): string | null => {
    try {
      return handleEvent(ev, opts.state, now); // те же часы, что у пауз: троттлинг ошибок в тестах без Date.now
    } catch (e) {
      log(`[X] voice-agent: событие ${ev.type} пропущено, обработка упала: ${failureText(e)}`);
      return null;
    }
  };

  // До blockedUntil (rate_limited у инструментов или потока, D-0012) запрос к game-server не шлём: поток
  // остаётся открытым, retriesExhausted — выставленным, и переоткроет следующая реплика после срока.
  const humanSpoke = () => {
    if (!opts.state.retriesExhausted || reopening || !conn) return;
    const waitMs = opts.state.blockedUntil - now();
    if (waitMs > 0) {
      log(
        `[!] voice-agent: реплика человека после retries_exhausted, но game-server просил подождать (rate_limited) ещё ${Math.ceil(waitMs / 1000)} с; поток переоткроет следующая реплика`,
      );
      return;
    }
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
          const instructions = react(ev);
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
      // Не раньше Retry-After этого отказа и срока blockedUntil, который мог выставить инструмент (D-0012).
      await sleep(Math.max(retryAfter, delay, opts.state.blockedUntil - now()));
    }
  };

  return { done: run(), humanSpoke };
}
