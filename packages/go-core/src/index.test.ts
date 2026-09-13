import { describe, expect, it } from 'vitest';
import * as core from './index.ts';
import { positionFromRows } from './testing.ts';

describe('публичная поверхность пакета', () => {
  it('тестовые помощники не в index.ts, а по подпути @goko/go-core/testing', async () => {
    expect(Object.keys(core)).toContain('play');
    expect(Object.keys(core)).not.toContain('positionFromRows');
    const testing = await import('@goko/go-core/testing');
    expect(testing.positionFromRows).toBe(positionFromRows);
  });
});
