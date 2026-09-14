import { describe, expect, it } from 'vitest';
import type { GameState } from '@goko/protocol';
import { guardedGameResponse, thinkingAfterMutationResponse } from './game-response.ts';

const game = (revision: number): GameState => ({
  id: 'g1', createdAt: 't', revision, settings: { boardSize: 13, rules: 'chinese', komi: 7.5 },
  seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } }, status: 'playing', toPlay: 'B',
  moves: [], board: '.'.repeat(169), captures: { B: 0, W: 0 }, ko: null, consecutivePasses: 0, pendingEngineMove: false, canRedo: false,
});

describe('guardedGameResponse', () => {
  it('не возвращает доску из запоздалого play после уже применённого undo', () => {
    const afterUndo = game(7);
    expect(guardedGameResponse('g1', afterUndo, game(6))).toBeNull();
    expect(guardedGameResponse('g1', afterUndo, game(8))?.revision).toBe(8);
    expect(guardedGameResponse('g2', null, game(8))).toBeNull();
  });

  it('не сбрасывает thinking новой партии ответом мутации старой', () => {
    expect(thinkingAfterMutationResponse(true, guardedGameResponse('g2', null, game(8)))).toBe(true);
    expect(thinkingAfterMutationResponse(true, guardedGameResponse('g1', null, game(8)))).toBe(false);
  });
});
