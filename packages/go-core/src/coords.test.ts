import { describe, expect, it } from 'vitest';
import {
  InvalidCoordError,
  coordToIndex,
  formatCoord,
  fromIndex,
  indexToCoord,
  normalizeCoordText,
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
    expect(parseCoord('А1', 13)).toEqual({ col: 0, row: 0 }); // кириллическая А
    expect(parseCoord('В4', 13)).toEqual({ col: 1, row: 3 }); // кириллическая В
    expect(parseCoord('С2', 13)).toEqual({ col: 2, row: 1 }); // кириллическая С
    expect(parseCoord('Е7', 13)).toEqual({ col: 4, row: 6 }); // кириллическая Е
    expect(parseCoord('Н5', 13)).toEqual({ col: 7, row: 4 }); // кириллическая Н
    expect(parseCoord('к10', 13)).toEqual({ col: 9, row: 9 }); // кириллическая к
    expect(parseCoord('М3', 13)).toEqual({ col: 11, row: 2 }); // кириллическая М
    expect(parseCoord('О1', 19)).toEqual({ col: 13, row: 0 }); // кириллическая О
    expect(parseCoord('Р1', 19)).toEqual({ col: 14, row: 0 }); // кириллическая Р
    expect(parseCoord('Т1', 19)).toEqual({ col: 18, row: 0 }); // кириллическая Т
  });

  it('терпит слитую и разделённую запись координаты', () => {
    expect(parseCoord('D04', 13)).toEqual({ col: 3, row: 3 });
    expect(parseCoord('D.4', 13)).toEqual({ col: 3, row: 3 });
  });

  it('распознаёт пас в любой записи', () => {
    expect(parseCoord('pass', 13)).toBe('pass');
    expect(parseCoord('PASS', 13)).toBe('pass');
    expect(parseCoord('Пас', 13)).toBe('pass');
    expect(parseCoord('пас', 13)).toBe('pass');
    expect(parseCoord('П А С', 13)).toBe('pass');
    expect(parseCoord('па-с', 13)).toBe('pass');
  });

  it('отвергает I, выход за доску и мусор', () => {
    expect(() => parseCoord('I5', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('D14', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('D0', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('O1', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('Z9', 19)).toThrow(InvalidCoordError);
    expect(() => parseCoord('foo', 13)).toThrow(InvalidCoordError);
    expect(() => parseCoord('', 13)).toThrow(InvalidCoordError);
    // Д в карту двойников не входит намеренно: русские названия букв
    // в координату переводит голосовой агент, а не парсер.
    expect(() => parseCoord('Д4', 13)).toThrow(InvalidCoordError);
  });

  it('объясняет, что столбца I не существует', () => {
    expect(() => parseCoord('I4', 13)).toThrow(/column I does not exist/);
  });
});

describe('normalizeCoordText', () => {
  it('приводит регистр, срезает разделители и кириллицу из карты', () => {
    expect(normalizeCoordText('d 4')).toBe('D4');
    expect(normalizeCoordText('В4')).toBe('B4');
    expect(normalizeCoordText('D.4')).toBe('D4');
    expect(normalizeCoordText('D_4')).toBe('D4');
    expect(normalizeCoordText('D-4')).toBe('D4');
  });

  it('оставляет кириллицу вне карты как есть', () => {
    expect(normalizeCoordText('Д4')).toBe('Д4');
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

  it('отвергает индексы и точки вне доски', () => {
    expect(() => fromIndex(-1, 13)).toThrow(InvalidCoordError);
    expect(() => fromIndex(169, 13)).toThrow(InvalidCoordError);
    expect(() => indexToCoord(999, 13)).toThrow(InvalidCoordError);
    expect(() => toIndex({ col: 13, row: 0 }, 13)).toThrow(InvalidCoordError);
    expect(() => toIndex({ col: 0, row: -1 }, 13)).toThrow(InvalidCoordError);
    expect(() => formatCoord({ col: 99, row: 0 })).toThrow(InvalidCoordError);
    expect(() => formatCoord({ col: 0, row: -1 })).toThrow(InvalidCoordError);
  });

  it('принимает валидные границы', () => {
    expect(fromIndex(168, 13)).toEqual({ col: 12, row: 12 });
    expect(toIndex({ col: 12, row: 12 }, 13)).toBe(168);
    expect(fromIndex(0, 13)).toEqual({ col: 0, row: 0 });
    expect(formatCoord({ col: 18, row: 18 })).toBe('T19');
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
