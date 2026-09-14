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
    return () => {
      c.abort();
      if (timer.current) clearTimeout(timer.current);
    };
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
      // Сессия сменилась (reset после not_found): поток новой сессии без партии не шлёт ничего,
      // и доска прежней партии иначе осталась бы на экране, а тапы уходили бы в партию чужой сессии.
      gameRef.current = null;
      setState(null);
      setGameId(null);
      setThinking(false);
      setConnected(false);
      setRetry(false);
    };
  }, [sessionId, onLost, flash]);

  // «Повторить» (D-0006): переоткрытие потока сессии заново запускает серию повторов сервера.
  // Лимит D-0012 общий на клиента: после rate_limited на тапе и «Повторить» не шлёт запрос раньше срока.
  // Паузу самого потока соблюдает streamEvents (его reopen до своего срока ничего не делает).
  const reopen = useCallback(() => {
    if (Date.now() < blockedUntil.current) return flash(humanText('rate_limited'));
    setRetry(false);
    stream.current?.reopen();
  }, [flash]);

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
  // Между session.game новой партии и её первым state.updated gameId уже новый, а state ещё старый: в этом окне
  // запрос ушёл бы в новую партию с ревизией старой, поэтому тоже «партии ещё нет».
  const act = useCallback(
    async (fn: (id: string, g: GameState, o: CallOptions) => Promise<unknown>, needTurn: boolean) => {
      if (!gameId || !state || state.id !== gameId) return flash('партии ещё нет');
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
