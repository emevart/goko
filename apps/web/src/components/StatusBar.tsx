// StatusBar.tsx — чей ход, номер хода, ранг, пленные; при finished — результат; сообщения на 3 с;
// «Повторить» после retries_exhausted (D-0006): переоткрывает поток сессии.
// notice — постоянная фраза страницы (нет связи с Гоко, микрофон не разрешён) отдельной строкой под главной:
// «чей ход» и итог партии видны всегда, доска при этом работает тапами.
import type { GameState } from '@goko/protocol';
import { capturesText, rankText, statusText } from '../text.ts';

type Props = {
  state: GameState | null;
  thinking: boolean;
  message: string | null;
  notice: string | null;
  connected: boolean;
  retry: boolean;
  onRetry: () => void;
};

export function StatusBar({ state, thinking, message, notice, connected, retry, onRetry }: Props) {
  return (
    <div className="status">
      <div className="status-row">
        <div className="status-main">{message ?? statusText(state, thinking)}</div>
        {retry && (
          <button type="button" className="btn btn-inline btn-accent" onClick={onRetry}>
            Повторить
          </button>
        )}
      </div>
      {notice && <div className="status-notice">{notice}</div>}
      <div className="status-sub muted">
        {state ? `${rankText(state)} · ${capturesText(state)}` : ''}
        {!connected && state ? ' · нет связи, переподключаюсь' : ''}
      </div>
    </div>
  );
}
