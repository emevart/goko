// Controls.tsx — «Микрофон» крупно, только в «Голосе» (повтор после отказа; первое касание страницы включает его само),
// остальные мелко. Цели ≥ 44 px.
import { useEffect, useState } from 'react';
import type { MicState } from '../hooks/useSession.ts';
import type { Mode } from '../prefs.ts';

type Props = {
  mode: Mode;
  mic: MicState;
  canAct: boolean;
  onMic: () => void;
  onPass: () => void;
  onResign: () => void;
  onUndo: () => void;
};

const MIC_LABEL: Record<MicState, string> = { off: 'Микрофон', connecting: 'Подключаю…', on: 'Микрофон включён', failed: 'Микрофон: ещё раз' };

export function Controls({ mode, mic, canAct, onMic, onPass, onResign, onUndo }: Props) {
  const [armed, setArmed] = useState(false); // «Сдаться» — двумя касаниями за 3 с
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const resign = () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    onResign();
  };
  return (
    <div className="controls">
      {mode === 'voice' && (
        <button type="button" className="btn btn-mic" onClick={onMic} disabled={mic === 'connecting' || mic === 'on'}>
          {MIC_LABEL[mic]}
        </button>
      )}
      <div className="controls-row">
        <button type="button" className="btn" onClick={onPass} disabled={!canAct}>Пас</button>
        <button type="button" className="btn" onClick={resign} disabled={!canAct}>{armed ? 'Точно?' : 'Сдаться'}</button>
        <button type="button" className="btn" onClick={onUndo} disabled={!canAct}>Отменить</button>
      </div>
    </div>
  );
}
