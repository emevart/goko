#!/usr/bin/env node
// Проверка окружения для агентов и founder'а. Ничего не меняет, значения env не печатает.
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function checkNodeVersion(version) {
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return { ok: false, reason: `cannot parse ${version}` };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const ok = major > 22 || (major === 22 && minor >= 18);
  return { ok, reason: ok ? '' : `need >= 22.18, got ${version}` };
}

// Пустая или из пробелов переменная — то же, что не заданная: так её читают game-server и go-engine,
// а infra/.env.example перечисляет необязательные переменные с пустыми значениями.
export function envValue(env, name) {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

export function checkEnvNames(env, required) {
  const present = required.filter((k) => envValue(env, k) !== undefined);
  const missing = required.filter((k) => !present.includes(k));
  return { present, missing };
}

export function readDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

// Что чем ломается. Списки разделены по последствию, а не по «стадии»: doctor не должен
// писать «можно работать» там, где сервис выходит с кодом 2 из-за отсутствующей переменной.
export const REQUIRED_ENV = {
  // Без этих пяти голосовой спайк не запускается: agent.ts, chat.mjs, token.mjs.
  spike: ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'OPENAI_API_KEY', 'WEB_HOST'],
  // ENGINE_KEY читает apps/go-engine/src/start-engine.ts: без него go-engine выходит с кодом 2.
  engine: ['ENGINE_KEY'],
  // Понадобится game-server'у; сейчас его никто не читает.
  later: ['APP_KEY'],
};

// Итоговая строка. blockers — имена переменных, без которых сервис не поднимется;
// значения переменных сюда не попадают никогда, только имена.
export function verdict({ failed, blockers }) {
  if (failed) return '[X] doctor: есть блокирующие проблемы';
  if (blockers.length) return `[!] doctor: инструменты на месте, но не запустится без ${blockers.join(', ')}`;
  return '[OK] doctor: можно работать';
}

function has(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let failed = false;
  const ok = (msg) => console.log(`[OK] ${msg}`);
  const warn = (msg) => console.log(`[!] ${msg}`);
  const fail = (msg) => {
    failed = true;
    console.log(`[X] ${msg}`);
  };

  const nv = checkNodeVersion(process.version);
  nv.ok ? ok(`node ${process.version}`) : fail(`node: ${nv.reason}`);
  has('npm --version') ? ok('npm') : fail('npm not found');
  has('docker --version') ? ok('docker (нужен только для образа движка)') : warn('docker не найден: образ движка не собрать, для dev не нужен');
  has('git --version') ? ok('git') : fail('git not found');

  const env = { ...readDotEnv(path.join(root, '.env')), ...process.env };

  const now = checkEnvNames(env, REQUIRED_ENV.spike);
  now.present.length ? ok(`env: ${now.present.join(', ')}`) : warn('env: ни одной переменной из .env не задано');
  if (now.missing.length) warn(`env отсутствуют: ${now.missing.join(', ')} — спайк не запустится (см. infra/.env.example)`);

  const engine = checkEnvNames(env, REQUIRED_ENV.engine);
  if (engine.missing.length) warn(`env отсутствуют: ${engine.missing.join(', ')} — go-engine не запустится (см. infra/.env.example)`);

  const later = checkEnvNames(env, REQUIRED_ENV.later);
  if (later.missing.length) warn(`env для стадии 1 отсутствуют: ${later.missing.join(', ')} (сейчас не нужны)`);

  // AGENT_NAME молча подменяется дефолтом 'goko' в трёх файлах спайка. На ПК это
  // продовое имя: воркер зарегистрируется, но заданий не получит, и выглядит это
  // как «агент запустился, но молчит».
  if (envValue(env, 'AGENT_NAME') === undefined) warn("AGENT_NAME не задан: спайк возьмёт продовое имя 'goko', на ПК нужен 'goko-dev'");
  else ok('AGENT_NAME задан');

  const kb = envValue(env, 'KATAGO_BIN');
  if (kb === undefined) warn('KATAGO_BIN не задан: движок будет недоступен, тесты движка пропускаются');
  else if (!existsSync(kb)) fail(`KATAGO_BIN указывает на несуществующий файл`);
  else ok('KATAGO_BIN найден');

  // Обе сети движка: имена переменных те же, что читает apps/go-engine/src/start-engine.ts.
  // Печатаются только имена переменных и вердикт: значения env не выводятся.
  const models = path.join(root, 'apps/go-engine/models');
  const nets = [
    { envName: 'KATAGO_MODEL', label: 'основная сеть', file: envValue(env, 'KATAGO_MODEL') ?? path.join(models, 'kata1-b10c128-s1141046784-d204142634.txt.gz') },
    { envName: 'KATAGO_HUMAN_MODEL', label: 'человеческая сеть', file: envValue(env, 'KATAGO_HUMAN_MODEL') ?? path.join(models, 'b18c384nbt-humanv0.bin.gz') },
  ];
  for (const net of nets) {
    if (existsSync(net.file)) ok(`${net.label} на месте (${net.envName})`);
    else warn(`${net.label} не найдена (${net.envName} или apps/go-engine/models/README.md)`);
  }

  console.log(verdict({ failed, blockers: [...now.missing, ...engine.missing] }));
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
