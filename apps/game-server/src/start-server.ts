// Запуск game-server из env. FAKE_ENGINE=1 — без KataGo (тесты, smoke, разработка веба).
// Модуль без побочных эффектов при импорте: запускает его тонкая точка входа main.ts.
// Конфигурация проверяется целиком до любых вызовов SDK и до чтения данных: пустой ключ LiveKit
// SDK молча заменил бы значением из process.env. Значения переменных не печатаются никогда,
// в лог идут только имена.
import path from 'node:path';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createApp } from './app.ts';
import { createEngineClient } from './engine-client.ts';
import { EventBus } from './events.ts';
import { createFakeEngine } from './fake-engine.ts';
import { type RoomCreator, createRoomService } from './livekit.ts';
import { GameService, type GameServiceDeps } from './service.ts';
import { SessionManager } from './sessions.ts';
import { GameStore } from './store.ts';

export type Listen = (
  app: Hono,
  port: number,
  hostname: string,
  onReady: (info: { address: string; port: number }) => void,
  onError: (error: Error) => void,
) => { close: (done: () => void) => void };

type ServeFn = (
  options: { fetch: Hono['fetch']; port: number; hostname: string },
  onListen: (info: { address: string; port: number }) => void,
) => { close: (done: () => void) => unknown; on: (event: 'error', listener: (error: Error) => void) => unknown };

// Швы для тестов запуска: боевой путь берёт настоящие process.env, serve, process.on и process.exit.
export type StartDeps = {
  env?: Record<string, string | undefined>;
  listen?: Listen;
  on?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  createRooms?: (opts: { url: string; apiKey: string; apiSecret: string }) => RoomCreator;
  createService?: (deps: GameServiceDeps) => GameService;
};

export type StartedServer = { app: Hono; service: GameService; sessions: SessionManager };

export const CONFIG_EXIT_CODE = 2;
// Партии не загрузились (нет прав на DATA_DIR, диск): не конфигурация env, а отказ данных.
export const INIT_EXIT_CODE = 1;
// service.close ждёт текущий запрос к движку (genmove 10 с и один повтор, около 20 с).
// Дольше остановка не ждёт: снапшоты уже на диске, выход без ожидания данных не теряет.
export const SHUTDOWN_MS = 25_000;
export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:8788';

// Шов над serve: адрес готовности — фактический адрес сокета, ошибка сокета (EADDRINUSE, EACCES)
// уходит в onError, а не падает процесс с сырым стеком.
export const createListen =
  (serveFn: ServeFn): Listen =>
  (app, port, hostname, onReady, onError) => {
    const server = serveFn({ fetch: app.fetch, port, hostname }, (info) => onReady({ address: info.address, port: info.port }));
    server.on('error', onError);
    return { close: (done) => void server.close(() => done()) };
  };

const defaultListen: Listen = createListen(serve);

type Config = {
  appKey: string;
  livekit: { url: string; apiKey: string; apiSecret: string; agentName: string };
  fake: boolean;
  engineUrl: string;
  engineKey: string;
  dataDir: string;
  maxSessions: number;
  sessionTtlMs: number;
  port: number;
  hostname: string;
};

// Пустая или из пробелов переменная — то же, что не заданная: так читается infra/.env.example,
// где необязательные переменные перечислены с пустыми значениями.
function readConfig(env: Record<string, string | undefined>, root: string): { config: Config; errors: [] } | { config: null; errors: string[] } {
  const errors: string[] = [];
  const optional = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim() === '' ? undefined : value;
  };
  const need = (name: string): string => {
    const value = optional(name);
    if (value === undefined) errors.push(`нужна переменная ${name} (см. infra/.env.example)`);
    return value ?? '';
  };
  const integer = (name: string, fallback: number, min: number, max: number, message: string): number => {
    const raw = optional(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    // Больше MAX_SAFE_INTEGER отсекает max: у всех переменных он не выше этого числа.
    if (!/^[1-9]\d*$/.test(raw) || value < min || value > max) {
      errors.push(message);
      return fallback;
    }
    return value;
  };

  const appKey = need('APP_KEY');
  const url = need('LIVEKIT_URL');
  const apiKey = need('LIVEKIT_API_KEY');
  const apiSecret = need('LIVEKIT_API_SECRET');
  const fake = env.FAKE_ENGINE === '1';
  const engineKey = fake ? '' : need('ENGINE_KEY');
  // Адрес движка проверяется только когда движок настоящий: при FAKE_ENGINE=1 он не используется.
  const engineUrl = optional('ENGINE_URL') ?? DEFAULT_ENGINE_URL;
  if (!fake && !isUrl(engineUrl, ['http:', 'https:'])) errors.push('ENGINE_URL должна быть адресом http:// или https://');
  if (url !== '' && !isUrl(url, ['ws:', 'wss:', 'http:', 'https:'])) errors.push('LIVEKIT_URL должна быть адресом ws://, wss://, http:// или https://');
  const maxSessions = integer('MAX_SESSIONS', 3, 1, Number.MAX_SAFE_INTEGER, 'MAX_SESSIONS должна быть целым числом от 1');
  // Меньше секунды нельзя: TTL токена — целые секунды TTL сессии, и 0 секунд токен не выдать.
  const sessionTtlMs = integer('SESSION_TTL_MS', 2 * 3600 * 1000, 1000, Number.MAX_SAFE_INTEGER, 'SESSION_TTL_MS должна быть целым числом от 1000');
  const port = integer('PORT', 8787, 1, 65535, 'PORT должна быть целым числом от 1 до 65535');
  if (errors.length > 0) return { config: null, errors };
  return {
    config: {
      appKey,
      livekit: { url, apiKey, apiSecret, agentName: optional('AGENT_NAME') ?? 'goko' },
      fake,
      engineUrl,
      engineKey,
      dataDir: optional('DATA_DIR') ?? path.join(root, 'data/games'),
      maxSessions,
      sessionTtlMs,
      port,
      hostname: optional('HOST') ?? '127.0.0.1',
    },
    errors: [],
  };
}

