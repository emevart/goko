import { describe, expect, it } from 'vitest';
import { REALTIME_MODEL_OPTIONS, REALTIME_TURN_DETECTION, parseVoiceMode } from './voice.ts';

describe('parseVoiceMode', () => {
  it('realtime по умолчанию, pipeline по запросу, иначе ошибка', () => {
    expect(parseVoiceMode(undefined)).toBe('realtime');
    expect(parseVoiceMode('')).toBe('realtime');
    expect(parseVoiceMode('realtime')).toBe('realtime');
    expect(parseVoiceMode('pipeline')).toBe('pipeline');
    expect(() => parseVoiceMode('gpt')).toThrow('VOICE_MODE');
  });
});

describe('настройки Realtime', () => {
  it('использует поддерживаемые payload semantic VAD и far-field noise reduction', () => {
    expect(REALTIME_MODEL_OPTIONS).toMatchObject({
      model: 'gpt-realtime',
      voice: 'cedar',
      inputAudioNoiseReduction: { type: 'far_field' },
      turnDetection: {
        type: 'semantic_vad',
        eagerness: 'medium',
        create_response: true,
        interrupt_response: true,
      },
    });
    expect(REALTIME_TURN_DETECTION).not.toHaveProperty('silence_duration_ms');
    expect(REALTIME_TURN_DETECTION).not.toHaveProperty('threshold');
  });
});
