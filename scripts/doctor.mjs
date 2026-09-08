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

export function checkEnvNames(env, required) {
  const present = required.filter((k) => env[k] !== undefined && env[k] !== '');
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
  // Список разделён по тому, что переменные ломают на самом деле, — иначе doctor
  // печатал «можно работать», а следом npm run token -w spike падал на WEB_HOST.
  // Без этих пяти голосовой спайк не запускается: agent.ts, chat.mjs, token.mjs.
  const requiredNow = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'OPENAI_API_KEY', 'WEB_HOST'];
  // Понадобятся на стадии 1 (game-server и go-engine), сейчас их никто не читает.
  const requiredLater = ['APP_KEY', 'ENGINE_KEY'];

  const now = checkEnvNames(env, requiredNow);
  now.present.length ? ok(`env: ${now.present.join(', ')}`) : warn('env: ни одной переменной из .env не задано');
  if (now.missing.length) warn(`env отсутствуют: ${now.missing.join(', ')} — спайк не запустится (см. infra/.env.example)`);

  const later = checkEnvNames(env, requiredLater);
  if (later.missing.length) warn(`env для стадии 1 отсутствуют: ${later.missing.join(', ')} (сейчас не нужны)`);

  // AGENT_NAME молча подменяется дефолтом 'goko' в трёх файлах спайка. На ПК это
  // продовое имя: воркер зарегистрируется, но заданий не получит, и выглядит это
  // как «агент запустился, но молчит».
  if (!env.AGENT_NAME) warn("AGENT_NAME не задан: спайк возьмёт продовое имя 'goko', на ПК нужен 'goko-dev'");
  else ok('AGENT_NAME задан');

  const kb = env.KATAGO_BIN;
  if (!kb) warn('KATAGO_BIN не задан: движок будет недоступен, тесты движка пропускаются');
  else if (!existsSync(kb)) fail(`KATAGO_BIN указывает на несуществующий файл`);
  else ok('KATAGO_BIN найден');

  const models = path.join(root, 'apps/go-engine/models');
  if (existsSync(models)) {
    const need = ['b18c384nbt-humanv0.bin.gz'];
    for (const f of need) existsSync(path.join(models, f)) ? ok(`модель ${f}`) : warn(`нет модели ${f} (apps/go-engine/models/README.md)`);
  }

  if (failed) console.log('[X] doctor: есть блокирующие проблемы');
  else if (now.missing.length) console.log(`[!] doctor: инструменты на месте, но голосовой спайк не запустится без ${now.missing.join(', ')}`);
  else console.log('[OK] doctor: можно работать');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