function isUrl(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Код ошибки Node (EACCES, EADDRINUSE) без текста: текст несёт пути и адреса из env.
function errorCode(e: unknown): string {
  const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && code !== '' ? code : 'без кода';
}

export async function startServer(deps: StartDeps = {}): Promise<StartedServer | null> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.error(line));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const listen = deps.listen ?? defaultListen;
  const on = deps.on ?? ((signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void process.on(signal, handler));
  const createRooms = deps.createRooms ?? createRoomService;
  const createService = deps.createService ?? ((serviceDeps: GameServiceDeps) => new GameService(serviceDeps));

  const { config, errors } = readConfig(env, root);
  if (!config) {
    for (const error of errors) log(`[X] game-server: ${error}`);
    exit(CONFIG_EXIT_CODE);
    return null;
  }

  const engine = config.fake ? createFakeEngine() : createEngineClient({ baseUrl: config.engineUrl, engineKey: config.engineKey });
  if (config.fake) log('[!] game-server: FAKE_ENGINE=1, ходы случайные, KataGo не используется');

  const bus = new EventBus();
  const service = createService({ store: new GameStore(config.dataDir), engine, bus, log });
  try {
    await service.init();
  } catch (e) {
    // Только код: текст ошибки fs содержит путь из DATA_DIR.
    log(`[X] game-server: не удалось загрузить партии (${errorCode(e)})`);
    exit(INIT_EXIT_CODE);
    return null;
  }
  const sessions = new SessionManager({ max: config.maxSessions, ttlMs: config.sessionTtlMs });
  const rooms = createRooms({ url: config.livekit.url, apiKey: config.livekit.apiKey, apiSecret: config.livekit.apiSecret });
  const closing = new AbortController();
  const app = createApp({
    service,
    sessions,
    bus,
    appKey: config.appKey,
    livekit: { ...config.livekit, tokenTtlSeconds: Math.floor(config.sessionTtlMs / 1000) },
    rooms,
    closing: closing.signal,
    log,
  });

  // Остановка: потоки SSE закрываются (иначе server.close ждал бы их вечно), сервер перестаёт
  // принимать соединения, сервис дожидается фоновых задач. Выход 0 — только когда закрылись оба;
  // дольше SHUTDOWN_MS не ждём. Повторный сигнал — немедленный выход.
  let server: { close: (done: () => void) => void } | null = null;
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    on(signal, () => {
      if (stopping) {
        log('[!] game-server: повторный сигнал, выход без ожидания');
        exit(1);
        return;
      }
      stopping = true;
      closing.abort();
      const deadline = setTimeout(() => {
        log(`[!] game-server: остановка дольше ${SHUTDOWN_MS} мс, выход без ожидания`);
        exit(1);
      }, SHUTDOWN_MS);
      const current = server;
      const serverClosed = new Promise<void>((resolve) => (current ? current.close(resolve) : resolve()));
      void Promise.allSettled([serverClosed, service.close()]).then(([, serviceClosed]) => {
        clearTimeout(deadline);
        // Выход всё равно 0: снапшоты пишутся до публикации состояния, но оператор должен видеть отказ.
        if (serviceClosed.status === 'rejected') log(`[!] game-server: service.close завершился ошибкой (${errorCode(serviceClosed.reason)})`);
        exit(0);
      });
    });
  }

  // До готовности ошибка сокета — это ошибка listen (порт занят, нет прав), после — ошибка работающего
  // сервера (например EMFILE на accept): оператору нужны разные подсказки.
  let ready = false;
  server = listen(
    app,
    config.port,
    config.hostname,
    (info) => {
      ready = true;
      console.log(`[OK] game-server на http://${info.address}:${info.port}; партий ${service.list().length}; движок ${config.fake ? 'fake' : 'go-engine'}`);
    },
    (error) => {
      // Только код: текст ошибки Node содержит адрес из HOST.
      log(`[X] game-server: ${ready ? 'ошибка сокета сервера' : 'не удалось слушать порт'} (${errorCode(error)})`);
      exit(1);
    },
  );
  return { app, service, sessions };
}
