// Запуск обёртки: KataGo из KATAGO_BIN, сети и конфиг из env или из apps/go-engine/{models,config}.
// Значения переменных окружения не печатаются: в лог идут только имена файлов сетей.
// Порядок важен и потому вынесен в startEngine: движок сначала отвечает на прогрев и только
// потом сервис начинает слушать порт. Обратный порядок означает таймаут на первом же ходу.
// Модуль без побочных эффектов при импорте: запускает его тонкая точка входа main.ts.
import path from 'node:path';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createEngineApp } from './app.ts';
import { KataGo, type KataGoOptions } from './katago.ts';
import { warmupOrExit } from './warmup.ts';

// Ровно то, что от движка нужно запуску: прогрев, HTTP-обёртка и остановка по сигналу.
export type EngineLike = Pick<KataGo, 'start' | 'stop' | 'query' | 'queueLength' | 'restarts' | 'alive'>;

export type Listen = (
  app: Hono,
  port: number,
  hostname: string,
  onReady: (port: number) => void,
) => { close: () => void };

// Швы для теста запуска: боевой путь берёт настоящие process.env, KataGo, serve и process.exit.
export type StartDeps = {
  env?: Record<string, string | undefined>;
  createEngine?: (options: KataGoOptions) => EngineLike;
  listen?: Listen;
  on?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  warmupMs?: number;
};

const defaultListen: Listen = (app, port, hostname, onReady) =>
  serve({ fetch: app.fetch, port, hostname }, (info) => onReady(info.port));

export async function startEngine(deps: StartDeps = {}): Promise<void> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.error(line));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const listen = deps.listen ?? defaultListen;
  const createEngine = deps.createEngine ?? ((options: KataGoOptions) => new KataGo(options));

  // Пустая или из пробелов переменная — то же, что не заданная: так читается infra/.env.example,
  // где необязательные переменные перечислены с пустыми значениями (правило то же, что в game-server).
  const optional = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim() === '' ? undefined : value;
  };
  const bin = optional('KATAGO_BIN');
  const engineKey = optional('ENGINE_KEY');
  // Порт — по правилу PORT game-server: запись целого без знака, ведущего нуля и пробелов, от 1
  // до 65535. Иначе Number('abc') дал бы NaN, а '0' — случайный порт, и game-server не нашёл бы движок.
  const rawPort = optional('ENGINE_PORT');
  const port = rawPort === undefined ? 8788 : Number(rawPort);
  const badPort = rawPort !== undefined && (!/^[1-9]\d*$/.test(rawPort) || port > 65535);
  if (bin === undefined || engineKey === undefined || badPort) {
    if (bin === undefined) log('[X] go-engine: нужна переменная KATAGO_BIN (см. infra/.env.example)');
    if (engineKey === undefined) log('[X] go-engine: нужна переменная ENGINE_KEY (см. infra/.env.example)');
    if (badPort) log('[X] go-engine: ENGINE_PORT должна быть целым числом от 1 до 65535 (см. infra/.env.example)');
    exit(2);
    return;
  }
  const model = optional('KATAGO_MODEL') ?? path.join(root, 'apps/go-engine/models/kata1-b10c128-s1141046784-d204142634.txt.gz');
  const humanModel = optional('KATAGO_HUMAN_MODEL') ?? path.join(root, 'apps/go-engine/models/b18c384nbt-humanv0.bin.gz');
  const config = optional('KATAGO_CONFIG') ?? path.join(root, 'apps/go-engine/config/analysis.cfg');
  const hostname = optional('ENGINE_HOST') ?? '127.0.0.1';

  const katago = createEngine({ bin, model, humanModel, config, log });
  katago.start();

  // Сигналы слушаются с первого мгновения жизни движка, а не после прогрева: прогрев длится
  // до 300 с, а node в контейнере — PID 1, которому ядро без обработчика сигнал не доставит.
  // Тогда docker stop ждёт SIGKILL, и KataGo не получает stop(). Сигнал во время прогрева —
  // штатная остановка с кодом 0: прогрев отклоняется через stop(), но отказом не считается.
  let server: { close: () => void } | null = null;
  let stopping = false;
  const on = deps.on ?? ((signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void process.on(signal, handler));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    on(signal, () => {
      stopping = true;
      server?.close();
      void katago.stop().finally(() => exit(0));
    });
  }

  // Порт открывается только после ответа движка: готовность сервиса — это готовность KataGo.
  // Прогрев не вернётся, если движок не поднялся: там свой видимый отказ и выход с кодом.
  const ready = await warmupOrExit({ katago, log, exit, timeoutMs: deps.warmupMs, cancelled: () => stopping });
  // Сигнал мог прийти, когда ответ прогрева уже был в пути: остановленному движку порт не нужен.
  if (!ready || stopping) return;

  const app = createEngineApp({
    katago,
    engineKey,
    models: { main: path.basename(model), human: path.basename(humanModel) },
    log,
  });
  server = listen(app, port, hostname, (actual) => {
    console.log(`[OK] go-engine на порту ${actual}; сети ${path.basename(model)} + ${path.basename(humanModel)}`);
  });
}
