// KataGo отдаёт policy/ownership строками сверху вниз (A13..N13, ..., A1..N1); наша индексация — снизу.
// Ответы движка нам не подконтрольны, поэтому длины и индексы проверяются на этой границе:
// молча подставленное значение по умолчанию здесь превратилось бы в ход не в ту точку.
import { indexToCoord } from '@goko/go-core';

// kataIndexToOurs и oursToKataIndex намеренно имеют одинаковое тело: пересчёт — отражение
// строк, то есть инволюция, и обратная функция совпадает с прямой. Две функции оставлены
// ради читаемости на месте вызова; это не копипаста, «чинить» их не нужно.
export function kataIndexToOurs(kataIndex: number, size: number): number {
  const rowFromTop = Math.floor(kataIndex / size);
  const col = kataIndex % size;
  return (size - 1 - rowFromTop) * size + col;
}

export function oursToKataIndex(index: number, size: number): number {
  const row = Math.floor(index / size);
  const col = index % size;
  return (size - 1 - row) * size + col;
}

export function kataIndexToCoord(kataIndex: number, size: number): string {
  const passIndex = size * size;
  // Контракт: целое в [0, size * size], верхняя граница включительно — это пас.
  if (!Number.isInteger(kataIndex) || kataIndex < 0 || kataIndex > passIndex) {
    throw new Error(
      `invalid KataGo index ${kataIndex}: expected an integer in [0, ${passIndex}] for a ${size}x${size} board`,
    );
  }
  if (kataIndex === passIndex) return 'pass';
  return indexToCoord(kataIndexToOurs(kataIndex, size), size);
}

export function reorderFromKata(values: readonly number[], size: number): number[] {
  const area = size * size;
  // Массивы движка бывают двух длин: ownership — ровно на доску, policy — с местом под пас
  // в конце. Пас на доску не переносится, всё прочее — сломанный ответ движка, не ноль.
  if (values.length !== area && values.length !== area + 1) {
    throw new Error(
      `invalid KataGo array length ${values.length}: expected ${area} or ${area + 1} for a ${size}x${size} board`,
    );
  }
  const out = new Array<number>(area).fill(0);
  for (let k = 0; k < area; k++) {
    const value = values[k];
    if (value === undefined) throw new Error(`invalid KataGo array: missing value at index ${k}`);
    out[kataIndexToOurs(k, size)] = value;
  }
  return out;
}

// Источник истины по разрядам — схема Rank в packages/protocol (20k..1k, 1d..9d); здесь она
// повторена регулярным выражением, чтобы пакет не зависел от протокола. Опечатка в разряде
// должна падать здесь, а не возвращаться невнятной ошибкой из KataGo.
const RANK_PATTERN = /^(?:20|1[0-9]|[1-9])k$|^[1-9]d$/;

export function rankToProfile(rank: string): string {
  if (!RANK_PATTERN.test(rank)) {
    throw new Error(`invalid rank "${rank}": expected 20k..1k or 1d..9d`);
  }
  return `rank_${rank}`;
}
