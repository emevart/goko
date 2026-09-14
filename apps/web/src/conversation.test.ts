import { describe, expect, it } from 'vitest';
import { acceptConversationEvent, bindAgent, isBoundAgent } from './conversation.ts';

const agentKind = 4;
const event = (seq: number, interrupted = false) =>
  JSON.stringify({ version: 1, type: 'assistant.response_finished', seq, itemId: `i${seq}`, text: 'Ответ', interrupted, serverTime: '2026-09-15T10:00:00.000Z' });

describe('agent conversation binding', () => {
  it('выбирает только ParticipantKind.AGENT и связывает identity+SID с поколением комнаты', () => {
    const bound = bindAgent(7, [{ identity: 'looks-ready', sid: 'P1', kind: 0 }, { identity: 'goko', sid: 'A1', kind: agentKind }], agentKind);
    expect(bound).toMatchObject({ generation: 7, identity: 'goko', sid: 'A1' });
    expect(isBoundAgent(bound, 7, { identity: 'goko', sid: 'A1', kind: agentKind })).toBe(true);
    expect(isBoundAgent(bound, 8, { identity: 'goko', sid: 'A1', kind: agentKind })).toBe(false);
    expect(isBoundAgent(bound, 7, { identity: 'goko', sid: 'A2', kind: agentKind })).toBe(false);
  });

  it('валидирует схему, отбрасывает повторы seq и принимает seq=1 после рестарта producer с новым SID', () => {
    const first = bindAgent(1, [{ identity: 'goko', sid: 'A1', kind: agentKind }], agentKind)!;
    const sender1 = { identity: 'goko', sid: 'A1', kind: agentKind };
    expect(acceptConversationEvent(first, 1, sender1, event(1, true))?.interrupted).toBe(true);
    expect(acceptConversationEvent(first, 1, sender1, event(1))).toBeNull();
    expect(acceptConversationEvent(first, 1, sender1, '{"type":"bad"}')).toBeNull();
    const restarted = bindAgent(1, [{ identity: 'goko', sid: 'A2', kind: agentKind }], agentKind)!;
    expect(acceptConversationEvent(restarted, 1, { ...sender1, sid: 'A2' }, event(1))).not.toBeNull();
  });
});
