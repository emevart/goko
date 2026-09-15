import { describe, expect, it } from 'vitest';
import { recordingStopReasonLabel } from './components/DiagnosticRecording.tsx';

describe('DiagnosticRecording', () => {
  it('показывает человеку русские причины остановки вместо enum протокола', () => {
    expect(recordingStopReasonLabel('user')).toBe('остановлена вручную');
    expect(recordingStopReasonLabel('mode-off')).toBe('голос выключен');
    expect(recordingStopReasonLabel('track-change')).toBe('аудиодорожка изменилась');
    expect(recordingStopReasonLabel('error')).toBe('ошибка записи');
  });
});
