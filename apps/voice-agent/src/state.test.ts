import { describe, expect, it } from 'vitest';
import { DEFAULT_KOMI, DEFAULT_RANK, forgetFinishIfReopened, newAgentState, noteFinishRevision } from './state.ts';

const score = { winner: 'B' as const, margin: 3.5, reason: 'score' as const };

describe('ревизия итога', () => {
  it('noteFinishRevision: для той же партии берёт большую ревизию, другая партия заменяет запись', () => {
    const s = newAgentState('s1');
    noteFinishRevision(s, 'g1', 7);
    noteFinishRevision(s, 'g1', 5); // ответ инструмента со старой ревизией после события потока
    expect(s.finishRevision).toEqual({ gameId: 'g1', revision: 7 });
    noteFinishRevision(s, 'g2', 3);
    expect(s.finishRevision).toEqual({ gameId: 'g2', revision: 3 });
  });
  it('forgetFinishIfReopened: партия снова идёт на ревизии новее итога — итог забыт', () => {
    const s = newAgentState('s1');
    s.finished = { gameId: 'g1', result: score };
    s.announcedFinish = 'g1';
    noteFinishRevision(s, 'g1', 7);
    forgetFinishIfReopened(s, 'g1', 8);
    expect(s.finished).toBeNull();
    expect(s.announcedFinish).toBeNull();
    expect(s.finishRevision).toBeNull();
  });
  it('forgetFinishIfReopened: ревизия не новее итога — устаревшее событие, итог цел', () => {
    const s = newAgentState('s1');
    const finished = { gameId: 'g1', result: score };
    s.finished = finished;
    s.announcedFinish = 'g1';
    noteFinishRevision(s, 'g1', 7);
    forgetFinishIfReopened(s, 'g1', 7);
    forgetFinishIfReopened(s, 'g1', 6);
    expect(s.finished).toBe(finished);
    expect(s.announcedFinish).toBe('g1');
    expect(s.finishRevision).toEqual({ gameId: 'g1', revision: 7 });
  });
  it('forgetFinishIfReopened: итог другой партии не трогает', () => {
    const s = newAgentState('s1');
    const finished = { gameId: 'g0', result: score };
    s.finished = finished;
    s.announcedFinish = 'g0';
    noteFinishRevision(s, 'g0', 7);
    forgetFinishIfReopened(s, 'g1', 100);
    forgetFinishIfReopened(s, 'g1', null);
    expect(s.finished).toBe(finished);
    expect(s.announcedFinish).toBe('g0');
    expect(s.finishRevision).toEqual({ gameId: 'g0', revision: 7 });
  });
  it('forgetFinishIfReopened: ревизия неизвестна (null) или известна только для другой партии — итог этой партии забыт', () => {
    const s = newAgentState('s1');
    s.finished = { gameId: 'g1', result: score };
    s.announcedFinish = 'g1';
    noteFinishRevision(s, 'g1', 7);
    forgetFinishIfReopened(s, 'g1', null);
    expect(s.finished).toBeNull();
    expect(s.announcedFinish).toBeNull();
    expect(s.finishRevision).toBeNull();
    const s2 = newAgentState('s1');
    s2.finished = { gameId: 'g1', result: score };
    s2.announcedFinish = 'g1';
    noteFinishRevision(s2, 'g0', 50);
    forgetFinishIfReopened(s2, 'g1', 3);
    expect(s2.finished).toBeNull();
    expect(s2.announcedFinish).toBeNull();
    expect(s2.finishRevision).toEqual({ gameId: 'g0', revision: 50 });
  });
});

describe('newAgentState', () => {
  it('новая сессия: партии нет, человек за чёрных, Гоко 10 кю, коми 7,5, флаги сброшены', () => {
    expect(DEFAULT_RANK).toBe('10k');
    expect(DEFAULT_KOMI).toBe(7.5);
    expect(newAgentState('s1')).toStrictEqual({
      sessionId: 's1',
      gameId: null,
      gameGeneration: 0,
      observedRevision: null,
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
      finishRevision: null,
      seenMove: null,
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
