import { describe, expect, it } from 'vitest';
import { sessionIdOf } from './metadata.ts';

describe('sessionIdOf', () => {
  it('берёт sessionId из метаданных диспетчеризации', () => {
    expect(sessionIdOf('{"sessionId":"abc"}', 'goko-abc')).toBe('abc');
  });
  it('без метаданных — из имени комнаты goko-<id>', () => {
    expect(sessionIdOf(undefined, 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('', 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('not json', 'goko-xyz')).toBe('xyz');
    expect(sessionIdOf('{"other":1}', 'room')).toBe('room');
  });
});
