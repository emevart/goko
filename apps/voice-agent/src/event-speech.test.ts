import { describe, expect, it } from 'vitest';
import { llm } from '@livekit/agents';
import { EVENT_MESSAGE_PREFIX, SAY_EVENT_INSTRUCTIONS, type SpeakerAgent, type SpeakerSession, createEventSpeaker, eventMessage } from './event-speech.ts';

type Journal = string[];

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const texts = (ctx: llm.ChatContext) => ctx.items.map((i) => (i.type === 'message' ? `${i.role}:${i.textContent ?? ''}` : `${i.type}:${i.id}`));

// Realtime-сессия плагина: chatCtx — копия подтверждённой сервером истории, updateChatCtx ждёт conversation.item.created.
function fakeRealtime(journal: Journal, opts: { syncMs?: (n: number) => number; fail?: boolean } = {}) {
  let remote = new llm.ChatContext([llm.FunctionCall.create({ id: 'item_remote_call', callId: 'c1', name: 'start_game', args: '{}' })]);
  const sent: llm.ChatContext[] = [];
  let n = 0;
  return {
    sent,
    get chatCtx() {
      return remote.copy();
    },
    async updateChatCtx(ctx: llm.ChatContext) {
      const call = ++n;
      sent.push(ctx);
      await new Promise((resolve) => setTimeout(resolve, opts.syncMs?.(call) ?? 0));
      if (opts.fail) throw new Error('update_chat_ctx timed out.');
      remote = ctx.copy();
      journal.push(`sync ${texts(ctx).at(-1)}`);
    },
  };
}

function fakeSession(journal: Journal, history: () => llm.ChatContext, opts: { playoutMs?: number; failReply?: number } = {}) {
  const calls: Parameters<SpeakerSession['generateReply']>[0][] = [];
  const session: SpeakerSession = {
    generateReply(options) {
      calls.push(options);
      if (opts.failReply === calls.length) throw new Error('AgentSession is not running');
      // В момент вызова ответа модель видит историю: последняя запись — событие этой реплики.
      journal.push(`reply after ${texts(history()).at(-1)}`);
      const n = calls.length;
      return {
        waitForPlayout: async () => {
          await new Promise((resolve) => setTimeout(resolve, opts.playoutMs ?? 0));
          journal.push(`played ${n}`);
        },
      };
    },
  };
  return { session, calls };
}

function realtimeAgent(rt: ReturnType<typeof fakeRealtime> | undefined): SpeakerAgent & { updates: llm.ChatContext[] } {
  const updates: llm.ChatContext[] = [];
  const agent = {
    _chatCtx: new llm.ChatContext([llm.FunctionCall.create({ id: 'item_local_call', callId: 'c1', name: 'start_game', args: '{}' })]),
    updates,
    async updateChatCtx(ctx: llm.ChatContext) {
      updates.push(ctx);
      agent._chatCtx = ctx.copy();
    },
    getActivityOrThrow: () => ({ realtimeLLMSession: rt }),
  };
  return agent;
}

