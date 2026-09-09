import type { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { KataGoOptions, KataQuery, KataResponse } from './katago.ts';
import { type EngineLike, type Listen, type StartDeps, startEngine } from './main.ts';
import { WARMUP_EXIT_CODE } from './warmup.ts';

// Порядок запуска: движок отвечает на прогрев раньше, чем сервис начинает слушать порт.
// Без этого первый ход у доски приходится на тюнинг ядер и не укладывается в бюджет genmove.

type Recorder = {
  events: string[];
  exits: number[];
  logs: string[];
  ports: number[];
  hostnames: string[];
  options: KataGoOptions[];
  closes: number;
  signals: Array<'SIGINT' | 'SIGTERM'>;
  handlers: Array<() => void>;
};

function harness(answer: () => Promise<KataResponse>): { deps: StartDeps; rec: Recorder } {
  const rec: Recorder = {
    events: [],
    exits: [],
    logs: [],
    ports: [],
    hostnames: [],
    options: [],
    closes: 0,
    signals: [],
    handlers: [],
  };
  const engine: EngineLike = {
    start: () => rec.events.push('engine.start'),
    stop: async () => {
      rec.events.push('engine.stop');
    },
    query: (_q: KataQuery): Promise<KataResponse> => {
      rec.events.push('engine.query');
      return answer();
    },
    queueLength: 0,
    restarts: 0,
    alive: true,
  };
  const listen: Listen = (_app: Hono, port, _hostname, onReady) => {
    rec.events.push('listen');
    onReady(port);
    return {
      close: () => {
        rec.closes++;
      },
    };
  };
  const deps: StartDeps = {
    env: { KATAGO_BIN: 'katago', ENGINE_KEY: 'k', ENGINE_PORT: '18788', ENGINE_HOST: '127.0.0.1' },
    createEngine: (options) => {
      rec.options.push(options);
      return engine;
    },
    listen: (app, port, hostname, onReady) => {
      rec.ports.push(port);
      rec.hostnames.push(hostname);
      return listen(app, port, hostname, onReady);
    },
    on: (signal, handler) => {
      rec.signals.push(signal);
      rec.handlers.push(handler);
    },
    exit: (code) => rec.exits.push(code),
    log: (line) => rec.logs.push(line),
  };
  return { deps, rec };
}

describe('запуск go-engine', () => {
  it('слушает порт только после того, как движок ответил на прогрев', async () => {
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    await startEngine(deps);
    expect(rec.events).toEqual(['engine.start', 'engine.query', 'listen']);
    expect(rec.exits).toEqual([]);
    expect(rec.ports).toEqual([18788]);
    expect(rec.hostnames).toEqual(['127.0.0.1']);
    expect(rec.logs.some((l) => l.includes('прогрет'))).toBe(true);
  });

  it('движок не поднялся: порт не открывается, выход с кодом', async () => {
    const { deps, rec } = harness(() => Promise.reject(new Error('no engine')));
    await startEngine(deps);
    expect(rec.events).not.toContain('listen');
    expect(rec.exits).toEqual([WARMUP_EXIT_CODE]);
    expect(rec.logs.some((l) => l.startsWith('[X]') && l.includes('no engine'))).toBe(true);
  });

  it('без KATAGO_BIN и ENGINE_KEY движок не запускается вовсе', async () => {
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    await startEngine({ ...deps, env: { ENGINE_KEY: 'k' } });
    expect(rec.events).toEqual([]);
    expect(rec.exits).toEqual([2]);
    await startEngine({ ...deps, env: { KATAGO_BIN: 'katago' } });
    expect(rec.exits).toEqual([2, 2]);
    expect(rec.logs).toEqual([
      '[X] go-engine: нужны KATAGO_BIN и ENGINE_KEY (см. infra/.env.example)',
      '[X] go-engine: нужны KATAGO_BIN и ENGINE_KEY (см. infra/.env.example)',
    ]); // отказ виден и не печатает значений переменных
  });

  it('сигнал закрывает сервер и останавливает движок', async () => {
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    await startEngine(deps);
    expect(rec.signals).toEqual(['SIGINT', 'SIGTERM']);
    const handler = rec.handlers[0];
    expect(handler).toBeDefined();
    handler?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.closes).toBe(1);
    expect(rec.events).toContain('engine.stop');
    expect(rec.exits).toEqual([0]);
  });

  it('боевой listen действительно поднимает сервер и сообщает порт', async () => {
    // Единственный путь, где участвует настоящий @hono/node-server: порт 0 — эфемерный,
    // движок подделан, поэтому тест не трогает ни KataGo, ни фиксированный порт спайка.
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    const say = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await startEngine({ ...deps, listen: undefined, env: { KATAGO_BIN: 'x', ENGINE_KEY: 'k', ENGINE_PORT: '0' } });
      // Готовность сервера приходит событием, а не возвратом startEngine: ждём саму строку.
      const line = await vi.waitFor(() => {
        const found = say.mock.calls.map((c) => String(c[0])).find((l) => l.includes('go-engine на порту'));
        expect(found).toBeDefined();
        return found;
      });
      expect(line).toMatch(/^\[OK\] go-engine на порту \d+; сети .+ \+ .+$/);
    } finally {
      say.mockRestore();
      rec.handlers[0]?.(); // закрываем сервер: иначе процесс теста останется слушать порт
    }
  });

  it('порт и хост берутся из env, пути к сетям — от корня репозитория', async () => {
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    await startEngine({ ...deps, env: { KATAGO_BIN: 'katago', ENGINE_KEY: 'k' } });
    expect(rec.ports).toEqual([8788]); // умолчание раздела 8 спеки
    // Движок слушает петлю: наружу его пускает только Caddy, снаружи он безключевой /health.
    expect(rec.hostnames).toEqual(['127.0.0.1']);
    const options = rec.options[0];
    expect(options?.model).toContain('kata1-b10c128');
    expect(options?.humanModel).toContain('b18c384nbt-humanv0');
    expect(options?.config).toContain('analysis.cfg');
    expect(options?.log).toBeDefined(); // без этого stderr движка не доходит до лога сервиса
  });
});
