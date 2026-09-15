import type { AudioSwitch } from './mode.ts';
import type { VoiceMode } from './voice.ts';

export function prepareRoomInput(session: AudioSwitch, mode: VoiceMode): { audioEnabled: boolean } {
  // RoomIO должен создать поток. До готовности Live отключаем его передачу,
  // а не создание: setAudioEnabled(true) не создаёт отсутствующий input.
  if (mode === 'live') session.input.setAudioEnabled(false);
  return { audioEnabled: true };
}
