import { describe, expect, it } from 'vitest';
import { ServerOptions } from '@livekit/agents';
import { LOAD_THRESHOLD, MAX_JOBS, NUM_IDLE_PROCESSES, SERVER_TARGET_LOAD, jobCeiling, jobLoad, workerPoolOptions } from './load.ts';

describe('загрузка воркера по числу job (D-0013)', () => {
  it('0 job — 0, MAX_JOBS — 1, больше — не выше 1', () => {
    expect(jobLoad(0)).toBe(0);
    expect(jobLoad(MAX_JOBS)).toBe(1);
    expect(jobLoad(MAX_JOBS + 3)).toBe(1);
    expect(jobLoad(2, 8)).toBe(0.25);
  });
  it('порог воркера 1: сам себя FULL он не ставит раньше MAX_JOBS', () => {
    expect(LOAD_THRESHOLD).toBe(1);
    expect(jobLoad(MAX_JOBS - 1)).toBeLessThan(LOAD_THRESHOLD);
  });
  it('сервер LiveKit даёт job при загрузке ниже 0,7: потолок — 6 одновременных job, с запасом вдвое над MAX_SESSIONS 3', () => {
    expect(SERVER_TARGET_LOAD).toBe(0.7);
    expect(jobCeiling()).toBe(6);
    // При 5 идущих job шестая ещё приходит, при 6 — нет.
    expect(jobLoad(5)).toBeLessThan(SERVER_TARGET_LOAD);
    expect(jobLoad(6)).toBeGreaterThanOrEqual(SERVER_TARGET_LOAD);
  });
  it('ни одно число job не даёт загрузку ровно 0,7: граница не зависит от округления float на сервере', () => {
    for (let n = 0; n <= MAX_JOBS; n++) expect(Math.abs(jobLoad(n) - SERVER_TARGET_LOAD)).toBeGreaterThan(0.01);
  });
});

describe('опции пула процессов воркера (ревью C1)', () => {
  // Без тёплых процессов (numIdleProcesses 0 — умолчание dev) ProcPool.launchJob кладёт исполнитель в executors
  // и не удаляет, а runningJob у него не сбрасывается: activeJobs растёт на каждую завершённую job, и после
  // шестой сервер перестаёт давать воркеру job. Удаляет исполнитель только procWatchTask тёплого процесса.
  it('тёплых процессов не меньше одного, загрузка и порог — по числу job', async () => {
    const opts = workerPoolOptions();
    expect(NUM_IDLE_PROCESSES).toBe(1);
    expect(opts.numIdleProcesses).toBeGreaterThanOrEqual(1);
    expect(opts.loadThreshold).toBe(LOAD_THRESHOLD);
    expect(await opts.loadFunc({ activeJobs: [{}, {}, {}] })).toBe(jobLoad(3));
  });
  it('значения переживают пересборку опций в cli.runApp и в dev, и в start', () => {
    const ours = new ServerOptions({ agent: 'agent.ts', agentName: 'goko-test', ...workerPoolOptions() });
    for (const production of [false, true]) {
      // cli.ts: const { production: _, ...opts } = args.opts; new ServerOptions({ ...opts, production })
      const { production: _, ...rest } = ours;
      const rebuilt = new ServerOptions({ ...rest, production });
      expect(rebuilt.numIdleProcesses).toBe(NUM_IDLE_PROCESSES);
      expect(rebuilt.loadThreshold).toBe(LOAD_THRESHOLD);
    }
  });
});
