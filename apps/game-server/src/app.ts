// HTTP-приложение game-server (раздел 5 спеки): маршруты, X-App-Key, ошибки по таблице, SSE.
import { createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
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
import { API_RATE, CREATE_RATE, type RateRule, RateLimiter, addressKey } from './rate-limit.ts';
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
  // Текущие запросы (кроме потоков SSE): остановка рвёт соединения только когда их не осталось.
  inFlight?: InFlight;
  // Ключ go-engine: в лог не попадает, как и прочие секреты. Пустой при FAKE_ENGINE.
  engineKey?: string;
  // Лимиты частоты на адрес (D-0012); по умолчанию API_RATE и CREATE_RATE.
  rateLimits?: { api: RateRule; create: RateRule };
  // TRUST_PROXY=1: адрес клиента — последний в X-Forwarded-For (его дописывает Caddy), иначе адрес сокета.
  trustProxy?: boolean;
  // ALLOW_SESSIONLESS_GAMES=1: POST /api/games создаёт партию без сессии (dev, smoke). Без флага партии создаются
  // только внутри сессии (D-0012): публичный APP_KEY иначе давал бы партии мимо MAX_SESSIONS.
  sessionlessGames?: boolean;
  log?: (line: string) => void;
};

// Счётчик текущих запросов. idle() осядет, когда счётчик дойдёт до нуля (сразу, если он уже ноль).
export class InFlight {
  #count = 0;
  #waiters: Array<() => void> = [];

  get size(): number {
    return this.#count;
  }

  enter(): void {
    this.#count++;
  }

