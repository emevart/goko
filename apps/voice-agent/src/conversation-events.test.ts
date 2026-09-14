import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CONVERSATION_TOPIC } from '@goko/protocol';
import { attachConversationEvents } from './conversation-events.ts';

describe('attachConversationEvents', () => {
  it('публикует авторитетный interrupted только адресату и с session-local sequence', async () => {
    const session = new EventEmitter();
    const sendText = vi.fn(async (_text: string, _options: { topic: string; destinationIdentities: string[] }) => undefined);
    const stop = attachConversationEvents({
      subscribe: (listener) => {
        session.on('conversation_item_added', listener);
        return () => void session.off('conversation_item_added', listener);
      },
      sendText,
      destinationIdentity: 'phone-1',
      now: () => new Date('2026-09-15T10:00:00.000Z'),
      log: vi.fn(),
    });
    session.emit('conversation_item_added', { item: { type: 'message', role: 'assistant', id: 'item_a', textContent: 'Фраза', interrupted: true } });
    session.emit('conversation_item_added', { item: { type: 'message', role: 'user', id: 'item_u', textContent: 'Вопрос', interrupted: false } });
    session.emit('conversation_item_added', { item: { type: 'message', role: 'assistant', id: 'item_b', textContent: 'Ответ', interrupted: false } });
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(2));
    expect(JSON.parse(sendText.mock.calls[0]![0])).toEqual({
      version: 1,
      type: 'assistant.response_finished',
      seq: 1,
      itemId: 'item_a',
      text: 'Фраза',
      interrupted: true,
      serverTime: '2026-09-15T10:00:00.000Z',
    });
    expect(sendText.mock.calls[0]![1]).toEqual({ topic: CONVERSATION_TOPIC, destinationIdentities: ['phone-1'] });
    expect(JSON.parse(sendText.mock.calls[1]![0])).toMatchObject({ seq: 2, itemId: 'item_b', interrupted: false });
    stop();
    session.emit('conversation_item_added', { item: { type: 'message', role: 'assistant', id: 'item_c', textContent: 'Позже', interrupted: false } });
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('логирует ошибку отправки и не бросает из listener', async () => {
    const session = new EventEmitter();
    const log = vi.fn();
    attachConversationEvents({
      subscribe: (listener) => {
        session.on('conversation_item_added', listener);
        return () => void session.off('conversation_item_added', listener);
      },
      sendText: async () => Promise.reject(new Error('room closed')),
      destinationIdentity: 'phone-1',
      log,
    });
    expect(() => session.emit('conversation_item_added', { item: { type: 'message', role: 'assistant', id: 'item_a', textContent: 'Фраза', interrupted: false } })).not.toThrow();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('room closed')));
  });
});
