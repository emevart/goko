import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEOUTS } from './app.ts';
import {
  KataGo,
  KataGoError,
  type KataProcess,
  type KataQuery,
  type KataResponse,
  type SpawnedChild,
  wrapChild,
} from './katago.ts';
import { WARMUP_EXIT_CODE, WARMUP_QUERY, WARMUP_TIMEOUT_MS, warmupOrExit } from './warmup.ts';

type Call = { query: KataQuery; timeoutMs: number | undefined };

// Подделка движка: запоминает запрос прогрева и отвечает тем, чем велено. events — общий список
// с подделанным exit теста: по нему виден порядок остановки движка и выхода.
function fakeKatago(answer: () => Promise<KataResponse>) {
  const calls: Call[] = [];
  const events: string[] = [];
  let stops = 0;
  return {
    calls,
    events,
    get stops() {
      return stops;
    },
    katago: {
      query: (query: KataQuery, timeoutMs?: number): Promise<KataResponse> => {
        calls.push({ query, timeoutMs });
        return answer();
      },
      stop: async (): Promise<void> => {
        stops++;
        events.push('stop');
      },
    },
  };
}

describe('прогрев движка при старте', () => {
  it('ждёт ответа движка своим бюджетом и не трогает выход', async () => {
    const f = fakeKatago(async () => ({ id: 'q1' }));
    const logs: string[] = [];
    const exits: number[] = [];
    const ready = await warmupOrExit({ katago: f.katago, log: (l) => logs.push(l), exit: (c) => exits.push(c) });
    expect(ready).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.query).toEqual(WARMUP_QUERY);
    expect(f.calls[0]?.timeoutMs).toBe(WARMUP_TIMEOUT_MS);
    expect(exits).toEqual([]);
    expect(f.stops).toBe(0);
    expect(logs.some((l) => l.startsWith('[OK]') && l.includes('прогрет'))).toBe(true);
  });

  it('движок не поднялся: видимый отказ с причиной и выход, а не тихое ожидание', async () => {
    const f = fakeKatago(() => Promise.reject(new KataGoError('crashed', 'katago exited with code 2')));
    const logs: string[] = [];
    const exits: number[] = [];
    const exit = (code: number) => {
      exits.push(code);
      f.events.push(`exit ${code}`);
    };
    const ready = await warmupOrExit({ katago: f.katago, log: (l) => logs.push(l), exit });
    expect(ready).toBe(false); // вызывающий не начинает слушать порт
    expect(exits).toEqual([WARMUP_EXIT_CODE]);
    expect(f.stops).toBe(1); // процесс и таймеры отпущены, иначе выход подвиснет
    // stop раньше exit: живой KataGo (ответ-ошибка, молчание 300 с) иначе пережил бы node.
    expect(f.events).toEqual(['stop', `exit ${WARMUP_EXIT_CODE}`]);
    const line = logs.find((l) => l.startsWith('[X]'));
    expect(line).toContain('прогрев');
    expect(line).toContain('katago exited with code 2');
  });

  it('остановка по сигналу во время прогрева — не отказ: ни [X], ни кода выхода', async () => {
    const f = fakeKatago(() => Promise.reject(new KataGoError('crashed', 'katago stopped')));
    const logs: string[] = [];
    const exits: number[] = [];
    const ready = await warmupOrExit({
      katago: f.katago,
      log: (l) => logs.push(l),
      exit: (c) => exits.push(c),
      cancelled: () => true,
    });
    expect(ready).toBe(false); // порт не открывается
    expect(exits).toEqual([]); // код 0 ставит обработчик сигнала, а не прогрев
    expect(f.stops).toBe(0); // движок останавливает тот же обработчик
    expect(logs.some((l) => l.startsWith('[X]'))).toBe(false);
  });

  it('сигнал пришёл, когда ответ прогрева уже был в пути: без строки [OK] прогрет', async () => {
    const f = fakeKatago(async () => ({ id: 'q1' }));
    const logs: string[] = [];
    const exits: number[] = [];
    await warmupOrExit({ katago: f.katago, log: (l) => logs.push(l), exit: (c) => exits.push(c), cancelled: () => true });
    expect(logs.some((l) => l.startsWith('[OK]'))).toBe(false);
    expect(exits).toEqual([]);
    expect(f.stops).toBe(0);
  });

  it('свой бюджет прогрева доходит до движка и попадает в сообщение об отказе', async () => {
    const f = fakeKatago(() => Promise.reject(new Error('boom')));
    const logs: string[] = [];
    await warmupOrExit({ katago: f.katago, timeoutMs: 1234, log: (l) => logs.push(l), exit: () => undefined });
    expect(f.calls[0]?.timeoutMs).toBe(1234);
    expect(logs.some((l) => l.startsWith('[X]') && l.includes('1234') && l.includes('boom'))).toBe(true);
  });

  it('бюджет прогрева заметно больше боевого: тюнинг ядер идёт минутами', () => {
    expect(WARMUP_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUTS.score * 10);
    expect(WARMUP_TIMEOUT_MS).toBe(300_000); // решение зафиксировано числом, а не неравенством
  });

  it('запрос прогрева: пустая доска 13x13, один просмотр и без своего id', () => {
    // Свой id перезаписал бы служебный, и ответ движка не нашёл бы ждущего прогрев.
    expect(WARMUP_QUERY).toEqual({
      rules: 'chinese',
      komi: 7.5,
      boardXSize: 13,
      boardYSize: 13,
      moves: [],
      maxVisits: 1,
    });
  });

  it('код выхода при провале не равен нулю: иначе оркестратор сочтёт запуск успешным', () => {
    expect(WARMUP_EXIT_CODE).toBeGreaterThan(0);
  });

  it('сообщение об отказе понимает и не-Error причину', async () => {
    const f = fakeKatago(() => Promise.reject('строка вместо ошибки'));
    const logs: string[] = [];
    await warmupOrExit({ katago: f.katago, log: (l) => logs.push(l), exit: () => undefined });
    expect(logs.some((l) => l.startsWith('[X]') && l.includes('строка вместо ошибки'))).toBe(true);
  });
});

