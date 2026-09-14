// Сессия Гоко на телефоне: сессия через game-server (sessionStorage), комната LiveKit по её токену, режим
// «Голос / Чат» атрибутом goko.mode, микрофон, чат и лента диалога. Комнат страница не создаёт (D-0001).
import { useCallback, useEffect, useRef, useState } from 'react';
import { ParticipantKind, Room, RoomEvent, Track } from 'livekit-client';
import { CONVERSATION_TOPIC, CreateSessionResponse } from '@goko/protocol';
import { client } from '../api.ts';
import { agentReady, sendChat } from '../chat.ts';
import { type Mode, type Prefs, loadPrefs, modeAttributes, savePrefs } from '../prefs.ts';
import { describeError } from '../text.ts';
import { type Line, acceptLine, isTrustedTranscriptSender, lineId, upsertLine, whoOf } from '../transcript.ts';
import { connectionFailureAction } from '../session-connection.ts';
import { acceptConversationEvent, bindAgent, isBoundAgent, participantRefOf, type AgentBinding } from '../conversation.ts';
import { DiagnosticRecorder, watchTrackEnd, type RecorderTrack, type RecordingSnapshot, type RecordingStopReason } from '../recording.ts';

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
function setRemoteAudio(room: Room, on: boolean, agentIdentity: string | null) {
  for (const p of room.remoteParticipants.values()) {
    if (p.identity !== agentIdentity || p.kind !== ParticipantKind.AGENT) continue;
    for (const pub of p.trackPublications.values()) {
      if (pub.kind === Track.Kind.Audio) pub.setSubscribed(on);
    }
  }
}

