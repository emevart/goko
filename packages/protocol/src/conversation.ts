import { z } from 'zod';

export const CONVERSATION_TOPIC = 'goko.conversation';
export const CONVERSATION_EVENT_MAX_BYTES = 32 * 1024;

export const AssistantResponseFinished = z.strictObject({
  version: z.literal(1),
  type: z.literal('assistant.response_finished'),
  seq: z.number().int().positive(),
  // ID сообщения AgentSession; это не lk.segment_id встроенного потока транскрипции.
  itemId: z.string().min(1).max(128),
  text: z.string().max(24_000),
  interrupted: z.boolean(),
  serverTime: z.iso.datetime(),
});
export const ConversationFailure = z.strictObject({
  version: z.literal(1),
  type: z.literal('conversation.failure'),
  seq: z.number().int().positive(),
  message: z.string().min(1).max(500),
  serverTime: z.iso.datetime(),
});

export const ConversationEvent = z.discriminatedUnion('type', [AssistantResponseFinished, ConversationFailure]);
export type ConversationEvent = z.infer<typeof ConversationEvent>;

export function encodeConversationEvent(value: unknown): string {
  const json = JSON.stringify(ConversationEvent.parse(value));
  if (new TextEncoder().encode(json).byteLength > CONVERSATION_EVENT_MAX_BYTES) {
    throw new Error(`событие разговора слишком велико: максимум ${CONVERSATION_EVENT_MAX_BYTES} байт`);
  }
  return json;
}
