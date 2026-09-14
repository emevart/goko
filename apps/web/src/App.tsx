// App.tsx — одна страница: режим, статус, доска, кнопки, новая партия, лента, поле чата.
// Без агента в комнате всё, кроме ленты и чата, работает тапами.
import { useEffect, useRef, useState } from 'react';
import { Board } from './components/Board.tsx';
import { ChatInput } from './components/ChatInput.tsx';
import { Controls } from './components/Controls.tsx';
import { NewGame } from './components/NewGame.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Transcript } from './components/Transcript.tsx';
import { VoiceOrb } from './components/VoiceOrb.tsx';
import { MoveHistory } from './components/MoveHistory.tsx';
import { DiagnosticRecording } from './components/DiagnosticRecording.tsx';
import { useGame } from './hooks/useGame.ts';
import { useSession } from './hooks/useSession.ts';
import { useWakeLock } from './hooks/useWakeLock.ts';
import { AGENT_HINT_TEXT, type AgentHint, agentHintTimer } from './agent.ts';

const AGENT_SEEN_KEY = 'goko.agentSeen';

// Был ли агент в комнате этой сессии: хранится рядом с сессией (sessionStorage) и переживает перезагрузку вкладки.
function loadAgentSeen(): string | null {
  try {
    return sessionStorage.getItem(AGENT_SEEN_KEY);
  } catch {
    return null;
  }
}

function saveAgentSeen(sessionId: string) {
  try {
    sessionStorage.setItem(AGENT_SEEN_KEY, sessionId);
  } catch {
    // без storage отметку держит ref в useAgentHint — до перезагрузки вкладки
  }
}

// Подсказка об агенте (agent.ts): «Гоко вышел» — агент в сессии был и ушёл, «Гоко не пришёл» — комната подключена,
// а агента в сессии ещё не было. Появление агента снимает подсказку сразу; отсчёт перезапускается при каждой смене
// подключения, агента или сессии.
function useAgentHint(sessionId: string | null, connected: boolean, agent: boolean): AgentHint | null {
  const [hint, setHint] = useState<AgentHint | null>(null);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (sessionId && agent) {
      seen.current = sessionId;
      saveAgentSeen(sessionId);
    }
    setHint(null);
    if (!sessionId) return;
    const wait = agentHintTimer(connected, agent, seen.current === sessionId || loadAgentSeen() === sessionId);
    if (!wait) return;
    const t = setTimeout(() => setHint(wait.hint), wait.ms);
    return () => clearTimeout(t);
  }, [sessionId, connected, agent]);
  return hint;
}

export function App() {
  const s = useSession();
  const { clearError, link, mic, agent } = s;
  const sessionId = s.session?.id ?? null;
  // onLost стабилен (reset — useCallback без зависимостей): иначе useGame переоткрывал бы поток на каждом рендере.
  const g = useGame(sessionId, s.reset, s.trace);
  const size = g.state?.settings.boardSize ?? 13;
  const keepAwake = useWakeLock();
  const activating = useRef(false);
  const agentHint = useAgentHint(sessionId, link === 'connected', agent);

  // Ошибка связи с комнатой или микрофона уходит, когда причина прошла: вошли в комнату и микрофон не в отказе.
  useEffect(() => {
    if (link === 'connected' && mic !== 'failed') clearError();
  }, [link, mic, clearError]);

  // Касание страницы: блокировка экрана. Без сессии (создание не удалось) — повтор создания, в том числе касанием
  // переключателя; второй запрос, пока первый в пути, не уходит (ref creating в useSession). Пока комната не
  // подключена — вход (startAudio на iOS — только из жеста), в «Голосе» ещё и микрофон; касание во время входа
  // ничего не добавляет. Касание переключателя режима вход не запускает: setMode сам входит и включает нужное.
  const onTouch = () => {
    keepAwake();
    if (!s.session) {
      void s.activate();
      return;
    }
    if (link === 'connected' || activating.current) return;
    activating.current = true;
    void s.activate().finally(() => {
      activating.current = false;
    });
  };

  const onSend = async (draft: string): Promise<string> => {
    const rest = await s.sendText(draft);
    if (draft.trim() && rest === '') clearError(); // отправлено: прежняя ошибка отправки уже не про сейчас
    return rest;
  };

  useEffect(() => {
    if (!g.state) return;
    s.trace('game.state', { gameId: g.state.id, revision: g.state.revision, moves: g.state.moves.length, pendingEngineMove: g.state.pendingEngineMove, status: g.state.status });
  }, [g.state, s.trace]);

  return (
    <div className="app" onPointerDownCapture={onTouch}>
      <header className="app-header">
        <h1>Гоко</h1>
        <NewGame prefs={s.prefs} onChange={s.updatePrefs} onStart={() => void g.newGame(s.prefs)} />
      </header>
      <Controls canPlay={g.state?.status === 'playing'} canUndo={g.canUndo} canRedo={g.canRedo} canResign={g.canResign} onPass={() => void g.pass()} onResign={() => void g.resign()} onUndo={() => void g.undo()} onRedo={() => void g.redo()} />
      {g.mutating && <div className="mutation-busy" role="status">Изменяю позицию…</div>}
      <main className="main-grid">
        <section className="board-column" aria-label="партия">
          <StatusBar state={g.state} thinking={g.thinking} message={g.message} notice={s.error} connected={g.connected} retry={g.retry} onRetry={g.reopen} />
          <Board state={g.state} size={size} onTap={(coord) => void g.play(coord)} />
          <MoveHistory state={g.state} />
        </section>
        <section className="conversation" aria-label="разговор с Гоко">
          <VoiceOrb link={link} mic={mic} agentPresent={s.agentPresent} agentState={s.agentState} amplitude={s.amplitude} />
          {s.audioPlaybackError && <div className="playback-error">{s.audioPlaybackError} <button type="button" className="btn btn-inline btn-accent" onClick={() => void s.retryAudio()}>Включить звук</button></div>}
          <Transcript lines={s.lines} mode={s.prefs.mode} notice={agentHint ? AGENT_HINT_TEXT[agentHint] : null} />
          <div className="conversation-input-row">
            <button type="button" className={`btn voice-button${s.prefs.mode === 'voice' && mic === 'on' ? ' voice-button-on' : ''}`} onClick={() => void s.toggleVoice()} disabled={mic === 'connecting'} aria-pressed={s.prefs.mode === 'voice' && mic === 'on'}>
              {mic === 'connecting' ? 'Подключаю…' : s.prefs.mode === 'voice' && mic === 'on' ? 'Выключить голос' : mic === 'failed' ? 'Повторить голос' : 'Включить голос'}
            </button>
            <ChatInput ready={agent} hint={agentHint} onSend={onSend} />
          </div>
          <DiagnosticRecording snapshot={s.recording} supported={typeof MediaRecorder !== 'undefined'} onStart={s.startRecording} onStop={() => void s.stopRecording()} onDelete={s.deleteRecording} />
        </section>
      </main>
      <div id="audio" hidden />
    </div>
  );
}
