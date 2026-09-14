// NewGame.tsx — «Новая партия» (D-0011): перед стартом цвет человека и ранг Гоко тапом, выбор помнится (prefs.ts).
// Форы в NewGameRequest нет, поэтому здесь только цвет и ранг.
import { useState } from 'react';
import { type ColorChoice, type Prefs, stepRank } from '../prefs.ts';

type Props = { prefs: Prefs; onChange: (patch: Partial<Prefs>) => void; onStart: () => void };

const COLORS: Array<[ColorChoice, string]> = [
  ['black', 'Чёрные'],
  ['white', 'Белые'],
  ['random', 'Случайно'],
];

export function NewGame({ prefs, onChange, onStart }: Props) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Новая партия
      </button>
    );
  }
  return (
    <div className="newgame">
      <div className="muted">Ты играешь</div>
      <div className="seg" role="group" aria-label="цвет">
        {COLORS.map(([c, label]) => (
          <button key={c} type="button" className="btn seg-btn" aria-pressed={prefs.color === c} onClick={() => onChange({ color: c })}>
            {label}
          </button>
        ))}
      </div>
      <div className="muted">Уровень Гоко</div>
      <div className="rank-row">
        <button type="button" className="btn btn-square" aria-label="слабее" disabled={prefs.rank === '20k'} onClick={() => onChange({ rank: stepRank(prefs.rank, -1) })}>
          −
        </button>
        <div className="rank-value">{prefs.rank}</div>
        <button type="button" className="btn btn-square" aria-label="сильнее" disabled={prefs.rank === '9d'} onClick={() => onChange({ rank: stepRank(prefs.rank, 1) })}>
          +
        </button>
      </div>
      <div className="controls-row">
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => {
            setOpen(false);
            onStart();
          }}
        >
          Начать
        </button>
      </div>
    </div>
  );
}
