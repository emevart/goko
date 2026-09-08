import { describe, expect, it } from 'vitest';
import { fakeFetch } from '@goko/protocol';
import { createEngineClient } from './engine-client.ts';

const req = { boardSize: 13, rules: 'chinese' as const, komi: 7.5, moves: [], rank: '10k' as const };
const ok = { move: 'D4', winrateB: 0.5, scoreLeadB: 0, humanPolicyTop: [], ms: 12 };

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

  it('один повтор при сетевой ошибке и при 503, затем успех', async () => {
    const f = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      () => Response.json(ok),
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    expect((await engine.genmove(req)).move).toBe('D4');
    expect(f.calls).toHaveLength(2);

    const g = fakeFetch([() => Response.json({ error: { code: 'engine_busy', message: 'очередь' } }, { status: 503 }), () => Response.json(ok)]);
    const engine2 = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: g.fetch, retryDelayMs: 1 });
    expect((await engine2.genmove(req)).move).toBe('D4');
    expect(g.calls).toHaveLength(2);
  });

  it('две неудачи подряд -> ApiError engine_unavailable (сеть) или код движка (503)', async () => {
    const f = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    await expect(engine.genmove(req)).rejects.toMatchObject({ name: 'ApiError', code: 'engine_unavailable' });
    expect(f.calls).toHaveLength(2);

    const g = fakeFetch([() => Response.json({ error: { code: 'engine_busy', message: 'очередь' } }, { status: 503 })]);
    const engine2 = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: g.fetch, retryDelayMs: 1 });
    await expect(engine2.analyze({ ...req })).rejects.toMatchObject({ code: 'engine_busy' });
    expect(g.calls).toHaveLength(2);
  });

  it('4xx не повторяется и отдаётся как ApiError', async () => {
    const f = fakeFetch([() => Response.json({ error: { code: 'bad_request', message: 'схема' } }, { status: 400 })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    await expect(engine.score({ boardSize: 13, rules: 'chinese', komi: 7.5, moves: [] })).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.calls).toHaveLength(1);
  });

  it('ответ не по протоколу с кодом ошибки -> engine_unavailable', async () => {
    const f = fakeFetch([() => new Response('<html>502</html>', { status: 502 })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    await expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_unavailable', message: 'engine responded with 502' });
    expect(f.calls).toHaveLength(2);
  });

  it('таймаут -> engine_busy после повтора', async () => {
    const f = fakeFetch([
      (call) =>
        new Promise((_, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(call.init.signal?.reason ?? new Error('aborted')));
        }),
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1, timeouts: { genmove: 20, analyze: 20, score: 20 } });
    await expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_busy' });
    expect(f.calls).toHaveLength(2);
  });

  it('500 тоже повторяется: граница повтора — сам код 500, а не «больше 500»', async () => {
    const f = fakeFetch([() => new Response('boom', { status: 500 }), () => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    expect((await engine.genmove(req)).move).toBe('D4');
    expect(f.calls).toHaveLength(2);
  });

  it('успешный ответ не по схеме — отказ, а не молчаливый мусор', async () => {
    const f = fakeFetch([() => Response.json({ move: 'D4' })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    await expect(engine.genmove(req)).rejects.toThrow();
  });

  it('пауза перед повтором берётся из retryDelayMs', async () => {
    const boom = () => {
      throw new TypeError('fetch failed');
    };
    const slow = fakeFetch([boom]);
    const engineSlow = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: slow.fetch, retryDelayMs: 150 });
    const t0 = Date.now();
    await expect(engineSlow.genmove(req)).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);

    const fast = fakeFetch([boom]);
    const engineFast = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: fast.fetch, retryDelayMs: 1 });
    const t1 = Date.now();
    await expect(engineFast.genmove(req)).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(Date.now() - t1).toBeLessThan(160);
  });

  it('каждой операции достаётся свой таймаут', async () => {
    const hang = fakeFetch([
      (call) =>
        new Promise((_, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(call.init.signal?.reason ?? new Error('aborted')));
        }),
    ]);
    const engine = createEngineClient({
      baseUrl: 'http://engine.test',
      engineKey: 'ek',
      fetch: hang.fetch,
      retryDelayMs: 1,
      timeouts: { genmove: 20, analyze: 200, score: 400 },
    });
    // Две попытки на операцию, поэтому ожидаемое время — примерно два таймаута.
    const elapsed = async (fn: () => Promise<unknown>) => {
      const t0 = Date.now();
      await expect(fn()).rejects.toMatchObject({ code: 'engine_busy' });
      return Date.now() - t0;
    };
    expect(await elapsed(() => engine.genmove(req))).toBeLessThan(250);
    const analyzeMs = await elapsed(() => engine.analyze({ ...req }));
    expect(analyzeMs).toBeGreaterThanOrEqual(380);
    expect(analyzeMs).toBeLessThan(750);
    expect(await elapsed(() => engine.score({ boardSize: 13, rules: 'chinese', komi: 7.5, moves: [] }))).toBeGreaterThanOrEqual(780);
  });

  it('константы по умолчанию: таймауты 10/15/30 с, пауза перед повтором 200 мс', async () => {
    const { ENGINE_TIMEOUTS, ENGINE_RETRY_DELAY_MS } = await import('./engine-client.ts');
    expect(ENGINE_TIMEOUTS).toEqual({ genmove: 10_000, analyze: 15_000, score: 30_000 });
    expect(ENGINE_RETRY_DELAY_MS).toBe(200);
  });
});
