import { describe, expect, it } from 'vitest';
import { CHAT_ATTRIBUTES, describeEvent, waitForQuiet } from './chat.mjs';

// Часы и пауза подделаны: время идёт только в pause.
function fakeClock() {
  const clock = { t: 0, pauses: 0 };
  return {
    clock,
    now: () => clock.t,
    pause: async (ms: number) => {
      clock.pauses += 1;
      clock.t += ms;
    },
  };
}

describe('CHAT_ATTRIBUTES', () => {
  it('консоль — режим «Чат» (D-0011): агент отвечает текстом, без звука', () => {
    expect(CHAT_ATTRIBUTES).toEqual({ 'goko.mode': 'chat' });
  });
});

describe('describeEvent', () => {
  it('коротко описывает события сессии', () => {
    expect(describeEvent({ type: 'session.game', gameId: 'g1' })).toBe('партия g1');
    expect(describeEvent({ type: 'engine.thinking', gameId: 'g1', color: 'W' })).toBe('Гоко думает за W');
    expect(describeEvent({ type: 'game.finished', result: { winner: 'W', reason: 'resign' } })).toBe('конец: W+R');
    expect(describeEvent({ type: 'game.finished', result: { winner: 'B', margin: 5.5, reason: 'score' } })).toBe('конец: B+5.5');
    expect(describeEvent({ type: 'error', gameId: 'g1', code: 'engine_busy', message: 'engine did not respond within 8000 ms' })).toBe('ошибка engine_busy: Гоко думает дольше обычного');
    expect(
      describeEvent({
        type: 'state.updated',
        cause: 'engine',
        by: 'engine',
        state: { revision: 4, toPlay: 'B', moves: [{ n: 1, color: 'B', coord: 'D4' }, { n: 2, color: 'W', coord: 'K10' }] },
      }),
    ).toBe('engine by engine: ход 2 W K10, rev 4, дальше B');
    expect(describeEvent({ type: 'state.updated', cause: 'play', by: 'human', via: 'tap', state: { revision: 1, toPlay: 'W', moves: [] } })).toBe(
      'play by human via tap: ходов 0, rev 1, дальше W',
    );
  });
});

describe('waitForQuiet: тишина перед выходом и перед следующей строкой сценария', () => {
  it('уже тихо — true сразу, без паузы', async () => {
    const { clock, now, pause } = fakeClock();
    const quiet = await waitForQuiet(() => ({ busy: false, lastActivityAt: -5000 }), { quietMs: 1000, maxWaitMs: 3000, pollMs: 200, now, pause });
    expect(quiet).toBe(true);
    expect(clock.pauses).toBe(0);
  });

  it('ждёт quietMs от последней активности; новая активность отодвигает тишину', async () => {
    const { clock, now, pause } = fakeClock();
    let lastActivityAt = 0;
    const probe = () => {
      if (clock.t === 400) lastActivityAt = 400;
      return { busy: false, lastActivityAt };
    };
    expect(await waitForQuiet(probe, { quietMs: 1000, maxWaitMs: 5000, pollMs: 200, now, pause })).toBe(true);
    expect(clock.t).toBe(1400);
  });

  it('открытый поток или неподтверждённый сегмент — не тишина, даже если активность давно', async () => {
    const { clock, now, pause } = fakeClock();
    const probe = () => ({ busy: clock.t < 2000, lastActivityAt: -10000 });
    expect(await waitForQuiet(probe, { quietMs: 1000, maxWaitMs: 5000, pollMs: 200, now, pause })).toBe(true);
    expect(clock.t).toBe(2000);
  });

  it('потолок maxWaitMs — false, дальше не ждёт', async () => {
    const { clock, now, pause } = fakeClock();
    expect(await waitForQuiet(() => ({ busy: true, lastActivityAt: 0 }), { quietMs: 1000, maxWaitMs: 3000, pollMs: 200, now, pause })).toBe(false);
    expect(clock.t).toBe(3000);
  });
});
