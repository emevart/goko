// mode.test.ts — режим Голос / Чат (D-0011) на замоканном сеансе
import { describe, expect, it } from 'vitest';
import { MODE_ATTRIBUTE, applyMode, followMode, modeOf } from './mode.ts';

function fakeSession() {
  const calls: string[] = [];
  return {
    calls,
    input: { setAudioEnabled: (enabled: boolean) => void calls.push(`in:${enabled}`) },
    output: { setAudioEnabled: (enabled: boolean) => void calls.push(`out:${enabled}`) },
  };
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
    applyMode(s, 'chat');
    applyMode(s, 'voice');
    expect(s.calls).toEqual(['out:false', 'in:false', 'out:true', 'in:true']);
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
