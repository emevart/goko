#!/usr/bin/env node
// Локальная разработка одной командой: game-server :8787, go-engine :8788 (без KATAGO_BIN — FAKE_ENGINE=1),
// web :5173 и voice-agent goko-dev, если их каталоги уже есть. Логи с префиксом, Ctrl+C гасит всех.
//
// .env читается только через process.loadEnvFile. LIVEKIT_* из него game-server получает (токены комнат
// для телефона), но ни одно значение не печатается: в строке готовности только имена процессов.
// Остановка: каждый процесс ждём не дольше STOP_CEILING_MS (дедлайн game-server — 25 с), затем силой.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOP_CEILING_MS, hasExited, isWindows, killTree, loadRootEnv, startLogged, stopWithCeiling, withoutEmpty } from './processes.mjs';

// Имя, под которым диспетчеризуется агент в dev (спека, раздел 11): воркер goko на VPS остаётся не у дел.
// Берётся всегда это, а не AGENT_NAME из .env: там имя боевого воркера.
export const DEV_AGENT_NAME = 'goko-dev';

/**
 * План запуска: какие процессы, с какими аргументами и окружением. Без побочных эффектов.
 * @param {Record<string, string | undefined>} parentEnv окружение после .env
 * @param {(relPath: string) => boolean} exists есть ли файл относительно корня
 * @param {() => string} [makeKey] разовый ключ движка, если ENGINE_KEY не задан
 */
export function devPlan(parentEnv, exists, makeKey = () => randomBytes(24).toString('hex')) {
  const env = withoutEmpty(parentEnv);
  /** @type {string[]} */
  const notes = [];
  /** @type {{ name: string, cmd: string, args: string[], env: Record<string, string>, shell?: boolean }[]} */
  const procs = [];
  const node = process.execPath;

  const hasKatago = Boolean(env.KATAGO_BIN);
  const engineKey = env.ENGINE_KEY ?? (hasKatago ? makeKey() : undefined);
  if (hasKatago) {
    if (!env.ENGINE_KEY) notes.push('[!] ENGINE_KEY не задан: game-server и go-engine получат разовый ключ на этот запуск');
    const enginePort = env.ENGINE_PORT ?? '8788';
    procs.push({ name: 'go-engine', cmd: node, args: ['apps/go-engine/src/main.ts'], env: { ...env, ENGINE_KEY: /** @type {string} */ (engineKey), ENGINE_PORT: enginePort } });
    // dev и smoke разрешают партии без сессии (curl, отладка); в prod compose флага нет (D-0012).
    const serverEnv = { ...env, ENGINE_KEY: /** @type {string} */ (engineKey), ENGINE_URL: `http://127.0.0.1:${enginePort}`, AGENT_NAME: DEV_AGENT_NAME, ALLOW_SESSIONLESS_GAMES: '1' };
    delete serverEnv.FAKE_ENGINE;
    procs.push({ name: 'game-server', cmd: node, args: ['apps/game-server/src/main.ts'], env: serverEnv });
  } else {
    notes.push('[!] KATAGO_BIN не задан: game-server с FAKE_ENGINE=1, ходы случайные');
    procs.push({ name: 'game-server', cmd: node, args: ['apps/game-server/src/main.ts'], env: { ...env, FAKE_ENGINE: '1', AGENT_NAME: DEV_AGENT_NAME, ALLOW_SESSIONLESS_GAMES: '1' } });
  }

  if (exists('apps/web/package.json')) procs.push({ name: 'web', cmd: 'npm', args: ['run', 'dev', '--workspace', 'apps/web'], env, shell: isWindows });
  else notes.push('[!] apps/web ещё нет: веб не запускаем');
  if (exists('apps/voice-agent/package.json')) procs.push({ name: 'voice-agent', cmd: node, args: ['apps/voice-agent/src/main.ts', 'dev'], env: { ...env, AGENT_NAME: DEV_AGENT_NAME } });
  else notes.push('[!] apps/voice-agent ещё нет: агента не запускаем');

  const ready = `[OK] dev: запущено ${procs.map((p) => p.name).join(', ')}; агент диспетчеризуется как ${DEV_AGENT_NAME}; Ctrl+C останавливает всё`;
  return { procs, notes, ready };
}

