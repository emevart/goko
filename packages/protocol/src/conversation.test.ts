import { describe, expect, it } from 'vitest';
import { CONVERSATION_EVENT_MAX_BYTES, ConversationEvent, encodeConversationEvent } from './conversation.ts';

describe('ConversationEvent', () => {
  const event = {
    version: 1,
    type: 'assistant.response_finished',
    seq: 1,
    itemId: 'item_123',
    text: 'Ка десять',
    interrupted: true,
    serverTime: '2026-09-15T10:00:00.000Z',
  } as const;

  it('валидирует versioned assistant completion без лишних полей', () => {
    expect(ConversationEvent.parse(event)).toEqual(event);
    expect(() => ConversationEvent.parse({ ...event, apiKey: 'secret' })).toThrow();
    expect(() => ConversationEvent.parse({ ...event, seq: 0 })).toThrow();
    expect(() => ConversationEvent.parse({ ...event, serverTime: 'today' })).toThrow();
  });

  it('ограничивает размер JSON до безопасного размера text stream', () => {
    expect(JSON.parse(encodeConversationEvent(event))).toEqual(event);
    expect(() => encodeConversationEvent({ ...event, text: 'я'.repeat(20_000) })).toThrow(/слишком велико/);
  });
});
