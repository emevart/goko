import { describe, expect, it } from 'vitest';
import {
  InvalidCoordError,
  coordToIndex,
  formatCoord,
  fromIndex,
  indexToCoord,
  parseCoord,
  speakCoord,
  toIndex,
} from './coords.ts';

describe('parseCoord', () => {
  it('принимает латиницу в любом регистре и с пробелом', () => {
    expect(parseCoord('D4', 13)).toEqual({ col: 3, row: 3 });
    expect(parseCoord('d4', 13)).toEqual({ col: 3, row: 3 });
    expect(parseCoord('D 4', 13)).toEqual({ col: 3, row: 3 });
    expect(parseCoord(' k10 ', 13)).toEqual({ col: 9, row: 9 });
  });

  it('пропускает I: J — десятый столбец', () => {
    expect(parseCoord('J1', 13)).toEqual({ col: 8, row: 0 });
    expect(parseCoord('N13', 13)).toEqual({ col: 12, row: 12 });
  });

  it('заменяет кириллические двойники', () => {
    expect(parseCoord('В4', 13)).toEqual({ col: 1, row: 3 }); // кириллическая В
    expect(parseCoord('к10', 13)).toEqual({ col: 9, row: 9 }); // кириллическая к
    expect(parseCoord('Е7', 13)).toEqual({ col: 4, row: 6 }); // кириллическая Е
  });

  it('распознаёт пас', () => {
    expect(parseCoord('pass', 13)).toBe('pass');
    expect(parseCoord('Пас', 13)).toBe('pass');
  });

  it('отвергает I, выход за доску и мусор', () => {
    expect(() => parseCoord('I5', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('D14', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('D0', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('O1', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('Z9', 19)).toThrow(InvalidCoordError);
    expect(() => parseCoord('foo', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('', 13)).toThrow(InvalidCoordError);
  });
});

describe('индексация', () => {
  it('A1 = 0, B1 = 1, A2 = size, N13 = 168 на 13x13', () => {
    expect(coordToIndex('A1', 13)).toBe(0);
    expect(coordToIndex('B1', 13)).toBe(1);
    expect(coordToIndex('A2', 13)).toBe(13);
    expect(coordToIndex('N13', 13)).toBe(168);
  });

  it('туда и обратно', () => {
    for (let i = 0; i < 169; i++) {
      expect(coordToIndex(indexToCoord(i, 13), 13)).toBe(i);
      expect(toIndex(fromIndex(i, 13), 13)).toBe(i);
    }
    expect(formatCoord(parseCoord('K10', 13) as { col: number; row: number })).toBe('K10');
  });

  it('coordToIndex не принимает пас', () => {
    expect(() => coordToIndex('pass', 13)).toThrow(InvalidCoordError);
  });
});

describe('speakCoord', () => {
  it('называет столбец по-русски и число словом', () => {
    expect(speakCoord('D4')).toBe('дэ четыре');
    expect(speakCoord('K10')).toBe('ка десять');
    expect(speakCoord('N13')).toBe('эн тринадцать');
    expect(speakCoord('A1')).toBe('а один');
    expect(speakCoord('pass')).toBe('пас');
  });
});
