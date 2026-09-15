// Реплика на событие партии (D-0013): факт — в историю разговора, ответ — без инструментов.
// Текст события, отданный только инструкцией ответа (response.instructions у Realtime), в историю не попадает:
// модель верила истории и правилам промпта и ставила ход человека через play_move сама. Поэтому текст события
// кладём в историю system-сообщением «Событие с экрана: …» и ждём, пока сервер его подтвердит, а ответ
// просим с toolChoice 'none': вызвать инструмент в ответ на событие модель не может.
import type { llm, voice } from '@livekit/agents';
import type { LiveBridge } from './live-bridge.ts';

export const EVENT_MESSAGE_PREFIX = 'Событие с экрана';
export const eventMessage = (text: string): string => `${EVENT_MESSAGE_PREFIX}: ${text}`;

export const SAY_EVENT_INSTRUCTIONS =
  'Ответь на последнее сообщение «Событие с экрана»: скажи вслух ровно то, что оно велит, одной короткой репликой. Ходы из него уже на доске.';
// Запасной путь: сообщения в истории нет, последнее «Событие с экрана» там — прошлое. Текст события идёт ниже.
export const SAY_EVENT_FALLBACK_INSTRUCTIONS =
  'Скажи вслух ровно реплику из события ниже, одной короткой репликой. Ходы из него уже на доске.';

// Сколько ждать, пока модель выйдет из thinking, прежде чем копировать историю (ревью I1). Выше клиентского
// потолка play, correct_last_move и analyze (15 с, CLIENT_TIMEOUTS) плюс таймаута синхронизации плагина (5 с):
// обычный вызов инструмента с синхронизацией результата укладывается. Дольше длится только pass со счётом
// (до 15 + 22 с), но итог партии в это время не озвучивается (awaitingFinish в events.ts).
export const THINKING_WAIT_MS = 20_000;
export const THINKING_POLL_MS = 100;

// Ровно то, что адаптеру нужно от @livekit/agents 1.8; в тестах подделки.
// realtimeLLMSession — публичный геттер AgentActivity; у конвейера STT -> LLM -> TTS его нет.
export type RealtimeHistory = { readonly chatCtx: llm.ChatContext; updateChatCtx(ctx: llm.ChatContext): Promise<void> };
// [!] _chatCtx помечен в библиотеке @internal (agent.ts). Та же вставка есть в самой библиотеке (userInput,
// результаты инструментов), но при обновлении @livekit/agents поле может исчезнуть или поменять смысл молча:
// после обновления прогнать event-speech.test.ts и проверить вставку по исходникам agent_activity.ts.
export type SpeakerAgent = {
  _chatCtx: llm.ChatContext;
  updateChatCtx(ctx: llm.ChatContext): Promise<void>;
  getActivityOrThrow(): { readonly realtimeLLMSession: RealtimeHistory | undefined };
};
export type SpeakerSession = {
  readonly agentState: voice.AgentState;
  generateReply(options: { instructions: string; toolChoice: 'none' }): { waitForPlayout(): Promise<void> };
};

export type EventSpeakerOptions = {
  agent: SpeakerAgent;
  session: SpeakerSession;
  log?: (line: string) => void;
  thinkingWaitMs?: number;
  pollMs?: number;
  liveBridge?: LiveBridge;
  current?: () => { gameId: string | null; revision: number | null };
};
export type EventSpeechMeta = { eventId: string; gameId: string; revision: number; cause: string };