// Сырой дочерний процесс для wrapChild: события через EventEmitter, потоки — настоящие.
type RawChild = SpawnedChild & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; emitter: EventEmitter };

function rawChild(): RawChild {
  const emitter = new EventEmitter();
  const on = ((event: string, cb: (...args: unknown[]) => void) => {
    emitter.on(event, cb);
  }) as SpawnedChild['on'];
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
    on,
    emitter,
  };
}

// Настоящий KataGo поверх подделанного процесса: тем же путём идёт боевой запуск.
function realKatago() {
  const logs: string[] = [];
  const exits: number[] = [];
  const children: RawChild[] = [];
  const log = (l: string): void => {
    logs.push(l);
  };
  const katago = new KataGo({
    bin: 'katago',
    model: 'main',
    humanModel: 'human',
    config: 'cfg',
    log,
    spawn: (): KataProcess => {
      const child = rawChild();
      children.push(child);
      return wrapChild(child, log);
    },
  });
  const child = (): RawChild => {
    const c = children[0];
    if (c === undefined) throw new Error('katago was not spawned');
    return c;
  };
  const run = (): Promise<boolean> => {
    katago.start();
    return warmupOrExit({ katago, log, exit: (c) => exits.push(c) });
  };
  return { katago, logs, exits, child, run };
}

// Доставка данных потоками настоящая (setImmediate не подменён), время не идёт вовсе.
const tick = async (): Promise<void> => {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
};

describe('быстрый отказ прогрева на настоящем KataGo', () => {
  // Отказ приходит событием процесса, а не бюджетом 300 с: запрос прогрева уходит в полёт
  // синхронно со start(), и выход процесса отклоняет его сразу. Часы не двигаются ни разу,
  // а после выхода не остаётся ни таймера бюджета, ни таймера перезапуска.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('процесс вышел сразу после старта: код 3 без ожидания бюджета', async () => {
    const e = realKatago();
    const ready = e.run();
    e.child().emitter.emit('exit', 1);
    await tick(); // только доставка событий: если бы прогрев ждал бюджета, выхода ещё не было бы
    expect(e.exits).toEqual([WARMUP_EXIT_CODE]);
    expect(await ready).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(performance.now()).toBe(0);
    expect(e.logs.some((l) => l.startsWith('[X]') && l.includes('katago exited with code 1'))).toBe(true);
  });

  it('процесс не запустился (error): код 3 без ожидания бюджета', async () => {
    const e = realKatago();
    const ready = e.run();
    e.child().emitter.emit('error', new Error('spawn katago ENOENT'));
    await tick(); // только доставка событий: если бы прогрев ждал бюджета, выхода ещё не было бы
    expect(e.exits).toEqual([WARMUP_EXIT_CODE]);
    expect(await ready).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(performance.now()).toBe(0);
    expect(e.logs.some((l) => l.includes('spawn failed: spawn katago ENOENT'))).toBe(true);
  });

  it('движок ответил на прогрев ошибкой: код 3 без ожидания бюджета, текст ошибки в логе', async () => {
    const e = realKatago();
    const ready = e.run();
    e.child().stdout.write(`${JSON.stringify({ id: 'q1', error: 'bad' })}
`);
    await tick();
    expect(e.exits).toEqual([WARMUP_EXIT_CODE]);
    expect(await ready).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(performance.now()).toBe(0);
    expect(e.logs.some((l) => l.startsWith('[X]') && l.includes('bad'))).toBe(true);
  });

  it('предупреждение движка — не отказ: прогрев ждёт ответа', async () => {
    const e = realKatago();
    const ready = e.run();
    e.child().stdout.write(`${JSON.stringify({ id: 'q1', warning: 'w', field: 'x' })}
`);
    await tick();
    expect(e.exits).toEqual([]);
    e.child().stdout.write(`${JSON.stringify({ id: 'q1', rootInfo: {} })}
`);
    await tick();
    expect(await ready).toBe(true);
    expect(e.exits).toEqual([]);
    await e.katago.stop();
  });
});

describe('строка отказа прогрева', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('печатает фактическое время отдельно от бюджета: иначе кажется, что ждали пять минут', async () => {
    const f = fakeKatago(() => {
      vi.advanceTimersByTime(4321);
      return Promise.reject(new Error('katago exited with code null'));
    });
    const logs: string[] = [];
    vi.advanceTimersByTime(1000); // часы процесса не с нуля: отсчёт идёт от начала прогрева
    await warmupOrExit({ katago: f.katago, log: (l) => logs.push(l), exit: () => undefined });
    const line = logs.find((l) => l.startsWith('[X]'));
    expect(line).toContain('через 4321 мс');
    expect(line).toContain(`бюджет ${WARMUP_TIMEOUT_MS} мс`);
    expect(line).toContain('katago exited with code null');
  });
});
