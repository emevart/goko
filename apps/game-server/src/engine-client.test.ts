import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Call, fakeFetch } from '@goko/protocol';
import { ENGINE_RETRY_DELAY_MS, ENGINE_TIMEOUTS, createEngineClient } from './engine-client.ts';

const req = { boardSize: 13, rules: 'chinese' as const, komi: 7.5, moves: [], rank: '10k' as const };
const scoreReq = { boardSize: 13, rules: 'chinese' as const, komi: 7.5, moves: [] };
const ok = { move: 'D4', winrateB: 0.5, scoreLeadB: 0, humanPolicyTop: [], ms: 12 };

// Время в тестах управляемое: и таймаут запроса, и пауза перед повтором — обычные
// setTimeout внутри клиента, поэтому тесты не спят ни миллисекунды.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

// Запрос, который отвечает только на прерывание сигнала.
const hang = () => (call: Call) =>
  new Promise<Response>((_, reject) => {
    call.init.signal?.addEventListener('abort', () => reject(call.init.signal?.reason ?? new Error('aborted')));
  });

// Наблюдение за промисом без ожидания: «уже осел или ещё нет».
function track<T>(p: Promise<T>): { settled: boolean } {
  const state = { settled: false };
  p.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

// Прокрутка времени с запасом: для тестов, которым важен исход, а не шаги.
async function drain(): Promise<void> {
  await vi.advanceTimersByTimeAsync(120_000);
}

describe('createEngineClient', () => {
  it('шлёт X-Engine-Key на /v1/genmove и разбирает ответ', async () => {
    const f = fakeFetch([() => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test/', engineKey: 'ek', fetch: f.fetch });
    const res = await engine.genmove(req);
    expect(res.move).toBe('D4');
    expect(f.calls[0]?.url).toBe('http://engine.test/v1/genmove');
    // Заголовки приводятся к Headers явно: fakeFetch отдаёт их объектом или Headers
    // в зависимости от того, как был вызван fetch.
    expect(new Headers(f.calls[0]?.init.headers).get('x-engine-key')).toBe('ek');
    expect(f.calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual(req);
  });

  it('у каждой операции свой путь: genmove, analyze, score', async () => {
    const analyzeOk = { visits: 10, winrateB: 0.5, scoreLeadB: 0, moveInfos: [] };
    const scoreOk = { ownership: [], dead: [], areaB: 1, areaW: 2, scoreLeadB: -8.5, winner: 'W' as const, margin: 8.5 };
    const f = fakeFetch([() => Response.json(ok), () => Response.json(analyzeOk), () => Response.json(scoreOk)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
    await engine.genmove(req);
    await engine.analyze({ ...req });
    await engine.score(scoreReq);
    expect(f.calls.map((c) => c.url)).toEqual(['http://engine.test/v1/genmove', 'http://engine.test/v1/analyze', 'http://engine.test/v1/score']);
  });

  it('один повтор при сетевой ошибке и при 503, затем успех', async () => {
    const f = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      () => Response.json(ok),
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const first = engine.genmove(req);
    await drain();
    expect((await first).move).toBe('D4');
    expect(f.calls).toHaveLength(2);

    const g = fakeFetch([() => Response.json({ error: { code: 'engine_busy', message: 'очередь' } }, { status: 503 }), () => Response.json(ok)]);
    const engine2 = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: g.fetch, retryDelayMs: 1 });
    const second = engine2.genmove(req);
    await drain();
    expect((await second).move).toBe('D4');
    expect(g.calls).toHaveLength(2);
  });

  it('две неудачи подряд -> ApiError engine_unavailable (сеть) или код движка (503)', async () => {
    const f = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ name: 'ApiError', code: 'engine_unavailable' });
    await drain();
    await failing;
    expect(f.calls).toHaveLength(2);

    const g = fakeFetch([() => Response.json({ error: { code: 'engine_busy', message: 'очередь' } }, { status: 503 })]);
    const engine2 = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: g.fetch, retryDelayMs: 1 });
    const failing2 = expect(engine2.analyze({ ...req })).rejects.toMatchObject({ code: 'engine_busy' });
    await drain();
    await failing2;
    expect(g.calls).toHaveLength(2);
  });

  it('4xx не повторяется и отдаётся как ApiError', async () => {
    const f = fakeFetch([() => Response.json({ error: { code: 'bad_request', message: 'схема' } }, { status: 400 })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.score(scoreReq)).rejects.toMatchObject({ code: 'bad_request' });
    await drain();
    await failing;
    expect(f.calls).toHaveLength(1);
  });

  it('ответ не по протоколу с кодом ошибки -> engine_unavailable', async () => {
    const f = fakeFetch([() => new Response('<html>502</html>', { status: 502 })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_unavailable', message: 'engine responded with 502' });
    await drain();
    await failing;
    expect(f.calls).toHaveLength(2);
  });

  it('таймаут -> engine_busy после повтора', async () => {
    const f = fakeFetch([hang()]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1, timeouts: { genmove: 20, analyze: 20, score: 20 } });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_busy' });
    await drain();
    await failing;
    expect(f.calls).toHaveLength(2);
  });

  it('500 тоже повторяется: граница повтора — сам код 500, а не «больше 500»', async () => {
    const f = fakeFetch([() => new Response('boom', { status: 500 }), () => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const pending = engine.genmove(req);
    await drain();
    expect((await pending).move).toBe('D4');
    expect(f.calls).toHaveLength(2);
  });

  it('успешный ответ не по схеме -> ApiError engine_unavailable без повтора', async () => {
    const f = fakeFetch([() => Response.json({ move: 'D4' })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ name: 'ApiError', code: 'engine_unavailable', status: 503 });
    await drain();
    await failing;
    // Тело детерминировано: вторая попытка разобрала бы его так же.
    expect(f.calls).toHaveLength(1);
  });

  it('нечитаемое тело успешного ответа тоже даёт ApiError, а не SyntaxError', async () => {
    const f = fakeFetch([() => new Response('not json', { status: 200 })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ name: 'ApiError', code: 'engine_unavailable' });
    await drain();
    await failing;
  });

  it('пауза перед повтором берётся из retryDelayMs, по шагам таймера', async () => {
    const f = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      () => Response.json(ok),
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 150 });
    const pending = engine.genmove(req);
    await vi.advanceTimersByTimeAsync(149);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    expect((await pending).move).toBe('D4');
  });

  it('каждой операции достаётся свой таймаут, и он тратится дважды', async () => {
    const hangs = fakeFetch([hang()]);
    const engine = createEngineClient({
      baseUrl: 'http://engine.test',
      engineKey: 'ek',
      fetch: hangs.fetch,
      retryDelayMs: 10,
      timeouts: { genmove: 20, analyze: 200, score: 400 },
    });
    // Две попытки на операцию: до второго таймаута отказа быть не должно.
    const check = async (call: () => Promise<unknown>, timeoutMs: number, callsBefore: number) => {
      const p = call();
      const state = track(p);
      const failing = expect(p).rejects.toMatchObject({ code: 'engine_busy' });
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(hangs.calls).toHaveLength(callsBefore + 1);
      await vi.advanceTimersByTimeAsync(1 + 10); // таймаут первой попытки и пауза повтора
      expect(hangs.calls).toHaveLength(callsBefore + 2);
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await failing;
      expect(state.settled).toBe(true);
    };
    await check(() => engine.genmove(req), 20, 0);
    await check(() => engine.analyze({ ...req }), 200, 2);
    await check(() => engine.score(scoreReq), 400, 4);
  });

  it('умолчания по шагам таймера: genmove 10 с, analyze 15 с, score 30 с, пауза 200 мс', async () => {
    const check = async (call: (e: ReturnType<typeof createEngineClient>) => Promise<unknown>, timeoutMs: number) => {
      const f = fakeFetch([hang()]);
      const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
      const p = call(engine);
      const failing = expect(p).rejects.toMatchObject({ code: 'engine_busy', message: `engine did not respond within ${timeoutMs} ms` });
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(f.calls).toHaveLength(1); // таймаут ещё не наступил
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(199);
      expect(f.calls).toHaveLength(1); // пауза перед повтором ещё идёт
      await vi.advanceTimersByTimeAsync(1);
      expect(f.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      await failing;
    };
    await check((e) => e.genmove(req), 10_000);
    await check((e) => e.analyze({ ...req }), 15_000);
    await check((e) => e.score(scoreReq), 30_000);
  });

  it('константы по умолчанию: таймауты 10/15/30 с, пауза перед повтором 200 мс', () => {
    expect(ENGINE_TIMEOUTS).toEqual({ genmove: 10_000, analyze: 15_000, score: 30_000 });
    expect(ENGINE_RETRY_DELAY_MS).toBe(200);
  });
});
