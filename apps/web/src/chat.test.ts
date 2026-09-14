import { describe, expect, it } from 'vitest';
import { CHAT_MAX_CHARS, agentReady, sendChat } from './chat.ts';

function deps(fail = false) {
  const sent: string[] = [];
  return {
    sent,
    send: async (text: string) => {
      if (fail) throw new Error('not connected');
      sent.push(text);
    },
    id: () => 'chat-1',
  };
}

describe('sendChat — форма ввода режима «Чат» (D-0011)', () => {
  it('отправляет обрезанный текст, очищает поле и добавляет свою строку в ленту', async () => {
    const d = deps();
    expect(await sendChat('  дэ четыре  ', d)).toEqual({ draft: '', line: { id: 'chat-1', who: 'me', text: 'дэ четыре', final: true }, error: null });
    expect(d.sent).toEqual(['дэ четыре']);
  });
  it('пустое поле не отправляет', async () => {
    const d = deps();
    expect(await sendChat('   ', d)).toEqual({ draft: '', line: null, error: null });
    expect(d.sent).toEqual([]);
  });
  it('слишком длинный текст не отправляет и оставляет черновик', async () => {
    const d = deps();
    const long = 'а'.repeat(CHAT_MAX_CHARS + 1);
    expect(await sendChat(long, d)).toEqual({ draft: long, line: null, error: `слишком длинно: не больше ${CHAT_MAX_CHARS} знаков` });
    expect(d.sent).toEqual([]);
  });
  it('ровно CHAT_MAX_CHARS знаков отправляет', async () => {
    const d = deps();
    const max = 'а'.repeat(CHAT_MAX_CHARS);
    expect((await sendChat(max, d)).error).toBeNull();
    expect(d.sent).toEqual([max]);
  });
  it('ошибка отправки оставляет черновик и говорит по-русски', async () => {
    expect(await sendChat('кто впереди', deps(true))).toEqual({ draft: 'кто впереди', line: null, error: 'не удалось отправить: нет связи с Гоко' });
    expect((await sendChat(' кто впереди  ', deps(true))).draft).toBe(' кто впереди  '); // черновик как набран, без обрезки
  });
});

describe('agentReady', () => {
  it('агент готов, когда выставил lk.agent.state и уже не инициализируется', () => {
    expect(agentReady(undefined)).toBe(false);
    expect(agentReady({})).toBe(false);
    expect(agentReady({ 'lk.agent.state': 'initializing' })).toBe(false);
    expect(agentReady({ 'lk.agent.state': 'listening' })).toBe(true);
    expect(agentReady({ 'lk.agent.state': 'speaking' })).toBe(true);
  });
});
