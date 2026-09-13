import { describe, expect, it } from 'vitest';
import { STOP_CEILING_MS, withoutEmpty } from './processes.mjs';
import { LIVEKIT_STUB, SMOKE_APP_KEY, gameServerEnv, goEngineEnv } from './smoke.mjs';

// Родительское окружение «как после .env»: настоящие ключи LiveKit и OpenAI и чужие настройки сервера.
const parent = {
  PATH: '/usr/bin',
  LIVEKIT_URL: 'wss://real.example',
  LIVEKIT_API_KEY: 'real-key',
  LIVEKIT_API_SECRET: 'real-secret',
  LIVEKIT_EXTRA: 'real-extra',
  OPENAI_API_KEY: 'real-openai',
  APP_KEY: 'real-app-key',
  ENGINE_KEY: 'real-engine-key',
  KATAGO_BIN: '/opt/katago',
  KATAGO_MODEL: '',
  MAX_SESSIONS: '1',
  SESSION_TTL_MS: '5',
  PORT: '8787',
};

describe('smoke: окружение game-server (D-0001)', () => {
  it('LIVEKIT_* — всегда заглушки, а не значения из process.env', () => {
    const env = gameServerEnv(parent, { port: 18787, dataDir: '/tmp/x' });
    expect(env.LIVEKIT_URL).toBe(LIVEKIT_STUB.LIVEKIT_URL);
    expect(env.LIVEKIT_API_KEY).toBe(LIVEKIT_STUB.LIVEKIT_API_KEY);
    expect(env.LIVEKIT_API_SECRET).toBe(LIVEKIT_STUB.LIVEKIT_API_SECRET);
    expect(env.LIVEKIT_URL).toMatch(/\.invalid$/);
    expect(env).not.toHaveProperty('LIVEKIT_EXTRA');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    for (const value of Object.values(env)) expect(value).not.toMatch(/^real-/);
  });

  it('то же для --real и для настоящего process.env', () => {
    const real = gameServerEnv(parent, { port: 1, dataDir: '/tmp/x', real: true, engineUrl: 'http://127.0.0.1:18788', engineKey: 'smoke-engine' });
    expect(real.LIVEKIT_URL).toBe(LIVEKIT_STUB.LIVEKIT_URL);
    expect(real.ENGINE_KEY).toBe('smoke-engine'); // ключ движка свой: оба процесса запускает smoke
    expect(real.FAKE_ENGINE).toBeUndefined();
    const fromProcess = gameServerEnv(process.env, { port: 1, dataDir: '/tmp/x' });
    expect(fromProcess.LIVEKIT_API_SECRET).toBe(LIVEKIT_STUB.LIVEKIT_API_SECRET);
  });

  it('свои ключ, порт, каталог и фейковый движок; чужие пределы сессий не протекают', () => {
    const env = gameServerEnv(parent, { port: 18787, dataDir: '/tmp/x' });
    expect(env).toMatchObject({ APP_KEY: SMOKE_APP_KEY, PORT: '18787', HOST: '127.0.0.1', DATA_DIR: '/tmp/x', FAKE_ENGINE: '1' });
    expect(env).not.toHaveProperty('ENGINE_KEY');
    expect(env).not.toHaveProperty('MAX_SESSIONS');
    expect(env).not.toHaveProperty('SESSION_TTL_MS');
    expect(env).not.toHaveProperty('KATAGO_MODEL');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('go-engine в --real получает KATAGO_* и свой порт, но не ключи LiveKit', () => {
    const env = goEngineEnv(parent, { port: 18788, engineKey: 'smoke-engine' });
    expect(env).toMatchObject({ KATAGO_BIN: '/opt/katago', ENGINE_KEY: 'smoke-engine', ENGINE_PORT: '18788', ENGINE_HOST: '127.0.0.1' });
    expect(env).not.toHaveProperty('KATAGO_MODEL');
    expect(env).not.toHaveProperty('LIVEKIT_API_SECRET');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
  });
});

describe('processes', () => {
  it('пустые значения детям не передаются', () => {
    expect(withoutEmpty({ A: '', B: '  ', C: 'x', D: undefined })).toEqual({ C: 'x' });
  });

  it('потолок остановки дольше дедлайна game-server SHUTDOWN_MS (25 с)', async () => {
    const { SHUTDOWN_MS } = await import('../apps/game-server/src/start-server.ts');
    expect(STOP_CEILING_MS).toBeGreaterThan(SHUTDOWN_MS);
  });
});
