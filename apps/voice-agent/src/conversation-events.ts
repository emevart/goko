import { CONVERSATION_TOPIC, encodeConversationEvent } from '@goko/protocol';

type ConversationItem = {
  type: string;
  role?: string;
  id?: string;
  textContent?: string;
  interrupted?: boolean;
};

type SendText = (
  text: string,
  options: { topic: string; destinationIdentities: string[] },
) => Promise<unknown>;

const MAX_PENDING_EVENTS = 32;
const SEND_TIMEOUT_MS = 3_000;

type PendingEvent = {
  seq: number;
  type: 'assistant.response_finished' | 'conversation.failure';
  text: string;
};

export type ConversationEventsHandle = (() => void) & { failure(message: string): void };

export function attachConversationEvents(deps: {
  subscribe: (listener: (event: { item: ConversationItem }) => void) => () => void;
  sendText: SendText;
  destinationIdentity: string;
  now?: () => Date;
  log?: (line: string) => void;
}): ConversationEventsHandle {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let seq = 0;
  let closed = false;
  let scheduled = false;
  let pumping = false;
  let stopActiveSend: (() => void) | undefined;
  const queue: PendingEvent[] = [];
  const unsettledSends = new Set<Promise<'sent' | 'failed'>>();

  const safeLog = (event: Pick<PendingEvent, 'seq' | 'type'>, reason: 'invalid_payload' | 'send_failed' | 'timeout' | 'overflow') => {
    log(`[!] voice-agent: событие разговора не отправлено: seq=${event.seq} type=${event.type} reason=${reason}`);
  };

  const pump = async () => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (!closed && queue.length > 0) {
        const event = queue.shift()!;
        if (unsettledSends.size >= MAX_PENDING_EVENTS) {
          safeLog(event, 'overflow');
          continue;
        }

        const settled = Promise.resolve()
          .then(() => deps.sendText(event.text, {
            topic: CONVERSATION_TOPIC,
            destinationIdentities: [deps.destinationIdentity],
          }))
          .then(
            () => 'sent' as const,
            () => 'failed' as const,
          );
        unsettledSends.add(settled);
        void settled.then(() => unsettledSends.delete(settled));

        let timer: ReturnType<typeof setTimeout> | undefined;
        let resolveStopped: (() => void) | undefined;
        const stopped = new Promise<'stopped'>((resolve) => {
          resolveStopped = () => resolve('stopped');
          stopActiveSend = resolveStopped;
        });
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), SEND_TIMEOUT_MS);
        });
        const outcome = await Promise.race([settled, timeout, stopped]);
        if (timer !== undefined) clearTimeout(timer);
        if (stopActiveSend === resolveStopped) stopActiveSend = undefined;

        if (outcome === 'stopped') return;
        if (outcome === 'failed') safeLog(event, 'send_failed');
        if (outcome === 'timeout') safeLog(event, 'timeout');
      }
    } finally {
      pumping = false;
    }
  };

  const schedulePump = () => {
    if (scheduled || pumping || closed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void pump();
    });
  };

  const listener = (event: { item: ConversationItem }) => {
    if (closed) return;
    const item = event.item;
    if (item.type !== 'message' || item.role !== 'assistant' || typeof item.id !== 'string' || typeof item.textContent !== 'string') return;
    const currentSeq = ++seq;
    const eventType = 'assistant.response_finished' as const;
    let text: string;
    try {
      text = encodeConversationEvent({
        version: 1,
        type: eventType,
        seq: currentSeq,
        itemId: item.id,
        text: item.textContent,
        interrupted: item.interrupted === true,
        serverTime: now().toISOString(),
      });
    } catch {
      safeLog({ seq: currentSeq, type: eventType }, 'invalid_payload');
      return;
    }
    if (queue.length >= MAX_PENDING_EVENTS) {
      safeLog({ seq: currentSeq, type: eventType }, 'overflow');
      return;
    }
    queue.push({ seq: currentSeq, type: eventType, text });
    schedulePump();
  };

  const unsubscribe = deps.subscribe(listener);
  const stop = (() => {
    if (closed) return;
    closed = true;
    unsubscribe();
    queue.length = 0;
    stopActiveSend?.();
    stopActiveSend = undefined;
  }) as ConversationEventsHandle;
  stop.failure = (message: string) => {
    if (closed) return;
    const currentSeq = ++seq;
    const eventType = 'conversation.failure' as const;
    try {
      queue.push({ seq: currentSeq, type: eventType, text: encodeConversationEvent({ version: 1, type: eventType, seq: currentSeq, message, serverTime: now().toISOString() }) });
      schedulePump();
    } catch {
      safeLog({ seq: currentSeq, type: eventType }, 'invalid_payload');
    }
  };
  return stop;
}
