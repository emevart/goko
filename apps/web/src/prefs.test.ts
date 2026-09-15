import { describe, expect, it } from 'vitest';
import type { GameState } from '@goko/protocol';
import { DEFAULT_PREFS, PREFS_KEY, loadPrefs, modeAttributes, newGameRequest, savePrefs, stepRank } from './prefs.ts';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string): string | null => data.get(k) ?? null,
    setItem: (k: string, v: string): void => void data.set(k, v),
  };
}

describe('prefs: хранение режима, цвета и ранга (D-0011)', () => {
  it('без записи — умолчания: Голос, чёрные, 10k', () => {
    expect(loadPrefs(() => memory())).toEqual({ mode: 'voice', color: 'black', rank: '10k' });
  });
  it('сохраняет и читает обратно', () => {
    const s = memory();
    expect(savePrefs(() => s, { mode: 'chat', color: 'random', rank: '3d' })).toBe(true);
    expect(loadPrefs(() => s)).toEqual({ mode: 'chat', color: 'random', rank: '3d' });
  });
  it('битый JSON и чужие значения — умолчание по каждому полю отдельно', () => {
    expect(loadPrefs(() => memory({ [PREFS_KEY]: '{oops' }))).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(() => memory({ [PREFS_KEY]: 'null' }))).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(() => memory({ [PREFS_KEY]: '7' }))).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(() => memory({ [PREFS_KEY]: JSON.stringify({ mode: 'video', color: 'white', rank: '30k' }) }))).toEqual({
      mode: 'voice',
      color: 'white',
      rank: '10k',
    });
  });
  it('исключение localStorage при чтении и записи не роняет страницу', () => {
    const denied = (): never => {
      throw new DOMException('The operation is insecure.', 'SecurityError'); // Safari с запретом данных сайта
    };
    expect(loadPrefs(denied)).toEqual(DEFAULT_PREFS);
    expect(savePrefs(denied, DEFAULT_PREFS)).toBe(false);
    const broken = {
      getItem: (): string | null => {
        throw new Error('storage is broken');
      },
    };
    expect(loadPrefs(() => broken)).toEqual(DEFAULT_PREFS);
    const full = {
      setItem: (): void => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(savePrefs(() => full, { mode: 'chat', color: 'white', rank: '5k' })).toBe(false);
  });
});

describe('prefs: новая партия только полями NewGameRequest', () => {
  it('человек чёрными, Гоко белыми выбранного ранга, ответ движка не ждём', () => {
    expect(newGameRequest({ mode: 'voice', color: 'black', rank: '5k' }, null)).toEqual({
      black: { controller: 'human' },
      white: { controller: 'engine', rank: '5k' },
      settings: { komi: 7.5 },
      waitForReply: false,
      via: 'tap',
    });
  });
  it('белыми — места меняются; случайно — по жребию', () => {
    expect(newGameRequest({ ...DEFAULT_PREFS, color: 'white' }, null)).toMatchObject({
      black: { controller: 'engine', rank: '10k' },
      white: { controller: 'human' },
    });
    expect(newGameRequest({ ...DEFAULT_PREFS, color: 'random' }, null, () => 0.2).black).toEqual({ controller: 'human' });
    expect(newGameRequest({ ...DEFAULT_PREFS, color: 'random' }, null, () => 0.7).black).toEqual({ controller: 'engine', rank: '10k' });
  });
  it('размер доски и коми берёт у текущей партии', () => {
    const current = { settings: { boardSize: 9, rules: 'chinese', komi: 5.5 } } as const;
    expect(newGameRequest(DEFAULT_PREFS, current as unknown as GameState).settings).toEqual({ boardSize: 9, komi: 5.5 });
  });
  it('stepRank ходит по списку рангов и упирается в края', () => {
    expect(stepRank('10k', 1)).toBe('9k');
    expect(stepRank('1k', 1)).toBe('1d');
    expect(stepRank('1d', -1)).toBe('1k');
    expect(stepRank('20k', -1)).toBe('20k');
    expect(stepRank('9d', 1)).toBe('9d');
    expect(stepRank('19k', -5)).toBe('20k');
    expect(stepRank('8d', 5)).toBe('9d');
  });
  it('атрибут участника для режима', () => {
    expect(modeAttributes('chat')).toEqual({ 'goko.mode': 'chat' });
    expect(modeAttributes('voice')).toEqual({ 'goko.mode': 'voice' });
  });
});
