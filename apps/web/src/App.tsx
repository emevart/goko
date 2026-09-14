// App.tsx — одна страница: режим, статус, доска, кнопки, новая партия, лента, поле чата.
// Без агента в комнате всё, кроме ленты и чата, работает тапами.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Board } from './components/Board.tsx';
import { ChatInput } from './components/ChatInput.tsx';
import { Controls } from './components/Controls.tsx';
import { ModeSwitch } from './components/ModeSwitch.tsx';
import { NewGame } from './components/NewGame.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Transcript } from './components/Transcript.tsx';
import { useGame } from './hooks/useGame.ts';
import { useSession } from './hooks/useSession.ts';
import { useWakeLock } from './hooks/useWakeLock.ts';

// Агент ждёт возврата телефона 15 минут и уходит из комнаты; в эту сессию его повторно не позвать.
// 15 с без агента в подключённой комнате — не переподключение агента, а уход.
const AGENT_GONE_MS = 15_000;
const AGENT_GONE_TEXT = 'Гоко вышел из комнаты: доска работает тапами. Чтобы снова говорить с Гоко, открой страницу в новой вкладке.';
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
    // без storage подсказка работает до перезагрузки вкладки
  }
}

// Подсказка «Гоко вышел»: комната подключена, агент в этой сессии уже был, а сейчас его нет дольше AGENT_GONE_MS.
// Без воркера (агента не было ни разу) подсказки нет: там поле «Гоко подключается…».
function useAgentGone(sessionId: string | null, connected: boolean, agent: boolean): boolean {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (sessionId && agent) saveAgentSeen(sessionId);
    setGone(false);
    if (!sessionId || !connected || agent || loadAgentSeen() !== sessionId) return;
    const t = setTimeout(() => setGone(true), AGENT_GONE_MS);
    return () => clearTimeout(t);
  }, [sessionId, connected, agent]);
  return gone;
}

// Страница пересоздаётся целиком (key), когда сессию нужно создать заново: после потери сессии (SSE not_found) и по
// касанию после отказа создания. useSession создаёт сессию при монтировании, если сохранённой нет, поэтому в свежем
// экземпляре «сессии нет, а ошибка есть» значит «создание не удалось», а не «ещё создаётся», и касание
// не отправит второй запрос, пока первый в пути. Блокировка экрана живёт выше и пересоздание переживает.
export function App() {
  const [epoch, setEpoch] = useState(0);
  const renew = useCallback(() => setEpoch((n) => n + 1), []);
  const keepAwake = useWakeLock();
  return <Page key={epoch} renew={renew} keepAwake={keepAwake} />;
}

function Page({ renew, keepAwake }: { renew: () => void; keepAwake: () => void }) {
  const s = useSession();
  const { reset, clearError, link, mic, agent } = s;
  const sessionId = s.session?.id ?? null;
  // Сессия истекла на сервере: reset стирает её из sessionStorage и отключает комнату, renew пересоздаёт страницу.
  // Оба вызова синхронно в одном обработчике: React объединяет обновления, старый экземпляр не начнёт создание сам.
  // onLost стабилен (reset и renew — useCallback): иначе useGame переоткрывал бы поток на каждом рендере.
  const onLost = useCallback(() => {
    reset();
    renew();
  }, [reset, renew]);
  const g = useGame(sessionId, onLost);
  const size = g.state?.settings.boardSize ?? 13;
  const activating = useRef(false);
  const agentGone = useAgentGone(sessionId, link === 'connected', agent);

  // Ошибка связи с комнатой или микрофона уходит из статуса, когда причина прошла: вошли в комнату и микрофон
  // не в отказе. Иначе фраза «нет связи с Гоко…» закрывала бы «чей ход» до перезагрузки.
  useEffect(() => {
    if (link === 'connected' && mic !== 'failed') clearError();
  }, [link, mic, clearError]);

  // Касание страницы: блокировка экрана; пока комната не подключена — вход (startAudio на iOS — только из жеста),
  // в «Голосе» ещё и микрофон. Касание во время входа ничего не добавляет: вход и микрофон уже в пути.
  // Касание переключателя режима не считается: setMode сам входит в комнату и включает нужное.
  const onTouch = (e: PointerEvent<HTMLDivElement>) => {
    keepAwake();
    if (!s.session) {
      if (s.error) renew(); // создание сессии не удалось — касание пробует снова
      return;
    }
    if (link === 'connected' || activating.current) return;
    if (e.target instanceof Element && e.target.closest('.mode-switch')) return;
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

  return (
    <div className="app" onPointerDownCapture={onTouch}>
      <div className="top-row">
        <ModeSwitch mode={s.prefs.mode} onChange={(m) => void s.setMode(m)} />
      </div>
      <StatusBar state={g.state} thinking={g.thinking} message={g.message ?? s.error} connected={g.connected} retry={g.retry} onRetry={g.reopen} />
      <Board state={g.state} size={size} onTap={(coord) => void g.play(coord)} />
      <Controls
        mode={s.prefs.mode}
        mic={mic}
        canAct={g.state?.status === 'playing'}
        onMic={() => void s.enableMic()}
        onPass={() => void g.pass()}
        onResign={() => void g.resign()}
        onUndo={() => void g.undo()}
      />
      <NewGame prefs={s.prefs} onChange={s.updatePrefs} onStart={() => void g.newGame(s.prefs)} />
      <Transcript lines={s.lines} mode={s.prefs.mode} notice={agentGone ? AGENT_GONE_TEXT : null} />
      {s.prefs.mode === 'chat' && <ChatInput ready={agent} onSend={onSend} />}
      <div id="audio" hidden />
    </div>
  );
}
