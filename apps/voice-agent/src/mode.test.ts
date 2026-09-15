// mode.test.ts — режим Голос / Чат (D-0011) на замоканном сеансе
import { describe, expect, it } from 'vitest';
import type { Clock } from './clock.ts';
import { MIC_ATTRIBUTE, MODE_ATTRIBUTE, MODE_WAIT_MS, type ParticipantLike, applyMode, followMode, modeOf, waitForMode } from './mode.ts';

function fakeSession() {
  const calls: string[] = [];
  return {
    calls,
    input: { setAudioEnabled: (enabled: boolean) => void calls.push(`in:${enabled}`) },
    output: { setAudioEnabled: (enabled: boolean) => void calls.push(`out:${enabled}`) },
  };
}

function fakeLive() {
  const calls: string[] = [];
  return { calls, setInputEnabled: (enabled: boolean) => calls.push(`provider:${enabled ? 'unmute' : 'mute'}`) };
}

describe('modeOf', () => {
  it('chat только при goko.mode=chat, всё остальное — voice', () => {
    expect(MODE_ATTRIBUTE).toBe('goko.mode');
    expect(modeOf({ 'goko.mode': 'chat' })).toBe('chat');
    expect(modeOf({ 'goko.mode': 'voice' })).toBe('voice');
    expect(modeOf({ 'goko.mode': 'CHAT' })).toBe('voice');
    expect(modeOf({})).toBe('voice');
    expect(modeOf(undefined)).toBe('voice');
  });
});

describe('applyMode', () => {
  it('chat выключает аудиовыход и аудиовход сессии, voice включает обратно', () => {
    const s = fakeSession();
    const live = fakeLive();
    applyMode(s, 'chat', live);
    applyMode(s, 'voice', live);
    expect(s.calls).toEqual(['out:false', 'in:false', 'out:true', 'in:true']);
    expect(live.calls).toEqual(['provider:mute', 'provider:unmute']);
  });

  it('followMode применяет provider mute до приветствия и unmute при включении голоса', () => {
    const s = fakeSession();
    const live = fakeLive();
    const f = followMode({ participant: { identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } }, session: s, live });
    expect(live.calls).toEqual(['provider:mute']);
    f.onAttributes({ identity: 'phone-s1', attributes: { 'goko.mode': 'voice' } });
    expect(live.calls).toEqual(['provider:mute', 'provider:unmute']);
  });

  it('muted микрофон в voice сохраняет silence clock, атрибут on включает живой input', () => {
    const live = fakeLive();
    const f = followMode({ participant: { identity: 'phone-s1', attributes: { [MODE_ATTRIBUTE]: 'voice', [MIC_ATTRIBUTE]: 'muted' } }, session: fakeSession(), live });
    expect(live.calls).toEqual(['provider:mute']);
    f.onAttributes({ identity: 'phone-s1', attributes: { [MODE_ATTRIBUTE]: 'voice', [MIC_ATTRIBUTE]: 'on' } });
    expect(live.calls).toEqual(['provider:mute', 'provider:unmute']);
  });
});

describe('followMode', () => {
  it('на старте читает атрибут участника: в чате звук выключен сразу', () => {
    const s = fakeSession();
    const logs: string[] = [];
    const f = followMode({ participant: { identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } }, session: s, log: (l) => void logs.push(l) });
    expect(f.mode).toBe('chat');
    expect(s.calls).toEqual(['out:false', 'in:false']);
    expect(logs).toEqual(['[OK] voice-agent: режим chat']);
  });
  it('смена атрибута переключает режим; чужой участник и тот же режим не трогают сессию', () => {
    const s = fakeSession();
    const f = followMode({ participant: { identity: 'phone-s1', attributes: {} }, session: s });
    expect(f.mode).toBe('voice');
    expect(s.calls).toEqual(['out:true', 'in:true']);
    s.calls.length = 0;
    f.onAttributes({ identity: 'someone-else', attributes: { 'goko.mode': 'chat' } });
    f.onAttributes({ identity: 'phone-s1', attributes: { 'goko.mode': 'voice' } });
    expect(s.calls).toEqual([]);
    f.onAttributes({ identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } });
    expect(f.mode).toBe('chat');
    expect(s.calls).toEqual(['out:false', 'in:false']);
    f.onAttributes({ identity: 'phone-s1', attributes: {} });
    expect(f.mode).toBe('voice');
    expect(s.calls).toEqual(['out:false', 'in:false', 'out:true', 'in:true']);
  });
  it('каждая смена режима пишется в лог, повтор того же режима — нет', () => {
    const logs: string[] = [];
    const f = followMode({ participant: { identity: 'phone-s1', attributes: {} }, session: fakeSession(), log: (l) => void logs.push(l) });
    f.onAttributes({ identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } });
    f.onAttributes({ identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } });
    f.onAttributes({ identity: 'phone-s1', attributes: { 'goko.mode': 'voice' } });
    expect(logs).toEqual(['[OK] voice-agent: режим voice', '[OK] voice-agent: режим chat', '[OK] voice-agent: режим voice']);
  });
});

