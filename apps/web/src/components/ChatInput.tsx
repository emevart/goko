// ChatInput.tsx — поле ввода «Чата» (D-0011): Enter или «Отправить» -> lk.chat через useSession.sendText.
// Логика отправки и её тесты — chat.ts; до готовности агента кнопка выключена.
// gone — агент ушёл из комнаты (подсказка в ленте): поле не обещает, что Гоко подключается.
import { useState } from 'react';
import type { FormEvent } from 'react';
import { CHAT_MAX_CHARS } from '../chat.ts';

type Props = { ready: boolean; gone?: boolean; onSend: (draft: string) => Promise<string> };

export function ChatInput({ ready, gone = false, onSend }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    try {
      setDraft(await onSend(draft));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="chat-input" onSubmit={(e) => void submit(e)}>
      <input
        className="chat-field"
        value={draft}
        readOnly={busy}
        maxLength={CHAT_MAX_CHARS}
        enterKeyHint="send"
        aria-label="сообщение Гоко"
        placeholder={ready ? 'Напиши Гоко' : gone ? 'Гоко вышел из комнаты' : 'Гоко подключается…'}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="submit" className="btn btn-inline btn-accent" disabled={!ready || busy || !draft.trim()}>
        Отправить
      </button>
    </form>
  );
}
