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

// Пустая переменная — то же, что не заданная (так читает конфигурацию game-server). go-engine и doctor
// читают `env.X ?? умолчание`, и пустая строка из infra/.env.example (`KATAGO_MODEL=`) подставилась бы
// вместо пути по умолчанию, а `ENGINE_PORT=` дала бы порт 0. Поэтому детям пустые значения не передаём.
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

// opts: { cwd, env, prefix, shell, detached }. Возвращает ChildProcess.
export function startLogged(name, cmd, args, opts) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: opts.shell ?? false,
    detached: opts.detached ?? false,
    windowsHide: true,
  });
  const print = (line) => console.log(`${opts.prefix ?? ''}[${name}] ${line}`);
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
// soft: 'SIGTERM' — послать сигнал; null — ничего не слать и только ждать (на Windows Ctrl+C
// в консоли уже получили сами дети, а мягкого сигнала другому процессу там нет).
// Возвращает 'exited' | 'killed' | 'stuck'.
export async function stopWithCeiling(child, { soft, ceilingMs = STOP_CEILING_MS }) {
  if (hasExited(child)) return 'exited';
  if (soft) killTree(child, soft);
  if (await waitExit(child, ceilingMs)) return 'exited';
  killTree(child, 'SIGKILL');
  return (await waitExit(child, 5_000)) ? 'killed' : 'stuck';
}
