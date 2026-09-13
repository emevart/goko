import { describe, expect, it, vi } from 'vitest';
import { coordToIndex } from '@goko/go-core';
import { serve } from '@hono/node-server';
import { DEFAULT_TIMEOUTS, MAX_BODY_BYTES, SCORE_VISITS, createEngineApp } from './app.ts';
import { KataGoError, type KataQuery, type KataResponse } from './katago.ts';
import { walls } from './test-helpers.ts';

type FakeKatago = {
  calls: KataQuery[];
  timeouts: (number | undefined)[];
  signals: (AbortSignal | undefined)[];
  alive: boolean;
  queueLength: number;
  restarts: number;
  query: (q: KataQuery, timeoutMs?: number, signal?: AbortSignal) => Promise<KataResponse>;
};

function fakeKatago(
  reply: (q: KataQuery) => Partial<KataResponse>,
  extra: { alive?: boolean; queueLength?: number; restarts?: number } = {},
): FakeKatago {
  return {
    calls: [],
    timeouts: [],
    signals: [],
    alive: extra.alive ?? true,
    queueLength: extra.queueLength ?? 0,
    restarts: extra.restarts ?? 0,
    async query(q: KataQuery, timeoutMs?: number, signal?: AbortSignal): Promise<KataResponse> {
      this.calls.push(q);
      this.timeouts.push(timeoutMs);
      this.signals.push(signal);
      return { id: 'q', ...reply(q) };
    },
  };
}

// Ошибка движка приходит из query(), а не из состояния: отдельная подделка.
function throwingKatago(err: Error): FakeKatago {
  const k = fakeKatago(() => ({}));
  k.query = () => Promise.reject(err);
  return k;
}

const KEY = 'engine-secret';
const headers = { 'content-type': 'application/json', 'x-engine-key': KEY };
const base = { boardSize: 13, rules: 'chinese', komi: 7.5 };

type ErrorShape = { error: { code: string; message: string } };
type GenmoveShape = {
  move: string;
  winrateB: number;
  scoreLeadB: number;
  humanPolicyTop: { coord: string; prob: number }[];
  humanFallback?: boolean;
  ms: number;
};
type AnalyzeShape = {
  visits: number;
  winrateB: number;
  scoreLeadB: number;
  moveInfos: { coord: string; order: number }[];
  ownership?: number[];
};
type ScoreShape = {
  ownership: number[];
  dead: string[];
  areaB: number;
  areaW: number;
  scoreLeadB: number;
  winner: string;
  margin: number;
};

const jsonAs = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const codeOf = async (res: Response): Promise<string> => (await jsonAs<ErrorShape>(res)).error.code;

const post = (
  app: ReturnType<typeof createEngineApp>,
  route: string,
  body: unknown,
  h = headers,
  signal?: AbortSignal,
) => app.request(route, { method: 'POST', headers: h, body: JSON.stringify(body), signal });

// Ownership в порядке KataGo (строки сверху): строки выше границы белые (-1), ниже — чёрные (+1).
function kataOwnership(blackRowsFromBottom: number, size = 13): number[] {
  const out: number[] = [];
  for (let rowFromTop = 0; rowFromTop < size; rowFromTop++) {
    const row = size - rowFromTop; // size..1
    for (let c = 0; c < size; c++) out.push(row <= blackRowsFromBottom ? 1 : -1);
  }
  return out;
}

