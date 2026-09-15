// Верхние действия партии. Сдача подтверждается вторым касанием; цели не меньше 44 px.
import { useEffect, useState } from 'react';
type Props = {
  canPlay: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canResign: boolean;
  onPass: () => void;
  onResign: () => void;
  onUndo: () => void;
  onRedo: () => void;
};
export function Controls({ canPlay, canUndo, canRedo, canResign, onPass, onResign, onUndo, onRedo }: Props) {
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
    <div className="controls-row game-actions">
      <button type="button" className="btn" onClick={onUndo} disabled={!canUndo} aria-label="назад, отменить ход">← Назад</button>
      <button type="button" className="btn" onClick={onRedo} disabled={!canRedo} aria-label="вперёд, вернуть ход">Вперёд →</button>
      <button type="button" className="btn" onClick={onPass} disabled={!canPlay}>Пас</button>
      <button type="button" className="btn" onClick={resign} disabled={!canResign}>{armed ? 'Точно?' : 'Сдаться'}</button>
    </div>
  );
}
