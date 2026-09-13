import { describe, expect, it, vi } from 'vitest';
import { MAX_ID_LENGTH, isSafeId, newId } from './ids.ts';

describe('newId', () => {
  // Настоящая генерация, без подмены времени и случайности: 1000 id подряд укладываются в несколько
  // миллисекунд, и уникальность держит только случайная часть. При 3 байтах тест падал в ~0,7 % прогонов
  // — это и была вероятность коллизии двух партий в одну миллисекунду.
  it('уникален на 1000 id подряд', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });

  it('формат: base36 времени и 12 hex случайной части, 20 символов на нынешних часах', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-07T10:00:00.000Z'));
      const prefix = Date.parse('2026-09-07T10:00:00.000Z').toString(36);
      expect(prefix).toHaveLength(8);
      for (let i = 0; i < 100; i++) {
        const id = newId();
        expect(id).toMatch(/^[0-9a-z]{8}[0-9a-f]{12}$/);
        expect(id).toHaveLength(20);
        expect(id.startsWith(prefix)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('префикс — время в base36, поэтому идентификаторы сортируются по времени', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-07T10:00:00.000Z'));
      const earlier = newId();
      vi.setSystemTime(new Date('2026-09-07T11:00:00.000Z'));
      const later = newId();
      expect(earlier.slice(0, -12)).toBe(Date.parse('2026-09-07T10:00:00.000Z').toString(36));
      expect(earlier < later).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('newId проходит isSafeId', () => {
    for (let i = 0; i < 100; i++) expect(isSafeId(newId())).toBe(true);
  });
});

describe('isSafeId: идентификатор годится в имя файла снапшота', () => {
  it('цифры и строчные латинские буквы, длина от 1 до MAX_ID_LENGTH', () => {
    expect(MAX_ID_LENGTH).toBe(64);
    expect(isSafeId('a')).toBe(true);
    expect(isSafeId('0')).toBe(true);
    expect(isSafeId('mf3k2x0a1b2c3')).toBe(true);
    expect(isSafeId('z'.repeat(64))).toBe(true);
    expect(isSafeId('z'.repeat(65))).toBe(false);
    for (const id of ['', '../escaped', 'a/b', 'a\\b', '.', 'g1.json', 'ABC', 'a-b', 'a b', 'я']) expect(isSafeId(id), id).toBe(false);
  });

  it('зарезервированные имена Windows отвергаются без учёта регистра, соседние имена проходят', () => {
    const reserved = ['con', 'prn', 'aux', 'nul', ...Array.from({ length: 10 }, (_, i) => `com${i}`), ...Array.from({ length: 10 }, (_, i) => `lpt${i}`)];
    for (const id of reserved) {
      expect(isSafeId(id), id).toBe(false);
      expect(isSafeId(id.toUpperCase()), id.toUpperCase()).toBe(false);
    }
    for (const id of ['con1', 'xcon', 'nul0', 'com', 'lpt', 'com10', 'lpt10', 'coma', 'auxx', 'prnt']) expect(isSafeId(id), id).toBe(true);
  });
});
