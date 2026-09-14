// Партия на экране: состояние из SSE сессии, действия тапами через тот же протокол, что и голос.
// Проверка «чей ход» — только по полям состояния; правил го здесь нет.
// Поток сессии несёт только текущую партию; engine.thinking и error чужой партии (гонка при смене партии) не показываем.
// Запросы идут с signal жизни компонента: после размонтирования ответ не трогает состояние и ошибку не показывает.
// rate_limited (D-0012): до Retry-After тапы запросов не шлют, а сразу показывают ту же фразу.
import { useCallback, useEffect, useRef, useState } from 'react';
import { type CallOptions, type GameState, humanColorOf, humanText } from '@goko/protocol';
import { client } from '../api.ts';
import { type Prefs, newGameRequest } from '../prefs.ts';
import { type StreamHandle, needsRetry, streamEvents } from '../stream.ts';
import { type SentMove, actionRefusal, describeError, retryDelayMs, sendTapMove } from '../text.ts';
import { guardedGameResponse, historyRequest, thinkingAfterMutationResponse } from '../game-response.ts';

const MESSAGE_MS = 3000;

export function useGame(sessionId: string | null, onLost: () => void, trace: (type: string, payload?: unknown) => void = () => {}) {
  const [state, setState] = useState<GameState | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stream = useRef<StreamHandle | null>(null);
  const gameRef = useRef<string | null>(null);
  const stateRef = useRef<GameState | null>(null);
  const blockedUntil = useRef(0);
  // Защита от второго тапа (m1): действие в пути и последний записанный ход тапом. Ref, а не состояние: тап в том же
  // кадре, до перерисовки, видит уже выставленную отметку.
  const playInFlight = useRef(false);
  const mutationInFlight = useRef(false);
  const mutationSequence = useRef(0);
  const sent = useRef<SentMove | null>(null);
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
        trace('game.event', ev.type === 'state.updated'
          ? { type: ev.type, cause: ev.cause, gameId: ev.state.id, revision: ev.state.revision, moves: ev.state.moves.length }
          : { type: ev.type, gameId: 'gameId' in ev ? ev.gameId : undefined });
        setRetry((r) => needsRetry(r, ev));
        switch (ev.type) {
          case 'session.game':
            gameRef.current = ev.gameId;
            setGameId(ev.gameId);
            break;
          case 'state.updated':
            gameRef.current = ev.state.id;
            stateRef.current = ev.state;
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
      stateRef.current = null;
      setState(null);
      setGameId(null);
      setThinking(false);
      setConnected(false);
      setRetry(false);
      mutationSequence.current++;
      mutationInFlight.current = false;
      setMutating(false);
    };
  }, [sessionId, onLost, flash, trace]);

  // «Повторить» (D-0006): переоткрытие потока сессии заново запускает серию повторов сервера.
  // Лимит D-0012 общий на клиента: после rate_limited на тапе и «Повторить» не шлёт запрос раньше срока.
  // Паузу самого потока соблюдает streamEvents (его reopen до своего срока ничего не делает).
  const reopen = useCallback(() => {
    if (Date.now() < blockedUntil.current) return flash(humanText('rate_limited'));
    setRetry(false);
    stream.current?.reopen();
  }, [flash]);

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

  // Действие над текущей партией. Отказ без запроса — actionRefusal (нет партии, партия окончена, не черёд, действие
  // в пути); иначе fn получает id партии и состояние уже проверенными, и действиям не нужны gameId! и state!.
  // Второе действие, пока первое в пути, не уходит: ход тапом со старой ревизией получил бы 409 (m1).
  const act = useCallback(
    async (fn: (id: string, g: GameState, o: CallOptions) => Promise<unknown>, needTurn: boolean) => {
      const refusal = actionRefusal(state, gameId, needTurn, playInFlight.current || mutationInFlight.current, sent.current);
      if (refusal !== null) return refusal ? flash(refusal) : undefined;
      if (!gameId || !state) return; // уже проверено в actionRefusal; здесь — для сужения типов
      playInFlight.current = true;
      try {
        await request((o) => fn(gameId, state, o));
      } finally {
        playInFlight.current = false;
      }
    },
    [gameId, state, flash, request],
  );

  // Состояние из ответа хода или перечитывания: не затирает более новое из потока и не рисуется,
  // если текущая партия сессии уже другая.
  const applyState = useCallback((actual: GameState) => {
    const accepted = guardedGameResponse(gameRef.current, stateRef.current, actual);
    if (!accepted) return null;
    stateRef.current = accepted;
    setState(accepted);
    return accepted;
  }, []);

  const mutate = useCallback(
    async (fn: (id: string, g: GameState, o: CallOptions) => Promise<{ state: GameState }>, allowDuringPlay: boolean) => {
      if (!gameId || !state) return flash('партии ещё нет');
      if (mutationInFlight.current || (!allowDuringPlay && playInFlight.current)) return;
      mutationInFlight.current = true;
      const operation = ++mutationSequence.current;
      setMutating(true);
      const targetId = gameId;
      try {
        await request(async (o) => {
          const response = await fn(targetId, state, o);
          const accepted = applyState(response.state);
          setThinking((value) => thinkingAfterMutationResponse(value, accepted));
        });
      } finally {
        if (mutationSequence.current === operation) {
          mutationInFlight.current = false;
          setMutating(false);
        }
      }
    },
    [gameId, state, flash, request, applyState],
  );

  // Ход и пас тапом. Ответ записанного хода рисуется сразу, не дожидаясь события потока, а отметка sent держит следующий
  // ход, пока на экране состояние не новее отправленной ревизии. Таймаут клиента не значит, что ход не записан: запрос
  // не повторяется, партия перечитывается и рисуется как есть (sendTapMove); та же ревизия — ещё и фраза «ход пока не записан».
  const tapMove = useCallback(
    (send: (id: string, revision: number, o: CallOptions) => Promise<{ state: GameState }>) =>
      act(async (id, before, o) => {
        const reread = await sendTapMove(
          client,
          before,
          async (opts) => {
            const res = await send(id, before.revision, opts);
            sent.current = { gameId: id, revision: before.revision };
            applyState(res.state);
          },
          o,
        );
        if (!reread || gameRef.current !== reread.state.id) return;
        applyState(reread.state);
        if (reread.text) flash(reread.text);
      }, true),
    [act, applyState, flash],
  );
  const play = useCallback(
    (coord: string) => tapMove((id, revision, o) => client.play(id, { coord, via: 'tap', expectedRevision: revision, waitForReply: false }, o)),
    [tapMove],
  );
  const pass = useCallback(() => tapMove((id, revision, o) => client.pass(id, { via: 'tap', expectedRevision: revision, waitForReply: false }, o)), [tapMove]);
  const undo = useCallback(() => mutate((id, g, o) => client.undo(id, historyRequest(g.revision, 'tap'), o), true), [mutate]);
  const redo = useCallback(() => mutate((id, g, o) => client.redo(id, historyRequest(g.revision, 'tap'), o), true), [mutate]);
  const resign = useCallback(() => mutate((id, g, o) => client.resign(id, { color: humanColorOf(g), via: 'tap' }, o), false), [mutate]);

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

  const canUndo = Boolean(state && ((state.status === 'playing' && state.moves.length > 0) || (state.status === 'finished' && state.result?.reason === 'score')));
  const canRedo = Boolean(state?.canRedo);
  const canResign = state?.status === 'playing';
  return { state, gameId, thinking, connected, retry, message, mutating, play, pass, undo, redo, resign, newGame, reopen, canUndo, canRedo, canResign };
}
