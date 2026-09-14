import { describe, expect, it } from 'vitest';
import { DEV_AGENT_NAME, devPlan, devStartOptions, startDev } from './dev.mjs';

const secretEnv = {
  APP_KEY: 'secret-app',
  LIVEKIT_URL: 'wss://secret-livekit',
  LIVEKIT_API_KEY: 'secret-lk-key',
  LIVEKIT_API_SECRET: 'secret-lk-secret',
  AGENT_NAME: 'goko',
  KATAGO_MODEL: '',
};
const none = () => false;

describe('dev: план запуска', () => {
  it('без KATAGO_BIN — только game-server с FAKE_ENGINE=1 и агентом goko-dev', () => {
    const plan = devPlan(secretEnv, none);
    expect(plan.procs.map((p) => p.name)).toEqual(['game-server']);
    const server = plan.procs[0];
    expect(server?.env).toMatchObject({ FAKE_ENGINE: '1', AGENT_NAME: DEV_AGENT_NAME, LIVEKIT_URL: 'wss://secret-livekit', ALLOW_SESSIONLESS_GAMES: '1' });
    expect(server?.env).not.toHaveProperty('KATAGO_MODEL'); // пустое значение не стало бы путём
    expect(plan.notes.join('\n')).toContain('KATAGO_BIN не задан');
  });

  it('с KATAGO_BIN — go-engine и game-server с общим ключом, без фейка', () => {
    const plan = devPlan({ ...secretEnv, KATAGO_BIN: '/opt/katago', FAKE_ENGINE: '1' }, none, () => 'one-time');
    expect(plan.procs.map((p) => p.name)).toEqual(['go-engine', 'game-server']);
    const [engine, server] = plan.procs;
    expect(engine?.env).toMatchObject({ ENGINE_KEY: 'one-time', ENGINE_PORT: '8788' });
    expect(server?.env).toMatchObject({ ENGINE_KEY: 'one-time', ENGINE_URL: 'http://127.0.0.1:8788', AGENT_NAME: DEV_AGENT_NAME, ALLOW_SESSIONLESS_GAMES: '1' });
    expect(server?.env).not.toHaveProperty('FAKE_ENGINE');
    expect(plan.notes.join('\n')).toContain('ENGINE_KEY не задан');
  });

  it('web и voice-agent — только если есть их package.json', () => {
    const plan = devPlan(secretEnv, (rel) => rel === 'apps/web/package.json' || rel === 'apps/voice-agent/package.json');
    expect(plan.procs.map((p) => p.name)).toEqual(['game-server', 'web', 'voice-agent']);
    expect(plan.procs[2]?.env.AGENT_NAME).toBe(DEV_AGENT_NAME);
  });

  it('web — vite через node без cmd.exe: Ctrl+C не спрашивает про пакетный файл', () => {
    const plan = devPlan(secretEnv, (rel) => rel === 'apps/web/package.json');
    const web = plan.procs.find((p) => p.name === 'web');
    expect(web?.cmd).toBe(process.execPath);
    expect(web?.args).toEqual(['node_modules/vite/bin/vite.js', 'apps/web', '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
    expect(web?.shell).toBeUndefined();
  });

  it('строки для терминала не содержат значений переменных', () => {
    const plan = devPlan({ ...secretEnv, KATAGO_BIN: '/opt/katago', ENGINE_KEY: 'secret-engine' }, () => true);
    const printed = [...plan.notes, plan.ready].join('\n');
    for (const value of ['secret-', '/opt/katago']) expect(printed).not.toContain(value);
    expect(plan.ready).toContain('goko-dev');
  });
});

describe('dev: опции запуска детей', () => {
  const plan = devPlan({ KATAGO_BIN: '/opt/katago' }, () => true, () => 'k');

  it('Windows: дети в консоли dev (windowsHide: false) и не detached — Ctrl+C терминала доходит до них самих', () => {
    // libuv при windowsHide и stdio без наследования ставит CREATE_NO_WINDOW: у ребёнка своя скрытая
    // консоль, и CTRL_C_EVENT терминала до него не доходит (отчёт задачи 13, круг правок 1, пункт 3).
    for (const p of plan.procs) {
      expect(devStartOptions(p, '/repo', true)).toEqual({ cwd: '/repo', env: p.env, shell: p.shell, detached: false, windowsHide: false });
    }
  });

  it('POSIX: каждый ребёнок — лидер своей группы, SIGTERM уходит дереву', () => {
    for (const p of plan.procs) expect(devStartOptions(p, '/repo', false)).toMatchObject({ cwd: '/repo', env: p.env, detached: true });
  });

  it('startDev запускает каждый процесс плана с devStartOptions', () => {
    const calls: unknown[][] = [];
    const running = startDev(plan, '/repo', (...args: unknown[]) => {
      calls.push(args);
      return { pid: calls.length };
    });
    expect(running.map((r) => r.name)).toEqual(plan.procs.map((p) => p.name));
    expect(calls).toEqual(plan.procs.map((p) => [p.name, p.cmd, p.args, devStartOptions(p, '/repo')]));
    expect(running.map((r) => r.child)).toEqual(plan.procs.map((_p, i) => ({ pid: i + 1 })));
  });
});
