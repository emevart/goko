// Фейковый движок для тестов и smoke без KataGo: легальные ходы, сценарий, задержка, наивный счёт.
import { type Color, type Position, areaScore, indexToCoord, neighbors, play, replay, resultFromArea } from '@goko/go-core';
import type { EngineAnalyzeRequest, EngineAnalyzeResponse, EngineGenmoveRequest, EngineGenmoveResponse, EngineScoreRequest, EngineScoreResponse } from '@goko/protocol';
import type { Engine } from './engine-client.ts';

export type FakeEngineOptions = {
  script?: string[]; // ходы по порядку вызовов genmove; когда кончились — случайные легальные
  delayMs?: number;
  random?: () => number;
  passAfterPass?: boolean; // пасовать, если последний ход соперника — пас (по умолчанию да)
};

export type FakeEngine = Engine & { calls: { genmove: number; analyze: number; score: number } };

function sideToMove(moves: readonly [Color, string][]): Color {
  const last = moves.at(-1);
  return last ? (last[0] === 'B' ? 'W' : 'B') : 'B';
}

function positionOf(req: { boardSize: number; moves: [Color, string][] }): Position {
  return replay(
    req.boardSize,
    req.moves.map(([color, coord]) => ({ color, coord })),
  );
}

// Случайный легальный ход; не заполняет собственные глаза (точка, где все соседи свои), чтобы партия кончалась.
function randomLegal(pos: Position, color: Color, random: () => number): string {
  const size = pos.size;
  const candidates: string[] = [];
  for (let i = 0; i < size * size; i++) {
    if (pos.board.charAt(i) !== '.') continue;
    const coord = indexToCoord(i, size);
    try {
      play(pos, color, coord);
    } catch {
      continue;
    }
    const eye = neighbors(i, size).every((n) => pos.board.charAt(n) === color);
    if (!eye) candidates.push(coord);
  }
  // Пас — ответ на оба случая, когда кандидата нет: список пуст или random вернул
  // значение вне [0, 1). Отдельная проверка на пустой список была бы её же дублем.
  return candidates[Math.floor(random() * candidates.length)] ?? 'pass';
}

function naiveOwnership(pos: Position): number[] {
  const own: number[] = [];
  for (let i = 0; i < pos.size * pos.size; i++) {
    const c = pos.board.charAt(i);
    own.push(c === 'B' ? 1 : c === 'W' ? -1 : 0);
  }
  return own;
}

export function createFakeEngine(opts: FakeEngineOptions = {}): FakeEngine {
  const script = [...(opts.script ?? [])];
  const random = opts.random ?? Math.random;
  const passAfterPass = opts.passAfterPass ?? true;
  const calls = { genmove: 0, analyze: 0, score: 0 };
  // Задержка ответа, прерываемая отменой, как у клиента движка: отказ — причина сигнала.
  const wait = (signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      if (!opts.delayMs) return resolve();
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, opts.delayMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  return {
    calls,
    async genmove(req: EngineGenmoveRequest, signal?: AbortSignal): Promise<EngineGenmoveResponse> {
      calls.genmove++;
      await wait(signal);
      const t0 = performance.now();
      const color = sideToMove(req.moves);
      let move = script.shift();
      if (move === undefined) {
        const lastCoord = req.moves.at(-1)?.[1];
        move = passAfterPass && lastCoord === 'pass' ? 'pass' : randomLegal(positionOf(req), color, random);
      }
      return { move, winrateB: 0.5, scoreLeadB: 0, humanPolicyTop: [{ coord: move, prob: 1 }], rankCandidates: [{ coord: move, prob: 1 }], candidateAnalysis: [], humanFallback: false, ms: Math.round(performance.now() - t0) };
    },
    async analyze(req: EngineAnalyzeRequest, signal?: AbortSignal): Promise<EngineAnalyzeResponse> {
      calls.analyze++;
      await wait(signal);
      const pos = positionOf(req);
      const color = sideToMove(req.moves);
      const best = randomLegal(pos, color, random);
      return {
        visits: req.maxVisits ?? 50,
        winrateB: 0.5,
        scoreLeadB: 0,
        moveInfos: [{ coord: best, winrateB: 0.5, scoreLeadB: 0, visits: 1, order: 0, pv: [] }],
        ownership: req.includeOwnership === false ? undefined : naiveOwnership(pos),
      };
    },
    async score(req: EngineScoreRequest, signal?: AbortSignal): Promise<EngineScoreResponse> {
      calls.score++;
      await wait(signal);
      const pos = positionOf(req);
      const ownership = naiveOwnership(pos);
      // Наивное владение даёт каждому камню +-1 в его же пользу, поэтому мёртвых групп
      // у фейка не бывает никогда: вызов deadStones вернул бы пустой список.
      const dead: string[] = [];
      const area = areaScore(pos, dead, req.komi);
      const { winner, margin } = resultFromArea(area);
      const scoreLeadB = area.areaB - area.areaW - req.komi;
      return { ownership, dead, areaB: area.areaB, areaW: area.areaW, scoreLeadB, winner, margin };
    },
  };
}
