import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { previewPlan, previewStartOptions } from './preview.mjs';
import webConfig from '../apps/web/vite.config.ts';

describe('preview: бесплатный локальный контур', () => {
  it('запускает только заглушенный game-server и Vite в режиме e2e', () => {
    const plan = previewPlan('/repo', { PATH: '/bin', OPENAI_API_KEY: 'не передавать', APP_KEY: 'не передавать' });
    expect(plan.procs.map((p) => p.name)).toEqual(['game-server', 'web']);
    expect(plan.procs[0]?.args).toEqual([path.join('scripts', 'preview-server.mjs')]);
    expect(plan.procs[1]?.args).toEqual([
      path.join('node_modules', 'vite', 'bin', 'vite.js'),
      'apps/web',
      '--mode',
      'e2e',
      '--host',
      '127.0.0.1',
      '--port',
      '4173',
      '--strictPort',
    ]);
    for (const proc of plan.procs) {
      expect(proc.env).toEqual({ PATH: '/bin' });
      expect(proc.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(proc.env).not.toHaveProperty('APP_KEY');
    }
  });

  it('режим e2e отключает все .env и включает только test alias LiveKit', () => {
    if (typeof webConfig !== 'function') throw new Error('vite config должен зависеть от mode');
    const config = webConfig({ command: 'serve', mode: 'e2e', isSsrBuild: false, isPreview: false });
    expect(config.envDir).toBe(false);
    expect(config.resolve).toMatchObject({ alias: { 'livekit-client': expect.stringContaining('e2e') } });
    expect(config.define?.['import.meta.env.VITE_APP_KEY']).toBe(JSON.stringify('goko-preview'));
  });

  it('стартует детей без shell и с отдельной группой на Linux', () => {
    expect(previewStartOptions({ env: { PATH: '/bin' } }, '/repo', false)).toEqual({
      cwd: '/repo',
      env: { PATH: '/bin' },
      shell: false,
      detached: true,
      windowsHide: true,
    });
  });
});
