import { describe, expect, it } from 'vitest';
import { voiceOrbPresentation } from './components/VoiceOrb.tsx';

describe('VoiceOrb', () => {
  it('не утверждает присутствие Гоко до binding trusted AGENT', () => {
    expect(voiceOrbPresentation('connected', false, 'connecting', 'off')).toEqual({
      state: 'connecting',
      label: 'Жду Гоко',
    });
    expect(voiceOrbPresentation('connected', true, 'idle', 'off')).toEqual({
      state: 'muted',
      label: 'Микрофон выключен',
    });
  });

  it('показывает отдельные состояния речи, размышления и инструментов', () => {
    expect(voiceOrbPresentation('connected', true, 'listening', 'on')).toEqual({ state: 'listening', label: 'Слушаю' });
    expect(voiceOrbPresentation('connected', true, 'thinking', 'on')).toEqual({ state: 'thinking', label: 'Гоко думает' });
    expect(voiceOrbPresentation('connected', true, 'thinking', 'on', 'get_position')).toEqual({ state: 'tool', label: 'Сверяю доску' });
    expect(voiceOrbPresentation('connected', true, 'speaking', 'on')).toEqual({ state: 'speaking', label: 'Гоко говорит' });
  });

  it('не выдаёт состояние инструмента до подключения агента', () => {
    expect(voiceOrbPresentation('connecting', true, 'thinking', 'on', 'get_position')).toEqual({
      state: 'connecting',
      label: 'Соединяюсь',
    });
  });
});