const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const seconds = (ms: number): string => String(ms / 1000).replace('.', ',');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Возвращает speak для watchSession: реплики строго по очереди, каждая ждёт конца воспроизведения предыдущей
// (или её прерывания). Отказ реплики отдаётся вызвавшему, очередь идёт дальше.
export function createEventSpeaker({
  agent,
  session,
  log = () => {},
  thinkingWaitMs = THINKING_WAIT_MS,
  pollMs = THINKING_POLL_MS,
  liveBridge,
  current,
}: EventSpeakerOptions): (text: string, meta?: EventSpeechMeta) => Promise<void> {
  const liveEvents = new Set<string>();
  // Гонка истории Realtime (ревью I1). И мы, и библиотека (результат инструмента, agent_activity.ts) делают одно:
  // копия истории сессии + свои элементы + updateChatCtx. Мьютекс плагина защищает отправку, а не момент копии,
  // и сверка удаляет на сервере всё, чего нет в копии. Если копии сняты до того, как чужая синхронизация
  // подтверждена, пропадает одно из двух:
  // - результат инструмента: наша копия без function_call_output, наш updateChatCtx второй — вывод удалён,
  //   ответ на инструмент генерируется без результата (модель может повторить play_move или выдумать ход);
  // - событие: копия библиотеки без нашего сообщения, её updateChatCtx второй — событие удалено, и ответ
  //   «на последнее «Событие с экрана»» озвучивает прошлое событие.
  // Совпадение коррелировано: при сбое движка game-server шлёт событие error и в тот же момент отвечает на play.
  // Защита: копируем только когда agentState не thinking. В Realtime thinking держится от окончания генерации
  // с вызовом инструмента через его выполнение и синхронизацию вывода до начала ответа; после этого серверная
  // история уже содержит вывод. По потолку thinkingWaitMs — строка [!] и копия без ожидания: риск гонки
  // для этого одного события возвращается, но реплика не теряется.
  // [TODO] Не защищено: текстовая реплика из «Чата» (userInput, та же копия вне мьютекса) в момент события и
  // полная сверка истории при прерывании ответа. Окна узкие и с событиями не связаны.
  const waitNotThinking = async (): Promise<void> => {
    const started = Date.now();
    while (session.agentState === 'thinking') {
      if (Date.now() - started >= thinkingWaitMs) {
        log(`[!] voice-agent: модель занята (agentState thinking) дольше ${seconds(thinkingWaitMs)} с, событие кладу в историю без ожидания`);
        return;
      }
      await sleep(pollMs);
    }
  };

  // Добавляет сообщение в историю модели; false — не вышло, и текст события пойдёт в инструкцию ответа.
  const addToHistory = async (content: string): Promise<boolean> => {
    await waitNotThinking();
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

  const speakOne = async (text: string, meta?: EventSpeechMeta): Promise<void> => {
    const content = eventMessage(text);
    if (liveBridge) {
      if (meta && liveEvents.has(meta.eventId)) return;
      if (meta) {
        liveEvents.add(meta.eventId);
        if (liveEvents.size > 64) liveEvents.delete(liveEvents.values().next().value as string);
      }
      const stillCurrent = () => {
        if (!meta || !current) return true;
        const snapshot = current();
        return snapshot.gameId === meta.gameId && (snapshot.revision === null || snapshot.revision <= meta.revision);
      };
      await liveBridge.commentary(
        SAY_EVENT_INSTRUCTIONS,
        meta ? `${content} [game=${meta.gameId} rev=${meta.revision} cause=${meta.cause}]` : content,
        stillCurrent,
      );
      return;
    }
    const inHistory = await addToHistory(content);
    const instructions = inHistory ? SAY_EVENT_INSTRUCTIONS : `${SAY_EVENT_FALLBACK_INSTRUCTIONS}\n${content}`;
    await session.generateReply({ instructions, toolChoice: 'none' }).waitForPlayout();
  };

  // Своя очередь дублирует последовательность say в watchSession (await в цикле) и страхует вызовы вне него:
  // две синхронизации истории вперемешку снова дали бы гонку копий.
  let tail: Promise<void> = Promise.resolve();
  return (text: string, meta?: EventSpeechMeta) => {
    const run = tail.then(() => {
      if (meta && current) {
        const snapshot = current();
        if (snapshot.gameId !== meta.gameId || snapshot.revision !== null && snapshot.revision > meta.revision) return;
      }
      return speakOne(text, meta);
    });
    tail = run.catch(() => {});
    return run;
  };
}
