// config.test.ts — чтение переменных воркера без process.env
import { describe, expect, it } from 'vitest';
import { CONFIG_EXIT_CODE, readConfig } from './config.ts';

const REQUIRED = {
  LIVEKIT_URL: 'wss://lk.example.test',
  LIVEKIT_API_KEY: 'lk-key-value',
  LIVEKIT_API_SECRET: 'lk-secret-value',
  OPENAI_API_KEY: 'openai-key-value',
  APP_KEY: 'app-key-value',
};

describe('readConfig', () => {
  it('все обязательные заданы — значения по умолчанию для API_BASE, AGENT_NAME, VOICE_MODE', () => {
    expect(readConfig({ ...REQUIRED })).toEqual({
      config: { appKey: 'app-key-value', apiBase: 'http://127.0.0.1:8787', agentName: 'goko', voiceMode: 'realtime' },
      errors: [],
    });
  });

  it('необязательные берутся из env, пустые и из пробелов — как не заданные', () => {
    const custom = readConfig({ ...REQUIRED, API_BASE: 'http://game-server:8787', AGENT_NAME: 'goko-dev', VOICE_MODE: 'pipeline' });
    expect(custom.config).toEqual({ appKey: 'app-key-value', apiBase: 'http://game-server:8787', agentName: 'goko-dev', voiceMode: 'pipeline' });
    const blank = readConfig({ ...REQUIRED, API_BASE: ' ', AGENT_NAME: '', VOICE_MODE: '  ' });
    expect(blank.config).toEqual({ appKey: 'app-key-value', apiBase: 'http://127.0.0.1:8787', agentName: 'goko', voiceMode: 'realtime' });
    expect(readConfig({ ...REQUIRED, VOICE_MODE: 'realtime' }).config?.voiceMode).toBe('realtime');
  });

  it('каждая обязательная переменная: нет, пустая, из пробелов — ошибка с её именем', () => {
    for (const name of Object.keys(REQUIRED)) {
      for (const value of [undefined, '', ' \t ']) {
        const result = readConfig({ ...REQUIRED, [name]: value });
        expect(result.config).toBeNull();
        expect(result.errors).toEqual([`[X] voice-agent: нужна переменная ${name} (см. infra/.env.example)`]);
      }
    }
  });

  it('недостающие перечислены все сразу, в порядке списка', () => {
    expect(readConfig({ OPENAI_API_KEY: 'x' }).errors).toEqual([
      '[X] voice-agent: нужна переменная LIVEKIT_URL (см. infra/.env.example)',
      '[X] voice-agent: нужна переменная LIVEKIT_API_KEY (см. infra/.env.example)',
      '[X] voice-agent: нужна переменная LIVEKIT_API_SECRET (см. infra/.env.example)',
      '[X] voice-agent: нужна переменная APP_KEY (см. infra/.env.example)',
    ]);
  });

  it('неверный VOICE_MODE — ошибка конфигурации с именем переменной, без значения', () => {
    const result = readConfig({ ...REQUIRED, VOICE_MODE: 'gpt-secret-mode' });
    expect(result.config).toBeNull();
    expect(result.errors).toEqual(['[X] voice-agent: VOICE_MODE должна быть realtime или pipeline']);
    const both = readConfig({ ...REQUIRED, APP_KEY: '', VOICE_MODE: 'Realtime' });
    expect(both.errors).toEqual([
      '[X] voice-agent: нужна переменная APP_KEY (см. infra/.env.example)',
      '[X] voice-agent: VOICE_MODE должна быть realtime или pipeline',
    ]);
  });

  it('в строках ошибок нет значений переменных; код выхода конфигурации — 2', () => {
    const env = { ...REQUIRED, LIVEKIT_URL: '', VOICE_MODE: 'gpt-secret-mode' };
    const text = readConfig(env).errors.join('\n');
    for (const value of [...Object.values(REQUIRED), 'gpt-secret-mode']) expect(text).not.toContain(value);
    expect(CONFIG_EXIT_CODE).toBe(2);
  });
});
