import { describe, expect, it } from 'vitest';
import { DEFAULT_KOMI, DEFAULT_RANK, newAgentState } from './state.ts';

describe('newAgentState', () => {
  it('новая сессия: партии нет, человек за чёрных, Гоко 10 кю, коми 7,5, флаги сброшены', () => {
    expect(DEFAULT_RANK).toBe('10k');
    expect(DEFAULT_KOMI).toBe(7.5);
    expect(newAgentState('s1')).toStrictEqual({
      sessionId: 's1',
      gameId: null,
      announceSync: null,
      humanColor: 'B',
      rank: '10k',
      komi: 7.5,
      toolGames: new Set(),
      announcedFinish: null,
      awaitingReply: false,
      lastTap: null,
      lastErrorAt: 0,
      retriesExhausted: false,
      fallbackMove: null,
      startingGame: false,
      awaitingFinish: null,
      finished: null,
      blockedUntil: 0,
    });
  });
  it('у каждой сессии свой набор партий инструмента', () => {
    const a = newAgentState('a');
    const b = newAgentState('b');
    a.toolGames.add('g1');
    expect(b.toolGames.size).toBe(0);
    expect(a.toolGames).not.toBe(b.toolGames);
  });
});
