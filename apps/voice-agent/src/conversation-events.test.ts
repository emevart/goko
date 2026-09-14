import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CONVERSATION_TOPIC } from '@goko/protocol';
import { attachConversationEvents } from './conversation-events.ts';

function assistantItem(id: string, textContent = 'Фраза') {
  return { item: { type: 'message', role: 'assistant', id, textContent, interrupted: false } };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('attachConversationEvents', () => {
  it('синхронно фиксирует payload и serverTime, сохраняя адресат и порядок', async () => {
    const session = new EventEmitter();
    const sendText = vi.fn(async (_text: string, _options: { topic: string; destinationIdentities: string[] }) => undefined);
    const now = vi.fn()
      .mockReturnValueOnce(new Date('2026-09-15T10:00:00.000Z'))
      .mockReturnValueOnce(new Date('2026-09-15T10:00:01.000Z'));
    const stop = attachConversationEvents({
      subscribe: (listener) => {
        session.on('conversation_item_added', listener);
        return () => void session.off('conversation_item_added', listener);
      },
      sendText,
      destinationIdentity: 'phone-1',
      now,
      log: vi.fn(),
    });
    const first = assistantItem('item_a', 'Первая');
    first.item.interrupted = true;
    session.emit('conversation_item_added', first);
    first.item.id = 'mutated';
    first.item.textContent = 'Изменено';
    first.item.interrupted = false;
    session.emit('conversation_item_added', { item: { type: 'message', role: 'user', id: 'item_u', textContent: 'Вопрос' } });
    session.emit('conversation_item_added', assistantItem('item_b', 'Вторая'));

    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(2));
    expect(JSON.parse(sendText.mock.calls[0]![0])).toEqual({
      version: 1,
      type: 'assistant.response_finished',
      seq: 1,
      itemId: 'item_a',
      text: 'Первая',
      interrupted: true,
      serverTime: '2026-09-15T10:00:00.000Z',
    });
    expect(sendText.mock.calls[0]![1]).toEqual({ topic: CONVERSATION_TOPIC, destinationIdentities: ['phone-1'] });
    expect(JSON.parse(sendText.mock.calls[1]![0])).toMatchObject({
      seq: 2,
      itemId: 'item_b',
      serverTime: '2026-09-15T10:00:01.000Z',
    });
    stop();
  });

  it('после timeout зависшей отправки продолжает очередь', async () => {
    vi.useFakeTimers();
    try {
      const session = new EventEmitter();
      const hung = deferred();
      const log = vi.fn();
      const sendText = vi.fn()
        .mockImplementationOnce(() => hung.promise)
        .mockResolvedValueOnce(undefined);
      const stop = attachConversationEvents({
        subscribe: (listener) => {
          session.on('conversation_item_added', listener);
          return () => void session.off('conversation_item_added', listener);
        },
        sendText,
        destinationIdentity: 'phone-1',
        log,
      });
      session.emit('conversation_item_added', assistantItem('item_a'));
      session.emit('conversation_item_added', assistantItem('item_b'));
      await vi.advanceTimersByTimeAsync(0);
      expect(sendText).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(sendText).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/seq=1 .*reason=timeout/));
      stop();
      hung.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ограничивает очередь и безопасно логирует overflow', () => {
    const session = new EventEmitter();
    const log = vi.fn();
    const sendText = vi.fn(async () => undefined);
    const stop = attachConversationEvents({
      subscribe: (listener) => {
        session.on('conversation_item_added', listener);
        return () => void session.off('conversation_item_added', listener);
      },
      sendText,
      destinationIdentity: 'phone-1',
      log,
    });
    for (let index = 1; index <= 33; index += 1) {
      session.emit('conversation_item_added', assistantItem(`item_${index}`));
    }
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/seq=33 .*type=assistant\.response_finished .*reason=overflow/));
    stop();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('stop до отправки удаляет очередь, а повторный stop отписывает один раз', async () => {
    const session = new EventEmitter();
    const unsubscribe = vi.fn();
    const sendText = vi.fn(async () => undefined);
    const stop = attachConversationEvents({
      subscribe: (listener) => {
        session.on('conversation_item_added', listener);
        return unsubscribe;
      },
      sendText,
      destinationIdentity: 'phone-1',
    });
    session.emit('conversation_item_added', assistantItem('item_a'));
    stop();
    stop();
    await Promise.resolve();
    expect(sendText).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stop во время отправки не начинает queued sends', async () => {
    const session = new EventEmitter();
    const hung = deferred();
    const sendText = vi.fn(() => hung.promise);
    const stop = attachConversationEvents({
      subscribe: (listener) => {
        session.on('conversation_item_added', listener);
        return () => void session.off('conversation_item_added', listener);
      },
      sendText,
      destinationIdentity: 'phone-1',
    });
    session.emit('conversation_item_added', assistantItem('item_a'));
    session.emit('conversation_item_added', assistantItem('item_b'));
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    stop();
    hung.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('обрабатывает поздний reject после timeout и не раскрывает error message', async () => {
    vi.useFakeTimers();
    try {
      const session = new EventEmitter();
      const late = deferred();
      const log = vi.fn();
      const sendText = vi.fn()
        .mockImplementationOnce(() => late.promise)
        .mockResolvedValueOnce(undefined);
      const stop = attachConversationEvents({
        subscribe: (listener) => {
          session.on('conversation_item_added', listener);
          return () => void session.off('conversation_item_added', listener);
        },
        sendText,
        destinationIdentity: 'phone-1',
        log,
      });
      session.emit('conversation_item_added', assistantItem('item_a'));
      session.emit('conversation_item_added', assistantItem('item_b'));
      await vi.advanceTimersByTimeAsync(3_000);
      late.reject(new Error('secret payload from SDK'));
      await Promise.resolve();
      expect(sendText).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toMatch(/seq=1 .*reason=timeout/);
      expect(log.mock.calls[0]![0]).not.toContain('secret payload');
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('безопасно логирует немедленную ошибку отправки', async () => {
    const session = new EventEmitter();
    const log = vi.fn();
    attachConversationEvents({
      subscribe: (listener) => {
        session.on('conversation_item_added', listener);
        return () => void session.off('conversation_item_added', listener);
      },
      sendText: async () => Promise.reject(new Error('secret room payload')),
      destinationIdentity: 'phone-1',
      log,
    });
    expect(() => session.emit('conversation_item_added', assistantItem('item_a'))).not.toThrow();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringMatching(/seq=1 .*reason=send_failed/)));
    expect(log.mock.calls[0]![0]).not.toContain('secret room payload');
  });
});
