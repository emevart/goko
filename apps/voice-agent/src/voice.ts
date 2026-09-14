// Сборка речи (раздел 9 спеки, «Речь»): realtime — gpt-realtime слушает и говорит сам;
// pipeline — запасной конвейер STT -> LLM -> TTS с VAD Silero. Инструменты и промпт одинаковые.
import type { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';

export type VoiceMode = 'realtime' | 'pipeline';
export type SessionOptions = ConstructorParameters<typeof voice.AgentSession>[0];

export function parseVoiceMode(v: string | undefined): VoiceMode {
  if (v === undefined || v === '' || v === 'realtime') return 'realtime';
  if (v === 'pipeline') return 'pipeline';
  throw new Error(`VOICE_MODE: expected realtime or pipeline, got "${v}"`); // для разработчика — по-английски, как ошибки ядра
}

// Параметры VAD — из docs/research/stage0-results.md (стадия 0 подбирала перебивание).
export const REALTIME_TURN_DETECTION = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
} as const;

export async function sessionOptions(mode: VoiceMode): Promise<SessionOptions> {
  if (mode === 'realtime') {
    return {
      llm: new openai.realtime.RealtimeModel({
        model: 'gpt-realtime',
        voice: 'marin',
        turnDetection: REALTIME_TURN_DETECTION,
        inputAudioTranscription: { model: 'gpt-live-transcribe', language: 'ru' },
      }),
    };
  }
  return {
    vad: await silero.VAD.load(),
    stt: new openai.STT({ model: 'gpt-transcribe', language: 'ru' }),
    llm: new openai.LLM({ model: 'gpt-4.1-mini' }),
    tts: new openai.TTS({
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      instructions: 'Говори по-русски, спокойно и коротко, как игрок за доской; координаты произноси по буквам, как написано.',
    }),
  };
}
