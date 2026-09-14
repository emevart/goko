import { describe, expect, it } from 'vitest';
import { sessionIdOf } from './metadata.ts';

describe('sessionIdOf', () => {
  it('берёт sessionId из метаданных диспетчеризации', () => {
    expect(sessionIdOf('{"sessionId":"abc"}', 'goko-abc')).toBe('abc');
    // Имя комнаты другое: ответ — именно из метаданных, а не совпадение с goko-<id>.
    expect(sessionIdOf('{"sessionId":"abc"}', 'room')).toBe('abc');
  });
  it('sessionId не строкой, JSON не объект — из имени комнаты; префикс goko- снимается только в начале', () => {
    expect(sessionIdOf('{"sessionId":42}', 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('null', 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('"abc"', 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf(undefined, 'my-goko-1')).toBe('my-goko-1');
  });
  it('без метаданных — из имени комнаты goko-<id>', () => {
    expect(sessionIdOf(undefined, 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('', 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('not json', 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('{"other":1}', 'room')).toBe('room');
  });
});
