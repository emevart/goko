import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Проводка внутри main(): чистые verdict() и checkEnvNames() её не покрывают, а ошибка
// ровно здесь однажды и дала «[OK] можно работать» при отсутствующем ENGINE_KEY.
// Doctor читает .env рядом с собой, поэтому копия скрипта живёт во временном каталоге.

const HERE = import.meta.dirname;

// Значения заведомо поддельные и узнаваемые: тест проверяет, что ни одно из них не печатается.
const MARKER = 'doctor-test-value';
const SPIKE = {
  LIVEKIT_URL: `wss://${MARKER}.invalid`,
  LIVEKIT_API_KEY: `${MARKER}-livekit-key`,
  LIVEKIT_API_SECRET: `${MARKER}-livekit-secret`,
  OPENAI_API_KEY: `${MARKER}-openai`,
  WEB_HOST: `${MARKER}.invalid`,
};

// Окружение подпроцесса собирается из белого списка: переменные Гоко с машины разработчика
// не должны подмешаться в проверку (process.env в doctor перекрывает .env).
const PASS_THROUGH = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'COMSPEC',
  'ComSpec',
  'windir',
  'TEMP',
  'TMP',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramData',
];

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'goko-doctor-main-'));
  mkdirSync(path.join(dir, 'scripts'));
  copyFileSync(path.join(HERE, 'doctor.mjs'), path.join(dir, 'scripts', 'doctor.mjs'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runDoctor(vars: Record<string, string>): { lines: string[]; status: number | null } {
  writeFileSync(
    path.join(dir, '.env'),
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const env: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const script = path.join(dir, 'scripts', 'doctor.mjs');
  const res = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  return { lines: (res.stdout ?? '').split(/\r?\n/).filter((l) => l !== ''), status: res.status };
}

describe('doctor: боевой запуск', () => {
  it(
    'без ENGINE_KEY и WEB_HOST не говорит «можно работать» и называет обе переменные',
    () => {
      const { WEB_HOST: _omit, ...withoutWebHost } = SPIKE;
      const { lines, status } = runDoctor(withoutWebHost);
      const joined = lines.join('\n');
      // Итог: обе недостающие переменные, и та, что ломает спайк, и та, что ломает движок.
      expect(lines).toContain('[!] doctor: инструменты на месте, но не запустится без WEB_HOST, ENGINE_KEY');
      expect(joined).not.toContain('[OK] doctor: можно работать');
      // Отдельные строки-подсказки: без них у founder'а нет имени файла, куда смотреть.
      expect(lines).toContain('[!] env отсутствуют: WEB_HOST — спайк не запустится (см. infra/.env.example)');
      expect(lines).toContain('[!] env отсутствуют: ENGINE_KEY — go-engine не запустится (см. infra/.env.example)');
      expect(lines).toContain('[OK] env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, OPENAI_API_KEY');
      // Значений переменных нет нигде в выводе: репозиторий публичный.
      expect(joined).not.toContain(MARKER);
      expect(status).toBe(0); // не запустится ещё не значит «сломан инструмент»
    },
    60_000,
  );

  it(
    'когда всё на месте, говорит «можно работать» и молчит про отсутствующие',
    () => {
      const { lines, status } = runDoctor({ ...SPIKE, ENGINE_KEY: `${MARKER}-engine`, APP_KEY: `${MARKER}-app` });
      const joined = lines.join('\n');
      expect(lines).toContain('[OK] doctor: можно работать');
      expect(joined).not.toContain('не запустится');
      expect(joined).not.toContain(MARKER);
      expect(status).toBe(0);
    },
    60_000,
  );
});
