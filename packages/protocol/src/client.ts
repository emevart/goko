// Типизированный клиент game-server. Им пользуются voice-agent, web, mcp-server и scripts/.
import type { z } from 'zod';
import { HttpError, apiErrorFromBody } from './errors.ts';
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
  return apiErrorFromBody(text, res.status) ?? new HttpError(res.status, text);
}

export function createClient(opts: ClientOptions) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const enc = encodeURIComponent;

  async function call<T extends z.ZodType>(method: 'GET' | 'POST', path: string, schema: T, body?: unknown): Promise<z.output<T>> {
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-app-key': opts.appKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await toError(res);
    // Успешный ответ, который не разобрался, — тоже HttpError: у клиента ровно два класса
    // ошибок (ApiError и HttpError), голый SyntaxError или ZodError наружу не выпускаем.
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
  }

  async function text(path: string): Promise<string> {
    const res = await fetchFn(`${base}${path}`, { headers: { 'x-app-key': opts.appKey } });
    if (!res.ok) throw await toError(res);
    return res.text();
  }

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
