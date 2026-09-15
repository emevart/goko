// ChatInput.tsx — поле ввода «Чата» (D-0011): Enter или «Отправить» -> lk.chat через useSession.sendText.
// Логика отправки и её тесты — chat.ts; первая отправка сама запускает чат и ограниченно ждёт агента.
// hint — подсказка об агенте в ленте («Гоко вышел», «Гоко не пришёл»): поле не обещает, что Гоко подключается.
import { useState } from 'react';
import type { FormEvent } from 'react';
import { type AgentHint, chatPlaceholder } from '../agent.ts';
import { CHAT_MAX_CHARS } from '../chat.ts';

type Props = { ready: boolean; active?: boolean; hint?: AgentHint | null; onSend: (draft: string) => Promise<string>; voiceActive?: boolean; voiceConnecting?: boolean; onVoice?: () => void };

export function ChatInput({ ready, active = true, hint = null, onSend, voiceActive, voiceConnecting, onVoice }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      setDraft(await onSend(draft));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="chat-input" onSubmit={(e) => void submit(e)}>
      <textarea
        className="chat-field"
        value={draft}
        readOnly={busy}
        maxLength={CHAT_MAX_CHARS}
        enterKeyHint="send"
        aria-label="сообщение Гоко"
        rows={1}
        placeholder={chatPlaceholder(ready, hint, active)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      {draft.trim() ? <button type="submit" className="btn btn-square btn-accent" aria-label="Отправить сообщение" disabled={busy}>↑</button> : null}
      {onVoice && <button type="button" className={`btn btn-square ${voiceActive ? 'btn-accent' : ''}`} aria-label={voiceActive ? 'Выйти из голосового разговора' : 'Говорить с Гоко'} aria-pressed={voiceActive === true} disabled={voiceConnecting} onClick={onVoice}>
        {voiceActive ? '×' : <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6M8 5v14M12 2v20M16 6v12M20 9v6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>}
      </button>}
    </form>
  );
}
