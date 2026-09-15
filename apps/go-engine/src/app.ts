// HTTP-обёртка над KataGo (раздел 8 спеки). Всё с точки зрения чёрных, индексация — наша.
import { createHash, timingSafeEqual } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { areaScore, deadStones, parseCoord, play, replay, resultFromArea } from '@goko/go-core';
import {
  ERROR_STATUS,
  EngineAnalyzeRequest,
  EngineAnalyzeResponse,
  EngineGenmoveRequest,
  EngineGenmoveResponse,
  EngineHealth,
  EngineScoreRequest,
  EngineScoreResponse,
  type ErrorCode,
} from '@goko/protocol';
import { type KataGo, KataGoError, type KataQuery, type KataResponse } from './katago.ts';
import { kataIndexToCoord, rankToProfile, reorderFromKata } from './mapping.ts';
import { type ChooseMoveResult, chooseMove } from './sampling.ts';

export type EngineDeps = {
  katago: Pick<KataGo, 'query' | 'queueLength' | 'restarts' | 'alive'>;
  engineKey: string;
  models: { main: string; human: string };
  random?: () => number;
  maxQueue?: number;
  timeouts?: { genmove: number; analyze: number; score: number };
  log?: (line: string) => void;
};

export const SCORE_VISITS = 400;
export const DEFAULT_MAX_QUEUE = 8;
// Правило «движок < клиент < сервис» (D-0010, раздел 8 спеки): go-engine 8 / 6 / 15 с, клиент
// game-server 10 / 8 / 18 с, сервис analyze 10 с и score 20 с. Иначе клиент отваливается по своему
// таймауту первым и никогда не видит осмысленного кода ошибки движка. timeoutMs у KataGo.query
// отсчитывается от вызова, поэтому это же число и есть «сколько ждёт game-server от нас».
export const DEFAULT_TIMEOUTS = { genmove: 8_000, analyze: 6_000, score: 15_000 };
// Самый большой законный запрос — позиция 19×19 с сотнями ходов, это единицы килобайт.
export const MAX_BODY_BYTES = 64 * 1024;

// Сравнение ключа за постоянное время: дайджесты одной длины, разная длина ключа не даёт раннего выхода.
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

type KataRoot = { winrate?: number; scoreLead?: number; visits?: number };
type KataMoveInfo = { move: string; winrate: number; scoreLead: number; visits: number; order: number; pv?: unknown };

function baseQuery(req: { boardSize: number; rules: string; komi: number; moves: [string, string][] }): KataQuery {
  return { rules: req.rules, komi: req.komi, boardXSize: req.boardSize, boardYSize: req.boardSize, moves: req.moves };
}

function rootOf(r: KataResponse): Required<KataRoot> {
  const root = (r.rootInfo ?? {}) as KataRoot;
  return { winrate: root.winrate ?? 0.5, scoreLead: root.scoreLead ?? 0, visits: root.visits ?? 0 };
}

function moveInfosOf(r: KataResponse): KataMoveInfo[] {
  return Array.isArray(r.moveInfos) ? (r.moveInfos as KataMoveInfo[]) : [];
}

function numbersOf(value: unknown): number[] {
  return Array.isArray(value) ? (value as number[]) : [];
}

function boundedPv(value: unknown, size: number, moves: [string, string][]): string[] {
  if (!Array.isArray(value)) return [];
  let position = replay(size, moves.map(([color, coord]) => ({ color: color as 'B' | 'W', coord })));
  let color: 'B' | 'W' = moves.length % 2 === 0 ? 'B' : 'W';
  const pv: string[] = [];
  for (const raw of value.slice(0, 4)) {
    if (typeof raw !== 'string') break;
    try {
      parseCoord(raw, size);
      position = play(position, color, raw).position;
    } catch {
      break;
    }
    pv.push(raw);
    color = color === 'B' ? 'W' : 'B';
  }
  return pv;
}

