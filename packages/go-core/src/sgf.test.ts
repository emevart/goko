import { describe, expect, it } from 'vitest';
import { fromSgf, toSgf } from './sgf.ts';

describe('sgf', () => {
  const game = {
    size: 13,
    komi: 7.5,
    rules: 'Chinese',
    black: 'Human',
    white: 'Goko 10k',
    result: 'B+5.5',
    moves: [
      { color: 'B' as const, coord: 'D4' },
      { color: 'W' as const, coord: 'K10' },
      { color: 'B' as const, coord: 'pass' },
      { color: 'W' as const, coord: 'A13' },
    ],
  };

  it('пишет заголовок и ходы в координатах SGF (строки сверху)', () => {
    expect(toSgf(game)).toBe('(;FF[4]GM[1]CA[UTF-8]SZ[13]KM[7.5]RU[Chinese]PB[Human]PW[Goko 10k]RE[B+5.5];B[dj];W[jd];B[];W[aa])');
  });

  it('туда и обратно', () => {
    expect(fromSgf(toSgf(game))).toEqual(game);
  });

  it('разбирает SGF без необязательных полей', () => {
    expect(fromSgf('(;FF[4]GM[1]SZ[9]KM[6.5];B[ee];W[])')).toEqual({
      size: 9,
      komi: 6.5,
      moves: [
        { color: 'B', coord: 'E5' },
        { color: 'W', coord: 'pass' },
      ],
    });
  });

  it('экранирует ] и \\ в значениях', () => {
    const s = toSgf({ ...game, black: 'a]b\\c', moves: [] });
    expect(s).toContain('PB[a\\]b\\\\c]');
    expect(fromSgf(s).black).toBe('a]b\\c');
  });
});
