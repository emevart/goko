import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { describe, expect, it } from 'vitest';
import { REQUIRED_ENV, checkEnvNames, checkNodeVersion, envValue, readDotEnv, verdict } from './doctor.mjs';

describe('doctor', () => {
  it('finds missing env names without printing values', () => {
    const res = checkEnvNames({ APP_KEY: 'x' }, ['APP_KEY', 'ENGINE_KEY']);
    expect(res.missing).toEqual(['ENGINE_KEY']);
    expect(res.present).toEqual(['APP_KEY']);
  });

  it('ENGINE_KEY нужен сейчас, а не «на стадии 1»: без него go-engine не стартует', () => {
    expect(REQUIRED_ENV.engine).toEqual(['ENGINE_KEY']);
    // Списка «понадобится потом» больше нет: всё, что читает запускаемый сервис, нужно сейчас.
    expect(Object.keys(REQUIRED_ENV)).toEqual(['spike', 'engine', 'gameServer']);
  });

  it('game-server без APP_KEY и LIVEKIT_* выходит с кодом 2, в том числе при FAKE_ENGINE=1', () => {
    expect(REQUIRED_ENV.gameServer).toEqual(['APP_KEY', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']);
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

  it('readDotEnv читает .env как process.loadEnvFile: комментарии в конце строки отрезаны, кавычки сняты', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'goko-doctor-'));
    const file = path.join(dir, '.env');
    try {
      // Знак = внутри значения — обычное дело для токенов: строка делится по первому, а не последнему.
      const lines = [
        '# ENGINE_KEY=commented',
        '',
        'APP_KEY="quoted"',
        'ENGINE_KEY=plain',
        'broken-line',
        'APP_URL=a=b',
        'KATAGO_BIN=                        # только на ПК',
        'WEB_HOST="with # hash"  # комментарий',
      ];
      writeFileSync(file, lines.join('\n'));
      expect(readDotEnv(file)).toEqual({ APP_KEY: 'quoted', ENGINE_KEY: 'plain', APP_URL: 'a=b', KATAGO_BIN: '', WEB_HOST: 'with # hash' });
      expect(readDotEnv(path.join(dir, 'missing.env'))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('infra/.env.example: пустые переменные с комментарием читаются пустыми, а не текстом комментария', () => {
    const example = readDotEnv(path.join(import.meta.dirname, '..', 'infra', '.env.example'));
    // Тот же разбор, что у dev и smoke (process.loadEnvFile).
    expect(example).toEqual(util.parseEnv(readFileSync(path.join(import.meta.dirname, '..', 'infra', '.env.example'), 'utf8')));
    for (const name of ['APP_KEY', 'ENGINE_KEY', 'KATAGO_BIN', 'KATAGO_MODEL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'TRUST_PROXY']) {
      expect(example[name], name).toBe('');
    }
    expect(checkEnvNames(example, REQUIRED_ENV.gameServer).missing).toEqual(['APP_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']);
  });

  it('accepts node >= 22.18 and rejects older', () => {
    expect(checkNodeVersion('v22.18.0').ok).toBe(true);
    expect(checkNodeVersion('v22.22.0').ok).toBe(true);
    expect(checkNodeVersion('v22.12.0').ok).toBe(false);
    expect(checkNodeVersion('v20.19.0').ok).toBe(false);
    expect(checkNodeVersion('unknown').ok).toBe(false); // неразобранная версия не считается годной
  });
});