// Вход отклонён сервером LiveKit: токен истёк или неверен (401/403 при проверке соединения) либо комнаты сессии
// уже нет (404 «requested room does not exist») — livekit-client 2.22.3 даёт на всё это NotAllowed. С тем же токеном
// повтор бесполезен. Прочие причины (сеть, таймаут ICE, отмена) — временные: сессия остаётся, повтор по касанию.
const chatLineId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function useSession() {
  const [info, setInfo] = useState<CreateSessionResponse | null>(loadStored);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [mic, setMic] = useState<MicState>('off');
  const [link, setLink] = useState<LinkState>('idle');
  const [agent, setAgent] = useState(false);
  const [agentPresent, setAgentPresent] = useState(false);
  const [agentState, setAgentState] = useState<string>('connecting');
  const [amplitude, setAmplitude] = useState(0);
  const [audioPlaybackError, setAudioPlaybackError] = useState<string | null>(null);
  const recorderRef = useRef(new DiagnosticRecorder());
  const [recording, setRecording] = useState<RecordingSnapshot>(recorderRef.current.getSnapshot());
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(local));
  const modeRef = useRef<Mode>(prefs.mode);
  const roomRef = useRef<Room | null>(null);
  const joining = useRef<Promise<Room | null> | null>(null);
  // Номер попытки входа: reset и размонтирование его меняют, и вход, начатый раньше, не трогает ни комнату, ни состояние.
  const generation = useRef(0);
  const creating = useRef(false);
  const agentBinding = useRef<AgentBinding | null>(null);
  const micTrack = useRef<RecorderTrack | null>(null);
  const remoteAgentTrack = useRef<RecorderTrack | null>(null);
  const stopMeter = useRef<(() => void) | null>(null);

  useEffect(() => recorderRef.current.subscribe(setRecording), []);

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
      stopMeter.current?.();
      void recorderRef.current.dispose().finally(() => room?.disconnect());
    },
    [],
  );

  // Создание сессии. Один запрос за раз (ref creating): эффект и касание страницы после отказа (activate)
  // не шлют второй, пока первый в пути. Старая фраза ошибки уходит сразу, чтобы не висеть над новой попыткой.
  const create = useCallback(() => {
    if (creating.current) return;
    creating.current = true;
    setError(null);
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
  }, []);

  // Без сессии при монтировании и после reset. После отказа сам не повторяет: повтор — касанием (activate).
  useEffect(() => {
    if (!info) create();
  }, [info, create]);

  // Сессия истекла на сервере (SSE ответил not_found): комната тоже мертва — отключаемся и создаём новую.
  const reset = useCallback(() => {
    saveStored(null);
    generation.current++;
    const room = roomRef.current;
    roomRef.current = null;
    joining.current = null;
    agentBinding.current = null;
    micTrack.current = null;
    remoteAgentTrack.current = null;
    stopMeter.current?.();
    stopMeter.current = null;
    setAmplitude(0);
    void recorderRef.current.stop('disconnect').finally(() => room?.disconnect());
    setMic('off');
    setLink('idle');
    setAgent(false);
    setAgentPresent(false);
    setAgentState('connecting');
    setLines([]);
    setError(null); // фраза прежней сессии не должна висеть над новой до входа в комнату
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
    const current = () => generation.current === gen;
    // stopMicTrackOnMute: в «Чате» setMicrophoneEnabled(false) останавливает захват, а не только глушит трек,
    // иначе индикатор микрофона телефона горит, а Bluetooth-гарнитура остаётся в HFP.
    const room = new Room({ publishDefaults: { stopMicTrackOnMute: true } });
    // Отмена чтения текстовых потоков при отключении: livekit при разрыве комнаты читателей не закрывает,
    // и for await висел бы вечно, держа старую комнату, а строка Гоко оставалась бы незаконченной.
    const streams = new AbortController();
    const audioHost = document.getElementById('audio') ?? document.body;
    const streamSender = (participant: { identity: string }) => participantRefOf(participant, (identity) => {
      const found = room.remoteParticipants.get(identity);
      return found ? { identity: found.identity, sid: found.sid, kind: found.kind } : undefined;
    });
    const refreshAgent = () => {
      const participants = [...room.remoteParticipants.values()].map((p) => ({ identity: p.identity, sid: p.sid, kind: p.kind }));
      const old = agentBinding.current;
      const stillPresent = old && participants.some((p) => isBoundAgent(old, gen, p));
      const next = stillPresent ? old : bindAgent(gen, participants, ParticipantKind.AGENT);
      if (old && next?.sid !== old.sid && recorderRef.current.getSnapshot().phase === 'recording') void recorderRef.current.stop('track-change');
      agentBinding.current = next;
      const p = next ? room.remoteParticipants.get(next.identity) : undefined;
      setAgentPresent(Boolean(p));
      setAgent(Boolean(p && agentReady(p.attributes)));
      setAgentState(p?.attributes['lk.agent.state'] ?? (p ? 'initializing' : 'connecting'));
      if (!p) remoteAgentTrack.current = null;
    };
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      refreshAgent();
      if (!isBoundAgent(agentBinding.current, gen, { identity: participant.identity, sid: participant.sid, kind: participant.kind })) {
        publication.setSubscribed(false);
        return;
      }
      if (remoteAgentTrack.current && remoteAgentTrack.current.id !== track.mediaStreamTrack.id && recorderRef.current.getSnapshot().phase === 'recording') {
        void recorderRef.current.stop('track-change');
      }
      remoteAgentTrack.current = track.mediaStreamTrack;
      if (modeRef.current === 'voice') {
        const element = track.attach();
        for (const type of ['play', 'playing', 'pause', 'waiting', 'stalled', 'error'] as const) {
          element.addEventListener(type, () => {
            recorderRef.current.trace(`player.${type}`);
            if (type === 'error') setAudioPlaybackError('звук Гоко не воспроизводится');
          });
        }
        audioHost.appendChild(element);
      }
      else publication.setSubscribed(false); // «Чат»: звук агента не принимаем (запасной путь D-0011)
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (remoteAgentTrack.current?.id === track.mediaStreamTrack.id) {
        if (recorderRef.current.getSnapshot().phase === 'recording') void recorderRef.current.stop('track-change');
        remoteAgentTrack.current = null;
      }
      for (const el of track.detach()) el.remove();
    });
    room.on(RoomEvent.ParticipantConnected, refreshAgent);
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (agentBinding.current?.sid === participant.sid) {
        if (recorderRef.current.getSnapshot().phase === 'recording') void recorderRef.current.stop('track-change');
        agentBinding.current = null;
        remoteAgentTrack.current = null;
      }
      refreshAgent();
    });
    room.on(RoomEvent.ParticipantAttributesChanged, (_attrs, participant) => {
      refreshAgent();
      if (agentBinding.current?.sid === participant.sid) setAgentState(participant.attributes['lk.agent.state'] ?? 'initializing');
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
      recorderRef.current.trace('room.audio-playback', { playing });
      if (!playing) setAudioPlaybackError('браузер остановил звук Гоко');
    });
    // Полное переподключение LiveKit: режим, выставленный во время разрыва, мог не дойти до агента — отправляем снова.
    room.on(RoomEvent.Reconnected, () => {
      recorderRef.current.trace('room.reconnected');
      if (roomRef.current === room) void sendMode(room, modeRef.current);
    });
    room.on(RoomEvent.Reconnecting, () => recorderRef.current.trace('room.reconnecting'));
    room.on(RoomEvent.Disconnected, () => {
      // Недочитанные потоки прерываются всегда; незаконченные строки Гоко закрывает finally обработчика.
      streams.abort();
      recorderRef.current.trace('room.disconnected');
      void recorderRef.current.stop('disconnect');
      stopMeter.current?.();
      stopMeter.current = null;
      setAmplitude(0);
      // Состояние — только для вошедшей и не сброшенной комнаты: неудачный вход livekit тоже завершает событием
      // Disconnected (до отказа connect), а комната после reset не должна сбрасывать вход новой сессии.
      if (roomRef.current !== room) return;
      roomRef.current = null;
      joining.current = null;
      setLink('idle');
      setMic('off');
      setAgent(false);
      setAgentPresent(false);
      setAgentState('connecting');
    });
    // Регистрировать до connect: первые реплики агента приходят сразу после входа.
    // Ленту трогает только текущая попытка входа: после reset лента принадлежит новой сессии.
    room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
      reader.withAbortSignal(streams.signal); // до чтения: сигнал берётся при создании итератора
      // SDK передаёт stream sender только с identity; SID/kind фиксируем немедленно при открытии stream,
      // чтобы поздние chunks не были приписаны новому участнику с той же identity.
      const sender = streamSender(participant);
      const attrs = reader.info.attributes ?? {};
      const id = lineId(attrs, reader.info.id);
      const mySids = new Set(room.localParticipant.getTrackPublications().map((p) => p.trackSid));
      const senderIdentity = participant?.identity ?? '';
      const myIdentity = room.localParticipant.identity;
      const who = whoOf(attrs, mySids, senderIdentity, myIdentity);
      const trusted = () => isTrustedTranscriptSender(who, senderIdentity, myIdentity, isBoundAgent(agentBinding.current, gen, sender));
      if (!trusted()) return;
      const validSender = () => current() && trusted();
      if (who === 'me') {
        // Человек: промежуточные результаты STT — отдельные закрытые потоки того же сегмента; берём только финал.
        try {
          const text = await reader.readAll();
          if (validSender() && acceptLine(attrs, who) && text.trim()) {
            recorderRef.current.trace('transcript.final', { id, who, text });
            setLines((ls) => upsertLine(ls, { id, who, text, final: true }));
          }
        } catch {
          // поток оборвался (агент ушёл, комната отключилась): недочитанную фразу человека не показываем
        }
        return;
      }
      // Гоко: дельта-поток, lk.transcription_final у него навсегда 'false' (agents 1.8.0) — финал = дочитанный поток.
      let text = '';
      let complete = false;
      try {
        for await (const chunk of reader) {
          if (!validSender()) return;
          text += chunk;
          if (validSender()) {
            recorderRef.current.trace('transcript.chunk', { id, who, chars: text.length });
            setLines((ls) => upsertLine(ls, { id, who, text, final: false }));
          }
        }
        complete = true;
      } catch {
        recorderRef.current.trace('transcript.error', { id, who, chars: text.length });
      } finally {
        if (validSender() && text) {
          recorderRef.current.trace(complete ? 'transcript.final' : 'transcript.stream-error', { id, who, text });
          setLines((ls) => upsertLine(ls, { id, who, text, final: complete, error: !complete }));
        }
      }
    });
    room.registerTextStreamHandler(CONVERSATION_TOPIC, async (reader, participant) => {
      reader.withAbortSignal(streams.signal);
      const sender = streamSender(participant);
      if (!isBoundAgent(agentBinding.current, gen, sender)) return;
      let raw = '';
      try {
        raw = await reader.readAll();
      } catch {
        return;
      }
      const event = acceptConversationEvent(agentBinding.current, gen, sender, raw);
      if (!current() || !event) return;
      recorderRef.current.trace('conversation.response-finished', { seq: event.seq, itemId: event.itemId, interrupted: event.interrupted, text: event.text });
      if (event.interrupted) {
        setLines((ls) => upsertLine(ls, { id: `interrupted-${sender?.sid}-${event.seq}`, who: 'goko', text: 'Ответ Гоко прерван', final: true }));
      }
    });
    setLink('connecting');
    const joined = (async (): Promise<Room | null> => {
      try {
        await room.connect(info.livekit.url, info.livekit.token);
      } catch (e) {
        if (!current()) return null; // reset или размонтирование во время входа: состояние уже сброшено
        console.warn('[!] web: вход в комнату не удался', e);
        joining.current = null;
        void room.disconnect();
        setLink('failed');
        if (connectionFailureAction(e) === 'reset') {
          // Токен истёк раньше продлённой сессии (D-0008) или комнаты уже нет: новая сессия создаётся сразу,
          // а следующее касание входит уже с её токеном.
          saveStored(null);
          reset();
          setError('нет связи с Гоко: доска работает тапами, коснись экрана, чтобы подключиться заново');
        } else {
          // Временный сбой: сессия сохранена, следующее касание страницы входит заново с тем же токеном.
          setError('нет связи с Гоко: доска работает тапами, коснись экрана, чтобы подключиться снова');
        }
        return null;
      }
      if (!current()) {
        void room.disconnect();
        return null;
      }
      roomRef.current = room;
      recorderRef.current.trace('room.connected', { generation: gen });
      saveStored(info); // вход удался — сессия переживает перезагрузку вкладки
      // Режим — сразу после входа и без ожидания: агент ждёт goko.mode перед приветствием не дольше 2 с, а
      // setAttributes ждёт подтверждения до 5 с и не должен задерживать микрофон и чат (отказ sendMode логирует).
      void sendMode(room, modeRef.current);
      // startAudio на iOS работает только недалеко от жеста. Отказ — не отказ связи: в «Чате» звук не нужен,
      // а в «Голосе» livekit сам повторяет startAudio при захвате микрофона.
      await room.startAudio().catch(() => setAudioPlaybackError('браузер не дал включить звук Гоко'));
      if (roomRef.current !== room) return null;
      setLink('connected');
      refreshAgent();
      return room;
    })();
    joining.current = joined;
    return joined;
  }, [info, sendMode, reset]);

  const enableMic = useCallback(async () => {
    const room = await connect();
    if (!room || modeRef.current !== 'voice') return;
    setMic('connecting');
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      // Пока включался микрофон, выбрали «Чат»: запоздавшее включение перекрыло бы выключение ветки «Чата».
      if (modeRef.current !== 'voice') {
        void room.localParticipant.setMicrophoneEnabled(false);
        setMic('off');
        return;
      }
      setMic('on');
      micTrack.current = room.localParticipant.getTrackPublications().find((p) => p.kind === Track.Kind.Audio)?.track?.mediaStreamTrack ?? null;
      stopMeter.current?.();
      const currentMic = micTrack.current;
      if (currentMic) {
        const stopTrackEnd = watchTrackEnd(currentMic, () => void recorderRef.current.stop('track-change'));
        stopMeter.current = stopTrackEnd;
      }
      if (currentMic && typeof AudioContext !== 'undefined') {
        try {
          const context = new AudioContext();
          const analyser = context.createAnalyser();
          analyser.fftSize = 256;
          const source = context.createMediaStreamSource(new MediaStream([currentMic as MediaStreamTrack]));
          source.connect(analyser);
          void context.resume();
          const samples = new Uint8Array(analyser.fftSize);
          let frame = 0;
          const tick = () => {
            analyser.getByteTimeDomainData(samples);
            let energy = 0;
            for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
            const participantLevel = agentBinding.current ? room.remoteParticipants.get(agentBinding.current.identity)?.audioLevel ?? 0 : 0;
            setAmplitude(Math.min(1, Math.max(Math.sqrt(energy / samples.length) * 3, participantLevel)));
            frame = requestAnimationFrame(tick);
          };
          frame = requestAnimationFrame(tick);
          const stopTrackEnd = stopMeter.current;
          stopMeter.current = () => {
            cancelAnimationFrame(frame);
            stopTrackEnd?.();
            source.disconnect();
            analyser.disconnect();
            void context.close();
          };
        } catch {
          // LiveKit state remains available when Web Audio is unsupported or blocked.
        }
      }
    } catch {
      // Отказ пришёл уже в «Чате» (например, диалог разрешения закрыли после переключения): микрофон там не нужен,
      // ни «failed», ни фразы про разрешение.
      if (modeRef.current !== 'voice') {
        setMic('off');
        return;
      }
      setMic('failed');
      setError('не удалось включить микрофон: разреши его в браузере или переключись на «Чат»');
    }
  }, [connect]);

  // Произвольное касание может восстановить транспорт, но никогда не включает захват микрофона.
  const activate = useCallback(async () => {
    if (!info) return create();
    await connect();
  }, [info, create, connect]);

  const setMode = useCallback(
    async (mode: Mode) => {
      modeRef.current = mode;
      setPrefs((p) => ({ ...p, mode }));
      const room = await connect();
      // Быстрое «Голос → Чат → Голос»: после каждого ожидания выходим, если режим уже сменили снова,
      // иначе запоздавшая ветка «Чата» выключила бы микрофон и звук уже в «Голосе».
      if (!room || modeRef.current !== mode) return;
      // Без ожидания, как при входе: подтверждение setAttributes до 5 с не задерживает микрофон и отписку звука.
      void sendMode(room, mode);
      if (mode === 'chat') {
        await recorderRef.current.stop('mode-off');
        try {
          await room.localParticipant.setMicrophoneEnabled(false);
        } catch {
          // микрофона и не было
        }
        if (modeRef.current !== mode) return;
        setMic('off');
        micTrack.current = null;
        stopMeter.current?.();
        stopMeter.current = null;
        setAmplitude(0);
        setRemoteAudio(room, false, agentBinding.current?.identity ?? null);
      } else {
        setRemoteAudio(room, true, agentBinding.current?.identity ?? null);
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
  const retryAudio = useCallback(async () => {
    const room = await connect();
    if (!room) return;
    try {
      await room.startAudio();
      if (!room.canPlaybackAudio) throw new Error('playback remains blocked');
      setAudioPlaybackError(null);
    } catch {
      setAudioPlaybackError('браузер не дал включить звук Гоко');
    }
  }, [connect]);
  const toggleVoice = useCallback(async () => {
    if (modeRef.current === 'voice' && (mic === 'on' || mic === 'connecting')) await setMode('chat');
    else if (modeRef.current === 'voice') await enableMic();
    else await setMode('voice');
  }, [mic, setMode, enableMic]);
  const startRecording = useCallback(() => {
    void recorderRef.current.start(micTrack.current, remoteAgentTrack.current)
      .then(() => recorderRef.current.trace('room.snapshot', { generation: generation.current, agentIdentity: agentBinding.current?.identity, agentSid: agentBinding.current?.sid }))
      .catch((e: unknown) => {
        setRecording({ ...recorderRef.current.getSnapshot(), phase: 'failed', error: e instanceof Error ? e.message : 'не удалось начать запись' });
      });
  }, []);
  const stopRecording = useCallback((reason: RecordingStopReason = 'user') => recorderRef.current.stop(reason), []);
  const deleteRecording = useCallback(() => recorderRef.current.delete(), []);
  const trace = useCallback((type: string, payload?: unknown) => recorderRef.current.trace(type, payload), []);

  return {
    session: info?.session ?? null,
    lines,
    mic,
    link,
    agent,
    agentPresent,
    agentState,
    amplitude,
    prefs,
    error,
    audioPlaybackError,
    recording,
    clearError,
    activate,
    enableMic,
    toggleVoice,
    retryAudio,
    startRecording,
    stopRecording,
    deleteRecording,
    trace,
    setMode,
    updatePrefs,
    sendText,
    reset,
  };
}
