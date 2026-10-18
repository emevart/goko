import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('офлайн preflight доказывает blocked stock transport без наследования credentials и сетевых вызовов', () => {
  const sentinel = 'OFFLINE_TEST_PARENT_SENTINEL';
  const result = spawnSync(process.execPath, ['scripts/cloud-voice-preflight.mjs'], {
    cwd: process.cwd(), timeout: 8_000, encoding: 'utf8',
    env: { OPENAI_API_KEY: sentinel, HTTPS_PROXY: 'https://invalid.test:9999' },
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain(sentinel);
  expect(result.stdout).not.toContain('invalid.test');
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'inconclusive', reason: 'unsupported_node', networkCalls: 0 });
    return;
  }
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: 'blocked_proxy_transport', networkCalls: 0,
    sdk: { agents: '1.8.1', openai: '1.8.1' },
    paths: { stock: 'provider-direct', explicitAgent: 'proxy' },
  });
});

it('preflight не предоставляет платный --run и не создаёт child для неизвестного аргумента', () => {
  const result = spawnSync(process.execPath, ['scripts/cloud-voice-preflight.mjs', '--run'], {
    cwd: process.cwd(), timeout: 8_000, encoding: 'utf8', env: {},
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'inconclusive', reason: 'unsupported_argument', networkCalls: 0 });
  expect(result.stderr).toBe('');
});
