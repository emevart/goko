import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUTS } from './app.ts';
import { KataGoError, type KataQuery, type KataResponse } from './katago.ts';
import { WARMUP_EXIT_CODE, WARMUP_QUERY, WARMUP_TIMEOUT_MS, warmupOrExit } from './warmup.ts';

type Call = { query: KataQuery; timeoutMs: number | undefined };

// Подделка движка: запоминает запрос прогрева и отвечает тем, чем велено.
function fakeKatago(answer: () => Promise<KataResponse>) {
  const calls: Call[] = [];
  let stops = 0;
  return {
    calls,
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
    const ready = await warmupOrExit({ katago: f.katago, log: (l) => logs.push(l), exit: (c) => exits.push(c) });
    expect(ready).toBe(false); // вызывающий не начинает слушать порт
    expect(exits).toEqual([WARMUP_EXIT_CODE]);
    expect(f.stops).toBe(1); // процесс и таймеры отпущены, иначе выход подвиснет
    const line = logs.find((l) => l.startsWith('[X]'));
    expect(line).toContain('прогрев');
    expect(line).toContain('katago exited with code 2');
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
  });

  it('запрос прогрева не несёт своего id: его подставляет KataGo.query', () => {
    expect(Object.keys(WARMUP_QUERY)).not.toContain('id');
    expect(WARMUP_QUERY.maxVisits).toBe(1); // прогрев не считает позицию, а будит движок
  });

  it('сообщение об отказе понимает и не-Error причину', async () => {
    const f = fakeKatago(() => Promise.reject('строка вместо ошибки'));
    const logs: string[] = [];
    await warmupOrExit({ katago: f.katago, log: (l) => logs.push(l), exit: () => undefined });
    expect(logs.some((l) => l.startsWith('[X]') && l.includes('строка вместо ошибки'))).toBe(true);
  });
});
