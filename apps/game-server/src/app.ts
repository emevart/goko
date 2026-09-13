// HTTP-приложение game-server (раздел 5 спеки): маршруты, X-App-Key, ошибки по таблице, SSE.
import { createHash, timingSafeEqual } from 'node:crypto';
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
import { type RoomCreator, createSessionRoom, mintToken } from './livekit.ts';
import type { GameService } from './service.ts';
import type { SessionManager } from './sessions.ts';

export type AppDeps = {
  service: GameService;
  sessions: SessionManager;
  bus: EventBus;
  appKey: string;
  // tokenTtlSeconds = floor(SESSION_TTL_MS / 1000): токен телефона не переживает сессию (D-0001).
  livekit: { url: string; apiKey: string; apiSecret: string; agentName: string; tokenTtlSeconds: number };
  rooms: RoomCreator;
  heartbeatMs?: number;
  // Остановка сервера: открытые потоки SSE закрываются, новые закрываются сразу.
  closing?: AbortSignal;
  log?: (line: string) => void;
};

export const DEFAULT_HEARTBEAT_MS = 15_000;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

// Пустое тело (POST без JSON) — это {}: схемы подставят defaults. Непустое, но не JSON — bad_request.
async function body(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('bad_request', 'тело запроса не JSON');
  }
}

export function createApp(deps: AppDeps): Hono {
  if (deps.appKey === '') throw new Error('createApp: пустой appKey');
  const app = new Hono();
  const { service, sessions, bus } = deps;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  // Сравнение за постоянное время: дайджесты одной длины, поэтому разная длина ключа не даёт раннего выхода.
  const appKeyDigest = digest(deps.appKey);
  const fail = (c: Context, code: ErrorCode, message: string, details?: Record<string, unknown>) =>
    c.json({ error: { code, message, ...(details ? { details } : {}) } }, ERROR_STATUS[code] as ContentfulStatusCode);

  app.get('/health', (c) => c.json({ ok: true, games: service.list().length, sessions: sessions.list().length }));

  app.use('/api/*', async (c, next) => {
    if (!timingSafeEqual(digest(c.req.header('x-app-key') ?? ''), appKeyDigest)) return fail(c, 'unauthorized', 'нет или неверный X-App-Key');
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
  // Подписка и слушатели отмены ставятся до первой записи: запись ждёт, пока клиент прочитает,
  // а отмена может прийти раньше. onBeat — на каждый пинг (поток сессии продлевает её срок).
  function sse(c: Context, channel: string, initial: GameEvent[], onBeat?: () => void): Response {
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
      deps.closing?.addEventListener('abort', stop);
      if (deps.closing?.aborted) stop();
      try {
        for (const event of initial) {
          if (!open) break;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
        while (open) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              // Таймер снимается при любом пробуждении: иначе при потоке событий копились бы таймеры.
              const done = () => {
                clearTimeout(timer);
                wake = null;
                resolve();
              };
              const timer = setTimeout(done, heartbeatMs);
              wake = done;
            });
          }
          if (!open) break;
          const event = queue.shift();
          if (event) {
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          } else {
            onBeat?.();
            await stream.write(': ping\n\n');
          }
        }
      } finally {
        stop();
        c.req.raw.signal.removeEventListener('abort', stop);
        deps.closing?.removeEventListener('abort', stop);
      }
    });
  }

  const syncEvent = (gameId: string): GameEvent => ({ type: 'state.updated', state: service.get(gameId), cause: 'sync', by: 'system' });

  // Срок сессии продлевается каждым событием её канала: ходы идут на /api/games/:id/* без sessionId,
  // и без этого сессия истекла бы посреди партии. Наблюдатель истёкшей сессии снимает себя сам
  // на первом событии, а наблюдатели сессий без событий — при создании следующей сессии.
  const watchers = new Map<string, () => void>();
  const isAlive = (sid: string) => sessions.list().some((s) => s.id === sid);
  const unwatch = (sid: string) => {
    watchers.get(sid)?.();
    watchers.delete(sid);
  };
  const pruneWatchers = () => {
    for (const sid of [...watchers.keys()]) if (!isAlive(sid)) unwatch(sid);
  };
  const watch = (sid: string) => {
    watchers.set(
      sid,
      bus.subscribe(`session:${sid}`, () => {
        if (isAlive(sid)) sessions.touch(sid);
        else unwatch(sid);
      }),
    );
  };

  // ---- сессии ----
  // Порядок: сессия (место в лимите) -> токен (чистая функция) -> комната с агентом. Отказ любого
  // шага освобождает место; при отказе токена платная комната с агентом не создаётся вовсе.
  app.post('/api/sessions', async (c) => {
    pruneWatchers();
    const session = sessions.create();
    let token: string;
    try {
      token = await mintToken({
        apiKey: deps.livekit.apiKey,
        apiSecret: deps.livekit.apiSecret,
        room: session.room,
        identity: `phone-${session.id}`,
        ttlSeconds: deps.livekit.tokenTtlSeconds,
      });
      await createSessionRoom(deps.rooms, { room: session.room, agentName: deps.livekit.agentName, sessionId: session.id });
    } catch (e) {
      sessions.remove(session.id);
      deps.log?.(`[X] game-server: сессия ${session.id} не создана: ${e instanceof Error ? e.message : String(e)}`);
      throw new ApiError('internal', 'не удалось подготовить комнату LiveKit для сессии');
    }
    watch(session.id);
    return c.json({ session, livekit: { url: deps.livekit.url, token } });
  });

  app.post('/api/sessions/:sid/games', async (c) => {
    const sid = c.req.param('sid');
    sessions.get(sid);
    sessions.touch(sid); // операция с sessionId продлевает срок сессии, даже если тело не пройдёт схему
    const req = NewGameRequest.parse(await body(c));
    const res = await service.create(req, { sessionId: sid });
    sessions.setGame(sid, res.state.id);
    return c.json(res);
  });

  app.get('/api/sessions/:sid/events', (c) => {
    const sid = c.req.param('sid');
    const session = sessions.get(sid);
    sessions.touch(sid); // открытие потока продлевает срок, дальше его продлевает каждый пинг
    const gameId = session.currentGameId;
    return sse(c, `session:${sid}`, gameId ? [{ type: 'session.game', gameId }, syncEvent(gameId)] : [], () => sessions.touch(sid));
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
