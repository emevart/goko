// Типизированный клиент game-server. Им пользуются voice-agent, web, mcp-server и scripts/.
import type { z } from 'zod';
import { ClientTimeoutError, HttpError, apiErrorFromBody } from './errors.ts';
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

// Потолок ожидания ответа по операциям (раздел 5 спеки), в миллисекундах. Операции, которые
// ждут ответ движка (play, pass, correct_last_move, новая партия), и analyze — 15 с: выше 8 с
// ожидания хода и 10 с бюджета analyze на сервере; score — 25 с при бюджете сервера 20 с.
export const CLIENT_TIMEOUTS = {
  create_session: 5_000,
  session_new_game: 15_000,
  create_game: 15_000,
  get_game: 5_000,
  list_games: 5_000,
  play: 15_000,
  pass: 15_000,
  resign: 5_000,
  undo: 5_000,
  correct_last_move: 15_000,
  set_rank: 5_000,
  analyze: 15_000,
  score: 25_000,
  render: 5_000,
  sgf: 5_000,
} as const satisfies Record<string, number>;
export type ClientOperation = keyof typeof CLIENT_TIMEOUTS;

export type ClientOptions = {
  baseUrl: string; // https://<WEB_HOST> или http://127.0.0.1:8787
  appKey: string;
  fetch?: typeof globalThis.fetch;
  // Переопределение потолка отдельных операций; остальные берут CLIENT_TIMEOUTS.
  timeoutMs?: Partial<Record<ClientOperation, number>>;
};

// Отмена вызова снаружи: исключение — причина сигнала (по умолчанию AbortError), не ClientTimeoutError.
export type CallOptions = { signal?: AbortSignal };

export type EventsTarget = { sessionId: string } | { gameId: string };

async function toError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '');
  return apiErrorFromBody(text, res.status) ?? new HttpError(res.status, text);
}

export function createClient(opts: ClientOptions) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const enc = encodeURIComponent;

  // Вызов целиком (заголовки и чтение тела) ограничен потолком операции и внешним сигналом.
  // Гонка с промисом отмены, а не только signal в fetch: тело, которое не приходит и на signal
  // не реагирует, иначе держало бы вызов вечно.
  async function bounded<T>(op: ClientOperation, callOpts: CallOptions | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const external = callOpts?.signal;
    external?.throwIfAborted();
    const ms = opts.timeoutMs?.[op] ?? CLIENT_TIMEOUTS[op];
    const timeoutError = new ClientTimeoutError(op, ms);
    const timer = new AbortController();
    const signal = external ? AbortSignal.any([external, timer.signal]) : timer.signal;
    let onAbort = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(timer.signal.aborted ? timeoutError : signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const handle = setTimeout(() => timer.abort(timeoutError), ms);
    try {
      return await Promise.race([work(signal), aborted]);
    } catch (e) {
      if (timer.signal.aborted) throw timeoutError;
      if (external?.aborted) throw external.reason;
      throw e;
    } finally {
      clearTimeout(handle);
      signal.removeEventListener('abort', onAbort);
    }
  }

  function call<T extends z.ZodType>(
    op: ClientOperation,
    method: 'GET' | 'POST',
    path: string,
    schema: T,
    body: unknown,
    callOpts: CallOptions | undefined,
  ): Promise<z.output<T>> {
    return bounded(op, callOpts, async (signal) => {
      const res = await fetchFn(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-app-key': opts.appKey },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw await toError(res);
      // Успешный ответ, который не разобрался, — тоже HttpError: у клиента классы ошибок
      // ApiError, HttpError и ClientTimeoutError, голый SyntaxError или ZodError наружу не выпускаем.
      const raw = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (cause) {
        throw new HttpError(res.status, raw, { cause });
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new HttpError(res.status, raw, { cause: parsed.error });
      return parsed.data;
    });
  }

  function text(op: ClientOperation, path: string, callOpts: CallOptions | undefined): Promise<string> {
    return bounded(op, callOpts, async (signal) => {
      const res = await fetchFn(`${base}${path}`, { headers: { 'x-app-key': opts.appKey }, signal });
      if (!res.ok) throw await toError(res);
      return res.text();
    });
  }

  // Поток событий без потолка: он живёт, пока его не закроет signal или сервер.
  // onUnknownEvent — необязательный крючок для вызывающего: событие не по схеме иначе
  // отбрасывается молча, и расхождение версий сервера и клиента остаётся невидимым.
  async function* events(
    target: EventsTarget,
    signal?: AbortSignal,
    onUnknownEvent?: (raw: unknown, error: z.ZodError) => void,
  ): AsyncGenerator<GameEvent, void, undefined> {
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
      else onUnknownEvent?.(json, parsed.error);
    }
  }

  return {
    createSession: (o?: CallOptions) => call('create_session', 'POST', '/api/sessions', CreateSessionResponse, {}, o),
    newGame: (sessionId: string, req: NewGameRequest, o?: CallOptions) =>
      call('session_new_game', 'POST', `/api/sessions/${enc(sessionId)}/games`, NewGameResponse, req, o),
    createGame: (req: NewGameRequest, o?: CallOptions) => call('create_game', 'POST', '/api/games', NewGameResponse, req, o),
    getGame: (id: string, o?: CallOptions) => call('get_game', 'GET', `/api/games/${enc(id)}`, GameState, undefined, o),
    listGames: (o?: CallOptions) => call('list_games', 'GET', '/api/games', ListGamesResponse, undefined, o),
    play: (id: string, req: PlayRequest, o?: CallOptions) => call('play', 'POST', `/api/games/${enc(id)}/play`, PlayResponse, req, o),
    pass: (id: string, req: PassRequest = {}, o?: CallOptions) => call('pass', 'POST', `/api/games/${enc(id)}/pass`, PlayResponse, req, o),
    resign: (id: string, req: ResignRequest, o?: CallOptions) => call('resign', 'POST', `/api/games/${enc(id)}/resign`, StateResponse, req, o),
    undo: (id: string, req: UndoRequest = {}, o?: CallOptions) => call('undo', 'POST', `/api/games/${enc(id)}/undo`, UndoResponse, req, o),
    correct: (id: string, req: CorrectRequest, o?: CallOptions) =>
      call('correct_last_move', 'POST', `/api/games/${enc(id)}/correct`, PlayResponse, req, o),
    setRank: (id: string, req: SetRankRequest, o?: CallOptions) => call('set_rank', 'POST', `/api/games/${enc(id)}/rank`, StateResponse, req, o),
    analyze: (id: string, req: AnalyzeRequest = {}, o?: CallOptions) => call('analyze', 'POST', `/api/games/${enc(id)}/analyze`, Analysis, req, o),
    score: (id: string, o?: CallOptions) => call('score', 'POST', `/api/games/${enc(id)}/score`, Result, {}, o),
    ascii: (id: string, o?: CallOptions) => text('render', `/api/games/${enc(id)}/ascii`, o),
    sgf: (id: string, o?: CallOptions) => text('sgf', `/api/games/${enc(id)}/sgf`, o),
    events,
  };
}

export type GokoClient = ReturnType<typeof createClient>;