/**
 * Опции запуска одного процесса dev.
 * POSIX: процесс — лидер своей группы, SIGTERM от dev уходит всему дереву (npm -> vite).
 * Windows: windowsHide: false — ребёнок остаётся в консоли терминала и сам получает Ctrl+C. Со скрытием
 * libuv ставит CREATE_NO_WINDOW (stdio без наследования), у ребёнка своя консоль, и мягкой остановки нет.
 * Окно при этом не появляется, если у dev есть консоль (запуск из терминала): ребёнок наследует её.
 * @param {{ env: Record<string, string>, shell?: boolean }} p
 * @param {string} root
 * @param {boolean} [windows]
 */
export function devStartOptions(p, root, windows = isWindows) {
  return { cwd: root, env: p.env, shell: p.shell, detached: !windows, windowsHide: false };
}

/**
 * Запускает процессы плана. start — шов для теста (боевой путь — startLogged).
 * @param {{ procs: { name: string, cmd: string, args: string[], env: Record<string, string>, shell?: boolean }[] }} plan
 * @param {string} root
 * @param {Function} [start]
 */
export function startDev(plan, root, start = startLogged) {
  return plan.procs.map((p) => ({ name: p.name, child: start(p.name, p.cmd, p.args, devStartOptions(p, root)) }));
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..');
  loadRootEnv(root);
  const plan = devPlan(process.env, (rel) => existsSync(path.join(root, rel)));
  for (const note of plan.notes) console.log(note);

  /** @type {{ name: string, child: import('node:child_process').ChildProcess }[]} */
  const running = startDev(plan, root);
  let stopping = false;
  for (const { name, child } of running) {
    child.on('exit', (code, signal) => {
      console.log(`[${name}] завершился (${signal ?? code})`);
      if (code === 2) console.log(`[!] ${name}: не хватает переменных окружения, см. npm run doctor и infra/.env.example`);
      if (!stopping && running.every(({ child: c }) => hasExited(c))) {
        console.log('[X] dev: все процессы завершились');
        process.exit(1);
      }
    });
  }
  console.log(plan.ready);

  async function stopAll() {
    stopping = true;
    console.log(`[!] dev: останавливаю, каждый процесс ждём не дольше ${STOP_CEILING_MS} мс`);
    // Windows: мягкого сигнала другому процессу нет. Ctrl+C терминала дети получили сами (они в консоли
    // dev, см. devStartOptions) — ждём их, а по потолку гасим дерево taskkill. SIGTERM без консоли
    // (например, от другого процесса) детям не доходит: тогда это ожидание потолка и taskkill.
    // POSIX: дети в своих группах, SIGTERM им шлём мы.
    const results = await Promise.all(running.map(async ({ name, child }) => ({ name, result: await stopWithCeiling(child, { soft: isWindows ? null : 'SIGTERM' }) })));
    let bad = false;
    for (const { name, result } of results) {
      if (result === 'killed') console.log(`[!] ${name} не вышел за ${STOP_CEILING_MS} мс, погашен силой`);
      if (result === 'stuck') {
        bad = true;
        console.log(`[X] ${name} не удалось остановить`);
      }
    }
    console.log(bad ? '[X] dev: остановлено не всё' : '[OK] dev: всё остановлено');
    process.exit(bad ? 1 : 0);
  }

  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.on(signal, () => {
      if (stopping) {
        // Повторный Ctrl+C: не ждём, гасим деревья сразу.
        console.log('[!] dev: повторный сигнал, гашу всё без ожидания');
        for (const { child } of running) killTree(child, 'SIGKILL');
        setTimeout(() => process.exit(1), 2_000).unref();
        return;
      }
      void stopAll();
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
