// Сборка речи (раздел 9 спеки, «Речь»): realtime — gpt-realtime слушает и говорит сам;
// pipeline — запасной конвейер STT -> LLM -> TTS с VAD Silero. Инструменты и промпт одинаковые.
import type { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { BACKEND_INSTRUCTIONS } from './prompt.ts';

export type VoiceMode = 'realtime' | 'live' | 'pipeline';
export type SessionOptions = ConstructorParameters<typeof voice.AgentSession>[0];

export function parseVoiceMode(v: string | undefined): VoiceMode {
  if (v === undefined || v === '' || v === 'realtime') return 'realtime';
  if (v === 'pipeline') return 'pipeline';
  if (v === 'live') return 'live';
  throw new Error(`VOICE_MODE: expected realtime, live or pipeline, got "${v}"`); // для разработчика — по-английски, как ошибки ядра
}

// semantic_vad определяет завершение фразы; far_field рассчитан на телефон рядом с физической доской.
export const REALTIME_TURN_DETECTION = {
  type: 'semantic_vad',
  eagerness: 'medium',
  create_response: true,
  interrupt_response: true,
} as const;

export const REALTIME_MODEL_OPTIONS = {
  model: 'gpt-realtime',
  voice: 'cedar',
  inputAudioNoiseReduction: { type: 'far_field' },
  turnDetection: REALTIME_TURN_DETECTION,
  inputAudioTranscription: { model: 'gpt-live-transcribe', language: 'ru' },
} as const satisfies ConstructorParameters<typeof openai.realtime.RealtimeModel>[0];

export const GPT_LIVE_MODEL_OPTIONS = {
  model: 'gpt-live-1',
  voice: 'marin',
  delegation: 'responses',
  responsesOptions: {
    model: 'gpt-5.6-luna',
    instructions: BACKEND_INSTRUCTIONS,
    parallelToolCalls: false,
    reasoning: { effort: 'low' },
    maxOutputTokens: 1_536,
  },
  maxSessionDuration: null,
} as const satisfies ConstructorParameters<typeof openai.realtime.GPTLiveModel>[0];

export async function sessionOptions(mode: VoiceMode): Promise<SessionOptions> {
  if (mode === 'realtime') {
    return {
      llm: new openai.realtime.RealtimeModel(REALTIME_MODEL_OPTIONS),
    };
  }
  if (mode === 'live') return { llm: new openai.realtime.GPTLiveModel(GPT_LIVE_MODEL_OPTIONS) };
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
