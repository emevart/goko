import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
let anyFile = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'goko-doctor-main-'));
  mkdirSync(path.join(dir, 'scripts'));
  anyFile = path.join(dir, 'scripts', 'doctor.mjs');
  copyFileSync(path.join(HERE, 'doctor.mjs'), anyFile);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Options = { extraEnv?: Record<string, string>; withoutPath?: boolean; rawDotEnv?: string };

function runDoctor(vars: Record<string, string>, options: Options = {}): { lines: string[]; status: number | null } {
  writeFileSync(
    path.join(dir, '.env'),
    options.rawDotEnv ??
      Object.entries(vars)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
  );
  const env: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (options.withoutPath === true) {
    // Пустой PATH вместо снятого: cmd.exe без переменной берёт системный список каталогов.
    env.PATH = path.join(dir, 'empty');
    env.Path = env.PATH;
  }
  const res = spawnSync(process.execPath, [path.join(dir, 'scripts', 'doctor.mjs')], {
    env: { ...env, ...options.extraEnv },
    encoding: 'utf8',
  });
  return { lines: (res.stdout ?? '').split(/\r?\n/).filter((l) => l !== ''), status: res.status };
}

describe('doctor: боевой запуск', () => {
  it(
    'без ENGINE_KEY и WEB_HOST не говорит «можно работать» и называет обе переменные',
    () => {
      const { WEB_HOST: _webHost, ...withoutWebHost } = SPIKE;
      const { lines, status } = runDoctor(withoutWebHost);
      const joined = lines.join('\n');
      // Итог: обе недостающие переменные, и та, что ломает спайк, и та, что ломает движок.
      expect(lines).toContain('[!] doctor: инструменты на месте, но не запустится без WEB_HOST, ENGINE_KEY, APP_KEY');
      expect(joined).not.toContain('[OK] doctor: можно работать');
      // Отдельные строки-подсказки: без них у founder'а нет имени файла, куда смотреть.
      expect(lines).toContain('[!] env отсутствуют: WEB_HOST — спайк не запустится (см. infra/.env.example)');
      expect(lines).toContain('[!] env отсутствуют: ENGINE_KEY — go-engine не запустится (см. infra/.env.example)');
      expect(lines).toContain('[!] env отсутствуют: APP_KEY — game-server выходит с кодом 2 (см. infra/.env.example)');
      expect(joined).not.toContain('сейчас не нужны');
      expect(lines).toContain('[OK] env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, OPENAI_API_KEY');
      expect(lines).toContain("[!] AGENT_NAME не задан: спайк возьмёт продовое имя 'goko', на ПК нужен 'goko-dev'");
      expect(lines).toContain('[!] KATAGO_BIN не задан: движок будет недоступен, тесты движка пропускаются');
      expect(lines).toContain('[!] основная сеть не найдена (KATAGO_MODEL или apps/go-engine/models/README.md)');
      expect(lines).toContain('[!] человеческая сеть не найдена (KATAGO_HUMAN_MODEL или apps/go-engine/models/README.md)');
      // Инструменты на месте — иначе вердикт был бы другим, и строка про env потеряла бы смысл.
      expect(lines).toContain('[OK] npm');
      expect(lines).toContain('[OK] git');
      // Значений переменных нет нигде в выводе: репозиторий публичный.
      expect(joined).not.toContain(MARKER);
      expect(status).toBe(0); // не запустится ещё не значит «сломан инструмент»
    },
    60_000,
  );

  it(
    'когда всё на месте, говорит «можно работать» и молчит про отсутствующие',
    () => {
      const { lines, status } = runDoctor(
        {
          ...SPIKE,
          WEB_HOST: '', // пусто в .env, но задано в окружении: process.env должен победить
          ENGINE_KEY: `${MARKER}-engine`,
          APP_KEY: `${MARKER}-app`,
          AGENT_NAME: 'goko-dev',
          KATAGO_BIN: anyFile,
          KATAGO_MODEL: anyFile,
          KATAGO_HUMAN_MODEL: anyFile,
        },
        { extraEnv: { WEB_HOST: `${MARKER}.invalid` } },
      );
      const joined = lines.join('\n');
      expect(lines).toContain('[OK] doctor: можно работать');
      expect(lines).toContain('[OK] AGENT_NAME задан');
      expect(lines).toContain('[OK] KATAGO_BIN найден');
      expect(lines).toContain('[OK] основная сеть на месте (KATAGO_MODEL)');
      expect(lines).toContain('[OK] человеческая сеть на месте (KATAGO_HUMAN_MODEL)');
      expect(joined).not.toContain('не запустится');
      expect(joined).not.toContain('отсутствуют');
      expect(joined).not.toContain(MARKER);
      expect(status).toBe(0);
    },
    60_000,
  );

  it(
    'пустые и из пробелов значения — «не задано»: сети по умолчанию, KATAGO_BIN из пробелов не [X]',
    () => {
      // Сети по умолчанию лежат на месте: пустая переменная должна привести к ним, а не к пути ''.
      const models = path.join(dir, 'apps', 'go-engine', 'models');
      mkdirSync(models, { recursive: true });
      writeFileSync(path.join(models, 'kata1-b10c128-s1141046784-d204142634.txt.gz'), '');
      writeFileSync(path.join(models, 'b18c384nbt-humanv0.bin.gz'), '');
      const { lines, status } = runDoctor(
        { ...SPIKE, KATAGO_MODEL: '', ENGINE_KEY: '' },
        // Из пробелов — через окружение процесса: разбор .env сам обрезает значения без кавычек.
        { extraEnv: { KATAGO_HUMAN_MODEL: '  ', APP_KEY: '  ', WEB_HOST: '  ', AGENT_NAME: '  ', KATAGO_BIN: '  ' } },
      );
      expect(lines).toContain('[OK] основная сеть на месте (KATAGO_MODEL)');
      expect(lines).toContain('[OK] человеческая сеть на месте (KATAGO_HUMAN_MODEL)');
      expect(lines).toContain('[!] KATAGO_BIN не задан: движок будет недоступен, тесты движка пропускаются');
      expect(lines).toContain("[!] AGENT_NAME не задан: спайк возьмёт продовое имя 'goko', на ПК нужен 'goko-dev'");
      expect(lines).toContain('[!] env отсутствуют: WEB_HOST — спайк не запустится (см. infra/.env.example)');
      expect(lines).toContain('[!] env отсутствуют: ENGINE_KEY — go-engine не запустится (см. infra/.env.example)');
      expect(lines).toContain('[!] env отсутствуют: APP_KEY — game-server выходит с кодом 2 (см. infra/.env.example)');
      expect(lines).toContain('[!] doctor: инструменты на месте, но не запустится без WEB_HOST, ENGINE_KEY, APP_KEY');
      expect(lines.join('\n')).not.toContain(MARKER);
      expect(status).toBe(0);
    },
    60_000,
  );

  it(
    '.env, скопированный из infra/.env.example: пустые переменные с комментарием — «не задано», без ложного [X]',
    () => {
      const { lines, status } = runDoctor({}, { rawDotEnv: readFileSync(path.join(HERE, '..', 'infra', '.env.example'), 'utf8') });
      const joined = lines.join('\n');
      expect(joined).not.toContain('[X]');
      expect(lines).toContain('[!] KATAGO_BIN не задан: движок будет недоступен, тесты движка пропускаются');
      expect(lines).toContain('[!] env отсутствуют: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, OPENAI_API_KEY — спайк не запустится (см. infra/.env.example)');
      expect(lines).toContain('[!] env отсутствуют: ENGINE_KEY — go-engine не запустится (см. infra/.env.example)');
      expect(lines).toContain('[!] env отсутствуют: APP_KEY, LIVEKIT_API_KEY, LIVEKIT_API_SECRET — game-server выходит с кодом 2 (см. infra/.env.example)');
      // Имена в итоге без повторов: LIVEKIT_* нужны и спайку, и game-server.
      expect(lines).toContain('[!] doctor: инструменты на месте, но не запустится без LIVEKIT_API_KEY, LIVEKIT_API_SECRET, OPENAI_API_KEY, ENGINE_KEY, APP_KEY');
      expect(status).toBe(0);
    },
    60_000,
  );

  it(
    'без LIVEKIT_* game-server не стартует и при FAKE_ENGINE=1: строка game-server, а не только спайка',
    () => {
      const { LIVEKIT_URL: _url, ...withoutUrl } = SPIKE;
      const { lines } = runDoctor({ ...withoutUrl, ENGINE_KEY: `${MARKER}-engine`, APP_KEY: `${MARKER}-app`, FAKE_ENGINE: '1' });
      expect(lines).toContain('[!] env отсутствуют: LIVEKIT_URL — game-server выходит с кодом 2 (см. infra/.env.example)');
      expect(lines).toContain('[!] doctor: инструменты на месте, но не запустится без LIVEKIT_URL');
      expect(lines.join('\n')).not.toContain(MARKER);
    },
    60_000,
  );

  it(
    'сломанный инструмент — это [X] и код возврата 1, а не «не запустится»',
    () => {
      // Без PATH не находятся ни npm, ни git, ни docker; KATAGO_BIN указывает в никуда.
      const { lines, status } = runDoctor(
        { ...SPIKE, ENGINE_KEY: `${MARKER}-engine`, KATAGO_BIN: path.join(dir, 'no-such-katago') },
        { withoutPath: true },
      );
      expect(lines).toContain('[X] npm not found');
      expect(lines).toContain('[X] git not found');
      expect(lines).toContain('[!] docker не найден: образ движка не собрать, для dev не нужен');
      expect(lines).toContain('[X] KATAGO_BIN указывает на несуществующий файл');
      expect(lines).toContain('[X] doctor: есть блокирующие проблемы');
      expect(lines.join('\n')).not.toContain(MARKER);
      expect(status).toBe(1);
    },
    60_000,
  );
});
