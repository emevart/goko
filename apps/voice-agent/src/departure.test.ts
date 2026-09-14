// departure.test.ts — ожидание возврата участника на фейковых часах
import { describe, expect, it } from 'vitest';
import type { Clock } from './clock.ts';
import { RETURN_GRACE_MS, watchDeparture } from './departure.ts';

function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const clock: Clock = {
    after(ms, fn) {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return {
    clock,
    pending: () => timers.filter((t) => !t.cancelled && t.at > now).length,
    advance(ms: number) {
      const until = now + ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.cancelled || t.at <= now || t.at > until) continue;
        now = t.at;
        t.fn();
      }
      now = until;
    },
  };
}

function setup(opts: { graceMs?: number } = {}) {
  const c = fakeClock();
  const events: string[] = [];
  const watch = watchDeparture({
    identity: 'phone-s1',
    clock: c.clock,
    ...opts,
    onGone: () => void events.push('gone'),
    onReturn: (p) => void events.push(`return:${p.identity}`),
    log: (line) => void events.push(line),
  });
  return { ...c, events, watch };
}

describe('watchDeparture', () => {
  it('ожидание по умолчанию — минута, меньше пустой комнаты game-server (300 с)', () => {
    expect(RETURN_GRACE_MS).toBe(60_000);
  });

  it('участник ушёл и не вернулся — onGone ровно по истечении ожидания, один раз', () => {
    const t = setup();
    t.watch.onDisconnected({ identity: 'phone-s1' });
    expect(t.events).toEqual(['[!] voice-agent: участник ушёл, ждём возврата 60 с']);
    t.advance(RETURN_GRACE_MS - 1);
    expect(t.events).not.toContain('gone');
    t.advance(1);
    expect(t.events).toEqual([
      '[!] voice-agent: участник ушёл, ждём возврата 60 с',
      '[!] voice-agent: участник не вернулся за 60 с, завершаем работу',
      'gone',
    ]);
    t.advance(RETURN_GRACE_MS * 5);
    expect(t.events.filter((e) => e === 'gone')).toHaveLength(1);
  });

  it('вернулся с тем же identity — таймер снят, onReturn с новым участником, onGone не зовётся', () => {
    const t = setup();
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.advance(30_000);
    t.watch.onConnected({ identity: 'phone-s1' });
    expect(t.pending()).toBe(0);
    t.advance(RETURN_GRACE_MS * 2);
    expect(t.events).toEqual([
      '[!] voice-agent: участник ушёл, ждём возврата 60 с',
      '[OK] voice-agent: участник вернулся',
      'return:phone-s1',
    ]);
  });

  it('чужие участники не запускают и не снимают таймер', () => {
    const t = setup();
    t.watch.onDisconnected({ identity: 'someone-else' });
    t.watch.onConnected({ identity: 'someone-else' });
    expect(t.pending()).toBe(0);
    expect(t.events).toEqual([]);
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.watch.onConnected({ identity: 'someone-else' });
    t.advance(RETURN_GRACE_MS);
    expect(t.events.at(-1)).toBe('gone');
  });

  it('вход без ухода — не возврат: onReturn не зовётся', () => {
    const t = setup();
    t.watch.onConnected({ identity: 'phone-s1' });
    expect(t.events).toEqual([]);
  });

  it('повторный уход во время ожидания не продлевает срок', () => {
    const t = setup();
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.advance(40_000);
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.advance(20_000);
    expect(t.events.at(-1)).toBe('gone');
    expect(t.events.filter((e) => e.startsWith('[!] voice-agent: участник ушёл'))).toHaveLength(1);
  });

  it('уход после возврата — новый полный срок', () => {
    const t = setup();
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.advance(50_000);
    t.watch.onConnected({ identity: 'phone-s1' });
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.advance(RETURN_GRACE_MS - 1);
    expect(t.events).not.toContain('gone');
    t.advance(1);
    expect(t.events.at(-1)).toBe('gone');
  });

  it('stop снимает таймер и глушит дальнейшие события', () => {
    const t = setup();
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.watch.stop();
    expect(t.pending()).toBe(0);
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.watch.onConnected({ identity: 'phone-s1' });
    t.advance(RETURN_GRACE_MS * 2);
    expect(t.events).toEqual(['[!] voice-agent: участник ушёл, ждём возврата 60 с']);
  });

  it('после onGone события участника ничего не делают', () => {
    const t = setup();
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.advance(RETURN_GRACE_MS);
    t.watch.onConnected({ identity: 'phone-s1' });
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.advance(RETURN_GRACE_MS);
    expect(t.events.slice(2)).toEqual(['gone']);
  });

  it('срок из опций попадает и в таймер, и в строки лога (секунды округляются вверх)', () => {
    const t = setup({ graceMs: 1_500 });
    t.watch.onDisconnected({ identity: 'phone-s1' });
    t.advance(1_499);
    expect(t.events).toEqual(['[!] voice-agent: участник ушёл, ждём возврата 2 с']);
    t.advance(1);
    expect(t.events.slice(1)).toEqual(['[!] voice-agent: участник не вернулся за 2 с, завершаем работу', 'gone']);
  });
});
