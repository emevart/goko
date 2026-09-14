// Режим «Чат» (D-0011): логика формы ввода без React и LiveKit. send — localParticipant.sendText в lk.chat;
// своя строка добавляется в ленту здесь, потому что lk.chat отправителю не возвращается.
import type { Line } from './transcript.ts';

export const CHAT_MAX_CHARS = 500;

export type ChatDeps = { send: (text: string) => Promise<unknown>; id: () => string };
export type ChatResult = { draft: string; line: Line | null; error: string | null };

export async function sendChat(draft: string, deps: ChatDeps): Promise<ChatResult> {
  const text = draft.trim();
  if (!text) return { draft: '', line: null, error: null };
  if (text.length > CHAT_MAX_CHARS) return { draft, line: null, error: `слишком длинно: не больше ${CHAT_MAX_CHARS} знаков` };
  try {
    await deps.send(text);
    return { draft: '', line: { id: deps.id(), who: 'me', text, final: true }, error: null };
  } catch {
    return { draft, line: null, error: 'не удалось отправить: нет связи с Гоко' };
  }
}

// Агент в комнате и слушает: атрибут lk.agent.state выставляет RoomIO @livekit/agents 1.8
// (initializing, idle, listening, thinking, speaking). До этого текст в lk.chat некому принять.
export function agentReady(attrs: Readonly<Record<string, string>> | undefined): boolean {
  const state = attrs?.['lk.agent.state'];
  return state !== undefined && state !== 'initializing';
}
