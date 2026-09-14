// Сессия Гоко на телефоне: сессия через game-server (sessionStorage), комната LiveKit по её токену, режим
// «Голос / Чат» атрибутом goko.mode, микрофон, чат и лента диалога. Комнат страница не создаёт (D-0001).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { CreateSessionResponse } from '@goko/protocol';
import { client } from '../api.ts';
import { agentReady, sendChat } from '../chat.ts';
import { type Mode, type Prefs, loadPrefs, modeAttributes, savePrefs } from '../prefs.ts';
import { describeError } from '../text.ts';
import { type Line, acceptLine, lineId, upsertLine, whoOf } from '../transcript.ts';

const STORAGE_KEY = 'goko.session';

export type MicState = 'off' | 'connecting' | 'on' | 'failed';
export type LinkState = 'idle' | 'connecting' | 'connected' | 'failed';

// Функцией: в Safari с запретом данных сайта исключение бросает уже обращение к localStorage (prefs.ts ловит).
const local = () => localStorage;

function loadStored(): CreateSessionResponse | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = CreateSessionResponse.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function saveStored(res: CreateSessionResponse | null) {
  try {
    if (res) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(res));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // приватный режим без storage — просто не запоминаем
  }
}

// getTrackPublications() типизирован базовым TrackPublication без setSubscribed (livekit-client 2.22.3),
// поэтому публикации удалённого участника — из Map trackPublications (RemoteTrackPublication).
function setRemoteAudio(room: Room, on: boolean) {
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      if (pub.kind === Track.Kind.Audio) pub.setSubscribed(on);
    }
  }
}

