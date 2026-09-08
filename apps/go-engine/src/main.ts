// Запуск обёртки: KataGo из KATAGO_BIN, сети и конфиг из env или из apps/go-engine/{models,config}.
// Значения переменных окружения не печатаются: в лог идут только имена файлов сетей.
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createEngineApp } from './app.ts';
import { KataGo } from './katago.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const env = process.env;
const log = (line: string) => console.error(line);

const bin = env.KATAGO_BIN;
const engineKey = env.ENGINE_KEY;
if (!bin || !engineKey) {
  console.error('[X] go-engine: нужны KATAGO_BIN и ENGINE_KEY (см. infra/.env.example)');
  process.exit(2);
}
const model = env.KATAGO_MODEL ?? path.join(root, 'apps/go-engine/models/kata1-b10c128-s1141046784-d204142634.txt.gz');
const humanModel = env.KATAGO_HUMAN_MODEL ?? path.join(root, 'apps/go-engine/models/b18c384nbt-humanv0.bin.gz');
const config = env.KATAGO_CONFIG ?? path.join(root, 'apps/go-engine/config/analysis.cfg');
const port = Number(env.ENGINE_PORT ?? 8788);
const hostname = env.ENGINE_HOST ?? '127.0.0.1';

const katago = new KataGo({ bin, model, humanModel, config, log });
katago.start();
const app = createEngineApp({
  katago,
  engineKey,
  models: { main: path.basename(model), human: path.basename(humanModel) },
  log,
});
const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[OK] go-engine на порту ${info.port}; сети ${path.basename(model)} + ${path.basename(humanModel)}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void katago.stop().finally(() => process.exit(0));
  });
}
