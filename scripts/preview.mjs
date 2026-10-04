#!/usr/bin/env node
// Бесплатный preview одной командой. Не читает .env, не запускает KataGo, LiveKit или OpenAI.
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { STOP_CEILING_MS, hasExited, isWindows, killTree, startLogged, stopWithCeiling } from './processes.mjs';

const SAFE_ENV = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'CI'];

export function previewPlan(root, parentEnv = process.env) {
  const env = Object.fromEntries(SAFE_ENV.filter((name) => parentEnv[name] !== undefined).map((name) => [name, parentEnv[name]]));
  return {
    procs: [
      { name: 'game-server', cmd: process.execPath, args: [path.join('scripts', 'preview-server.mjs')], env },
      {
        name: 'web',
        cmd: process.execPath,
        args: [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'apps/web', '--mode', 'e2e', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
        env,
      },
    ],
    ready: '[OK] preview: http://127.0.0.1:4173; game-server fake, LiveKit mock, без .env и платных вызовов',
  };
}

export function previewStartOptions(proc, root, windows = isWindows) {
  return { cwd: root, env: proc.env, shell: false, detached: !windows, windowsHide: true };
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const plan = previewPlan(root);
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'goko-preview-supervisor-'));
  const dataDir = path.join(runtimeDir, 'data');
  const readyFile = path.join(runtimeDir, 'game-server.ready');
  mkdirSync(dataDir);
  /** @type {{ name: string, child: import('node:child_process').ChildProcess }[]} */
  const running = [];
  let stopping = false;

  async function stopAll(code = 0) {
    if (stopping) return;
    stopping = true;
    const results = await Promise.all(
      running.map(({ child }) => stopWithCeiling(child, { soft: isWindows ? 'SIGTERM' : 'SIGTERM', ceilingMs: STOP_CEILING_MS })),
    );
    rmSync(runtimeDir, { recursive: true, force: true });
    process.exit(results.includes('stuck') ? 1 : code);
  }

  const launch = (proc) => {
    const child = startLogged(proc.name, proc.cmd, proc.args, previewStartOptions(proc, root));
    running.push({ name: proc.name, child });
    child.once('error', (error) => {
      if (!stopping) {
        console.error(`[X] preview: ${proc.name} не запустился (${error.message})`);
        void stopAll(1);
      }
    });
    child.once('exit', (code) => {
      if (!stopping) {
        console.error(`[X] preview: ${proc.name} завершился (${child.signalCode ?? code})`);
        void stopAll(1);
      }
    });
    return child;
  };
  const waitForHttp = async (url, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!stopping && Date.now() < deadline) {
      try {
        const response = await fetch(url);
        if (response.ok) return;
      } catch { /* процесс ещё запускается */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`preview readiness timeout: ${new URL(url).pathname}`);
  };
  const waitForFile = async (file, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!stopping && Date.now() < deadline) {
      if (existsSync(file)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('preview readiness timeout: game-server process');
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (stopping) {
        for (const { child } of running) if (!hasExited(child)) killTree(child);
        return;
      }
      void stopAll();
    });
  }
  try {
    launch({ ...plan.procs[0], args: [...plan.procs[0].args, '--data-dir', dataDir, '--ready-file', readyFile] });
    await waitForFile(readyFile);
    if (stopping) return;
    await waitForHttp('http://127.0.0.1:8787/health');
    if (stopping) return;
    launch(plan.procs[1]);
    await waitForHttp('http://127.0.0.1:4173/');
    if (!stopping) console.log(plan.ready);
  } catch (error) {
    if (!stopping) console.error(`[X] preview: ${error instanceof Error ? error.message : 'не удалось запустить'}`);
    await stopAll(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
