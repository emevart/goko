import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawnOptions, startLogged } from './processes.mjs';

describe('processes: опции запуска детей', () => {
  it('stdio без наследования, по умолчанию скрыто, без shell и не detached', () => {
    const opts = spawnOptions({ cwd: '/repo', env: { A: '1' } });
    expect(opts).toEqual({ cwd: '/repo', env: { A: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: false, windowsHide: true });
  });

  it('shell, detached и windowsHide передаются как заданы', () => {
    expect(spawnOptions({ cwd: '/r', env: {}, shell: true, detached: true, windowsHide: false })).toMatchObject({ shell: true, detached: true, windowsHide: false });
  });

  it('startLogged передаёт в spawn ровно spawnOptions и печатает строки детей с префиксом', async () => {
    const calls: unknown[][] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fake = { stdout, stderr };
    const printed: string[] = [];
    const opts = { cwd: '/r', env: { A: '1' }, prefix: '  ', detached: true, windowsHide: false };
    const child = startLogged('web', 'npm', ['run', 'dev'], opts, (...args: unknown[]) => {
      calls.push(args);
      return fake;
    }, (line: string) => printed.push(line));
    expect(child).toBe(fake);
    expect(calls).toEqual([['npm', ['run', 'dev'], spawnOptions(opts)]]);
    // Порядок строк задан явно: сначала stdout до конца, потом stderr.
    const outEnded = new Promise((r) => stdout.once('end', r));
    const errEnded = new Promise((r) => stderr.once('end', r));
    stdout.end('ready\n');
    await outEnded;
    stderr.end('oops\n');
    await errEnded;
    expect(printed).toEqual(['  [web] ready', '  [web] oops']);
  });
});
