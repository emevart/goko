// Чистая модель визуального состояния орба. Three.js здесь намеренно не импортируется:
// таблица состояний и переходы остаются тестируемыми без WebGL и без браузера.
export type OrbState = 'connecting' | 'muted' | 'listening' | 'thinking' | 'tool' | 'speaking' | 'error';
export type OrbRgb = readonly [number, number, number];

export type OrbVisual = {
  colorA: OrbRgb;
  colorB: OrbRgb;
  glow: OrbRgb;
  scale: number;
  pulse: number;
  speed: number;
  ringSpeed: number;
  particleSpeed: number;
  opacity: number;
};

const VISUALS: Record<OrbState, OrbVisual> = {
  connecting: { colorA: [0.48, 0.5, 0.55], colorB: [0.18, 0.22, 0.28], glow: [0.48, 0.5, 0.55], scale: 0.93, pulse: 0.15, speed: 0.12, ringSpeed: 0.18, particleSpeed: 0.12, opacity: 0.58 },
  muted: { colorA: [0.36, 0.42, 0.5], colorB: [0.12, 0.15, 0.2], glow: [0.36, 0.42, 0.5], scale: 0.94, pulse: 0.22, speed: 0.18, ringSpeed: 0.12, particleSpeed: 0.16, opacity: 0.7 },
  listening: { colorA: [0.42, 0.92, 0.72], colorB: [0.08, 0.38, 0.34], glow: [0.18, 0.78, 0.58], scale: 1, pulse: 0.72, speed: 0.8, ringSpeed: 0.75, particleSpeed: 0.95, opacity: 0.92 },
  thinking: { colorA: [0.74, 0.62, 1], colorB: [0.28, 0.18, 0.55], glow: [0.55, 0.36, 0.92], scale: 0.99, pulse: 0.48, speed: 0.5, ringSpeed: 0.56, particleSpeed: 0.48, opacity: 0.88 },
  tool: { colorA: [1, 0.84, 0.42], colorB: [0.62, 0.25, 0.06], glow: [0.95, 0.56, 0.16], scale: 1.01, pulse: 0.58, speed: 0.64, ringSpeed: 1.4, particleSpeed: 1.2, opacity: 0.94 },
  speaking: { colorA: [1, 0.82, 0.55], colorB: [0.7, 0.18, 0.13], glow: [1, 0.48, 0.22], scale: 1.03, pulse: 0.95, speed: 1.08, ringSpeed: 0.95, particleSpeed: 1.1, opacity: 0.98 },
  error: { colorA: [1, 0.58, 0.52], colorB: [0.42, 0.1, 0.12], glow: [0.85, 0.24, 0.2], scale: 0.97, pulse: 0.28, speed: 0.2, ringSpeed: 0.2, particleSpeed: 0.18, opacity: 0.82 },
};

export const orbVisualForState = (state: OrbState): OrbVisual => VISUALS[state];

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const lerp = (from: number, to: number, progress: number): number => from + (to - from) * clamp01(progress);

export function mixOrbVisual(from: OrbVisual, to: OrbVisual, progress: number): OrbVisual {
  const t = clamp01(progress);
  if (t === 0) return from;
  if (t === 1) return to;
  return {
    colorA: [lerp(from.colorA[0], to.colorA[0], t), lerp(from.colorA[1], to.colorA[1], t), lerp(from.colorA[2], to.colorA[2], t)],
    colorB: [lerp(from.colorB[0], to.colorB[0], t), lerp(from.colorB[1], to.colorB[1], t), lerp(from.colorB[2], to.colorB[2], t)],
    glow: [lerp(from.glow[0], to.glow[0], t), lerp(from.glow[1], to.glow[1], t), lerp(from.glow[2], to.glow[2], t)],
    scale: lerp(from.scale, to.scale, t),
    pulse: lerp(from.pulse, to.pulse, t),
    speed: lerp(from.speed, to.speed, t),
    ringSpeed: lerp(from.ringSpeed, to.ringSpeed, t),
    particleSpeed: lerp(from.particleSpeed, to.particleSpeed, t),
    opacity: lerp(from.opacity, to.opacity, t),
  };
}

export function transitionProgress(elapsedMs: number, durationMs = 460): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return clamp01(elapsedMs / durationMs);
}

export function smoothOrbLevel(current: number, target: number, deltaMs: number, attackMs = 42, releaseMs = 180): number {
  const safeTarget = clamp01(Number.isFinite(target) ? target : 0);
  const safeCurrent = clamp01(Number.isFinite(current) ? current : 0);
  const duration = safeTarget > safeCurrent ? attackMs : releaseMs;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return safeCurrent;
  if (duration <= 0) return safeTarget;
  const amount = 1 - Math.exp(-deltaMs / duration);
  return lerp(safeCurrent, safeTarget, amount);
}
