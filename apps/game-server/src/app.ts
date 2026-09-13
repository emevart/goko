// HTTP-приложение game-server (раздел 5 спеки): маршруты, X-App-Key, ошибки по таблице, SSE.
import { createHash, timingSafeEqual } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
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
import { errorDetail } from './error-detail.ts';
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
// Предел тела запроса: самое большое тело протокола (новая партия с метками мест) — сотни байт.
export const MAX_BODY_BYTES = 64 * 1024;
// Предел очереди потока SSE на медленного клиента: больше — поток закрывается, клиент
// переподключается и получает свежее состояние первым событием (sync), а память не растёт.
export const SSE_QUEUE_LIMIT = 1000;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

// Пустое тело (POST без JSON) — это {}: схемы подставят defaults. Непустое, но не JSON — bad_request.
async function body(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('bad_request', 'request body is not JSON');
  }
}

// Разбор тела схемой: только здесь несовпадение со схемой становится bad_request. ZodError из
// любого другого места (сервис, собственные схемы) — ошибка сервера, её ловит onError как internal.
async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const parsed = schema.safeParse(await body(c));
  if (!parsed.success) throw new ApiError('bad_request', 'request body does not match the schema', { issues: parsed.error.issues });
  return parsed.data;
}

export function createApp(deps: AppDeps): Hono {
  // Ошибка программиста (конфигурация проверяется при старте): текст по-английски.
  if (deps.appKey === '') throw new Error('createApp: empty appKey');
  const app = new Hono();
  const { service, sessions, bus } = deps;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  // Сравнение за постоянное время: дайджесты одной длины, поэтому разная длина ключа не даёт раннего выхода.
  const appKeyDigest = digest(deps.appKey);
  // Известные секреты вырезаются из текста чужих исключений перед записью в лог.
  // Длинные первыми: ключ может оказаться частью секрета.
  const secrets = [deps.appKey, deps.livekit.apiKey, deps.livekit.apiSecret].filter((s) => s !== '').sort((a, b) => b.length - a.length);
  const redact = (text: string) => secrets.reduce((acc, secret) => acc.split(secret).join('[скрыто]'), text);
  const fail = (c: Context, code: ErrorCode, message: string, details?: Record<string, unknown>) =>
    c.json({ error: { code, message, ...(details ? { details } : {}) } }, ERROR_STATUS[code] as ContentfulStatusCode);

  app.get('/health', (c) => c.json({ ok: true, games: service.list().length, sessions: sessions.list().length }));

  app.use('/api/*', async (c, next) => {
    if (!timingSafeEqual(digest(c.req.header('x-app-key') ?? ''), appKeyDigest)) return fail(c, 'unauthorized', 'missing or invalid X-App-Key');
    await next();
  });

  // После проверки ключа: без ключа тело не читается вовсе.
  app.use('/api/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 'bad_request', 'request body is too large', { maxBytes: MAX_BODY_BYTES }) }));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      // Исходное исключение (текст go-engine, адрес) — только в лог: в ответ идёт фиксированный message.
      if (err.cause !== undefined) deps.log?.(`[!] game-server: ${c.req.method} ${c.req.path}: ${redact(errorDetail(err))}`);
      return c.json(err.toBody(), err.status as ContentfulStatusCode);
    }
    // Стек несёт текст исключения, а в нём может оказаться секрет: через redact, как и прочие логи.
    deps.log?.(`[X] game-server: ${redact(err.stack ?? err.message)}`);
    return fail(c, 'internal', 'internal server error');
  });

  app.notFound((c) => fail(c, 'not_found', `no route ${c.req.method} ${c.req.path}`));

  // Поток SSE: initial уходит первым, дальше события канала, между ними heartbeat-комментарии.
  // Подписка и слушатели отмены ставятся до первой записи: запись ждёт, пока клиент прочитает,
  // а отмена может прийти раньше. onBeat — на каждый пинг (поток сессии продлевает её срок).
  // alive проверяется на каждом пробуждении (событие или пинг): поток истёкшей сессии закрывается.
  function sse(c: Context, channel: string, initial: GameEvent[], opts: { onBeat?: () => void; alive?: () => boolean } = {}): Response {
    return streamSSE(c, async (stream: SSEStreamingApi) => {
      let open = true;
      let wake: (() => void) | null = null;
      const queue: GameEvent[] = [];
      const stop = () => {
        open = false;
        unsubscribe();
        wake?.();
      };
      const unsubscribe = bus.subscribe(channel, (event) => {
        queue.push(event);
        // Клиент не читает: очередь не растёт без предела.
        if (queue.length > SSE_QUEUE_LIMIT) return stop();
        wake?.();
      });
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
          if (opts.alive && !opts.alive()) {
            stop();
            break;
          }
          const event = queue.shift();
          if (event) {
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
          } else {
            opts.onBeat?.();
            await stream.write(': ping\n\n');
          }
        }
      } finally {
        // Цикл выходит только после stop(). Слушатель на долгоживущем сигнале остановки снимается,
        // иначе копился бы на каждом закрытом потоке; сигнал запроса умирает вместе с запросом.
        deps.closing?.removeEventListener('abort', stop);
      }
    });
  }

  const syncEvent = (gameId: string): GameEvent => ({ type: 'state.updated', state: service.get(gameId), cause: 'sync', by: 'system' });

  // Срок сессии продлевается каждым событием её канала: ходы идут на /api/games/:id/* без sessionId,
  // и без этого сессия истекла бы посреди партии. Наблюдатель истёкшей сессии снимает себя сам
  // на первом событии, а наблюдатели сессий без событий — при создании следующей сессии.
  // currentGameId переключается здесь же, по session.game: порядок совпадает с порядком событий
  // в потоке, а не с порядком ответов (ответ с ходом движка приходит позже).
  const watchers = new Map<string, () => void>();
  const isAlive = (sid: string) => sessions.list().some((s) => s.id === sid);
  const unwatch = (sid: string) => {
    watchers.get(sid)?.();
    watchers.delete(sid);
  };
  const pruneWatchers = () => {
    for (const sid of [...watchers.keys()]) if (!isAlive(sid)) unwatch(sid);
  };
  // Наблюдатель ставится на любом маршруте сессии, а не только при POST /api/sessions: сессия,
  // появившаяся другим путём (восстановление, будущие маршруты), иначе не переключала бы
  // currentGameId. Повторный вызов для той же сессии ничего не делает.
  const watch = (sid: string) => {
    if (watchers.has(sid)) return;
    watchers.set(
      sid,
      bus.subscribe(`session:${sid}`, (event) => {
        if (!isAlive(sid)) return unwatch(sid);
        if (event.type === 'session.game') sessions.setGame(sid, event.gameId);
        else sessions.touch(sid);
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
      deps.log?.(`[X] game-server: сессия ${session.id} не создана: ${redact(e instanceof Error ? e.message : String(e))}`);
      throw new ApiError('internal', 'could not prepare the LiveKit room for the session');
    }
    watch(session.id);
    return c.json({ session, livekit: { url: deps.livekit.url, token } });
  });

  app.post('/api/sessions/:sid/games', async (c) => {
    const sid = c.req.param('sid');
    sessions.get(sid);
    sessions.touch(sid); // операция с sessionId продлевает срок сессии, даже если тело не пройдёт схему
    watch(sid);
    const req = await parseBody(c, NewGameRequest);
    // currentGameId ставит наблюдатель по session.game; сессия, истёкшая пока движок думал, не превращает
    // уже созданную партию в 404.
    return c.json(await service.create(req, { sessionId: sid }));
  });

  app.get('/api/sessions/:sid/events', (c) => {
    const sid = c.req.param('sid');
    const session = sessions.get(sid);
    sessions.touch(sid); // открытие потока продлевает срок, дальше его продлевает каждый пинг
    watch(sid);
    const gameId = session.currentGameId;
    const initial: GameEvent[] = gameId ? [{ type: 'session.game', gameId }, syncEvent(gameId)] : [];
    // Открытие потока — действие человека: исчерпанная серия повторов текущей партии начинается заново.
    if (gameId) service.resume(gameId);
    return sse(c, `session:${sid}`, initial, { onBeat: () => sessions.touch(sid), alive: () => isAlive(sid) });
  });

  // ---- партии ----
  app.post('/api/games', async (c) => c.json(await service.create(await parseBody(c, NewGameRequest))));
  app.get('/api/games', (c) => c.json({ games: service.list() }));
  app.get('/api/games/:id', (c) => c.json(service.get(c.req.param('id'))));
  app.post('/api/games/:id/play', async (c) => c.json(await service.play(c.req.param('id'), await parseBody(c, PlayRequest))));
  app.post('/api/games/:id/pass', async (c) => c.json(await service.pass(c.req.param('id'), await parseBody(c, PassRequest))));
  app.post('/api/games/:id/resign', async (c) => c.json(await service.resign(c.req.param('id'), await parseBody(c, ResignRequest))));
  app.post('/api/games/:id/undo', async (c) => c.json(await service.undo(c.req.param('id'), await parseBody(c, UndoRequest))));
  app.post('/api/games/:id/correct', async (c) => c.json(await service.correct(c.req.param('id'), await parseBody(c, CorrectRequest))));
  app.post('/api/games/:id/rank', async (c) => c.json(await service.setRank(c.req.param('id'), await parseBody(c, SetRankRequest))));
  app.post('/api/games/:id/analyze', async (c) => c.json(await service.analyze(c.req.param('id'), await parseBody(c, AnalyzeRequest))));
  app.post('/api/games/:id/score', async (c) => c.json(await service.score(c.req.param('id'))));
  app.get('/api/games/:id/ascii', (c) => c.text(service.ascii(c.req.param('id'))));
  app.get('/api/games/:id/sgf', (c) => new Response(service.sgf(c.req.param('id')), { status: 200, headers: { 'content-type': 'application/x-go-sgf; charset=utf-8' } }));
  app.get('/api/games/:id/events', (c) => {
    const id = c.req.param('id');
    const initial = [syncEvent(id)];
    service.resume(id);
    return sse(c, `game:${id}`, initial);
  });

  return app;
}
