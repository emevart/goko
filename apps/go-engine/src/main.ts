// Запуск обёртки: KataGo из KATAGO_BIN, сети и конфиг из env или из apps/go-engine/{models,config}.
// Значения переменных окружения не печатаются: в лог идут только имена файлов сетей.
// Порядок важен и потому вынесен в startEngine: движок сначала отвечает на прогрев и только
// потом сервис начинает слушать порт. Обратный порядок означает таймаут на первом же ходу.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { createEngineApp } from './app.ts';
import { KataGo, type KataGoOptions } from './katago.ts';
import { warmupOrExit } from './warmup.ts';

// Ровно то, что от движка нужно точке входа: прогрев, HTTP-обёртка и остановка по сигналу.
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

  const bin = env.KATAGO_BIN;
  const engineKey = env.ENGINE_KEY;
  if (!bin || !engineKey) {
    log('[X] go-engine: нужны KATAGO_BIN и ENGINE_KEY (см. infra/.env.example)');
    exit(2);
    return;
  }
  const model = env.KATAGO_MODEL ?? path.join(root, 'apps/go-engine/models/kata1-b10c128-s1141046784-d204142634.txt.gz');
  const humanModel = env.KATAGO_HUMAN_MODEL ?? path.join(root, 'apps/go-engine/models/b18c384nbt-humanv0.bin.gz');
  const config = env.KATAGO_CONFIG ?? path.join(root, 'apps/go-engine/config/analysis.cfg');
  const port = Number(env.ENGINE_PORT ?? 8788);
  const hostname = env.ENGINE_HOST ?? '127.0.0.1';

  const katago = createEngine({ bin, model, humanModel, config, log });
  katago.start();
  // Порт открывается только после ответа движка: готовность сервиса — это готовность KataGo.
  // Прогрев не вернётся, если движок не поднялся: там свой видимый отказ и выход с кодом.
  if (!(await warmupOrExit({ katago, log, exit, timeoutMs: deps.warmupMs }))) return;

  const app = createEngineApp({
    katago,
    engineKey,
    models: { main: path.basename(model), human: path.basename(humanModel) },
    log,
  });
  const server = listen(app, port, hostname, (actual) => {
    console.log(`[OK] go-engine на порту ${actual}; сети ${path.basename(model)} + ${path.basename(humanModel)}`);
  });

  const on = deps.on ?? ((signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void process.on(signal, handler));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    on(signal, () => {
      server.close();
      void katago.stop().finally(() => exit(0));
    });
  }
}

// Импорт из теста не поднимает сервис: побочные эффекты только при прямом запуске.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startEngine();
}
