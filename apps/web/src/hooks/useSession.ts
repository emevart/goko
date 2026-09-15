// Сессия Гоко на телефоне: сессия через game-server (sessionStorage), комната LiveKit по её токену, режим
// «Голос / Чат» атрибутом goko.mode, микрофон, чат и лента диалога. Комнат страница не создаёт (D-0001).
import { useCallback, useEffect, useRef, useState } from 'react';
import { LocalAudioTrack, ParticipantKind, Room, RoomEvent, Track } from 'livekit-client';
import { cleanSpeechTranscript, CONVERSATION_TOPIC, CreateSessionResponse } from '@goko/protocol';
import { client } from '../api.ts';
import { agentReady, sendChat } from '../chat.ts';
import { type Mode, type Prefs, loadPrefs, modeAttributes, savePrefs } from '../prefs.ts';
import { describeError } from '../text.ts';
import { type Line, acceptLine, isTrustedTranscriptSender, lineId, upsertLine, whoOf } from '../transcript.ts';
import { connectionFailureAction } from '../session-connection.ts';
import { acceptConversationEvent, bindAgent, isBoundAgent, participantRefOf, type AgentBinding } from '../conversation.ts';
import { DiagnosticRecorder, watchTrackEnd, type RecorderTrack, type RecordingSnapshot, type RecordingStopReason } from '../recording.ts';
import { ConversationEndBarrier, ConversationRestart, preflightVoice, publishGestureTrack, SessionGate, voiceFailureMode, waitForAgentReady } from '../session-lifecycle.ts';

const STORAGE_KEY = 'goko.session';
const ENDED_CONVERSATION_KEY = 'goko.endedConversation';

export type MicState = 'off' | 'connecting' | 'on' | 'failed';
export type LinkState = 'idle' | 'connecting' | 'connected' | 'failed';
export type ConversationState = 'idle' | 'chat' | 'voice';
const AGENT_READY_TIMEOUT_MS = 8_000;

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

function loadEndedConversation(): string | null {
  try { return sessionStorage.getItem(ENDED_CONVERSATION_KEY); } catch { return null; }
}