export function createEngineApp(deps: EngineDeps): Hono {
  const app = new Hono();
  const timeouts = deps.timeouts ?? DEFAULT_TIMEOUTS;
  const maxQueue = deps.maxQueue ?? DEFAULT_MAX_QUEUE;
  const engineKeyDigest = digest(deps.engineKey);
  const fail = (c: Context, code: ErrorCode, message: string) =>
    c.json({ error: { code, message } }, ERROR_STATUS[code] as ContentfulStatusCode);

  app.get('/health', (c) =>
    c.json(
      EngineHealth.parse({
        ok: deps.katago.alive,
        models: deps.models,
        queue: deps.katago.queueLength,
        restarts: deps.katago.restarts,
      }),
    ),
  );

  app.use('/v1/*', async (c, next) => {
    if (!timingSafeEqual(digest(c.req.header('x-engine-key') ?? ''), engineKeyDigest)) return fail(c, 'unauthorized', 'missing or wrong X-Engine-Key');
    if (!deps.katago.alive) return fail(c, 'engine_unavailable', 'katago process is not running');
    if (deps.katago.queueLength >= maxQueue) return fail(c, 'engine_busy', `queue is full (${deps.katago.queueLength})`);
    await next();
  });

  // После проверки ключа: без ключа тело не читается вовсе.
  app.use('/v1/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 'bad_request', 'request body is too large') }));

  app.onError((err, c) => {
    if (err instanceof KataGoError) {
      // rejected — движок разобрал запрос и отказал: повтор того же запроса не поможет,
      // это наша ошибка, а не занятость машины. 503 с намёком «повторите» здесь врал бы.
      // aborted — вызывающий уже ушёл, ответ читать некому; 503 здесь только ради формы.
      if (err.kind === 'timeout' || err.kind === 'aborted') return fail(c, 'engine_busy', err.message);
      if (err.kind === 'crashed') return fail(c, 'engine_unavailable', err.message);
      deps.log?.(`[X] engine: katago rejected the query: ${err.message}`);
      return fail(c, 'internal', err.message);
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return fail(c, 'bad_request', issues);
    }
    deps.log?.(`[X] engine: ${err.stack ?? err.message}`);
    return fail(c, 'internal', err.message);
  });

  app.post('/v1/genmove', async (c) => {
    const req = EngineGenmoveRequest.parse(await c.req.json());
    const t0 = performance.now();
    const r = await deps.katago.query(
      {
        ...baseQuery(req),
        maxVisits: req.maxVisits,
        includePolicy: true,
        overrideSettings: { humanSLProfile: rankToProfile(req.rank) },
      },
      timeouts.genmove,
      c.req.raw.signal,
    );
    const root = rootOf(r);
    const infos = moveInfosOf(r);
    const bestMove = infos.find((m) => m.order === 0)?.move ?? infos[0]?.move ?? 'pass';
    const humanPolicy = numbersOf(r.humanPolicy);
    // Пустой humanPolicy — не «сломанный массив», а ответ без человеческой сети: chooseMove
    // такую длину справедливо считает рассогласованием и бросает, поэтому сюда он не зовётся.
    // Партия при этом продолжается лучшим ходом поиска, только сильнее заявленного разряда,
    // поэтому наружу идёт humanFallback: у доски иначе не понять, почему Гоко вдруг усилился.
    let chosen: ChooseMoveResult = { move: bestMove, top: [], fallback: true };
    if (humanPolicy.length === 0) deps.log?.('[!] humanPolicy отсутствует: проверить -human-model');
    else chosen = chooseMove({ humanPolicy, size: req.boardSize, bestMove, random: deps.random });
    const chosenIndex = humanPolicy.findIndex((_prob, index) => kataIndexToCoord(index, req.boardSize) === chosen.move);
    const selected = { coord: chosen.move, prob: chosenIndex >= 0 ? (humanPolicy[chosenIndex] ?? 0) : 0 };
    const rankCandidates = (chosen.fallback ? [] : [selected, ...chosen.top.filter((candidate) => candidate.coord !== chosen.move)])
      .filter((candidate, index, all) => all.findIndex((item) => item.coord === candidate.coord) === index)
      .slice(0, 3);
    const candidateAnalysis: Array<{ coord: string; winrateB: number; scoreLeadB: number; visits: number; pv: string[] }> = [];
    const deadline = t0 + timeouts.genmove;
    const player = req.moves.length % 2 === 0 ? 'B' : 'W';
    for (const candidate of rankCandidates) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0 || c.req.raw.signal.aborted) break;
      try {
        const analysis = await deps.katago.query({
          ...baseQuery(req),
          maxVisits: 30,
          analysisPVLen: 4,
          allowMoves: [{ player, moves: [candidate.coord], untilDepth: 1 }],
        }, remaining, c.req.raw.signal);
        const info = moveInfosOf(analysis).find((item) => item.order === 0) ?? moveInfosOf(analysis)[0];
        const candidateRoot = rootOf(analysis);
        candidateAnalysis.push({
          coord: candidate.coord,
          winrateB: info?.winrate ?? candidateRoot.winrate,
          scoreLeadB: info?.scoreLead ?? candidateRoot.scoreLead,
          visits: info?.visits ?? candidateRoot.visits,
          pv: boundedPv(info?.pv, req.boardSize, req.moves),
        });
      } catch (error) {
        if (c.req.raw.signal.aborted) throw error;
        deps.log?.(`[!] engine: дополнительный анализ ${candidate.coord} пропущен: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    return c.json(
      EngineGenmoveResponse.parse({
        move: chosen.move,
        winrateB: root.winrate,
        scoreLeadB: root.scoreLead,
        humanPolicyTop: chosen.top,
        searchCandidates: [...infos].sort((a,b)=>a.order-b.order).slice(0,5).map(info=>info.move),
        rankCandidates,
        candidateAnalysis,
        humanFallback: chosen.fallback,
        ms: Math.round(performance.now() - t0),
      }),
    );
  });

  app.post('/v1/analyze', async (c) => {
    const req = EngineAnalyzeRequest.parse(await c.req.json());
    const r = await deps.katago.query(
      { ...baseQuery(req), maxVisits: req.maxVisits, includeOwnership: req.includeOwnership },
      timeouts.analyze,
      c.req.raw.signal,
    );
    const root = rootOf(r);
    const moveInfos = [...moveInfosOf(r)]
      .sort((a, b) => a.order - b.order)
      .slice(0, 5)
      .map((m) => ({ coord: m.move, winrateB: m.winrate, scoreLeadB: m.scoreLead, visits: m.visits, order: m.order }));
    // Владение проверяется и разворачивается один раз, здесь, на границе с движком.
    const ownership = Array.isArray(r.ownership) ? reorderFromKata(numbersOf(r.ownership), req.boardSize) : undefined;
    return c.json(
      EngineAnalyzeResponse.parse({
        visits: root.visits,
        winrateB: root.winrate,
        scoreLeadB: root.scoreLead,
        moveInfos,
        ownership,
      }),
    );
  });

  app.post('/v1/score', async (c) => {
    const req = EngineScoreRequest.parse(await c.req.json());
    const r = await deps.katago.query(
      { ...baseQuery(req), maxVisits: SCORE_VISITS, includeOwnership: true },
      timeouts.score,
      // Брошенный клиентом score обязан отпустить единственный слот KataGo сразу, иначе
      // следующий запрос встаёт в очередь за зомби — это минута тишины у доски.
      c.req.raw.signal,
    );
    const root = rootOf(r);
    const ownership = reorderFromKata(numbersOf(r.ownership), req.boardSize);
    const pos = replay(
      req.boardSize,
      req.moves.map(([color, coord]) => ({ color, coord })),
    );
    const dead = deadStones(pos, ownership);
    const area = areaScore(pos, dead, req.komi);
    const { winner, margin } = resultFromArea(area);
    return c.json(
      EngineScoreResponse.parse({
        ownership,
        dead,
        areaB: area.areaB,
        areaW: area.areaW,
        scoreLeadB: root.scoreLead,
        winner,
        margin,
      }),
    );
  });

  return app;
}
