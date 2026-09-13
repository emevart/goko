import { describe, expect, it } from 'vitest';
import { errorDetail } from './error-detail.ts';

describe('errorDetail', () => {
  it('текст исключения вместе с цепочкой cause', () => {
    const root = new TypeError('connect ECONNREFUSED');
    const mid = new Error('fetch failed', { cause: root });
    expect(errorDetail(new Error('engine is unreachable', { cause: mid }))).toBe('engine is unreachable: fetch failed: connect ECONNREFUSED');
  });

  it('не Error и cause не Error — строкой', () => {
    expect(errorDetail('boom')).toBe('boom');
    expect(errorDetail(new Error('outer', { cause: 42 }))).toBe('outer: 42');
  });

  it('цепочка ограничена пятью звеньями: зацикленная cause не вешает лог', () => {
    const loop = new Error('loop');
    (loop as { cause?: unknown }).cause = loop;
    expect(errorDetail(loop)).toBe(new Array(5).fill('loop').join(': '));
  });
});
