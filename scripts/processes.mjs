// Общее для smoke.mjs и dev.mjs: окружение детей, запуск с префиксом в логе, остановка дерева с потолком.
// Значения переменных окружения здесь не печатаются никогда: в лог идут только строки самих процессов.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

// Потолок ожидания выхода одного процесса при остановке. game-server держит свой дедлайн SHUTDOWN_MS
// 25 с (текущий запрос к движку и один повтор), поэтому ждём чуть дольше, а затем гасим силой.
export const STOP_CEILING_MS = 30_000;

// .env из корня репозитория — только через process.loadEnvFile: файл не читается и не печатается.
export function loadRootEnv(root) {
  const file = path.join(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

// Пустая переменная — то же, что не заданная: так читают конфигурацию game-server, go-engine и doctor.
// Детям пустые значения всё равно не передаём: план dev сам решает по env (`KATAGO_BIN`, `ENGINE_KEY`,
// `ENGINE_PORT`), и пустая строка там не должна считаться заданным значением.
/**
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function withoutEmpty(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') out[name] = value;
  }
  return out;
}

// Разбивает поток на строки и печатает каждую с префиксом имени процесса.
function pipeLines(stream, print) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) if (line) print(line);
  });
  stream.on('end', () => {
    if (buf) print(buf);
    buf = '';
  });
}

// Опции spawn для startLogged. windowsHide по умолчанию true: при stdio без наследования libuv ставит
// CREATE_NO_WINDOW, и у ребёнка своя скрытая консоль — окна не появляются, но и Ctrl+C консоли
// родителя ребёнок не получает. dev передаёт windowsHide: false, чтобы дети остались в консоли терминала.
/**
 * @param {{ cwd: string, env: Record<string, string>, shell?: boolean, detached?: boolean, windowsHide?: boolean }} opts
 */
export function spawnOptions(opts) {
  return {
    cwd: opts.cwd,
    env: opts.env,
    stdio: /** @type {['ignore', 'pipe', 'pipe']} */ (['ignore', 'pipe', 'pipe']),
    shell: opts.shell ?? false,
    detached: opts.detached ?? false,
    windowsHide: opts.windowsHide ?? true,
  };
}

// opts: { cwd, env, prefix, shell, detached, windowsHide }. Возвращает ChildProcess.
// spawnImpl и out — швы для теста: боевой путь берёт node:child_process и console.log.
/**
 * @param {string} name
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string, string>, prefix?: string, shell?: boolean, detached?: boolean, windowsHide?: boolean }} opts
 * @param {Function} [spawnImpl]
 * @param {(line: string) => void} [out]
 */
export function startLogged(name, cmd, args, opts, spawnImpl = spawn, out = console.log) {
  const child = spawnImpl(cmd, args, spawnOptions(opts));
  const print = (line) => out(`${opts.prefix ?? ''}[${name}] ${line}`);
  pipeLines(child.stdout, print);
  pipeLines(child.stderr, print);
  return child;
}

export function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

// Ждёт выхода процесса не дольше ms; true — вышел.
export function waitExit(child, ms) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

// Всё дерево процесса силой. На Windows kill() не достаёт до внуков (npm -> vite, go-engine -> KataGo),
// поэтому taskkill /T /F. На POSIX процесс запущен лидером своей группы (detached), и сигнал уходит группе.
export function killTree(child, signal = 'SIGKILL') {
  if (hasExited(child) || child.pid === undefined) return;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // группы нет (процесс не detached): сигнал самому процессу
    child.kill(signal);
  }
}

// Остановка с потолком: мягкий сигнал (если он есть), ожидание не дольше ceilingMs, затем силой.
// soft: 'SIGTERM' — послать сигнал (на Windows killTree с любым сигналом — taskkill /T /F, то есть силой);
// null — ничего не слать и только ждать. null годится только для детей, запущенных в консоли родителя
// (windowsHide: false, как в dev): Ctrl+C терминала они получили сами. Скрытый ребёнок его не получает.
// Возвращает 'exited' | 'killed' | 'stuck'.
export async function stopWithCeiling(child, { soft, ceilingMs = STOP_CEILING_MS }) {
  if (hasExited(child)) return 'exited';
  if (soft) killTree(child, soft);
  if (await waitExit(child, ceilingMs)) return 'exited';
  killTree(child, 'SIGKILL');
  return (await waitExit(child, 5_000)) ? 'killed' : 'stuck';
}
