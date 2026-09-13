import net from 'node:net';
import type { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { KataGoOptions, KataQuery, KataResponse } from './katago.ts';
import { type EngineLike, type Listen, type StartDeps, startEngine } from './start-engine.ts';
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
  // Резолвится первым вызовом подделанного exit: тест ждёт событие, а не число микрозадач.
  exited: Promise<number>;
};

// Свободный порт петли: ОС выдаёт эфемерный, сервер сразу закрывается и порт отдаётся тесту.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no ephemeral port'))));
    });
  });
}

function harness(answer: () => Promise<KataResponse>): { deps: StartDeps; rec: Recorder } {
  let onExit: (code: number) => void = () => undefined;
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
    exited: new Promise<number>((resolve) => {
      onExit = resolve;
    }),
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
    exit: (code) => {
      rec.exits.push(code);
      rec.events.push(`exit ${code}`);
      onExit(code);
    },
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

  it('движок не поднялся: порт не открывается, выход с кодом после остановки движка', async () => {
    const { deps, rec } = harness(() => Promise.reject(new Error('no engine')));
    await startEngine(deps);
    // stop раньше exit: живой KataGo (ответ-ошибка, молчание) иначе пережил бы node.
    expect(rec.events).toEqual(['engine.start', 'engine.query', 'engine.stop', `exit ${WARMUP_EXIT_CODE}`]);
    expect(rec.exits).toEqual([WARMUP_EXIT_CODE]);
    expect(rec.logs.some((l) => l.startsWith('[X]') && l.includes('no engine'))).toBe(true);
  });

  it('без KATAGO_BIN и ENGINE_KEY движок не запускается вовсе', async () => {
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    await startEngine({ ...deps, env: { ENGINE_KEY: 'k' } });
    expect(rec.events).toEqual(['exit 2']); // ни старта движка, ни прогрева
    expect(rec.signals).toEqual([]);
    expect(rec.exits).toEqual([2]);
    await startEngine({ ...deps, env: { KATAGO_BIN: 'katago' } });
    expect(rec.exits).toEqual([2, 2]);
    await startEngine({ ...deps, env: {} });
    expect(rec.exits).toEqual([2, 2, 2]);
    expect(rec.logs).toEqual([
      '[X] go-engine: нужна переменная KATAGO_BIN (см. infra/.env.example)',
      '[X] go-engine: нужна переменная ENGINE_KEY (см. infra/.env.example)',
      '[X] go-engine: нужна переменная KATAGO_BIN (см. infra/.env.example)',
      '[X] go-engine: нужна переменная ENGINE_KEY (см. infra/.env.example)',
    ]); // отказ виден, называет переменную и не печатает значений
  });

  it('пустые или из пробелов KATAGO_BIN и ENGINE_KEY — то же, что не заданные: [X] с именем, код 2', async () => {
    for (const name of ['KATAGO_BIN', 'ENGINE_KEY'] as const) {
      for (const value of ['', '  ']) {
        const { deps, rec } = harness(async () => ({ id: 'q1' }));
        await startEngine({ ...deps, env: { ...deps.env, [name]: value } });
        expect(rec.events).toEqual(['exit 2']);
        expect(rec.logs).toEqual([`[X] go-engine: нужна переменная ${name} (см. infra/.env.example)`]);
      }
    }
  });

  it('пустые или из пробелов переменные с умолчанием берут умолчание: как в infra/.env.example', async () => {
    const base = { KATAGO_BIN: 'katago', ENGINE_KEY: 'k' };
    const { deps: defDeps, rec: def } = harness(async () => ({ id: 'q1' }));
    await startEngine({ ...defDeps, env: base });
    const first = def.options[0];
    if (!first) throw new Error('движок не создан');
    // Лог у каждой обвязки свой: сравниваются только пути.
    const { log: _log, ...defaults } = first;
    for (const value of ['', '  ']) {
      for (const name of ['KATAGO_MODEL', 'KATAGO_HUMAN_MODEL', 'KATAGO_CONFIG', 'ENGINE_PORT', 'ENGINE_HOST']) {
        const { deps, rec } = harness(async () => ({ id: 'q1' }));
        await startEngine({ ...deps, env: { ...base, [name]: value } });
        expect(rec.exits).toEqual([]);
        expect(rec.options[0]).toMatchObject(defaults);
        expect(rec.ports).toEqual([8788]);
        expect(rec.hostnames).toEqual(['127.0.0.1']);
      }
    }
  });

  it('ENGINE_PORT не целое от 1 до 65535 — [X] с именем переменной, код 2, движок не стартует', async () => {
    // Правило то же, что у PORT game-server: только запись целого без ведущего нуля и пробелов.
    for (const value of ['abc', '0', '65536', '-1', '1.5', '8788x', '1e3', '08788', ' 18788 ', '0x10']) {
      const { deps, rec } = harness(async () => ({ id: 'q1' }));
      await startEngine({ ...deps, env: { ...deps.env, ENGINE_PORT: value } });
      expect(rec.events).toEqual(['exit 2']);
      expect(rec.signals).toEqual([]);
      // Строка фиксированная: называет переменную и не печатает значение.
      expect(rec.logs).toEqual(['[X] go-engine: ENGINE_PORT должна быть целым числом от 1 до 65535 (см. infra/.env.example)']);
    }
  });

  it('неверный ENGINE_PORT и отсутствующие переменные — все строки [X] разом, код 2', async () => {
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    await startEngine({ ...deps, env: { ENGINE_PORT: 'abc' } });
    expect(rec.events).toEqual(['exit 2']);
    expect(rec.logs).toEqual([
      '[X] go-engine: нужна переменная KATAGO_BIN (см. infra/.env.example)',
      '[X] go-engine: нужна переменная ENGINE_KEY (см. infra/.env.example)',
      '[X] go-engine: ENGINE_PORT должна быть целым числом от 1 до 65535 (см. infra/.env.example)',
    ]);
  });

  it('ENGINE_PORT на границах 1 и 65535 принимается', async () => {
    for (const value of ['1', '65535']) {
      const { deps, rec } = harness(async () => ({ id: 'q1' }));
      await startEngine({ ...deps, env: { ...deps.env, ENGINE_PORT: value } });
      expect(rec.exits).toEqual([]);
      expect(rec.ports).toEqual([Number(value)]);
    }
  });

  it('заданные пути сетей и конфига уходят в движок как есть', async () => {
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    await startEngine({ ...deps, env: { ...deps.env, KATAGO_MODEL: '/m/main.bin.gz', KATAGO_HUMAN_MODEL: '/m/human.bin.gz', KATAGO_CONFIG: '/c/a.cfg' } });
    expect(rec.options[0]).toMatchObject({ bin: 'katago', model: '/m/main.bin.gz', humanModel: '/m/human.bin.gz', config: '/c/a.cfg' });
  });

  it('сигнал закрывает сервер и останавливает движок', async () => {
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    await startEngine(deps);
    expect(rec.signals).toEqual(['SIGINT', 'SIGTERM']);
    const handler = rec.handlers[0];
    expect(handler).toBeDefined();
    handler?.();
    expect(await rec.exited).toBe(0);
    expect(rec.closes).toBe(1);
    // Сначала движок, потом выход: настоящий process.exit раньше stop() оставил бы KataGo живым.
    expect(rec.events).toEqual(['engine.start', 'engine.query', 'listen', 'engine.stop', 'exit 0']);
    expect(rec.exits).toEqual([0]);
  });

  it('сигнал во время прогрева: движок останавливается, выход 0 без отказа прогрева', async () => {
    // Прогрев не завершён: обработчик сигнала уже должен стоять, иначе docker stop ждёт SIGKILL.
    let rejectWarmup: (err: Error) => void = () => undefined;
    const { deps, rec } = harness(
      () =>
        new Promise<KataResponse>((_resolve, reject) => {
          rejectWarmup = reject;
        }),
    );
    const started = startEngine({
      ...deps,
      createEngine: (options) => {
        const engine = deps.createEngine?.(options);
        if (engine === undefined) throw new Error('harness has no engine');
        // Настоящий KataGo.stop() отклоняет ждущий прогрев: подделка ведёт себя так же.
        return {
          ...engine,
          stop: async () => {
            await engine.stop();
            rejectWarmup(new Error('katago stopped'));
          },
        };
      },
    });
    expect(rec.signals).toEqual(['SIGINT', 'SIGTERM']);
    rec.handlers[1]?.();
    expect(await rec.exited).toBe(0);
    await started;
    expect(rec.exits).toEqual([0]);
    // Полный порядок: stop раньше exit. Вне контейнера process.exit раньше stop() оставил бы
    // KataGo тюнить ядра сиротой до EOF на stdin.
    expect(rec.events).toEqual(['engine.start', 'engine.query', 'engine.stop', 'exit 0']);
    expect(rec.logs.some((l) => l.startsWith('[X]'))).toBe(false);
    expect(rec.closes).toBe(0);
  });

  it('сигнал пришёл, а прогрев всё же ответил: порт не открывается', async () => {
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    const started = startEngine(deps);
    rec.handlers[0]?.(); // до того, как startEngine дождался прогрева
    await started;
    expect(await rec.exited).toBe(0);
    expect(rec.events).not.toContain('listen');
    // Сервис не поднялся: строка «прогрет» сбила бы читающего лог.
    expect(rec.logs.some((l) => l.includes('прогрет'))).toBe(false);
    expect(rec.exits).toEqual([0]);
  });

  it('боевой listen действительно поднимает сервер и сообщает порт', async () => {
    // Единственный путь, где участвует настоящий @hono/node-server: порт свободный, взятый у ОС
    // (ENGINE_PORT=0 отклоняется), движок подделан, поэтому тест не трогает ни KataGo, ни порт спайка.
    const port = await freePort();
    const { deps, rec } = harness(async () => ({ id: 'q1' }));
    const say = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await startEngine({ ...deps, listen: undefined, env: { KATAGO_BIN: 'x', ENGINE_KEY: 'k', ENGINE_PORT: String(port) } });
      // Готовность сервера приходит событием, а не возвратом startEngine: ждём саму строку.
      const line = await vi.waitFor(() => {
        const found = say.mock.calls.map((c) => String(c[0])).find((l) => l.includes('go-engine на порту'));
        expect(found).toBeDefined();
        return found;
      });
      expect(line).toBe(`[OK] go-engine на порту ${port}; сети kata1-b10c128-s1141046784-d204142634.txt.gz + b18c384nbt-humanv0.bin.gz`);
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
