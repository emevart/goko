// Координаты доски: столбцы A..T без I, строки 1..size снизу вверх.
// Внутренняя индексация: row * size + col, где row 0 — строка «1».

export const COLUMN_LETTERS = 'ABCDEFGHJKLMNOPQRST';

export type Point = { col: number; row: number };

export class InvalidCoordError extends Error {
  readonly text: string;

  constructor(text: string, reason: string) {
    super(`invalid coord "${text}": ${reason}`);
    this.name = 'InvalidCoordError';
    this.text = text;
  }
}

// Кириллические буквы, которые выглядят как латинские: транскрипт речи их путает.
const CYRILLIC_TO_LATIN: Record<string, string> = {
  А: 'A',
  В: 'B',
  С: 'C',
  Е: 'E',
  Н: 'H',
  К: 'K',
  М: 'M',
  О: 'O',
  Р: 'P',
  Т: 'T',
};

// Класс кириллических букв строится из карты: один источник списка, забыть
// букву в одном из двух мест невозможно.
const CYRILLIC_PATTERN = new RegExp(`[${Object.keys(CYRILLIC_TO_LATIN).join('')}]`, 'g');

// Известная граница: разделители склеиваются, поэтому 'D 1 3' — валидный ход D13.
// Цена — редкая неверная координата, выгода — устойчивость к транскрипту речи.
export function normalizeCoordText(text: string): string {
  return text
    .trim()
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(CYRILLIC_PATTERN, (ch) => CYRILLIC_TO_LATIN[ch] as string);
}

// Пас сверяется по нормализованному тексту, как и координата: из одного
// транскрипта не должно получаться двух разных правил разбора.
function isPassText(text: string): boolean {
  const norm = text.toLowerCase().replace(/[\s\-_.]/g, '');
  return norm === 'pass' || norm === 'пас';
}

export function parseCoord(text: string, size: number): Point | 'pass' {
  if (isPassText(text)) return 'pass';
  const norm = normalizeCoordText(text);
  const m = /^([A-Z])(\d{1,2})$/.exec(norm);
  if (!m) throw new InvalidCoordError(text, 'expected a letter and a number, e.g. D4');
  const letter = m[1] ?? '';
  // Ветка существует ради понятного сообщения: буквы I нет в COLUMN_LETTERS,
  // проверка col < 0 отсекла бы её и без этой строки.
  if (letter === 'I') throw new InvalidCoordError(text, 'column I does not exist');
  const col = COLUMN_LETTERS.indexOf(letter);
  const row = Number(m[2]) - 1;
  if (col < 0 || col >= size) throw new InvalidCoordError(text, `column is outside the ${size}x${size} board`);
  if (row < 0 || row >= size) throw new InvalidCoordError(text, `row is outside the ${size}x${size} board`);
  return { col, row };
}

// Размера доски здесь нет: проверяем то, что можем — столбец по списку букв
// и неотрицательную строку.
export function formatCoord(p: Point): string {
  if (p.col < 0 || p.col >= COLUMN_LETTERS.length || p.row < 0) {
    throw new InvalidCoordError(`${p.col},${p.row}`, 'point is outside the letters range');
  }
  return `${COLUMN_LETTERS.charAt(p.col)}${p.row + 1}`;
}

export function toIndex(p: Point, size: number): number {
  if (p.col < 0 || p.col >= size || p.row < 0 || p.row >= size) {
    throw new InvalidCoordError(`${p.col},${p.row}`, `point is outside the ${size}x${size} board`);
  }
  return p.row * size + p.col;
}

export function fromIndex(index: number, size: number): Point {
  if (index < 0 || index >= size * size) {
    throw new InvalidCoordError(String(index), `index is outside the ${size}x${size} board`);
  }
  return { col: index % size, row: Math.floor(index / size) };
}

export function coordToIndex(coord: string, size: number): number {
  const p = parseCoord(coord, size);
  if (p === 'pass') throw new InvalidCoordError(coord, 'pass has no index');
  return toIndex(p, size);
}

export function indexToCoord(index: number, size: number): string {
  if (index < 0 || index >= size * size) {
    throw new InvalidCoordError(String(index), `index is outside the ${size}x${size} board`);
  }
  return formatCoord(fromIndex(index, size));
}

// Произношение для промпта и озвучивания: столбцы по спеке, числа словами.
export const COLUMN_NAMES_RU: Record<string, string> = {
  A: 'а',
  B: 'бэ',
  C: 'цэ',
  D: 'дэ',
  E: 'е',
  F: 'эф',
  G: 'гэ',
  H: 'аш',
  J: 'джей',
  K: 'ка',
  L: 'эль',
  M: 'эм',
  N: 'эн',
  O: 'о',
  P: 'пэ',
  Q: 'ку',
  R: 'эр',
  S: 'эс',
  T: 'тэ',
};

const NUMBERS_RU = [
  '',
  'один',
  'два',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
];

export function speakCoord(coord: string): string {
  const p = parseCoord(coord, 19);
  if (p === 'pass') return 'пас';
  const letter = COLUMN_LETTERS.charAt(p.col);
  return `${COLUMN_NAMES_RU[letter] ?? letter.toLowerCase()} ${NUMBERS_RU[p.row + 1] ?? String(p.row + 1)}`;
}
