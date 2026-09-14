// Переменные воркера. Ключи LiveKit и OpenAI библиотеки читают из process.env сами, здесь только проверка,
// что они заданы. Пустая или из пробелов переменная — то же, что не заданная (как в game-server и go-engine).
// Строки ошибок называют только переменную: значения, в том числе VOICE_MODE, в лог не идут.
import { type VoiceMode, parseVoiceMode } from './voice.ts';

export const CONFIG_EXIT_CODE = 2;

export const REQUIRED_ENV = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'OPENAI_API_KEY', 'APP_KEY'] as const;

export type WorkerConfig = { appKey: string; apiBase: string; agentName: string; voiceMode: VoiceMode };

export type ConfigResult = { config: WorkerConfig; errors: [] } | { config: null; errors: string[] };

export function readConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const optional = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim() === '' ? undefined : value;
  };
  const errors: string[] = [];
  for (const name of REQUIRED_ENV) {
    if (optional(name) === undefined) errors.push(`[X] voice-agent: нужна переменная ${name} (см. infra/.env.example)`);
  }
  let voiceMode: VoiceMode = 'realtime';
  try {
    voiceMode = parseVoiceMode(optional('VOICE_MODE'));
  } catch {
    errors.push('[X] voice-agent: VOICE_MODE должна быть realtime или pipeline');
  }
  const appKey = optional('APP_KEY');
  if (errors.length > 0 || appKey === undefined) return { config: null, errors };
  return {
    config: {
      appKey,
      apiBase: optional('API_BASE') ?? 'http://127.0.0.1:8787',
      agentName: optional('AGENT_NAME') ?? 'goko',
      voiceMode,
    },
    errors: [],
  };
}
