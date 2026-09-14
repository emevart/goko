import type { RecordingSnapshot } from '../recording.ts';

const duration = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const bytes = (size: number) => size < 1024 * 1024 ? `${Math.ceil(size / 1024)} КиБ` : `${(size / 1024 / 1024).toFixed(1)} МиБ`;

export function DiagnosticRecording({ snapshot, supported, onStart, onStop, onDelete }: { snapshot: RecordingSnapshot; supported: boolean; onStart: () => void; onStop: () => void; onDelete: () => void }) {
  const result = snapshot.result;
  return (
    <details className="diagnostic" open={snapshot.phase === 'recording' || snapshot.phase === 'stopping' || snapshot.phase === 'ready'}>
      <summary>Записать для диагностики</summary>
      <p className="muted diagnostic-note">Две дорожки хранятся только в памяти этого браузера и пропадут после перезагрузки. На сервер они не отправляются.</p>
      {snapshot.phase === 'recording' || snapshot.phase === 'stopping' ? (
        <div className="recording-active" role="status">
          <span className="recording-dot" aria-hidden="true" />
          <span>{snapshot.phase === 'stopping' ? 'Сохраняю…' : `Запись ${duration(snapshot.elapsedMs)} · ${bytes(snapshot.bytes)}`}</span>
          <button type="button" className="btn btn-inline" disabled={snapshot.phase === 'stopping'} onClick={onStop}>Остановить</button>
        </div>
      ) : result ? (
        <div className="recording-result">
          <p>{result.partial ? 'Частичная запись' : 'Запись готова'} · {duration(result.durationMs)} · {bytes(result.totalBytes)} · причина: {result.stopReason}</p>
          <div className="download-row">
            <a className="btn link-btn" href={result.mic.url} download={`goko-microphone.${result.mic.mimeType.includes('mp4') ? 'm4a' : 'webm'}`}>Микрофон</a>
            <a className="btn link-btn" href={result.agent.url} download={`goko-agent.${result.agent.mimeType.includes('mp4') ? 'm4a' : 'webm'}`}>Гоко</a>
            <a className="btn link-btn" href={result.manifest.url} download="goko-diagnostic.json">Журнал</a>
          </div>
          <button type="button" className="btn" onClick={onDelete}>Удалить из памяти</button>
        </div>
      ) : supported ? (
        <button type="button" className="btn" onClick={onStart}>Начать запись</button>
      ) : (
        <p className="status-notice">Этот браузер не поддерживает локальную запись MediaRecorder.</p>
      )}
      {snapshot.error && <p className="status-notice">{snapshot.error}</p>}
    </details>
  );
}
