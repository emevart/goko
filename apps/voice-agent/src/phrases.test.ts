import { describe, expect, it } from 'vitest';
import { colorName, describeResult, formatPoints, parseRank, speakMove, speakRank } from './phrases.ts';

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
});
