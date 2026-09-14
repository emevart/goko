// Transcript.tsx — диалог «Ты / Гоко» (D-0011): реплики агента, финальные реплики человека и свои строки чата.
// notice — строка страницы под диалогом (Гоко вышел из комнаты), не реплика и в ленту не пишется.
import { useEffect, useRef } from 'react';
import type { Mode } from '../prefs.ts';
import type { Line } from '../transcript.ts';

const EMPTY: Record<Mode, string> = {
  voice: 'Здесь будет диалог с Гоко. Коснись экрана и скажи «давай партию».',
  chat: 'Здесь будет диалог с Гоко. Напиши ему внизу, например «давай партию».',
};

export function Transcript({ lines, mode, notice = null }: { lines: Line[]; mode: Mode; notice?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, notice]);
  return (
    <div ref={ref} className="transcript" aria-live="polite">
      {lines.length === 0 && !notice && <p className="muted">{EMPTY[mode]}</p>}
      {lines.map((l) => (
        <p key={l.id} className={`line line-${l.who}${l.final ? '' : ' line-partial'}`}>
          <span className="who">{l.who === 'me' ? 'Ты' : 'Гоко'}</span> {l.text}{l.error ? ' · поток оборван' : ''}
        </p>
      ))}
      {notice && <p className="notice">{notice}</p>}
    </div>
  );
}