function saveEndedConversation(sessionId: string | null) {
  try {
    if (sessionId) sessionStorage.setItem(ENDED_CONVERSATION_KEY, sessionId);
    else sessionStorage.removeItem(ENDED_CONVERSATION_KEY);
  } catch { /* без storage marker живёт в ref */ }
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
  const [conversation, setConversation] = useState<ConversationState>('idle');
  const conversationRef = useRef<ConversationState>('idle');
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
  const sessionGate = useRef<SessionGate<CreateSessionResponse> | null>(null);
  const agentBinding = useRef<AgentBinding | null>(null);
  const micTrack = useRef<RecorderTrack | null>(null);
  const remoteAgentTrack = useRef<RecorderTrack | null>(null);
  const stopMeter = useRef<(() => void) | null>(null);
  const readyListeners = useRef(new Set<() => void>());
  const voiceAttempt = useRef(0);
  const gestureAudio = useRef<AudioContext | null>(null);
  const conversationRestart = useRef<ConversationRestart | null>(null);
  const conversationAbort = useRef(new AbortController());
  const endBarrier = useRef(new ConversationEndBarrier());
  const chatInFlight = useRef(0);
  const chatRequestVersion = useRef(0);

  if (!sessionGate.current) {
    sessionGate.current = new SessionGate(async () => {
      setError(null);
      const res = await client.createSession();
      saveStored(res);
      setInfo(res);
      return res;
    });
    if (info) sessionGate.current.seed(info);
  }
  if (!conversationRestart.current) {
    conversationRestart.current = new ConversationRestart(() => crypto.randomUUID());
    const ended = loadEndedConversation();
    if (ended) conversationRestart.current.ended(ended);
  }

  useEffect(() => recorderRef.current.subscribe(setRecording), []);

  useEffect(() => {
    savePrefs(local, prefs);
  }, [prefs]);

  // Размонтирование: комнату не оставляем открытой; незавершённый вход увидит новый номер и отключится сам.
  useEffect(
    () => () => {
      generation.current++;
      conversationAbort.current.abort();
      const room = roomRef.current;
      roomRef.current = null;
      joining.current = null;
      stopMeter.current?.();
      void gestureAudio.current?.close();
      void recorderRef.current.dispose().finally(() => room?.disconnect());
    },
    [],
  );

  const ensureSession = useCallback(async (): Promise<CreateSessionResponse | null> => {
    if (info) return info;
    try {
      return await sessionGate.current!.ensure();
    } catch (e) {
      setError(describeError(e));
      return null;
    }
  }, [info]);

  // Сессия истекла на сервере (SSE ответил not_found): комната тоже мертва — отключаемся и создаём новую.
  const reset = useCallback(() => {
    saveStored(null);
    saveEndedConversation(null);
    sessionGate.current?.seed(null);
    generation.current++;
    conversationAbort.current.abort();
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
    setConversation('idle');
    conversationRef.current = 'idle';
    setLines([]);
    setError(null); // фраза прежней сессии не должна висеть над новой до входа в комнату
    setInfo(null);
  }, []);

  const sendMode = useCallback(async (room: Room, mode: Mode) => {
    try {
      const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = publication?.track?.mediaStreamTrack;
      const active = mode === 'voice' && !publication?.isMuted && track?.readyState === 'live' && track.enabled;
      await room.localParticipant.setAttributes({ ...modeAttributes(mode), 'goko.conversation': 'active', 'goko.mic': active ? 'on' : 'muted' });
    } catch (e) {
      // Нет права canUpdateOwnMetadata или сервер не ответил: агент останется в прежнем режиме.
      console.warn('[!] web: не удалось выставить goko.mode', e);
    }
  }, []);
  const sendMicState = useCallback((room: Room, active: boolean) => {
    void room.localParticipant.setAttributes({ 'goko.mic': active ? 'on' : 'muted' }).catch(() => {});
  }, []);

  // Вход в комнату, идемпотентный: повторные касания получают тот же промис.
  const connect = useCallback(async (): Promise<Room | null> => {
    const requestedGeneration = generation.current;
    const requestedConversation = conversationAbort.current.signal;
    let sessionInfo = info ?? await ensureSession();
    if (joining.current) return joining.current;
    if (!sessionInfo || conversationRef.current === 'idle' || requestedConversation.aborted || generation.current !== requestedGeneration) return null;
    await endBarrier.current.wait();
    if (joining.current) return joining.current;
    if (requestedConversation.aborted || generation.current !== requestedGeneration) return null;
    try {
      sessionInfo = await conversationRestart.current!.prepare(sessionInfo, (sid, request) => client.restartConversation(sid, request));
      if (joining.current) return joining.current;
      if (requestedConversation.aborted || generation.current !== requestedGeneration) return null;
      saveEndedConversation(null);
      saveStored(sessionInfo);
      setInfo(sessionInfo);
    } catch (e) {
      setError(describeError(e));
      return null;
    }
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
      for (const notify of readyListeners.current) notify();
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
      if (roomRef.current === room) {
        setLink('connected');
        void sendMode(room, modeRef.current);
      }
    });
    room.on(RoomEvent.Reconnecting, () => {
      recorderRef.current.trace('room.reconnecting');
      if (roomRef.current === room) setLink('connecting');
    });
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
          const text = cleanSpeechTranscript(await reader.readAll());
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
      if (event.type === 'conversation.failure') {
        recorderRef.current.trace('conversation.failure', { seq: event.seq, message: event.message });
        setError(event.message);
        return;
      }
      recorderRef.current.trace('conversation.response-finished', { seq: event.seq, itemId: event.itemId, interrupted: event.interrupted, text: event.text });
      if (event.interrupted) {
        setLines((ls) => upsertLine(ls, { id: `interrupted-${sender?.sid}-${event.seq}`, who: 'goko', text: 'Ответ Гоко прерван', final: true }));
      }
    });
    setLink('connecting');
    const joined = (async (): Promise<Room | null> => {
      try {
        await room.connect(sessionInfo.livekit.url, sessionInfo.livekit.token);
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
          setError('нет связи с Гоко: доска работает тапами, повтори запуск разговора');
        } else {
          // Временный сбой: сессия сохранена, следующее касание страницы входит заново с тем же токеном.
          setError('нет связи с Гоко: доска работает тапами, повтори действие разговора');
        }
        return null;
      }
      if (!current()) {
        void room.disconnect();
        return null;
      }
      roomRef.current = room;
      recorderRef.current.trace('room.connected', { generation: gen });
      saveStored(sessionInfo); // вход удался — сессия переживает перезагрузку вкладки
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
  }, [info, ensureSession, sendMode, reset]);

  const monitorMic = useCallback((room: Room, currentMic: RecorderTrack) => {
    micTrack.current = currentMic;
    stopMeter.current?.();
    const stopTrackEnd = watchTrackEnd(currentMic, () => void recorderRef.current.stop('track-change'));
    stopMeter.current = stopTrackEnd;
    if (typeof AudioContext === 'undefined') return;
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
      stopMeter.current = () => {
        cancelAnimationFrame(frame);
        stopTrackEnd();
        source.disconnect();
        analyser.disconnect();
        void context.close();
      };
    } catch {
      // LiveKit state remains available when Web Audio is unsupported or blocked.
    }
  }, []);

  const enableMic = useCallback(async () => {
    const room = await connect();
    if (!room || modeRef.current !== 'voice') return;
    setMic('connecting');
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      // Пока включался микрофон, выбрали «Чат»: запоздавшее включение перекрыло бы выключение ветки «Чата».
      if (modeRef.current !== 'voice' || conversationRef.current !== 'voice' || roomRef.current !== room) {
        void room.localParticipant.setMicrophoneEnabled(false);
        setMic('off');
        return;
      }
      setMic('on');
      sendMicState(room, true);
      const currentMic = room.localParticipant.getTrackPublications().find((p) => p.kind === Track.Kind.Audio)?.track?.mediaStreamTrack ?? null;
      if (currentMic) monitorMic(room, currentMic);
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
  }, [connect, monitorMic, sendMicState]);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch })), []);

  // Отправка из поля ввода «Чата». Возвращает, что оставить в поле: '' после успеха, черновик при ошибке.
  const sendText = useCallback(
    async (draft: string): Promise<string> => {
      if (!draft.trim()) return draft;
      chatRequestVersion.current++;
      chatInFlight.current++;
      if (conversationRef.current === 'idle') {
        conversationAbort.current = new AbortController();
        modeRef.current = 'chat';
        conversationRef.current = 'chat';
        setConversation('chat');
        setPrefs((p) => ({ ...p, mode: 'chat' }));
      }
      const room = await connect();
      if (!room) {
        chatInFlight.current--;
        return draft;
      }
      const gen = generation.current;
      void sendMode(room, modeRef.current);
      const ready = await waitForAgentReady(
        () => {
          const binding = agentBinding.current;
          const participant = binding ? room.remoteParticipants.get(binding.identity) : undefined;
          return Boolean(participant && agentReady(participant.attributes));
        },
        (notify) => {
          readyListeners.current.add(notify);
          return () => readyListeners.current.delete(notify);
        },
        () => generation.current === gen && roomRef.current === room && conversationRef.current !== 'idle',
        AGENT_READY_TIMEOUT_MS,
        conversationAbort.current.signal,
      );
      if (!ready) {
        chatInFlight.current--;
        setError('Гоко не успел подключиться; сообщение сохранено, попробуй ещё раз');
        return draft;
      }
      const res = await sendChat(draft, {
        send: (text) => room.localParticipant.sendText(text, { topic: 'lk.chat' }),
        id: chatLineId,
      });
      const line = res.line;
      if (line) setLines((ls) => upsertLine(ls, line));
      if (res.error) setError(res.error);
      chatInFlight.current--;
      return res.draft;
    },
    [connect, sendMode],
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
  const startVoice = useCallback(async () => {
    const chatWasActive = conversationRef.current === 'chat';
    const chatVersionAtStart = chatRequestVersion.current;
    if (conversationRef.current === 'idle') conversationAbort.current = new AbortController();
    const attempt = ++voiceAttempt.current;
    conversationRef.current = 'voice';
    setConversation('voice');
    modeRef.current = 'voice';
    setPrefs((p) => ({ ...p, mode: 'voice' }));
    let permission: MediaStream | null = null;
    try {
      permission = await preflightVoice(
        async () => {
          if (typeof AudioContext === 'undefined') return;
          gestureAudio.current ??= new AudioContext();
          await gestureAudio.current.resume();
        },
        () => navigator.mediaDevices.getUserMedia({ audio: true }),
        (stream) => { for (const track of stream.getTracks()) track.stop(); },
      );
    } catch {
      if (voiceAttempt.current === attempt) {
        const fallback = voiceFailureMode(chatWasActive, chatRequestVersion.current > chatVersionAtStart, chatInFlight.current > 0);
        conversationRef.current = fallback;
        setConversation(fallback);
        if (fallback === 'chat') {
          modeRef.current = 'chat';
          setPrefs((p) => ({ ...p, mode: 'chat' }));
        } else {
          generation.current++;
          conversationAbort.current.abort();
          const room = roomRef.current;
          roomRef.current = null;
          joining.current = null;
          void room?.disconnect();
        }
        setMic('failed');
        setError('не удалось включить микрофон: разреши его в браузере; чат остаётся доступен');
      }
      return;
    }
    const acquiredTrack = permission.getAudioTracks()[0];
    for (const track of permission.getTracks()) if (track !== acquiredTrack) track.stop();
    if (!acquiredTrack) return;
    if (voiceAttempt.current !== attempt || conversationRef.current !== 'voice') {
      acquiredTrack.stop();
      return;
    }
    const room = await connect();
    if (!room || voiceAttempt.current !== attempt) {
      acquiredTrack.stop();
      return;
    }
    void sendMode(room, 'voice');
    sendMicState(room, false);
    setMic('connecting');
    try {
      const publication = await publishGestureTrack(
        acquiredTrack,
        // Захват начат жестом, но дальнейшее освобождение/повторный захват принадлежит SDK.
        // Сырой MediaStreamTrack помечается userProvided и не восстанавливается после stop.
        (track) => room.localParticipant.publishTrack(new LocalAudioTrack(track, track.getConstraints(), false), { source: Track.Source.Microphone }),
        async (track) => { await room.localParticipant.unpublishTrack(track); },
        () => voiceAttempt.current === attempt && conversationRef.current === 'voice' && roomRef.current === room,
      );
      if (!publication) {
        setMic('off');
        return;
      }
      monitorMic(room, publication.track?.mediaStreamTrack ?? acquiredTrack);
      setMic('on');
      sendMicState(room, true);
    } catch {
      acquiredTrack.stop();
      if (voiceAttempt.current === attempt) {
        setMic('failed');
        setError('не удалось опубликовать микрофон; повтори запуск голоса');
      }
    }
  }, [connect, monitorMic, sendMicState, sendMode]);

  const toggleMute = useCallback(async () => {
    if (conversation !== 'voice') return;
    const room = roomRef.current;
    if (!room) return startVoice();
    if (mic === 'on') {
      await room.localParticipant.setMicrophoneEnabled(false);
      sendMicState(room, false);
      setMic('off');
      stopMeter.current?.();
      stopMeter.current = null;
      setAmplitude(0);
    } else await enableMic();
  }, [conversation, mic, enableMic, sendMicState, startVoice]);

  const endConversation = useCallback(async () => {
    const endedAttempt = ++voiceAttempt.current;
    const endedGeneration = ++generation.current;
    conversationAbort.current.abort();
    conversationRef.current = 'idle';
    setConversation('idle');
    const room = roomRef.current;
    roomRef.current = null;
    joining.current = null;
    for (const notify of readyListeners.current) notify();
    const endedSessionId = info?.session.id ?? null;
    if (endedSessionId) {
      conversationRestart.current?.ended(endedSessionId);
      saveEndedConversation(endedSessionId);
    }
    const cleanup = endBarrier.current.begin(async () => {
      await recorderRef.current.stop('mode-off');
      if (room) {
        await Promise.race([
          room.localParticipant.setAttributes({ 'goko.conversation': 'ended' }).catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 750)),
        ]);
        try { await room.localParticipant.setMicrophoneEnabled(false); } catch { /* уже отключён */ }
        await room.disconnect();
      }
    });
    await cleanup;
    if (generation.current !== endedGeneration || voiceAttempt.current !== endedAttempt) return;
    agentBinding.current = null;
    micTrack.current = null;
    remoteAgentTrack.current = null;
    stopMeter.current?.();
    stopMeter.current = null;
    setAmplitude(0);
    setMic('off');
    setLink('idle');
    setAgent(false);
    setAgentPresent(false);
    setAgentState('connecting');
  }, [info]);
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
    conversation,
    amplitude,
    prefs,
    error,
    audioPlaybackError,
    recording,
    clearError,
    ensureSession,
    enableMic,
    startVoice,
    toggleMute,
    endConversation,
    retryAudio,
    startRecording,
    stopRecording,
    deleteRecording,
    trace,
    updatePrefs,
    sendText,
    reset,
  };
}
