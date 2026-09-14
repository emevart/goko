import { describe, expect, it } from 'vitest';
import { parseVoiceMode } from './voice.ts';

describe('parseVoiceMode', () => {
  it('realtime по умолчанию, pipeline по запросу, иначе ошибка', () => {
    expect(parseVoiceMode(undefined)).toBe('realtime');
    expect(parseVoiceMode('')).toBe('realtime');
    expect(parseVoiceMode('realtime')).toBe('realtime');
    expect(parseVoiceMode('pipeline')).toBe('pipeline');
    expect(() => parseVoiceMode('gpt')).toThrow('VOICE_MODE');
  });
});