  leave(): void {
    this.#count--;
    if (this.#count > 0) return;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  idle(): Promise<void> {
    if (this.#count === 0) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

export const DEFAULT_HEARTBEAT_MS = 15_000;
// Предел тела запроса: самое большое тело протокола (новая партия с метками мест) — сотни байт.
export const MAX_BODY_BYTES = 64 * 1024;
// Предел очереди потока SSE на медленного клиента: больше — поток закрывается, клиент
// переподключается и получает свежее состояние первым событием (sync), а память не растёт.
export const SSE_QUEUE_LIMIT = 1000;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

// Адрес IPv6 — до 45 символов; длиннее ключ лимитера не бывает, чем бы ни был заголовок.
const MAX_CLIENT_KEY_LENGTH = 64;
const CREATE_PATH = /^\/api\/(sessions|games|sessions\/[^/]+\/games)$/;

// Ключ лимитера: адрес сокета от @hono/node-server (c.env.incoming). За прокси все соединения
// приходят с его адреса, поэтому при trustProxy берётся последний адрес X-Forwarded-For: его дописал
// сам прокси, а первые клиент мог подставить любые. Без сокета (app.request в тестах) — общий ключ.
// Адрес сводится addressKey: IPv6 — к префиксу /64, IPv4-mapped — к IPv4.
function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (forwarded) return addressKey(forwarded).slice(0, MAX_CLIENT_KEY_LENGTH);
  }
  const address = (c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined)?.incoming?.socket?.remoteAddress;
  return typeof address === 'string' && address !== '' ? addressKey(address) : 'unknown';
}

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
  const secrets = [deps.appKey, deps.livekit.apiKey, deps.livekit.apiSecret, deps.engineKey ?? ''].filter((s) => s !== '').sort((a, b) => b.length - a.length);
  const redact = (text: string) => secrets.reduce((acc, secret) => acc.split(secret).join('[скрыто]'), text);
  const fail = (c: Context, code: ErrorCode, message: string, details?: Record<string, unknown>) =>
    c.json({ error: { code, message, ...(details ? { details } : {}) } }, ERROR_STATUS[code] as ContentfulStatusCode);

  // Счёт текущих запросов — первым, чтобы в него попали и отказы по ключу и телу. Под @hono/node-server
  // обработчик возвращает Response раньше, чем ответ записан в сокет, поэтому запрос выходит из счёта
  // по close ответа Node (c.env.outgoing); без сокета (app.request) — по возврату обработчика.
  // Слушатель close ставится до обработчика: соединение может закрыться, пока сервис думает.
  // Поток SSE выходит из счёта сразу: он живёт до остановки и закрывается по сигналу closing.
  const inFlight = deps.inFlight;
  if (inFlight) {
    app.use('*', async (c, next) => {
      const outgoing = (c.env as { outgoing?: unknown } | undefined)?.outgoing;
      const socket = outgoing instanceof EventEmitter ? outgoing : null;
      let closed = false;
      const onClose = () => {
        closed = true;
      };
      socket?.once('close', onClose);
      inFlight.enter();
      try {
        await next();
      } finally {
        const sse = c.res.headers.get('content-type')?.startsWith('text/event-stream') === true;
        if (socket === null || closed || sse) {
          socket?.off('close', onClose);
          inFlight.leave();
        } else {
          socket.off('close', onClose);
          socket.once('close', () => inFlight.leave());
        }
      }
    });
  }

  app.get('/health', (c) => c.json({ ok: true, games: service.list().length, sessions: sessions.list().length }));

  // Лимиты частоты (D-0012) — раньше ключа: подбор ключа и запросы без него тоже в счёте. Поток SSE
  // считается один раз, при открытии. Отказ общего лимита не расходует лимит создания.
  const trustProxy = deps.trustProxy === true;
  const apiLimiter = new RateLimiter(deps.rateLimits?.api ?? API_RATE);
  const createLimiter = new RateLimiter(deps.rateLimits?.create ?? CREATE_RATE);
  app.use('/api/*', async (c, next) => {
    const key = clientKey(c, trustProxy);
    let verdict = apiLimiter.hit(key);
    if (verdict.ok && c.req.method === 'POST' && CREATE_PATH.test(c.req.path)) verdict = createLimiter.hit(key);
    if (!verdict.ok) {
      const seconds = verdict.retryAfterSeconds;
      c.header('Retry-After', String(seconds));
      return fail(c, 'rate_limited', `too many requests, retry in ${seconds} s`, { retryAfterSeconds: seconds });
    }
    await next();
  });

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
      // stop обрывает и запись, застрявшую на медленном клиенте: stream.abort() отменяет чтение
      // внутреннего потока, ждущая запись завершается, цикл выходит. Без этого поток сверх предела
      // очереди или при остановке сервера висел бы до разгрузки сокета. abort идемпотентен, поэтому
      // вызов из собственного onAbort не зацикливается.
      const stop = () => {
        open = false;
        unsubscribe();
        wake?.();
        stream.abort();
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
  // Владелец сессии — ключ адреса, создавшего её (D-0012): партии сессии идут в его счёт, даже когда их
  // создаёт voice-agent со своего адреса. Запись живёт, пока жив наблюдатель сессии.
  const sessionOwners = new Map<string, string>();
  const isAlive = (sid: string) => sessions.list().some((s) => s.id === sid);
  const unwatch = (sid: string) => {
    watchers.get(sid)?.();
    watchers.delete(sid);
    sessionOwners.delete(sid);
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
    sessionOwners.set(session.id, clientKey(c, trustProxy));
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
    // Защитный путь: владелец пишется при POST /api/sessions, а сессии рестарт не переживают, поэтому в prod
    // сессии без владельца нет. Сессия, появившаяся другим путём (тесты, будущие маршруты), — счёт по адресу запроса.
    return c.json(await service.create(req, { sessionId: sid, clientKey: sessionOwners.get(sid) ?? clientKey(c, trustProxy) }));
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
  app.post('/api/games', async (c) => {
    if (deps.sessionlessGames !== true) throw new ApiError('bad_request', 'games are created only inside a session', { reason: 'sessionless_disabled' });
    return c.json(await service.create(await parseBody(c, NewGameRequest), { clientKey: clientKey(c, trustProxy) }));
  });
  // Список отдаёт id всех партий: с ним один адрес вернул бы в счёт чужие партии. Нужен только dev и smoke,
  // поэтому доступен под тем же флагом, что партии без сессии (D-0012).
  app.get('/api/games', (c) => {
    if (deps.sessionlessGames !== true) throw new ApiError('bad_request', 'the game list is available only with sessionless games enabled', { reason: 'list_disabled' });
    return c.json({ games: service.list() });
  });
  app.get('/api/games/:id', (c) => c.json(service.get(c.req.param('id'))));
  app.post('/api/games/:id/play', async (c) => c.json(await service.play(c.req.param('id'), await parseBody(c, PlayRequest))));
  app.post('/api/games/:id/pass', async (c) => c.json(await service.pass(c.req.param('id'), await parseBody(c, PassRequest))));
  app.post('/api/games/:id/resign', async (c) => c.json(await service.resign(c.req.param('id'), await parseBody(c, ResignRequest))));
  // Откат партии, завершённой счётом, возвращает её в счёт: без владельца в памяти — в счёт адреса запроса (D-0012).
  app.post('/api/games/:id/undo', async (c) => c.json(await service.undo(c.req.param('id'), await parseBody(c, UndoRequest), 'human', { clientKey: clientKey(c, trustProxy) })));
  app.post('/api/games/:id/correct', async (c) => c.json(await service.correct(c.req.param('id'), await parseBody(c, CorrectRequest), 'human', { clientKey: clientKey(c, trustProxy) })));
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
