// Реплика на событие партии (D-0013): факт — в историю разговора, ответ — без инструментов.
// Текст события, отданный только инструкцией ответа (response.instructions у Realtime), в историю не попадает:
// модель верила истории и правилам промпта и ставила ход человека через play_move сама. Поэтому текст события
// кладём в историю system-сообщением «Событие с экрана: …» и ждём, пока сервер его подтвердит, а ответ
// просим с toolChoice 'none': вызвать инструмент в ответ на событие модель не может.
import type { llm } from '@livekit/agents';

export const EVENT_MESSAGE_PREFIX = 'Событие с экрана';
export const eventMessage = (text: string): string => `${EVENT_MESSAGE_PREFIX}: ${text}`;

export const SAY_EVENT_INSTRUCTIONS =
  'Ответь на последнее сообщение «Событие с экрана»: скажи вслух ровно то, что оно велит, одной короткой репликой. Ходы из него уже на доске.';

// Ровно то, что адаптеру нужно от @livekit/agents 1.8; в тестах подделки.
// realtimeLLMSession — публичный геттер AgentActivity; у конвейера STT -> LLM -> TTS его нет.
export type RealtimeHistory = { readonly chatCtx: llm.ChatContext; updateChatCtx(ctx: llm.ChatContext): Promise<void> };
export type SpeakerAgent = {
  _chatCtx: llm.ChatContext;
  updateChatCtx(ctx: llm.ChatContext): Promise<void>;
  getActivityOrThrow(): { readonly realtimeLLMSession: RealtimeHistory | undefined };
};
export type SpeakerSession = {
  generateReply(options: { instructions: string; toolChoice: 'none' }): { waitForPlayout(): Promise<void> };
};

export type EventSpeakerOptions = { agent: SpeakerAgent; session: SpeakerSession; log?: (line: string) => void };

const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

// Возвращает speak для watchSession: реплики строго по очереди, каждая ждёт конца воспроизведения предыдущей
// (или её прерывания). Отказ реплики отдаётся вызвавшему, очередь идёт дальше.
export function createEventSpeaker({ agent, session, log = () => {} }: EventSpeakerOptions): (text: string) => Promise<void> {
  // Добавляет сообщение в историю модели; false — не вышло, и текст события пойдёт в инструкцию ответа.
  const addToHistory = async (content: string): Promise<boolean> => {
    const realtime = agent.getActivityOrThrow().realtimeLLMSession;
    if (!realtime) {
      // Конвейер: история — это chatCtx агента, updateChatCtx меняет её сразу, без сети.
      const ctx = agent._chatCtx.copy();
      ctx.addMessage({ role: 'system', content });
      await agent.updateChatCtx(ctx);
      return true;
    }
    // Realtime. agent.updateChatCtx не годится по двум причинам (agent_activity.ts, realtime_model.ts плагина openai):
    // - он не ждёт отправки: AgentActivity зовёт realtimeSession.updateChatCtx без await, и ответ мог уйти раньше
    //   сообщения;
    // - он сверяет с сервером всю историю агента, а у вызовов инструментов там свои id, не серверные: на каждое
    //   событие плагин удалял и заново создавал элементы истории.
    // Поэтому, как сам AgentActivity для userInput и результатов инструментов: берём подтверждённую сервером
    // историю сессии, добавляем одно сообщение и ждём updateChatCtx сессии. Разница с сервером — один
    // conversation.item.create, промис ждёт conversation.item.created (потолок плагина 5 с, затем RealtimeError).
    // [!] Остаточная гонка: если в тот же момент историю правит сама библиотека (результат инструмента), наша копия
    // может не содержать её новых элементов, и сверка их удалит. Реплики событий идут по очереди, инструменты —
    // по голосовой реплике человека, совпадение редкое.
    const ctx = realtime.chatCtx.copy();
    const message = ctx.addMessage({ role: 'system', content });
    try {
      await realtime.updateChatCtx(ctx);
    } catch (e) {
      log(`[!] voice-agent: событие не попало в историю Realtime (${errorText(e)}), текст события — в инструкции ответа`);
      return false;
    }
    // В историю агента — как библиотека для userInput: иначе её следующая сверка с сервером удалила бы сообщение.
    agent._chatCtx.insert(message);
    return true;
  };

  const speakOne = async (text: string): Promise<void> => {
    const content = eventMessage(text);
    const inHistory = await addToHistory(content);
    const instructions = inHistory ? SAY_EVENT_INSTRUCTIONS : `${SAY_EVENT_INSTRUCTIONS}\n${content}`;
    await session.generateReply({ instructions, toolChoice: 'none' }).waitForPlayout();
  };

  let tail: Promise<void> = Promise.resolve();
  return (text: string) => {
    const run = tail.then(() => speakOne(text));
    tail = run.catch(() => {});
    return run;
  };
}
