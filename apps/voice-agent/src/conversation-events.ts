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

export function attachConversationEvents(deps: {
  subscribe: (listener: (event: { item: ConversationItem }) => void) => () => void;
  sendText: SendText;
  destinationIdentity: string;
  now?: () => Date;
  log?: (line: string) => void;
}): () => void {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let seq = 0;
  let pending = Promise.resolve<unknown>(undefined);

  const listener = (event: { item: ConversationItem }) => {
    const item = event.item;
    if (item.type !== 'message' || item.role !== 'assistant' || typeof item.id !== 'string' || typeof item.textContent !== 'string') return;
    const currentSeq = ++seq;
    pending = pending
      .then(() => encodeConversationEvent({
        version: 1,
        type: 'assistant.response_finished',
        seq: currentSeq,
        itemId: item.id,
        text: item.textContent,
        interrupted: item.interrupted === true,
        serverTime: now().toISOString(),
      }))
      .then((text) => deps.sendText(text, { topic: CONVERSATION_TOPIC, destinationIdentities: [deps.destinationIdentity] }))
      .catch((error: unknown) => log(`[!] voice-agent: событие разговора не отправлено: ${error instanceof Error ? error.message : String(error)}`));
  };

  return deps.subscribe(listener);
}
