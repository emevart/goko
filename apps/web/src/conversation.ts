import { ConversationEvent } from '@goko/protocol';

export type AgentBinding = {
  generation: number;
  identity: string;
  sid: string;
  lastConversationSeq: number;
};

export type ParticipantRef = { identity: string; sid: string; kind: number };

export function bindAgent(generation: number, participants: Iterable<ParticipantRef>, agentKind: number): AgentBinding | null {
  const participant = [...participants].find((item) => item.kind === agentKind);
  return participant ? { generation, identity: participant.identity, sid: participant.sid, lastConversationSeq: 0 } : null;
}

export function isBoundAgent(binding: AgentBinding | null, generation: number, participant: ParticipantRef | undefined): boolean {
  return Boolean(
    binding && participant && binding.generation === generation && participant.identity === binding.identity && participant.sid === binding.sid,
  );
}

export function acceptConversationEvent(binding: AgentBinding | null, generation: number, participant: ParticipantRef | undefined, raw: string) {
  if (!isBoundAgent(binding, generation, participant) || !binding) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ConversationEvent.safeParse(value);
  if (!parsed.success || parsed.data.seq <= binding.lastConversationSeq) return null;
  binding.lastConversationSeq = parsed.data.seq;
  return parsed.data;
}
