import { describe, expect, it } from 'vitest';
import { REQUIRED_ENV, checkEnvNames, checkNodeVersion, verdict } from './doctor.mjs';

describe('doctor', () => {
  it('finds missing env names without printing values', () => {
    const res = checkEnvNames({ APP_KEY: 'x' }, ['APP_KEY', 'ENGINE_KEY']);
    expect(res.missing).toEqual(['ENGINE_KEY']);
    expect(res.present).toEqual(['APP_KEY']);
  });

  it('ENGINE_KEY нужен сейчас, а не «на стадии 1»: без него go-engine не стартует', () => {
    expect(REQUIRED_ENV.engine).toContain('ENGINE_KEY');
    expect(REQUIRED_ENV.later).not.toContain('ENGINE_KEY');
  });

  it('вердикт не говорит «можно работать», если сервис без переменной не запустится', () => {
    expect(verdict({ failed: false, blockers: [] })).toBe('[OK] doctor: можно работать');
    const withEngineKey = verdict({ failed: false, blockers: ['ENGINE_KEY'] });
    expect(withEngineKey.startsWith('[OK]')).toBe(false);
    expect(withEngineKey).toContain('ENGINE_KEY');
    expect(verdict({ failed: true, blockers: [] }).startsWith('[X]')).toBe(true);
  });

  it('вердикт не печатает значений переменных, только имена', () => {
    const line = verdict({ failed: false, blockers: ['ENGINE_KEY', 'OPENAI_API_KEY'] });
    expect(line).toBe('[!] doctor: инструменты на месте, но не запустится без ENGINE_KEY, OPENAI_API_KEY');
  });

  it('accepts node >= 22.18 and rejects older', () => {
    expect(checkNodeVersion('v22.18.0').ok).toBe(true);
    expect(checkNodeVersion('v22.22.0').ok).toBe(true);
    expect(checkNodeVersion('v22.12.0').ok).toBe(false);
    expect(checkNodeVersion('v20.19.0').ok).toBe(false);
  });
});
