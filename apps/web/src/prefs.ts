// Настройки телефона (D-0011): режим «Голос / Чат», цвет человека и ранг Гоко для «Новой партии».
// Хранятся в localStorage. storage передаётся функцией: в Safari с запретом данных сайта исключение бросает
// уже обращение к window.localStorage, а не только getItem/setItem. Любое исключение — работаем с умолчаниями.
// Форы в NewGameRequest нет: выбор только цвета и ранга, коми и размер доски — от текущей партии.
import { RANKS, Rank, type GameState, type NewGameRequest } from '@goko/protocol';

export type Mode = 'voice' | 'chat';
export type ColorChoice = 'black' | 'white' | 'random';
export type Prefs = { mode: Mode; color: ColorChoice; rank: Rank };

export const PREFS_KEY = 'goko.prefs';
export const MODE_ATTRIBUTE = 'goko.mode';
export const DEFAULT_PREFS: Prefs = { mode: 'voice', color: 'black', rank: '10k' };
export const DEFAULT_KOMI = 7.5;

const isMode = (v: unknown): v is Mode => v === 'voice' || v === 'chat';
const isColor = (v: unknown): v is ColorChoice => v === 'black' || v === 'white' || v === 'random';
const isRank = (v: unknown): v is Rank => Rank.safeParse(v).success;

export function loadPrefs(storage: () => Pick<Storage, 'getItem'>): Prefs {
  try {
    const raw = storage().getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed: unknown = JSON.parse(raw);
    const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { mode?: unknown; color?: unknown; rank?: unknown };
    return {
      mode: isMode(o.mode) ? o.mode : DEFAULT_PREFS.mode,
      color: isColor(o.color) ? o.color : DEFAULT_PREFS.color,
      rank: isRank(o.rank) ? o.rank : DEFAULT_PREFS.rank,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(storage: () => Pick<Storage, 'setItem'>, prefs: Prefs): boolean {
  try {
    storage().setItem(PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false; // приватный режим или квота: выбор живёт до перезагрузки
  }
}

// RANKS упорядочен от 20k к 9d: +1 — сильнее, -1 — слабее.
export function stepRank(rank: Rank, delta: number): Rank {
  const i = RANKS.indexOf(rank);
  return RANKS[Math.max(0, Math.min(RANKS.length - 1, i + delta))] ?? rank;
}

export function newGameRequest(prefs: Prefs, current: GameState | null, random: () => number = Math.random): NewGameRequest {
  const humanBlack = prefs.color === 'black' || (prefs.color === 'random' && random() < 0.5);
  const human = { controller: 'human' as const };
  const engine = { controller: 'engine' as const, rank: prefs.rank };
  return {
    black: humanBlack ? human : engine,
    white: humanBlack ? engine : human,
    settings: current ? { boardSize: current.settings.boardSize, komi: current.settings.komi } : { komi: DEFAULT_KOMI },
    waitForReply: false, // ответ движка придёт событием
    via: 'tap',
  };
}

export const modeAttributes = (mode: Mode): Record<string, string> => ({ [MODE_ATTRIBUTE]: mode });
