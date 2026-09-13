import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Call, fakeFetch } from '@goko/protocol';
import { ENGINE_RETRY_DELAY_MS, ENGINE_TIMEOUTS, createEngineClient, isConnectionError } from './engine-client.ts';
import { track } from './test-helpers.ts';

const req = { boardSize: 13, rules: 'chinese' as const, komi: 7.5, moves: [], rank: '10k' as const };
const scoreReq = { boardSize: 13, rules: 'chinese' as const, komi: 7.5, moves: [] };
const ok = { move: 'D4', winrateB: 0.5, scoreLeadB: 0, humanPolicyTop: [], humanFallback: false, ms: 12 };

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

// Заголовки отданы сразу, тело не приходит никогда: поток обрывается только сигналом запроса,
// как у настоящего fetch, когда движок отдал статус и замолчал.
const stalledBody = (status: number) => (call: Call) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        call.init.signal?.addEventListener('abort', () => controller.error(call.init.signal?.reason ?? new Error('aborted')));
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

// Ошибка fetch при отказе соединения, как у undici: TypeError('fetch failed') с системной ошибкой в cause.
const connectionError = (code: string) => {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:8788`), { code });
  return new TypeError('fetch failed', { cause });
};
const refused = () => () => {
  throw connectionError('ECONNREFUSED');
};

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

  it.each(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'])('genmove: один повтор на ошибку соединения %s до ответа, затем успех', async (code) => {
    const f = fakeFetch([
      () => {
        throw connectionError(code);
      },
      () => Response.json(ok),
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const first = engine.genmove(req);
    await drain();
    expect((await first).move).toBe('D4');
    expect(f.calls).toHaveLength(2);
  });

  it('genmove: две ошибки соединения подряд -> engine_unavailable, попыток ровно две', async () => {
    const f = fakeFetch([refused()]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ name: 'ApiError', code: 'engine_unavailable', message: 'engine is unreachable' });
    await drain();
    await failing;
    expect(f.calls).toHaveLength(2);
  });

  it('analyze и score не повторяются даже на ошибку соединения', async () => {
    const f = fakeFetch([refused()]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const analyzing = expect(engine.analyze({ ...req })).rejects.toMatchObject({ code: 'engine_unavailable' });
    await drain();
    await analyzing;
    expect(f.calls).toHaveLength(1);
    const scoring = expect(engine.score(scoreReq)).rejects.toMatchObject({ code: 'engine_unavailable' });
    await drain();
    await scoring;
    expect(f.calls).toHaveLength(2);
  });

  it('genmove: 503 go-engine не повторяется — ответ получен', async () => {
    const g = fakeFetch([() => Response.json({ error: { code: 'engine_busy', message: 'очередь' } }, { status: 503 }), () => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: g.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_busy' });
    await drain();
    await failing;
    expect(g.calls).toHaveLength(1);
  });

  it('genmove: ошибка fetch без кода соединения не повторяется', async () => {
    const f = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      () => Response.json(ok),
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_unavailable', message: 'engine is unreachable' });
    await drain();
    await failing;
    expect(f.calls).toHaveLength(1);
  });

  it('isConnectionError: код в цепочке cause и в AggregateError, глубина ограничена', () => {
    expect(isConnectionError(connectionError('ECONNREFUSED'))).toBe(true);
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isConnectionError(new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('a'), { code: 'EHOSTUNREACH' }), Object.assign(new Error('b'), { code: 'ECONNREFUSED' })]) }))).toBe(true);
    expect(isConnectionError(new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' }) }))).toBe(true);
    for (const code of ['ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_HEADERS_TIMEOUT', 'ABORT_ERR']) {
      expect(isConnectionError(connectionError(code)), code).toBe(false);
    }
    expect(isConnectionError(new TypeError('fetch failed'))).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError('ECONNREFUSED')).toBe(false);
    // Цепочка из шести обёрток над кодом: глубже предела не ищем, цикл cause не зависает.
    let deep: Error = Object.assign(new Error('root'), { code: 'ECONNREFUSED' });
    for (let i = 0; i < 5; i++) deep = new Error('wrap', { cause: deep });
    expect(isConnectionError(deep)).toBe(true);
    expect(isConnectionError(new Error('wrap', { cause: deep }))).toBe(false);
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;
    expect(isConnectionError(loop)).toBe(false);
  });

  it('4xx не повторяется и отдаётся как ApiError', async () => {
    const f = fakeFetch([() => Response.json({ error: { code: 'bad_request', message: 'схема' } }, { status: 400 })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.score(scoreReq)).rejects.toMatchObject({ name: 'ApiError', code: 'internal' });
    await drain();
    await failing;
    expect(f.calls).toHaveLength(1);
  });

  it('ответ не по протоколу с кодом ошибки -> engine_unavailable без повтора', async () => {
    const f = fakeFetch([() => new Response('<html>502</html>', { status: 502 }), () => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_unavailable', message: 'engine responded with 502' });
    await drain();
    await failing;
    expect(f.calls).toHaveLength(1);
  });

  it('таймаут -> engine_busy без повтора', async () => {
    const f = fakeFetch([hang()]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1, timeouts: { genmove: 20, analyze: 20, score: 20 } });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_busy' });
    await drain();
    await failing;
    expect(f.calls).toHaveLength(1);
  });

  it('500 без тела по протоколу не повторяется', async () => {
    const f = fakeFetch([() => new Response('boom', { status: 500 }), () => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_unavailable', message: 'engine responded with 500' });
    await drain();
    await failing;
    expect(f.calls).toHaveLength(1);
  });

  it('успешный ответ не по схеме -> ApiError engine_unavailable без повтора', async () => {
    const f = fakeFetch([() => Response.json({ move: 'D4' })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ name: 'ApiError', code: 'engine_unavailable', status: 503 });
    await drain();
    await failing;
    // Тело детерминировано: вторая попытка разобрала бы его так же.
    expect(f.calls).toHaveLength(1);
    // Текст ZodError ушёл бы в событие error, в SSE и в голос: наружу фиксированный текст, сам ZodError — в cause.
    const err: unknown = await engine.genmove(req).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'engine response does not match the protocol' });
    expect(String((err as Error).cause)).toContain('humanFallback');
  });

  it('нечитаемое тело успешного ответа тоже даёт ApiError, а не SyntaxError', async () => {
    const f = fakeFetch([() => new Response('not json', { status: 200 })]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ name: 'ApiError', code: 'engine_unavailable' });
    await drain();
    await failing;
  });

  it('пауза перед повтором берётся из retryDelayMs, по шагам таймера', async () => {
    const f = fakeFetch([refused(), () => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 150 });
    const pending = engine.genmove(req);
    await vi.advanceTimersByTimeAsync(149);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    expect((await pending).move).toBe('D4');
  });

  it('каждой операции достаётся свой таймаут, и тратится он один раз', async () => {
    const hangs = fakeFetch([hang()]);
    const engine = createEngineClient({
      baseUrl: 'http://engine.test',
      engineKey: 'ek',
      fetch: hangs.fetch,
      retryDelayMs: 10,
      timeouts: { genmove: 20, analyze: 200, score: 400 },
    });
    const check = async (call: () => Promise<unknown>, timeoutMs: number, callsBefore: number) => {
      const p = call();
      const state = track(p);
      const failing = expect(p).rejects.toMatchObject({ code: 'engine_busy', message: `engine did not respond within ${timeoutMs} ms` });
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await failing;
      expect(state.settled).toBe(true);
      await vi.advanceTimersByTimeAsync(10 + timeoutMs);
      expect(hangs.calls).toHaveLength(callsBefore + 1);
      expect(vi.getTimerCount()).toBe(0);
    };
    await check(() => engine.genmove(req), 20, 0);
    await check(() => engine.analyze({ ...req }), 200, 1);
    await check(() => engine.score(scoreReq), 400, 2);
  });

  it('умолчания по шагам таймера: genmove 10 с, analyze 8 с, score 18 с, повтора после таймаута нет', async () => {
    const check = async (call: (e: ReturnType<typeof createEngineClient>) => Promise<unknown>, timeoutMs: number) => {
      const f = fakeFetch([hang()]);
      const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
      const p = call(engine);
      const state = track(p);
      const failing = expect(p).rejects.toMatchObject({ code: 'engine_busy', message: `engine did not respond within ${timeoutMs} ms` });
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(state.settled).toBe(false); // таймаут ещё не наступил
      await vi.advanceTimersByTimeAsync(1);
      await failing;
      await vi.advanceTimersByTimeAsync(ENGINE_RETRY_DELAY_MS + timeoutMs);
      expect(f.calls).toHaveLength(1);
    };
    await check((e) => e.genmove(req), 10_000);
    await check((e) => e.analyze({ ...req }), 8_000);
    await check((e) => e.score(scoreReq), 18_000);
  });

  it('пауза по умолчанию перед повтором genmove — 200 мс', async () => {
    const f = fakeFetch([refused(), () => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
    const pending = engine.genmove(req);
    await vi.advanceTimersByTimeAsync(199);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    expect((await pending).move).toBe('D4');
  });

  it('заголовки пришли, тело застряло: таймаут прерывает и чтение тела', async () => {
    const f = fakeFetch([stalledBody(200)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 10, timeouts: { genmove: 300, analyze: 300, score: 300 } });
    const p = engine.genmove(req);
    const state = track(p);
    const failing = expect(p).rejects.toMatchObject({ name: 'ApiError', code: 'engine_busy', message: 'engine did not respond within 300 ms' });
    await vi.advanceTimersByTimeAsync(299);
    expect(state.settled).toBe(false);
    // Тело обрывается на 300-й: это таймаут, повтора нет.
    await vi.advanceTimersByTimeAsync(1);
    await failing;
    await vi.advanceTimersByTimeAsync(10 + 300);
    expect(f.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('таймаут до заголовков узнаётся по сигналу, а не по имени ошибки fetch', async () => {
    // Подставной fetch отдаёт на прерывание свой AbortError, а не причину сигнала.
    const f = fakeFetch([
      (call: Call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
        }),
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 10, timeouts: { genmove: 300, analyze: 300, score: 300 } });
    const failing = expect(engine.genmove(req)).rejects.toMatchObject({ code: 'engine_busy', message: 'engine did not respond within 300 ms' });
    await vi.advanceTimersByTimeAsync(300 + 10 + 300);
    await failing;
    expect(f.calls).toHaveLength(1);
  });

  it('код ошибки пришёл, тело застряло: тоже таймаут, а не «ответил 503»', async () => {
    const f = fakeFetch([stalledBody(503)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 10, timeouts: { genmove: 300, analyze: 300, score: 300 } });
    const p = engine.score(scoreReq);
    const state = track(p);
    const failing = expect(p).rejects.toMatchObject({ code: 'engine_busy', message: 'engine did not respond within 300 ms' });
    await vi.advanceTimersByTimeAsync(299);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1 + 10 + 300);
    await failing;
    expect(f.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('после отказа таймер запроса тоже снят: мусор в теле и код ошибки', async () => {
    const garbage = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: fakeFetch([() => Response.json({ move: 'D4' })]).fetch });
    await expect(garbage.genmove(req)).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(vi.getTimerCount()).toBe(0);
    const refused = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: fakeFetch([() => Response.json({ error: { code: 'bad_request', message: 'схема' } }, { status: 400 })]).fetch });
    await expect(refused.genmove(req)).rejects.toMatchObject({ code: 'internal' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('после ответа таймер запроса снят: клиент не держит процесс живым', async () => {
    const f = fakeFetch([() => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
    await engine.genmove(req);
    // Незакрытый таймаут держал бы событийный цикл до 30 с после ответа.
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('текст чужого исключения не уходит в message (п.5 брифа)', () => {
    const LEAK = 'connect ECONNREFUSED 10.1.2.3:8788 /opt/katago/secret';
    const leaks = (err: unknown) => {
      const e = err as Error & { details?: unknown };
      expect(e.message).toMatch(/^[ -~]+$/);
      expect(e.message).not.toContain('10.1.2.3');
      expect(e.message).not.toContain('/opt');
      expect(JSON.stringify(e.details ?? null)).not.toContain('/opt');
    };

    it('fetch бросил: engine is unreachable, исходное исключение в cause', async () => {
      const cause = new TypeError(LEAK);
      const f = fakeFetch([
        () => {
          throw cause;
        },
      ]);
      const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
      const p = engine.genmove(req).catch((e: unknown) => e);
      await drain();
      const err = await p;
      expect(err).toMatchObject({ name: 'ApiError', code: 'engine_unavailable', message: 'engine is unreachable' });
      expect((err as Error).cause).toBe(cause);
      leaks(err);
    });

    it('go-engine ответил ошибкой по протоколу: message и details чужие не проходят', async () => {
      const body = { error: { code: 'engine_busy', message: `KataGo failed: ${LEAK}`, details: { model: '/opt/katago/model.bin.gz' } } };
      const f = fakeFetch([() => Response.json(body, { status: 503 })]);
      const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
      const p = engine.score(scoreReq).catch((e: unknown) => e);
      await drain();
      const err = await p;
      expect(err).toMatchObject({ name: 'ApiError', code: 'engine_busy', status: 503, message: 'engine error: engine_busy' });
      expect((err as Error & { details?: unknown }).details).toBeUndefined();
      expect(String((err as Error).cause)).toContain('KataGo failed');
      leaks(err);
      const refused = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: fakeFetch([() => Response.json({ error: { code: 'bad_request', message: LEAK } }, { status: 400 })]).fetch });
      const err400 = await refused.analyze({ ...req }).catch((e: unknown) => e);
      expect(err400).toMatchObject({ code: 'internal', message: 'engine error: bad_request' });
      leaks(err400);
    });
  });

  // Наружу как свои проходят только занятость и недоступность движка: на них у агента есть реплика.
  // Повтора нет ни у одного кода: ответ получен. unauthorized, bad_request и internal go-engine — ошибка нашей стороны
  // (ключ, схема, отказ KataGo), и в публичном API это internal: чужой 401 или 400 выглядел бы как
  // ошибка вызывающего. Код go-engine остаётся в message, исходная ошибка — в cause.
  const engineCodes: [code: string, status: number, outCode: string, outStatus: number, calls: number][] = [
    ['engine_busy', 503, 'engine_busy', 503, 1],
    ['engine_unavailable', 503, 'engine_unavailable', 503, 1],
    ['unauthorized', 401, 'internal', 500, 1],
    ['bad_request', 400, 'internal', 500, 1],
    ['internal', 500, 'internal', 500, 1],
  ];
  for (const [code, status, outCode, outStatus, calls] of engineCodes) {
    it(`код go-engine ${code} (${status}) наружу как ${outCode}`, async () => {
      const body = { error: { code, message: 'secret text' } };
      const f = fakeFetch([() => Response.json(body, { status })]);
      const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch, retryDelayMs: 1 });
      const p = engine.genmove(req).catch((e: unknown) => e);
      await drain();
      const err = await p;
      expect(err).toMatchObject({ name: 'ApiError', code: outCode, status: outStatus, message: `engine error: ${code}` });
      expect((err as Error & { details?: unknown }).details).toBeUndefined();
      expect((err as Error).cause).toMatchObject({ code, message: 'secret text' });
      expect(f.calls).toHaveLength(calls);
    });
  }

  it('константы по умолчанию: таймауты 10/8/18 с, пауза перед повтором 200 мс', () => {
    expect(ENGINE_TIMEOUTS).toEqual({ genmove: 10_000, analyze: 8_000, score: 18_000 });
    expect(ENGINE_RETRY_DELAY_MS).toBe(200);
  });
});

// Отмена вызывающим (B1): signal доходит до fetch, отказ — причина сигнала, повтора после отмены нет.
describe('отмена вызова движка', () => {
  const ops: { name: string; run: (e: ReturnType<typeof createEngineClient>, signal: AbortSignal) => Promise<unknown> }[] = [
    { name: 'genmove', run: (e, signal) => e.genmove(req, signal) },
    { name: 'analyze', run: (e, signal) => e.analyze({ ...req }, signal) },
    { name: 'score', run: (e, signal) => e.score(scoreReq, signal) },
  ];

  it.each(ops)('$name: abort до ответа рвёт fetch, отказ — причина сигнала, таймеров не остаётся', async ({ run }) => {
    const f = fakeFetch([hang()]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
    const ac = new AbortController();
    const p = run(engine, ac.signal);
    const state = track(p);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls[0]?.init.signal?.aborted).toBe(false);
    const reason = new Error('deadline');
    ac.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.settled).toBe(true);
    await expect(p).rejects.toBe(reason);
    expect(f.calls[0]?.init.signal?.aborted).toBe(true);
    await drain();
    expect(f.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(ops)('$name: abort во время чтения тела — тоже причина сигнала, а не engine_busy', async ({ run }) => {
    const f = fakeFetch([stalledBody(200)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
    const ac = new AbortController();
    const p = run(engine, ac.signal);
    const failing = expect(p).rejects.toBe('stop');
    await vi.advanceTimersByTimeAsync(10);
    ac.abort('stop');
    await failing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(ops)('$name: уже отменённый сигнал — fetch не вызывается', async ({ run }) => {
    const f = fakeFetch([() => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
    const ac = new AbortController();
    ac.abort('gone');
    await expect(run(engine, ac.signal)).rejects.toBe('gone');
    expect(f.calls).toHaveLength(0);
  });

  it('genmove: abort во время паузы перед повтором — второй попытки нет', async () => {
    const f = fakeFetch([refused(), () => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
    const ac = new AbortController();
    const p = engine.genmove(req, ac.signal);
    const failing = expect(p).rejects.toBe('stop');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.calls).toHaveLength(1);
    ac.abort('stop');
    await failing;
    await drain();
    expect(f.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('genmove: ошибка соединения, пришедшая после abort, не повторяется', async () => {
    const ac = new AbortController();
    const f = fakeFetch([
      () => {
        ac.abort('stop');
        throw connectionError('ECONNRESET');
      },
      () => Response.json(ok),
    ]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
    const failing = expect(engine.genmove(req, ac.signal)).rejects.toBe('stop');
    await drain();
    await failing;
    expect(f.calls).toHaveLength(1);
  });

  it('ответ до отмены не портится поздним abort', async () => {
    const f = fakeFetch([() => Response.json(ok)]);
    const engine = createEngineClient({ baseUrl: 'http://engine.test', engineKey: 'ek', fetch: f.fetch });
    const ac = new AbortController();
    expect((await engine.genmove(req, ac.signal)).move).toBe('D4');
    ac.abort('late');
    expect(vi.getTimerCount()).toBe(0);
  });
});
