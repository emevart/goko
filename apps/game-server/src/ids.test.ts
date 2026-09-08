import { describe, expect, it, vi } from 'vitest';
import { newId } from './ids.ts';

describe('newId', () => {
  it('уникален, из base36 времени и шести hex', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{8,}[0-9a-f]{6}$/);
  });

  it('префикс — время в base36, поэтому идентификаторы сортируются по времени', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-07T10:00:00.000Z'));
      const earlier = newId();
      vi.setSystemTime(new Date('2026-09-07T11:00:00.000Z'));
      const later = newId();
      expect(earlier.slice(0, -6)).toBe(Date.parse('2026-09-07T10:00:00.000Z').toString(36));
      expect(earlier < later).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
