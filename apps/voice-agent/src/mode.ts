// Режим разговора (D-0011): веб и scripts/chat.mjs выставляют атрибут участника goko.mode = voice | chat.
// В «Чате» аудиовход и аудиовыход сессии выключены, ответы идут только текстом в lk.transcription.
// Realtime при этом всё равно генерирует аудио (modalities задаются только в конструкторе RealtimeModel):
// это известная цена D-0011. Запасной путь — веб в «Чате» не подписан на аудиотрек агента.
export type TalkMode = 'voice' | 'chat';

export const MODE_ATTRIBUTE = 'goko.mode';

// Незнакомое значение и отсутствие атрибута — «Голос»: основной режим, и старый веб без атрибута работает как раньше.
export function modeOf(attributes: Readonly<Record<string, string>> | undefined): TalkMode {
  return attributes?.[MODE_ATTRIBUTE] === 'chat' ? 'chat' : 'voice';
}

// Ровно то, что нужно от voice.AgentSession (@livekit/agents 1.8: session.input и session.output, src/voice/io.ts).
export type AudioSwitch = {
  input: { setAudioEnabled(enabled: boolean): void };
  output: { setAudioEnabled(enabled: boolean): void };
};

export function applyMode(session: AudioSwitch, mode: TalkMode): void {
  const on = mode === 'voice';
  session.output.setAudioEnabled(on);
  session.input.setAudioEnabled(on);
}

// RemoteParticipant из @livekit/rtc-node подходит как есть: identity и attributes — геттеры.
export type ParticipantLike = { identity: string; attributes: Readonly<Record<string, string>> };

export type ModeFollower = { readonly mode: TalkMode; onAttributes(p: ParticipantLike): void };

// Следит за режимом одного участника — того, кого дождался ctx.waitForParticipant(). Вызывать после
// session.start: подключение аудиовыхода RoomIO внутри start вызывает onAttached независимо от флага.
export function followMode(opts: { participant: ParticipantLike; session: AudioSwitch; log?: (line: string) => void }): ModeFollower {
  const log = opts.log ?? (() => {});
  let mode = modeOf(opts.participant.attributes);
  applyMode(opts.session, mode);
  log(`[OK] voice-agent: режим ${mode}`);
  return {
    get mode() {
      return mode;
    },
    onAttributes(p) {
      if (p.identity !== opts.participant.identity) return;
      const next = modeOf(p.attributes);
      if (next === mode) return;
      mode = next;
      applyMode(opts.session, mode);
      log(`[OK] voice-agent: режим ${mode}`);
    },
  };
}
