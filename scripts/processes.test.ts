import { describe, expect, it } from 'vitest';
import { spawnOptions } from './processes.mjs';

describe('processes: опции запуска детей', () => {
  it('stdio без наследования, по умолчанию скрыто, без shell и не detached', () => {
    const opts = spawnOptions({ cwd: '/repo', env: { A: '1' } });
    expect(opts).toEqual({ cwd: '/repo', env: { A: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: false, windowsHide: true });
  });

  it('shell, detached и windowsHide передаются как заданы', () => {
    expect(spawnOptions({ cwd: '/r', env: {}, shell: true, detached: true, windowsHide: false })).toMatchObject({ shell: true, detached: true, windowsHide: false });
  });
});
