// Настоящий KataGo: сторона winrate, порядок ownership, легальность ходов, счёт известной позиции.
// Без KATAGO_BIN весь блок пропускается: на чужой машине движка нет.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coordToIndex, parseCoord, play, replay } from '@goko/go-core';
import { createEngineApp } from './app.ts';
import { KataGo } from './katago.ts';
import { walls } from './test-helpers.ts';

const BIN = process.env.KATAGO_BIN;
const root = path.resolve(import.meta.dirname, '../../..');
const MODEL =
  process.env.KATAGO_MODEL ?? path.join(root, 'apps/go-engine/models/kata1-b10c128-s1141046784-d204142634.txt.gz');
const HUMAN = process.env.KATAGO_HUMAN_MODEL ?? path.join(root, 'apps/go-engine/models/b18c384nbt-humanv0.bin.gz');
const CONFIG = process.env.KATAGO_CONFIG ?? path.join(root, 'apps/go-engine/config/analysis.cfg');
const KEY = 'contract';
const headers = { 'content-type': 'application/json', 'x-engine-key': KEY };
const base = { boardSize: 13, rules: 'chinese', komi: 7.5 };

type GenmoveShape = { move: string; humanPolicyTop: { coord: string; prob: number }[] };
type AnalyzeShape = { winrateB: number; scoreLeadB: number; ownership: number[] };
type ScoreShape = { areaB: number; areaW: number; winner: string; margin: number; dead: string[] };

describe.skipIf(!BIN)('KataGo contract', () => {
  const katago = new KataGo({
    bin: BIN ?? '',
    model: MODEL,
    humanModel: HUMAN,
    config: CONFIG,
    log: (l) => console.error(l),
  });
  const app = createEngineApp({ katago, engineKey: KEY, models: { main: 'main', human: 'human' } });
  const post = async <T>(route: string, body: unknown): Promise<T> => {
    const res = await app.request(route, { method: 'POST', headers, body: JSON.stringify(body) });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as T;
  };

  beforeAll(async () => {
    katago.start();
    // Поля перечислены руками: раскрытие `base` протащило бы наше `boardSize`, которого нет в запросе KataGo.
    // Своего `id` здесь быть не должно: KataGo.query подставляет собственный, а поле из запроса
    // его перезаписало бы, и ответ движка не нашёл бы ждущего.
    await katago.query(
      { rules: base.rules, komi: base.komi, boardXSize: 13, boardYSize: 13, moves: [], maxVisits: 1 },
      300_000,
    ); // прогрев, OpenCL тюнит ядра
  }, 320_000);

  afterAll(async () => {
    await katago.stop();
  });

  it('genmove на пустой доске: не пас, легально, humanPolicy есть', async () => {
    const r = await post<GenmoveShape>('/v1/genmove', { ...base, moves: [], rank: '10k' });
    expect(r.move).not.toBe('pass');
    expect(parseCoord(r.move, 13)).not.toBe('pass');
    expect(r.humanPolicyTop.length).toBeGreaterThan(0);
  }, 60_000);

  it('genmove в середине партии легален по go-core', async () => {
    const moves: [string, string][] = [
      ['B', 'D4'],
      ['W', 'K10'],
      ['B', 'K4'],
      ['W', 'D10'],
      ['B', 'G7'],
    ];
    const r = await post<GenmoveShape>('/v1/genmove', { ...base, moves, rank: '5k' });
    const pos = replay(
      13,
      moves.map(([color, coord]) => ({ color: color as 'B' | 'W', coord })),
    );
    expect(() => play(pos, 'W', r.move)).not.toThrow();
  }, 60_000);

  it('score известной позиции: стены 7/8 -> B+5.5', async () => {
    const r = await post<ScoreShape>('/v1/score', { ...base, moves: walls(7, 8) });
    expect(r).toMatchObject({ areaB: 91, areaW: 78, winner: 'B', margin: 5.5, dead: [] });
  }, 120_000);

  it('winrate с точки зрения чёрных независимо от стороны на ходу', async () => {
    // Пять ходов подряд против пасов: перевес чёрных не зависит от числа просмотров.
    // Стена в 13 камней для этого не годится — открытая область под ней взламывается,
    // и KataGo честно считает такую «территорию» ничьей.
    const free: [string, string][] = [];
    for (const coord of ['D4', 'K10', 'D10', 'K4', 'G7']) {
      free.push(['B', coord]);
      free.push(['W', 'pass']);
    }
    const blackToPlay = await post<AnalyzeShape>('/v1/analyze', { ...base, moves: free, maxVisits: 20 });
    const whiteToPlay = await post<AnalyzeShape>('/v1/analyze', {
      ...base,
      moves: [...free, ['B', 'pass']],
      maxVisits: 20,
    });
    // Если бы сторона считалась от того, кто ходит, вторая цифра оказалась бы зеркальной.
    expect(blackToPlay.winrateB).toBeGreaterThan(0.5);
    expect(whiteToPlay.winrateB).toBeGreaterThan(0.5);
    expect(blackToPlay.scoreLeadB).toBeGreaterThan(0);
    expect(whiteToPlay.scoreLeadB).toBeGreaterThan(0);
  }, 120_000);

  it('ownership лежит в правильных клетках: низ чёрный, верх белый', async () => {
    // Две тонкие полосы: под чёрной стеной на 3 и над белой на 11 жить некому,
    // поэтому владение там однозначное, а не «пополам», как в открытом центре.
    const r = await post<AnalyzeShape>('/v1/analyze', { ...base, moves: walls(3, 11), maxVisits: 20 });
    expect(r.ownership[coordToIndex('A1', 13)]).toBeGreaterThan(0.5);
    expect(r.ownership[coordToIndex('N2', 13)]).toBeGreaterThan(0.5);
    expect(r.ownership[coordToIndex('A13', 13)]).toBeLessThan(-0.5);
    expect(r.ownership[coordToIndex('G12', 13)]).toBeLessThan(-0.5);
  }, 120_000);
});