describe('createEventSpeaker: реплика на событие через историю разговора (D-0013)', () => {
  it('текст события — system-сообщение «Событие с экрана: …»', () => {
    expect(EVENT_MESSAGE_PREFIX).toBe('Событие с экрана');
    expect(eventMessage('ход уже на доске')).toBe('Событие с экрана: ход уже на доске');
  });

  it('Realtime: сообщение подтверждено в истории до generateReply, ответ без инструментов, реплика ждёт воспроизведения', async () => {
    const journal: Journal = [];
    const rt = fakeRealtime(journal, { syncMs: () => 5 });
    const agent = realtimeAgent(rt);
    const { session, calls } = fakeSession(journal, () => rt.chatCtx, { playoutMs: 5 });
    const speak = createEventSpeaker({ agent, session });
    await speak('Твой ход ка десять уже на доске. Скажи вслух только: «Ка десять».');
    expect(journal).toEqual([
      'sync system:Событие с экрана: Твой ход ка десять уже на доске. Скажи вслух только: «Ка десять».',
      'reply after system:Событие с экрана: Твой ход ка десять уже на доске. Скажи вслух только: «Ка десять».',
      'played 1',
    ]);
    expect(calls).toEqual([{ instructions: SAY_EVENT_INSTRUCTIONS, toolChoice: 'none' }]);
  });

  it('Realtime: в сессию уходит её же история плюс одно сообщение — без пересоздания элементов из истории агента', async () => {
    const journal: Journal = [];
    const rt = fakeRealtime(journal);
    const agent = realtimeAgent(rt);
    const { session } = fakeSession(journal, () => rt.chatCtx);
    await createEventSpeaker({ agent, session })('Ход тапом на экране: дэ четыре, он уже на доске.');
    expect(rt.sent).toHaveLength(1);
    const ids = rt.sent[0]!.items.map((i) => i.id);
    expect(ids[0]).toBe('item_remote_call'); // не item_local_call: у вызова инструмента в истории агента свой id
    expect(ids).toHaveLength(2);
    // Историю агента updateChatCtx не трогаем (он пересинхронизировал бы всю историю), сообщение добавлено в неё напрямую.
    expect(agent.updates).toEqual([]);
    expect(texts(agent._chatCtx)).toEqual(['function_call:item_local_call', 'system:Событие с экрана: Ход тапом на экране: дэ четыре, он уже на доске.']);
    expect(agent._chatCtx.items[1]!.id).toBe(ids[1]);
  });

  it('порядок реплик сохранён: вторая реплика не синхронизируется и не звучит раньше первой, даже если её синхронизация быстрее', async () => {
    const journal: Journal = [];
    const rt = fakeRealtime(journal, { syncMs: (n) => (n === 1 ? 30 : 0) });
    const agent = realtimeAgent(rt);
    const { session, calls } = fakeSession(journal, () => rt.chatCtx, { playoutMs: 10 });
    const speak = createEventSpeaker({ agent, session });
    await Promise.all([speak('первое'), speak('второе')]);
    expect(journal).toEqual([
      'sync system:Событие с экрана: первое',
      'reply after system:Событие с экрана: первое',
      'played 1',
      'sync system:Событие с экрана: второе',
      'reply after system:Событие с экрана: второе',
      'played 2',
    ]);
    expect(calls.every((c) => c.toolChoice === 'none')).toBe(true);
  });

  it('конвейер (без Realtime): сообщение добавлено через agent.updateChatCtx до generateReply', async () => {
    const journal: Journal = [];
    const agent = realtimeAgent(undefined);
    const { session, calls } = fakeSession(journal, () => agent._chatCtx);
    await createEventSpeaker({ agent, session })('Партия окончена, итог уже записан.');
    expect(agent.updates).toHaveLength(1);
    expect(journal).toEqual(['reply after system:Событие с экрана: Партия окончена, итог уже записан.', 'played 1']);
    expect(calls).toEqual([{ instructions: SAY_EVENT_INSTRUCTIONS, toolChoice: 'none' }]);
  });

  it('синхронизация не удалась: [!] в логе, реплика всё равно без инструментов, текст события — в инструкции ответа', async () => {
    const journal: Journal = [];
    const logs: string[] = [];
    const rt = fakeRealtime(journal, { fail: true });
    const agent = realtimeAgent(rt);
    const { session, calls } = fakeSession(journal, () => rt.chatCtx);
    await createEventSpeaker({ agent, session, log: (l) => void logs.push(l) })('Твой ход ка десять уже на доске.');
    expect(logs).toEqual(['[!] voice-agent: событие не попало в историю Realtime (Error: update_chat_ctx timed out.), текст события — в инструкции ответа']);
    expect(calls).toEqual([{ instructions: `${SAY_EVENT_INSTRUCTIONS}\nСобытие с экрана: Твой ход ка десять уже на доске.`, toolChoice: 'none' }]);
    expect(agent._chatCtx.items).toHaveLength(1); // в историю агента не попало то, чего нет у модели
  });

  it('отказ одной реплики отдаётся вызвавшему и не останавливает очередь', async () => {
    const journal: Journal = [];
    const rt = fakeRealtime(journal);
    const agent = realtimeAgent(rt);
    const { session } = fakeSession(journal, () => rt.chatCtx, { failReply: 1 });
    const speak = createEventSpeaker({ agent, session });
    const first = speak('первое');
    const second = speak('второе');
    await expect(first).rejects.toThrow('AgentSession is not running');
    await second;
    await tick();
    expect(journal.at(-1)).toBe('played 2');
  });
});
