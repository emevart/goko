// ModeSwitch.tsx — «Голос / Чат» (D-0011). Выбор хранит prefs.ts, атрибут goko.mode выставляет useSession.
import type { Mode } from '../prefs.ts';

const MODES: Array<[Mode, string]> = [
  ['voice', 'Голос'],
  ['chat', 'Чат'],
];

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div className="seg mode-switch" role="group" aria-label="режим">
      {MODES.map(([m, label]) => (
        <button key={m} type="button" className="btn seg-btn" aria-pressed={m === mode} onClick={() => m !== mode && onChange(m)}>
          {label}
        </button>
      ))}
    </div>
  );
}
