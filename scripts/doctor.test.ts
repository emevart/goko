import { describe, expect, it } from 'vitest';
import { checkEnvNames, checkNodeVersion } from './doctor.mjs';

describe('doctor', () => {
  it('finds missing env names without printing values', () => {
    const res = checkEnvNames({ APP_KEY: 'x' }, ['APP_KEY', 'ENGINE_KEY']);
    expect(res.missing).toEqual(['ENGINE_KEY']);
    expect(res.present).toEqual(['APP_KEY']);
  });

  it('accepts node >= 22.18 and rejects older', () => {
    expect(checkNodeVersion('v22.18.0').ok).toBe(true);
    expect(checkNodeVersion('v22.22.0').ok).toBe(true);
    expect(checkNodeVersion('v22.12.0').ok).toBe(false);
    expect(checkNodeVersion('v20.19.0').ok).toBe(false);
  });
});