describe('createEngineApp', () => {
  it('без ключа — 401, при полной очереди — 503 engine_busy, без процесса — engine_unavailable', async () => {
    const app = createEngineApp({ katago: fakeKatago(() => ({})), engineKey: KEY, models: { main: 'm', human: 'h' } });
    const noKey = await app.request('/v1/genmove', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(noKey.status).toBe(401);
    expect(await codeOf(noKey)).toBe('unauthorized');
    const busy = createEngineApp({
      katago: fakeKatago(() => ({}), { queueLength: 8 }),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const busyRes = await post(busy, '/v1/genmove', {});
    expect(busyRes.status).toBe(503);
    expect(await codeOf(busyRes)).toBe('engine_busy');
    const dead = createEngineApp({
      katago: fakeKatago(() => ({}), { alive: false }),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const deadRes = await post(dead, '/v1/analyze', {});
    expect(deadRes.status).toBe(503);
    expect(await codeOf(deadRes)).toBe('engine_unavailable');
  });

  it('ключ другой длины, пустой и совпадающий префикс — 401; верный ключ проходит', async () => {
    const katago = fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0, visits: 1 }, ownership: kataOwnership(7) }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    for (const key of ['', KEY.slice(0, -1), `${KEY}x`, KEY.toUpperCase()]) {
      const res = await post(app, '/v1/score', { ...base, moves: [] }, { ...headers, 'x-engine-key': key });
      expect(res.status, `ключ длины ${key.length}`).toBe(401);
      expect(await codeOf(res)).toBe('unauthorized');
    }
    expect(katago.calls).toEqual([]);
    expect((await post(app, '/v1/score', { ...base, moves: [] })).status).toBe(200);
  });

  it('тело больше 64 КБ — 400 bad_request, движок не дёргается; тело ровно на пределе проходит', async () => {
    expect(MAX_BODY_BYTES).toBe(64 * 1024);
    const katago = fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0, visits: 1 }, ownership: kataOwnership(7) }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const json = JSON.stringify({ ...base, moves: [] });
    const padded = (size: number) => json + ' '.repeat(size - Buffer.byteLength(json));
    const big = await app.request('/v1/score', { method: 'POST', headers, body: padded(MAX_BODY_BYTES + 1) });
    expect(big.status).toBe(400);
    expect(await big.json()).toEqual({ error: { code: 'bad_request', message: 'request body is too large' } });
    expect(katago.calls).toEqual([]);
    // Без ключа тело не читается: отказ по ключу, а не по размеру.
    const noKey = await app.request('/v1/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: padded(MAX_BODY_BYTES + 1) });
    expect(noKey.status).toBe(401);
    const edge = await app.request('/v1/score', { method: 'POST', headers, body: padded(MAX_BODY_BYTES) });
    expect(edge.status).toBe(200);
    expect(katago.calls).toHaveLength(1);
  });

  it('обрыв соединения клиентом на настоящем сокете отменяет запрос к движку', async () => {
    // Сигнал запроса @hono/node-server обрывает по close сокета; KataGo по этому сигналу снимает
    // запрос и из очереди, и из полёта (katago.test.ts: «abort в очереди», «abort в полёте»).
    const signals: AbortSignal[] = [];
    const katago = fakeKatago(() => ({}));
    katago.query = (_q, _timeoutMs, signal) =>
      new Promise((_, reject) => {
        if (!signal) return reject(new Error('no signal'));
        signals.push(signal);
        signal.addEventListener('abort', () => reject(new KataGoError('aborted', 'katago query aborted by the caller')), { once: true });
      });
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    // Настоящий ввод-вывод: ждём обороты цикла событий с потолком, без часов.
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 100_000; i++) {
        if (cond()) return;
        await new Promise((r) => setImmediate(r));
      }
      throw new Error('условие не выполнилось за отведённые обороты очереди');
    };
    try {
      await until(() => server.listening);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const ac = new AbortController();
      const request = fetch(`http://127.0.0.1:${port}/v1/score`, { method: 'POST', headers, body: JSON.stringify({ ...base, moves: [] }), signal: ac.signal }).catch((e: unknown) => e);
      await until(() => signals.length === 1);
      expect(signals[0]?.aborted).toBe(false);
      ac.abort();
      await until(() => signals[0]?.aborted === true);
      expect(await request).toBeInstanceOf(Error);
    } finally {
      server.close();
    }
  });

  it('неверный ключ — 401, движок не дёргается', async () => {
    const katago = fakeKatago(() => ({}));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await post(app, '/v1/score', { ...base, moves: [] }, { ...headers, 'x-engine-key': 'wrong' });
    expect(res.status).toBe(401);
    expect(katago.calls).toEqual([]);
  });

  it('очередь на единицу меньше лимита ещё пропускается, свой maxQueue уважается', async () => {
    const okDeps = {
      katago: fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0, visits: 1 }, moveInfos: [] }), {
        queueLength: 7,
      }),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    };
    expect((await post(createEngineApp(okDeps), '/v1/analyze', { ...base, moves: [] })).status).toBe(200);
    const tight = createEngineApp({
      katago: fakeKatago(() => ({}), { queueLength: 2 }),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
      maxQueue: 2,
    });
    expect(await codeOf(await post(tight, '/v1/analyze', { ...base, moves: [] }))).toBe('engine_busy');
  });

  it('health без ключа', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({})),
      engineKey: KEY,
      models: { main: 'main.bin.gz', human: 'human.bin.gz' },
    });
    const res = await app.request('/health');
    expect(await res.json()).toEqual({
      ok: true,
      models: { main: 'main.bin.gz', human: 'human.bin.gz' },
      queue: 0,
      restarts: 0,
    });
  });

  it('health показывает мёртвый процесс, длину очереди и перезапуски', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({}), { alive: false, queueLength: 3, restarts: 2 }),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    expect(await (await app.request('/health')).json()).toEqual({
      ok: false,
      models: { main: 'm', human: 'h' },
      queue: 3,
      restarts: 2,
    });
  });

  it('genmove: humanSLProfile, includePolicy, выбор по humanPolicy', async () => {
    const policy = new Array<number>(170).fill(0);
    policy[169] = 0.5; // пас — отбрасывается, лучший ход не пас
    policy[0] = 0.4; // A13 в порядке KataGo
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.61, scoreLead: 3.2, visits: 10 },
      moveInfos: [{ move: 'D4', order: 0, winrate: 0.6, scoreLead: 3, visits: 9 }],
      humanPolicy: policy,
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await post(app, '/v1/genmove', { ...base, moves: [['B', 'D4']], rank: '10k' });
    expect(res.status).toBe(200);
    const body = await jsonAs<GenmoveShape>(res);
    expect(body).toMatchObject({
      move: 'A13',
      winrateB: 0.61,
      scoreLeadB: 3.2,
      humanPolicyTop: [{ coord: 'A13', prob: 0.4 }],
    });
    expect(typeof body.ms).toBe('number');
    expect(katago.calls[0]).toMatchObject({
      rules: 'chinese',
      komi: 7.5,
      boardXSize: 13,
      boardYSize: 13,
      moves: [['B', 'D4']],
      maxVisits: 10,
      includePolicy: true,
      overrideSettings: { humanSLProfile: 'rank_10k' },
    });
  });

  it('genmove без humanPolicy — лучший ход поиска и предупреждение в лог', async () => {
    const lines: string[] = [];
    const app = createEngineApp({
      katago: fakeKatago(() => ({
        rootInfo: { winrate: 0.5, scoreLead: 0 },
        moveInfos: [{ move: 'K10', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
      })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
      log: (l) => lines.push(l),
    });
    const res = await post(app, '/v1/genmove', { ...base, moves: [], rank: '1d' });
    expect((await jsonAs<GenmoveShape>(res)).move).toBe('K10');
    expect(lines.join('\n')).toContain('humanPolicy');
  });

  it('genmove: лучший ход берётся по order === 0, а не по месту в массиве', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({
        rootInfo: { winrate: 0.5, scoreLead: 0 },
        moveInfos: [
          { move: 'C3', order: 2, winrate: 0.4, scoreLead: -1, visits: 3 },
          { move: 'Q4', order: 0, winrate: 0.5, scoreLead: 0, visits: 9 },
        ],
      })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const body = await jsonAs<GenmoveShape>(await post(app, '/v1/genmove', { ...base, moves: [], rank: '3k' }));
    expect(body.move).toBe('Q4');
  });

  it('genmove: пустые moveInfos — пас, а не падение', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0 }, moveInfos: [] })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const body = await jsonAs<GenmoveShape>(await post(app, '/v1/genmove', { ...base, moves: [], rank: '3k' }));
    expect(body.move).toBe('pass');
  });

  it('genmove: значения по умолчанию — winrate 0.5 и scoreLead 0, если rootInfo пуст', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({ moveInfos: [{ move: 'K10', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }] })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const body = await jsonAs<GenmoveShape>(await post(app, '/v1/genmove', { ...base, moves: [], rank: '3k' }));
    expect(body).toMatchObject({ winrateB: 0.5, scoreLeadB: 0 });
  });

  it('genmove: maxVisits из запроса доходит до движка', async () => {
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.5, scoreLead: 0 },
      moveInfos: [{ move: 'K10', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    await post(app, '/v1/genmove', { ...base, moves: [], rank: '5k', maxVisits: 33 });
    expect(katago.calls[0]).toMatchObject({ maxVisits: 33 });
  });

  it('analyze: ownership перекладывается в нашу индексацию, moveInfos по order', async () => {
    const ownership = new Array<number>(169).fill(0);
    ownership[0] = 0.9; // A13 у KataGo
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.4, scoreLead: -2, visits: 50 },
      ownership,
      moveInfos: [
        { move: 'C3', order: 1, winrate: 0.39, scoreLead: -2.5, visits: 10 },
        { move: 'D4', order: 0, winrate: 0.41, scoreLead: -1.5, visits: 30 },
      ],
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const body = await jsonAs<AnalyzeShape>(await post(app, '/v1/analyze', { ...base, moves: [] }));
    expect(body.ownership?.[coordToIndex('A13', 13)]).toBe(0.9);
    expect(body.ownership?.[coordToIndex('A1', 13)]).toBe(0);
    expect(body.moveInfos.map((m) => m.coord)).toEqual(['D4', 'C3']);
    expect(body).toMatchObject({ visits: 50, winrateB: 0.4, scoreLeadB: -2 });
    expect(body.moveInfos[0]).toEqual({ coord: 'D4', winrateB: 0.41, scoreLeadB: -1.5, visits: 30, order: 0 });
    expect(katago.calls[0]).toMatchObject({ maxVisits: 50, includeOwnership: true });
  });

  it('analyze: не больше пяти вариантов, includeOwnership: false — без массива владения', async () => {
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.5, scoreLead: 0, visits: 7 },
      moveInfos: Array.from({ length: 8 }, (_, i) => ({
        move: `A${i + 1}`,
        order: 7 - i,
        winrate: 0.5,
        scoreLead: 0,
        visits: 1,
      })),
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const body = await jsonAs<AnalyzeShape>(
      await post(app, '/v1/analyze', { ...base, moves: [], includeOwnership: false }),
    );
    expect(body.moveInfos.map((m) => m.order)).toEqual([0, 1, 2, 3, 4]);
    expect(body.ownership).toBeUndefined();
    expect(katago.calls[0]).toMatchObject({ includeOwnership: false });
  });

  it('analyze: maxVisits из запроса доходит до движка', async () => {
    const katago = fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0, visits: 77 }, moveInfos: [] }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    await post(app, '/v1/analyze', { ...base, moves: [], maxVisits: 77 });
    expect(katago.calls[0]).toMatchObject({ maxVisits: 77 });
  });

  it('analyze на доске 9x9: владение перекладывается по запрошенному размеру', async () => {
    const ownership = new Array<number>(81).fill(0);
    ownership[0] = 0.9; // A9 у KataGo
    const katago = fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0, visits: 1 }, moveInfos: [], ownership }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await post(app, '/v1/analyze', { boardSize: 9, rules: 'chinese', komi: 7.5, moves: [] });
    expect(res.status).toBe(200);
    const body = await jsonAs<AnalyzeShape>(res);
    expect(body.ownership).toHaveLength(81);
    expect(body.ownership?.[coordToIndex('A9', 9)]).toBe(0.9);
  });

  it('score: мёртвые по владению, площадь через go-core, winner и margin', async () => {
    // Чёрные строки 1..7 (стена на 7), белые 8..13; плюс чёрный камень M12 в белой зоне.
    const moves: [string, string][] = [...walls(7, 8), ['B', 'M12'], ['W', 'pass']];
    const katago = fakeKatago(() => ({
      // scoreLead движка намеренно не равен margin: иначе перепутанные поля не видны.
      rootInfo: { winrate: 0.7, scoreLead: 4.25, visits: 400 },
      ownership: kataOwnership(7),
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const body = await jsonAs<ScoreShape>(await post(app, '/v1/score', { ...base, moves }));
    expect(body).toMatchObject({ dead: ['M12'], areaB: 91, areaW: 78, scoreLeadB: 4.25, winner: 'B', margin: 5.5 });
    expect(body.ownership[coordToIndex('A1', 13)]).toBe(1);
    expect(body.ownership[coordToIndex('A13', 13)]).toBe(-1);
    expect(katago.calls[0]).toMatchObject({ maxVisits: SCORE_VISITS, includeOwnership: true });
    expect(SCORE_VISITS).toBe(400);
  });

  it('score: коми учитывается, победитель может быть белым', async () => {
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.4, scoreLead: -1.5, visits: 400 },
      ownership: kataOwnership(6),
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const body = await jsonAs<ScoreShape>(await post(app, '/v1/score', { ...base, moves: walls(6, 7) }));
    // Чёрным 78, белым 91, коми 7.5 -> W+20.5.
    expect(body).toMatchObject({ areaB: 78, areaW: 91, winner: 'W', margin: 20.5, dead: [] });
  });

  it('score: сломанный массив владения — 500, а не молча неверный счёт', async () => {
    const katago = fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0, visits: 400 }, ownership: [1, 2, 3] }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await post(app, '/v1/score', { ...base, moves: [] });
    expect(res.status).toBe(500);
    expect(await codeOf(res)).toBe('internal');
  });

  it('score: нечисловое значение владения — 500', async () => {
    const ownership: unknown[] = new Array<number>(169).fill(0);
    ownership[5] = null;
    const katago = fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0, visits: 400 }, ownership }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    expect((await post(app, '/v1/score', { ...base, moves: [] })).status).toBe(500);
  });

  it('genmove: профиль берётся из запрошенного разряда', async () => {
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.5, scoreLead: 0 },
      moveInfos: [{ move: 'K10', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    await post(app, '/v1/genmove', { ...base, moves: [], rank: '3d' });
    expect(katago.calls[0]).toMatchObject({ overrideSettings: { humanSLProfile: 'rank_3d' } });
  });

  it('genmove: ms — настоящая длительность запроса', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      // Часы уводятся от нуля: ms — длительность запроса, а не показание часов.
      vi.advanceTimersByTime(5000);
      const app = createEngineApp({
        katago: fakeKatago(() => {
          vi.advanceTimersByTime(1234);
          return { rootInfo: { winrate: 0.5, scoreLead: 0 }, moveInfos: [] };
        }),
        engineKey: KEY,
        models: { main: 'm', human: 'h' },
      });
      const body = await jsonAs<GenmoveShape>(await post(app, '/v1/genmove', { ...base, moves: [], rank: '5k' }));
      expect(body.ms).toBe(1234);
    } finally {
      vi.useRealTimers();
    }
  });

  it('analyze: visits без rootInfo.visits — ноль', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0 }, moveInfos: [] })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const body = await jsonAs<AnalyzeShape>(await post(app, '/v1/analyze', { ...base, moves: [] }));
    expect(body.visits).toBe(0);
  });

  it('коми из запроса доходит до движка и до счёта', async () => {
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.5, scoreLead: 0, visits: 400 },
      ownership: kataOwnership(7),
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const body = await jsonAs<ScoreShape>(await post(app, '/v1/score', { boardSize: 13, rules: 'chinese', komi: 0.5, moves: walls(7, 8) }));
    expect(katago.calls[0]).toMatchObject({ komi: 0.5 });
    // 91 - 78 - 0.5 = 12.5.
    expect(body).toMatchObject({ winner: 'B', margin: 12.5 });
  });

  it('тело не по схеме — 400 bad_request', async () => {
    const app = createEngineApp({ katago: fakeKatago(() => ({})), engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await post(app, '/v1/genmove', { ...base, moves: [], rank: '99k' });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('bad_request');
  });

  it('лишнее поле в теле — 400: схемы запросов строгие', async () => {
    const app = createEngineApp({ katago: fakeKatago(() => ({})), engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await post(app, '/v1/score', { ...base, moves: [], extra: 1 });
    expect(res.status).toBe(400);
  });

  it('таймауты по умолчанию разные для трёх маршрутов и переопределяются', async () => {
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.5, scoreLead: 0, visits: 1 },
      moveInfos: [{ move: 'K10', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
      ownership: new Array<number>(169).fill(0),
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    await post(app, '/v1/genmove', { ...base, moves: [], rank: '5k' });
    await post(app, '/v1/analyze', { ...base, moves: [] });
    await post(app, '/v1/score', { ...base, moves: [] });
    expect(katago.timeouts).toEqual([8_000, 6_000, 15_000]);
    // Правило «движок < клиент < сервис» (D-0010): клиент game-server ждёт 10 / 8 / 18 с, иначе
    // клиент всегда отваливается первым и осмысленного кода ошибки движка не видит.
    expect(DEFAULT_TIMEOUTS).toEqual({ genmove: 8_000, analyze: 6_000, score: 15_000 });

    const own = fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0, visits: 1 }, moveInfos: [] }));
    const custom = createEngineApp({
      katago: own,
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
      timeouts: { genmove: 1, analyze: 2, score: 3 },
    });
    await post(custom, '/v1/analyze', { ...base, moves: [] });
    expect(own.timeouts).toEqual([2]);
  });

  it('ошибки движка: timeout — engine_busy, crashed — engine_unavailable, rejected — internal', async () => {
    const make = (err: Error) =>
      createEngineApp({ katago: throwingKatago(err), engineKey: KEY, models: { main: 'm', human: 'h' } });
    const timeout = await post(make(new KataGoError('timeout', 'slow')), '/v1/analyze', { ...base, moves: [] });
    expect(timeout.status).toBe(503);
    expect(await codeOf(timeout)).toBe('engine_busy');
    const crashed = await post(make(new KataGoError('crashed', 'katago stopped')), '/v1/analyze', {
      ...base,
      moves: [],
    });
    expect(crashed.status).toBe(503);
    expect(await codeOf(crashed)).toBe('engine_unavailable');
    const rejected = await post(make(new KataGoError('rejected', 'bad query')), '/v1/analyze', { ...base, moves: [] });
    expect(rejected.status).toBe(500);
    expect(await codeOf(rejected)).toBe('internal');
    // aborted — вызывающий уже ушёл; в internal такой отказ падать не должен, иначе
    // каждый оборванный запрос выглядит в логах как ошибка сервера.
    const aborted = await post(make(new KataGoError('aborted', 'gone')), '/v1/score', { ...base, moves: [] });
    expect(aborted.status).toBe(503);
    expect(await codeOf(aborted)).toBe('engine_busy');
  });

  it('прочая ошибка — 500 internal и строка в логе', async () => {
    const lines: string[] = [];
    const app = createEngineApp({
      katago: throwingKatago(new Error('boom')),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
      log: (l) => lines.push(l),
    });
    const res = await post(app, '/v1/score', { ...base, moves: [] });
    expect(res.status).toBe(500);
    expect(await codeOf(res)).toBe('internal');
    expect(lines.join('\n')).toContain('boom');
  });

  it('random из зависимостей управляет выбором хода', async () => {
    const policy = new Array<number>(170).fill(0);
    policy[0] = 0.5; // A13
    policy[1] = 0.5; // B13
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.5, scoreLead: 0 },
      moveInfos: [{ move: 'D4', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
      humanPolicy: policy,
    }));
    const app = createEngineApp({
      katago,
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
      random: () => 0.9,
    });
    const body = await jsonAs<GenmoveShape>(await post(app, '/v1/genmove', { ...base, moves: [], rank: '5k' }));
    expect(body.move).toBe('B13');
  });

  it('сигнал HTTP-запроса доходит до движка на всех трёх маршрутах', async () => {
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.5, scoreLead: 0, visits: 1 },
      moveInfos: [{ move: 'K10', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
      ownership: new Array<number>(169).fill(0),
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    await post(app, '/v1/genmove', { ...base, moves: [], rank: '5k' });
    await post(app, '/v1/analyze', { ...base, moves: [] });
    await post(app, '/v1/score', { ...base, moves: [] });
    expect(katago.signals).toHaveLength(3);
    for (const signal of katago.signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('оборванный HTTP-запрос отменяет работу движка, а не досиживает бюджет', async () => {
    const katago = fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0, visits: 400 }, ownership: kataOwnership(7) }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const ac = new AbortController();
    await post(app, '/v1/score', { ...base, moves: [] }, headers, ac.signal);
    const signal = katago.signals[0];
    expect(signal?.aborted).toBe(false);
    ac.abort();
    expect(signal?.aborted).toBe(true);
  });

  it('genmove без человеческой сети помечает ход запасным, а не только пишет в лог', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({
        rootInfo: { winrate: 0.5, scoreLead: 0 },
        moveInfos: [{ move: 'K10', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
      })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const body = await jsonAs<GenmoveShape>(await post(app, '/v1/genmove', { ...base, moves: [], rank: '1d' }));
    // Без признака у доски видно только то, что Гоко вдруг заиграл на порядок сильнее.
    expect(body).toMatchObject({ move: 'K10', humanFallback: true, humanPolicyTop: [] });
  });

  it('genmove по человеческой сети запасным не помечается', async () => {
    const policy = new Array<number>(170).fill(0);
    policy[0] = 0.4;
    const app = createEngineApp({
      katago: fakeKatago(() => ({
        rootInfo: { winrate: 0.5, scoreLead: 0 },
        moveInfos: [{ move: 'D4', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
        humanPolicy: policy,
      })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const body = await jsonAs<GenmoveShape>(await post(app, '/v1/genmove', { ...base, moves: [], rank: '5k' }));
    expect(body).toMatchObject({ move: 'A13', humanFallback: false });
  });

  it('genmove: человеческая сеть без годных кандидатов — тоже запасной ход', async () => {
    const policy = new Array<number>(170).fill(0);
    policy[0] = 0.001; // ниже отсечки хвоста
    const app = createEngineApp({
      katago: fakeKatago(() => ({
        rootInfo: { winrate: 0.5, scoreLead: 0 },
        moveInfos: [{ move: 'D4', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
        humanPolicy: policy,
      })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const body = await jsonAs<GenmoveShape>(await post(app, '/v1/genmove', { ...base, moves: [], rank: '5k' }));
    expect(body).toMatchObject({ move: 'D4', humanFallback: true });
  });

  it('genmove на доске 9x9: размер доходит до движка и до выбора хода', async () => {
    const policy = new Array<number>(82).fill(0);
    policy[0] = 0.4; // A9 в порядке KataGo
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.5, scoreLead: 0 },
      moveInfos: [{ move: 'E5', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
      humanPolicy: policy,
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await post(app, '/v1/genmove', { boardSize: 9, rules: 'chinese', komi: 7.5, moves: [], rank: '5k' });
    expect(res.status).toBe(200);
    expect(await jsonAs<GenmoveShape>(res)).toMatchObject({ move: 'A9', humanFallback: false });
    expect(katago.calls[0]).toMatchObject({ boardXSize: 9, boardYSize: 9 });
  });

  it('score на доске 9x9: владение, позиция и площадь считаются по запрошенному размеру', async () => {
    const katago = fakeKatago(() => ({
      rootInfo: { winrate: 0.4, scoreLead: -1, visits: 400 },
      ownership: kataOwnership(4, 9),
    }));
    const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await post(app, '/v1/score', {
      boardSize: 9,
      rules: 'chinese',
      komi: 7.5,
      moves: walls(4, 5, 9),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<ScoreShape>(res);
    // Чёрным строки 1..4 (36), белым 5..9 (45), коми 7.5 -> W+16.5.
    expect(body).toMatchObject({ areaB: 36, areaW: 45, winner: 'W', margin: 16.5, dead: [] });
    expect(body.ownership).toHaveLength(81);
    expect(body.ownership[coordToIndex('A1', 9)]).toBe(1);
    expect(body.ownership[coordToIndex('A9', 9)]).toBe(-1);
    expect(katago.calls[0]).toMatchObject({ boardXSize: 9, boardYSize: 9 });
  });

  it('нет ключа и движок мёртв — 401: ключ проверяется первым', async () => {
    // Порядок проверок важен: состояние движка не должно утекать неаутентифицированному.
    const app = createEngineApp({
      katago: fakeKatago(() => ({}), { alive: false }),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const res = await app.request('/v1/genmove', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe('unauthorized');
  });

  it('genmove: непустые moveInfos без order === 0 — первый из массива, а не пас', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({
        rootInfo: { winrate: 0.5, scoreLead: 0 },
        moveInfos: [
          { move: 'D4', order: 1, winrate: 0.5, scoreLead: 0, visits: 3 },
          { move: 'C3', order: 2, winrate: 0.4, scoreLead: -1, visits: 2 },
        ],
      })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const body = await jsonAs<GenmoveShape>(await post(app, '/v1/genmove', { ...base, moves: [], rank: '3k' }));
    expect(body.move).toBe('D4');
  });

  it('движок ответил мусором вместо moveInfos — пас, а не падение', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0 }, moveInfos: null })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const res = await post(app, '/v1/genmove', { ...base, moves: [], rank: '3k' });
    expect(res.status).toBe(200);
    expect((await jsonAs<GenmoveShape>(res)).move).toBe('pass');
  });

  it('движок ответил мусором вместо humanPolicy — запасной ход, а не падение', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({
        rootInfo: { winrate: 0.5, scoreLead: 0 },
        moveInfos: [{ move: 'K10', order: 0, winrate: 0.5, scoreLead: 0, visits: 1 }],
        humanPolicy: null,
      })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const res = await post(app, '/v1/genmove', { ...base, moves: [], rank: '3k' });
    expect(res.status).toBe(200);
    expect(await jsonAs<GenmoveShape>(res)).toMatchObject({ move: 'K10', humanFallback: true });
  });

  it('движок ответил мусором вместо ownership в analyze — ответ без владения', async () => {
    const app = createEngineApp({
      katago: fakeKatago(() => ({ rootInfo: { winrate: 0.5, scoreLead: 0, visits: 1 }, moveInfos: [], ownership: 'x' })),
      engineKey: KEY,
      models: { main: 'm', human: 'h' },
    });
    const res = await post(app, '/v1/analyze', { ...base, moves: [] });
    expect(res.status).toBe(200);
    expect((await jsonAs<AnalyzeShape>(res)).ownership).toBeUndefined();
  });

  it('тело не по схеме: в тексте ошибки — поле и причина, а не дамп zod', async () => {
    const app = createEngineApp({ katago: fakeKatago(() => ({})), engineKey: KEY, models: { main: 'm', human: 'h' } });
    const res = await post(app, '/v1/genmove', { ...base, moves: [], rank: '99k' });
    const message = (await jsonAs<ErrorShape>(res)).error.message;
    expect(message).toMatch(/^rank: /);
    expect(message.startsWith('[')).toBe(false); // err.message в zod 4 — это JSON со всеми issue
  });
});
