import { describe, expect, it } from 'vitest';
import { colorName, colorNameInstrumental, describeResult, formatPoints, parseRank, speakMove, speakRank } from './phrases.ts';

describe('parseRank', () => {
  it('понимает кю и дан по-русски и по-английски', () => {
    expect(parseRank('10 кю')).toBe('10k');
    expect(parseRank('10k')).toBe('10k');
    expect(parseRank('3 дан')).toBe('3d');
    expect(parseRank('3d')).toBe('3d');
    expect(parseRank('первый дан')).toBeNull();
    expect(parseRank('1-й дан')).toBe('1d');
    expect(parseRank(' 5 kyu ')).toBe('5k');
    expect(parseRank('поставь 3 кю пожалуйста')).toBe('3k');
  });
  it('отвергает ранги вне списка и мусор', () => {
    expect(parseRank('25 кю')).toBeNull();
    expect(parseRank('10 дан')).toBeNull();
    expect(parseRank('сильно')).toBeNull();
    expect(parseRank('')).toBeNull();
  });
  it('порядковые суффиксы с дефисом и пробелами, английское dan, регистр и ведущий ноль', () => {
    expect(parseRank('1й дан')).toBe('1d');
    expect(parseRank('1-ый дан')).toBe('1d');
    expect(parseRank('1 - й дан')).toBe('1d');
    expect(parseRank('до 5-го кю')).toBe('5k');
    expect(parseRank('5-ого кю')).toBe('5k');
    expect(parseRank('2 dan')).toBe('2d');
    expect(parseRank('5K')).toBe('5k');
    expect(parseRank('3 ДАН')).toBe('3d');
    expect(parseRank('05 кю')).toBe('5k');
  });
  it('единица — отдельное слово, число — не больше двух цифр и не хвост длинного числа', () => {
    expect(parseRank('2 days')).toBeNull();
    expect(parseRank('3d4')).toBeNull();
    expect(parseRank('115 кю')).toBeNull();
    expect(parseRank('005 кю')).toBeNull();
  });
  it('родительный «дана» и порядковые -ой, -ий, -й у дан и кю', () => {
    expect(parseRank('3 дана')).toBe('3d');
    expect(parseRank('до 2-го дана')).toBe('2d');
    expect(parseRank('2-ой дан')).toBe('2d');
    expect(parseRank('3-ий дан')).toBe('3d');
    expect(parseRank('2-й дан')).toBe('2d');
    expect(parseRank('2-ой кю')).toBe('2k');
    expect(parseRank('3-ий кю')).toBe('3k');
    expect(parseRank('3 данные')).toBeNull();
  });
  it('дробное число — не ранг; запятая перед числом через пробел не мешает', () => {
    expect(parseRank('2,5 кю')).toBeNull();
    expect(parseRank('2.5 кю')).toBeNull();
    expect(parseRank('1,5 дан')).toBeNull();
    expect(parseRank('итак, 5 кю')).toBe('5k');
  });
});

describe('speakRank / speakMove / colorName', () => {
  it('произносит ранг, ход и цвет', () => {
    expect(speakRank('10k')).toBe('10 кю');
    expect(speakRank('2d')).toBe('2 дан');
    expect(speakMove('D4')).toBe('дэ четыре');
    expect(speakMove('pass')).toBe('пас');
    expect(colorName('B')).toBe('чёрные');
    expect(colorName('W')).toBe('белые');
  });
  it('цвет в творительном падеже', () => {
    expect(colorNameInstrumental('B')).toBe('чёрными');
    expect(colorNameInstrumental('W')).toBe('белыми');
  });
});

describe('formatPoints', () => {
  it('склоняет очки', () => {
    expect(formatPoints(1)).toBe('1 очко');
    expect(formatPoints(2)).toBe('2 очка');
    expect(formatPoints(5)).toBe('5 очков');
    expect(formatPoints(11)).toBe('11 очков');
    expect(formatPoints(21)).toBe('21 очко');
    expect(formatPoints(5.5)).toBe('5,5 очка');
    expect(formatPoints(0.5)).toBe('0,5 очка');
  });
  it('границы склонения, сотни и знак', () => {
    expect(formatPoints(4)).toBe('4 очка');
    expect(formatPoints(14)).toBe('14 очков');
    expect(formatPoints(111)).toBe('111 очков');
    expect(formatPoints(-3.5)).toBe('3,5 очка');
    expect(formatPoints(-1)).toBe('1 очко');
  });
});

describe('describeResult', () => {
  it('говорит от лица Гоко и без рода для человека', () => {
    expect(describeResult({ winner: 'B', reason: 'resign' }, 'B')).toBe('победа за тобой: я сдался');
    expect(describeResult({ winner: 'W', reason: 'resign' }, 'B')).toBe('победа за мной: партия сдана');
    expect(describeResult({ winner: 'W', margin: 5.5, reason: 'score' }, 'B')).toBe('победа за мной, разница 5,5 очка');
    expect(describeResult({ winner: 'B', margin: 12, reason: 'score' }, 'B')).toBe('победа за тобой, разница 12 очков');
  });
  it('в партии двух людей называет цвет победителя (D-0005)', () => {
    expect(describeResult({ winner: 'B', reason: 'resign' }, null)).toBe('победа чёрных: белые сдались');
    expect(describeResult({ winner: 'W', margin: 2.5, reason: 'score' }, null)).toBe('победа белых, разница 2,5 очка');
  });
  it('счёт без margin: разница 0 очков', () => {
    expect(describeResult({ winner: 'B', reason: 'score' }, 'B')).toBe('победа за тобой, разница 0 очков');
    expect(describeResult({ winner: 'B', reason: 'score' }, null)).toBe('победа чёрных, разница 0 очков');
  });
});