const chatLineId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function useSession() {
  const [info, setInfo] = useState<CreateSessionResponse | null>(loadStored);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [mic, setMic] = useState<MicState>('off');
  const [link, setLink] = useState<LinkState>('idle');
  const [agent, setAgent] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(local));
  const modeRef = useRef<Mode>(prefs.mode);
  const roomRef = useRef<Room | null>(null);
  const joining = useRef<Promise<Room | null> | null>(null);
  // Номер попытки входа: reset и размонтирование его меняют, и вход, начатый раньше, не трогает ни комнату, ни состояние.
  const generation = useRef(0);
  const creating = useRef(false);

  useEffect(() => {
    savePrefs(local, prefs);
  }, [prefs]);

  // Размонтирование: комнату не оставляем открытой; незавершённый вход увидит новый номер и отключится сам.
  useEffect(
    () => () => {
      generation.current++;
      const room = roomRef.current;
      roomRef.current = null;
      joining.current = null;
      void room?.disconnect();
    },
    [],
  );

  useEffect(() => {
    if (info || creating.current) return;
    creating.current = true;
    client
      .createSession()
      .then((res) => {
        saveStored(res);
        setInfo(res);
      })
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => {
        creating.current = false;
      });
  }, [info]);

  // Сессия истекла на сервере (SSE ответил not_found): комната тоже мертва — отключаемся и создаём новую.
  const reset = useCallback(() => {
    saveStored(null);
    generation.current++;
    const room = roomRef.current;
    roomRef.current = null;
    joining.current = null;
    void room?.disconnect();
    setMic('off');
    setLink('idle');
    setAgent(false);
    setLines([]);
    setInfo(null);
  }, []);

  const sendMode = useCallback(async (room: Room, mode: Mode) => {
    try {
      await room.localParticipant.setAttributes(modeAttributes(mode));
    } catch (e) {
      // Нет права canUpdateOwnMetadata или сервер не ответил: агент останется в прежнем режиме.
      console.warn('[!] web: не удалось выставить goko.mode', e);
    }
  }, []);

  // Вход в комнату, идемпотентный: повторные касания получают тот же промис.
  const connect = useCallback((): Promise<Room | null> => {
    if (!info) return Promise.resolve(null);
    if (joining.current) return joining.current;
    const gen = ++generation.current;
    const room = new Room();
    const audioHost = document.getElementById('audio') ?? document.body;
    const refreshAgent = () => setAgent([...room.remoteParticipants.values()].some((p) => agentReady(p.attributes)));
    room.on(RoomEvent.TrackSubscribed, (track, publication) => {
      if (track.kind !== Track.Kind.Audio) return;
      if (modeRef.current === 'voice') audioHost.appendChild(track.attach());
      else publication.setSubscribed(false); // «Чат»: звук агента не принимаем (запасной путь D-0011)
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const el of track.detach()) el.remove();
    });
    room.on(RoomEvent.ParticipantConnected, refreshAgent);
    room.on(RoomEvent.ParticipantDisconnected, refreshAgent);
    room.on(RoomEvent.ParticipantAttributesChanged, refreshAgent);
    // Только для вошедшей и не сброшенной комнаты: неудачный вход livekit тоже завершает событием Disconnected
    // (до отказа connect), а комната после reset не должна сбрасывать вход новой сессии.
    room.on(RoomEvent.Disconnected, () => {
      if (roomRef.current !== room) return;
      roomRef.current = null;
      joining.current = null;
      setLink('idle');
      setMic('off');
      setAgent(false);
    });
    // Регистрировать до connect: первые реплики агента приходят сразу после входа.
    room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
      const attrs = reader.info.attributes ?? {};
      const id = lineId(attrs, reader.info.id);
      const mySids = new Set(room.localParticipant.getTrackPublications().map((p) => p.trackSid));
      const who = whoOf(attrs, mySids, participant?.identity ?? '', room.localParticipant.identity);
      if (who === 'me') {
        // Человек: промежуточные результаты STT — отдельные закрытые потоки того же сегмента; берём только финал.
        const text = await reader.readAll();
        if (acceptLine(attrs, who) && text.trim()) setLines((ls) => upsertLine(ls, { id, who, text, final: true }));
        return;
      }
      // Гоко: дельта-поток, lk.transcription_final у него навсегда 'false' (agents 1.8.0) — финал = дочитанный поток.
      let text = '';
      for await (const chunk of reader) {
        text += chunk;
        setLines((ls) => upsertLine(ls, { id, who, text, final: false }));
      }
      setLines((ls) => upsertLine(ls, { id, who, text, final: true }));
    });
    setLink('connecting');
    const joined = (async (): Promise<Room | null> => {
      try {
        await room.connect(info.livekit.url, info.livekit.token);
      } catch (e) {
        if (generation.current !== gen) return null; // reset или размонтирование во время входа: состояние уже сброшено
        console.warn('[!] web: вход в комнату не удался', e);
        joining.current = null;
        void room.disconnect();
        // Токен мог истечь раньше продлённой сессии (D-0008): перезагрузка страницы создаст новую.
        saveStored(null);
        setLink('failed');
        setError('нет связи с Гоко: доска работает тапами, перезагрузи страницу, чтобы подключиться заново');
        return null;
      }
      if (generation.current !== gen) {
        void room.disconnect();
        return null;
      }
      roomRef.current = room;
      // Режим и звук — сразу после входа и одновременно: агент ждёт goko.mode перед приветствием не дольше 2 с,
      // а startAudio на iOS работает только недалеко от жеста. Отказ startAudio — не отказ связи: в «Чате» звук
      // не нужен, а в «Голосе» livekit сам повторяет startAudio при захвате микрофона.
      await Promise.all([
        sendMode(room, modeRef.current),
        room.startAudio().catch((e: unknown) => console.warn('[!] web: браузер не дал включить звук', e)),
      ]);
      if (roomRef.current !== room) return null;
      setLink('connected');
      refreshAgent();
      return room;
    })();
    joining.current = joined;
    return joined;
  }, [info, sendMode]);

  const enableMic = useCallback(async () => {
    const room = await connect();
    if (!room || modeRef.current !== 'voice') return;
    setMic('connecting');
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      setMic('on');
    } catch {
      setMic('failed');
      setError('не удалось включить микрофон: разреши его в браузере или переключись на «Чат»');
    }
  }, [connect]);

  // Первое касание страницы: вход в комнату; в «Голосе» — ещё и микрофон.
  const activate = useCallback(async () => {
    if (modeRef.current === 'voice') await enableMic();
    else await connect();
  }, [connect, enableMic]);

  const setMode = useCallback(
    async (mode: Mode) => {
      modeRef.current = mode;
      setPrefs((p) => ({ ...p, mode }));
      const room = await connect();
      if (!room) return;
      await sendMode(room, mode);
      if (mode === 'chat') {
        try {
          await room.localParticipant.setMicrophoneEnabled(false);
        } catch {
          // микрофона и не было
        }
        setMic('off');
        setRemoteAudio(room, false);
      } else {
        setRemoteAudio(room, true);
        await enableMic();
      }
    },
    [connect, sendMode, enableMic],
  );

  const updatePrefs = useCallback((patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })), []);

  // Отправка из поля ввода «Чата». Возвращает, что оставить в поле: '' после успеха, черновик при ошибке.
  const sendText = useCallback(
    async (draft: string): Promise<string> => {
      const room = await connect();
      if (!room) return draft;
      const res = await sendChat(draft, {
        send: (text) => room.localParticipant.sendText(text, { topic: 'lk.chat' }),
        id: chatLineId,
      });
      const line = res.line;
      if (line) setLines((ls) => upsertLine(ls, line));
      if (res.error) setError(res.error);
      return res.draft;
    },
    [connect],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    session: info?.session ?? null,
    lines,
    mic,
    link,
    agent,
    prefs,
    error,
    clearError,
    activate,
    enableMic,
    setMode,
    updatePrefs,
    sendText,
    reset,
  };
}
