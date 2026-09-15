import { describe, expect, it } from 'vitest';
import { voiceOrbPresentation } from './components/VoiceOrb.tsx';

describe('VoiceOrb', () => {
  it('не утверждает присутствие Гоко до binding trusted AGENT', () => {
    expect(voiceOrbPresentation('connected', false, 'connecting', 'off')).toEqual({
      state: 'connecting',
      label: 'Жду Гоко',
    });
    expect(voiceOrbPresentation('connected', true, 'idle', 'off')).toEqual({
      state: 'idle',
      label: 'Гоко рядом',
    });
  });
});
