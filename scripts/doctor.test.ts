import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_ENV, checkEnvNames, checkNodeVersion, envValue, readDotEnv, verdict } from './doctor.mjs';

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

  it('список переменных спайка закреплён: doctor не должен «забыть» WEB_HOST', () => {
    // Исходная боль: doctor писал «можно работать», а npm run token падал на WEB_HOST.
    expect(REQUIRED_ENV.spike).toEqual([
      'LIVEKIT_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      'OPENAI_API_KEY',
      'WEB_HOST',
    ]);
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

  it('пустое значение переменной считается отсутствующим', () => {
    // Пустая строка в .env — самая частая форма «переменной нет»: сервис на ней падает так же.
    const res = checkEnvNames({ APP_KEY: '', ENGINE_KEY: 'x' }, ['APP_KEY', 'ENGINE_KEY']);
    expect(res.missing).toEqual(['APP_KEY']);
    expect(res.present).toEqual(['ENGINE_KEY']);
  });

  it('значение из пробелов тоже считается отсутствующим', () => {
    const res = checkEnvNames({ APP_KEY: ' \t', ENGINE_KEY: ' x ' }, ['APP_KEY', 'ENGINE_KEY']);
    expect(res.missing).toEqual(['APP_KEY']);
    expect(res.present).toEqual(['ENGINE_KEY']);
    expect(envValue({ A: '', B: '  ', C: 'x' }, 'A')).toBeUndefined();
    expect(envValue({ A: '', B: '  ', C: 'x' }, 'B')).toBeUndefined();
    expect(envValue({ A: '', B: '  ', C: 'x' }, 'C')).toBe('x');
    expect(envValue({}, 'D')).toBeUndefined();
  });

  it('readDotEnv пропускает комментарии и пустые строки, снимает кавычки', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'goko-doctor-'));
    const file = path.join(dir, '.env');
    try {
      // Знак = внутри значения — обычное дело для токенов: строка делится по первому, а не последнему.
      const lines = ['# ENGINE_KEY=commented', '', 'APP_KEY="quoted"', 'ENGINE_KEY=plain', 'broken-line', 'APP_URL=a=b'];
      writeFileSync(file, lines.join('\n'));
      expect(readDotEnv(file)).toEqual({ APP_KEY: 'quoted', ENGINE_KEY: 'plain', APP_URL: 'a=b' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts node >= 22.18 and rejects older', () => {
    expect(checkNodeVersion('v22.18.0').ok).toBe(true);
    expect(checkNodeVersion('v22.22.0').ok).toBe(true);
    expect(checkNodeVersion('v22.12.0').ok).toBe(false);
    expect(checkNodeVersion('v20.19.0').ok).toBe(false);
    expect(checkNodeVersion('unknown').ok).toBe(false); // неразобранная версия не считается годной
  });
});