describe('followMode.onRejoin', () => {
  it('вернувшийся без атрибута не сбрасывает режим в voice: атрибут придёт следом', () => {
    const s = fakeSession();
    const f = followMode({ participant: { identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } }, session: s });
    s.calls.length = 0;
    f.onRejoin({ identity: 'phone-s1', attributes: {} });
    expect(f.mode).toBe('chat');
    expect(s.calls).toEqual([]);
    f.onRejoin({ identity: 'someone-else', attributes: { 'goko.mode': 'voice' } });
    expect(s.calls).toEqual([]);
    f.onRejoin({ identity: 'phone-s1', attributes: { 'goko.mode': 'voice' } });
    expect(f.mode).toBe('voice');
    expect(s.calls).toEqual(['out:true', 'in:true']);
  });
});

function fakeAttributes() {
  let listeners: ((p: ParticipantLike) => void)[] = [];
  let timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const clock: Clock = {
    after(ms, fn) {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
  return {
    clock,
    subscribe(listener: (p: ParticipantLike) => void) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    emit: (p: ParticipantLike) => {
      for (const l of [...listeners]) l(p);
    },
    listeners: () => listeners.length,
    live: () => timers.filter((t) => !t.cancelled),
    fire() {
      const live = timers.filter((t) => !t.cancelled);
      timers = [];
      for (const t of live) t.fn();
    },
  };
}

describe('waitForMode', () => {
  it('атрибут уже есть — сразу true, без подписки и таймера', async () => {
    const r = fakeAttributes();
    const got = await waitForMode({ participant: { identity: 'phone-s1', attributes: { 'goko.mode': 'voice' } }, subscribe: r.subscribe, clock: r.clock });
    expect(got).toBe(true);
    expect(r.listeners()).toBe(0);
    expect(r.live()).toEqual([]);
  });

  it('атрибут пришёл от этого участника — true, подписка и таймер сняты', async () => {
    const r = fakeAttributes();
    const p = { identity: 'phone-s1', attributes: {} };
    const wait = waitForMode({ participant: p, subscribe: r.subscribe, clock: r.clock });
    expect(r.live().map((t) => t.ms)).toEqual([MODE_WAIT_MS]);
    r.emit({ identity: 'someone-else', attributes: { 'goko.mode': 'chat' } });
    r.emit({ identity: 'phone-s1', attributes: { other: 'x' } });
    expect(r.listeners()).toBe(1);
    r.emit({ identity: 'phone-s1', attributes: { 'goko.mode': 'chat' } });
    expect(await wait).toBe(true);
    expect(r.listeners()).toBe(0);
    expect(r.live()).toEqual([]);
  });

  it('атрибута нет за срок — false, подписка снята; срок по умолчанию 2 с', async () => {
    expect(MODE_WAIT_MS).toBe(2_000);
    const r = fakeAttributes();
    const wait = waitForMode({ participant: { identity: 'phone-s1', attributes: {} }, subscribe: r.subscribe, clock: r.clock, timeoutMs: 700 });
    expect(r.live().map((t) => t.ms)).toEqual([700]);
    r.fire();
    expect(await wait).toBe(false);
    expect(r.listeners()).toBe(0);
  });
});
