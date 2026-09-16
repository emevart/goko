import { describe, expect, it } from 'vitest';
import { mixOrbVisual, orbVisualForState, smoothOrbLevel, transitionProgress } from './orb.ts';

describe('модель орба', () => {
  it('даёт разные устойчивые визуальные профили для состояний', () => {
    const listening = orbVisualForState('listening');
    const speaking = orbVisualForState('speaking');
    expect(listening.pulse).toBeLessThan(speaking.pulse);
    expect(listening.colorA).not.toEqual(speaking.colorA);
  });

  it('интерполирует переход без скачка и ограничивает прогресс', () => {
    const from = orbVisualForState('muted');
    const to = orbVisualForState('speaking');
    expect(mixOrbVisual(from, to, 0)).toEqual(from);
    expect(mixOrbVisual(from, to, 1)).toEqual(to);
    expect(mixOrbVisual(from, to, 0.5).scale).toBeCloseTo((from.scale + to.scale) / 2);
    expect(mixOrbVisual(from, to, 3).opacity).toBe(to.opacity);
  });

  it('сглаживает уровень с быстрой атакой и более длинным спадом', () => {
    expect(smoothOrbLevel(0, 1, 42)).toBeGreaterThan(0.5);
    expect(smoothOrbLevel(1, 0, 180)).toBeLessThan(0.5);
    expect(smoothOrbLevel(0.4, 0.9, 0)).toBe(0.4);
  });

  it('ограничивает длительность перехода', () => {
    expect(transitionProgress(-1, 460)).toBe(0);
    expect(transitionProgress(230, 460)).toBeCloseTo(0.5);
    expect(transitionProgress(1000, 460)).toBe(1);
  });
});
