// Режим разговора (D-0011): веб и scripts/chat.mjs выставляют атрибут участника goko.mode = voice | chat.
// В «Чате» аудиовход и аудиовыход сессии выключены, ответы идут только текстом в lk.transcription.
// Realtime при этом всё равно генерирует аудио (modalities задаются только в конструкторе RealtimeModel):
// это известная цена D-0011. Запасной путь — веб в «Чате» не подписан на аудиотрек агента.
import { type Clock, realClock } from './clock.ts';

export type TalkMode = 'voice' | 'chat';

export const MODE_ATTRIBUTE = 'goko.mode';
export const MIC_ATTRIBUTE = 'goko.mic';

// Незнакомое значение и отсутствие атрибута — «Голос»: основной режим, и старый веб без атрибута работает как раньше.
export function modeOf(attributes: Readonly<Record<string, string>> | undefined): TalkMode {
  return attributes?.[MODE_ATTRIBUTE] === 'chat' ? 'chat' : 'voice';
}

// Ровно то, что нужно от voice.AgentSession (@livekit/agents 1.8: session.input и session.output, src/voice/io.ts).
export type AudioSwitch = {
  input: { setAudioEnabled(enabled: boolean): void };
  output: { setAudioEnabled(enabled: boolean): void };
};
export type LiveInputSwitch = { setInputEnabled(enabled: boolean): void };

export function applyMode(session: AudioSwitch, mode: TalkMode, live?: LiveInputSwitch, microphoneActive = true): void {
  const on = mode === 'voice';
  const liveInput = on && microphoneActive;
  session.output.setAudioEnabled(on);
  if (liveInput) {
    live?.setInputEnabled(true); // сначала остановить synthetic clock
    session.input.setAudioEnabled(true);
  } else {
    session.input.setAudioEnabled(false); // сначала отсоединить реальный Room input
    live?.setInputEnabled(false);
  }
}

// RemoteParticipant из @livekit/rtc-node подходит как есть: identity и attributes — геттеры.
export type ParticipantLike = { identity: string; attributes: Readonly<Record<string, string>> };

export type ModeFollower = { readonly mode: TalkMode; onAttributes(p: ParticipantLike): void; onRejoin(p: ParticipantLike): void };

// Следит за режимом одного участника — того, кого дождался ctx.waitForParticipant(). Вызывать после
// session.start: подключение аудиовыхода RoomIO внутри start вызывает onAttached независимо от флага.
export function followMode(opts: { participant: ParticipantLike; session: AudioSwitch; live?: LiveInputSwitch; log?: (line: string) => void }): ModeFollower {
  const log = opts.log ?? (() => {});
  let mode = modeOf(opts.participant.attributes);
  let microphoneActive = opts.participant.attributes[MIC_ATTRIBUTE] !== 'muted';
  applyMode(opts.session, mode, opts.live, microphoneActive);
  log(`[OK] voice-agent: режим ${mode}`);
  const onAttributes = (p: ParticipantLike) => {
    if (p.identity !== opts.participant.identity) return;
    const next = modeOf(p.attributes);
    const nextMicrophoneActive = p.attributes[MIC_ATTRIBUTE] !== 'muted';
    if (next === mode && nextMicrophoneActive === microphoneActive) return;
    mode = next;
    microphoneActive = nextMicrophoneActive;
    applyMode(opts.session, mode, opts.live, microphoneActive);
    log(`[OK] voice-agent: режим ${mode}`);
  };
  return {
    get mode() {
      return mode;
    },
    onAttributes,
    // Вернувшийся участник (перезагрузка вкладки) входит без атрибутов и выставляет goko.mode следом.
    // Пустые атрибуты при входе — не «Голос», а «ещё не сказал»: режим держим до ParticipantAttributesChanged.
    onRejoin(p) {
      if (hasMode(p.attributes)) onAttributes(p);
    },
  };
}

export function hasMode(attributes: Readonly<Record<string, string>> | undefined): boolean {
  return attributes?.[MODE_ATTRIBUTE] !== undefined;
}

// Сколько приветствие ждёт атрибут режима. Веб и chat.mjs выставляют goko.mode сразу после входа, это доли
// секунды; обычно ожидание идёт параллельно с session.start и приветствие не задерживает.
export const MODE_WAIT_MS = 2_000;

// Ждёт, пока у участника появится goko.mode, но не дольше timeoutMs: true — атрибут есть, false — срок вышел.
// По сроку main.ts здоровается в режиме по умолчанию («Голос»); атрибут, пришедший позже, переключит режим
// через followMode, и остаток приветствия в «Чате» уйдёт текстом.
export function waitForMode(opts: {
  participant: ParticipantLike;
  subscribe: (listener: (p: ParticipantLike) => void) => () => void;
  timeoutMs?: number;
  clock?: Clock;
}): Promise<boolean> {
  if (hasMode(opts.participant.attributes)) return Promise.resolve(true);
  const clock = opts.clock ?? realClock;
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    let cancel = () => {};
    const finish = (got: boolean) => {
      unsubscribe();
      cancel();
      resolve(got);
    };
    unsubscribe = opts.subscribe((p) => {
      if (p.identity === opts.participant.identity && hasMode(p.attributes)) finish(true);
    });
    cancel = clock.after(opts.timeoutMs ?? MODE_WAIT_MS, () => finish(false));
  });
}
