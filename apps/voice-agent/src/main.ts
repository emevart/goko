// Воркер LiveKit Agents: одна комната = одна сессия Гоко. Запуск: node apps/voice-agent/src/main.ts dev|start.
// .env берётся из корня репозитория (на VPS переменные приходят из compose).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import { RoomEvent } from '@livekit/rtc-node';
import { createClient } from '@goko/protocol';
import { GokoAgent } from './agent.ts';
import { type WatchHandle, watchSession } from './events.ts';
import { sessionIdOf } from './metadata.ts';
import { followMode } from './mode.ts';
import { GREETING_INSTRUCTIONS } from './prompt.ts';
import { newAgentState } from './state.ts';
import { createTools } from './tools.ts';
import { parseVoiceMode, sessionOptions } from './voice.ts';

const root = path.resolve(import.meta.dirname, '../../..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

// Пустая строка и строка из пробелов — «не задано», как в doctor, go-engine и game-server.
function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v;
}

function need(name: string): string {
  const v = optional(name);
  if (v === undefined) {
    console.error(`[X] voice-agent: нужна переменная ${name} (см. infra/.env.example)`);
    process.exit(2);
  }
  return v;
}

for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'OPENAI_API_KEY']) need(name);
const APP_KEY = need('APP_KEY');
const API_BASE = optional('API_BASE') ?? 'http://127.0.0.1:8787';
const AGENT_NAME = optional('AGENT_NAME') ?? 'goko';
const VOICE_MODE = parseVoiceMode(optional('VOICE_MODE'));

const log = (line: string) => console.log(line);
// Имена событий сеанса — из перечисления библиотеки: строковые литералы тип TypedEmitter не принимает.
const Events = voice.AgentSessionEventTypes;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const sessionId = sessionIdOf(ctx.job.metadata, ctx.room.name ?? '');
    log(`[OK] voice-agent: комната ${ctx.room.name}, сессия ${sessionId}, речь ${VOICE_MODE}`);
    await ctx.connect();
    // Комнату создал game-server (D-0001), агент приходит раньше телефона: Realtime открываем только
    // при живом участнике, иначе платная сессия шла бы в пустой комнате до emptyTimeout.
    const participant = await ctx.waitForParticipant();

    const client = createClient({ baseUrl: API_BASE, appKey: APP_KEY });
    const state = newAgentState(sessionId);
    // Сигнал сеанса: закрытие сессии или остановка воркера обрывает поток и вызовы инструментов.
    // Долгоживущий сигнал в CallOptions допустим: клиент снимает свой слушатель после каждого вызова.
    const abort = new AbortController();
    // Приветствие не в onEnter, а после применения режима: в «Чате» оно должно прийти только текстом.
    const agent = new GokoAgent(createTools({ client, state, log, signal: abort.signal }), { greet: false });
    const session = new voice.AgentSession(await sessionOptions(VOICE_MODE));
    let watch: WatchHandle | null = null;

    // Лента для логов: что услышали и что сказали. Значений env здесь нет.
    // Реплика человека после retries_exhausted переоткрывает поток сессии (D-0006): голосом — финальный
    // транскрипт, текстом из lk.chat — сообщение пользователя в истории (оно приходит и для голоса, повтор безвреден).
    session.on(Events.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      log(`[user] ${ev.transcript}`);
      watch?.humanSpoke();
    });
    session.on(Events.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type !== 'message') return; // AgentHandoffItem без role и текста
      if (item.role === 'user') watch?.humanSpoke();
      if (item.role === 'assistant' && item.textContent) log(`[goko] ${item.textContent}`);
    });
    session.on(Events.FunctionToolsExecuted, (ev) => {
      for (const call of ev.functionCalls) log(`[tool] ${call.name} ${call.args}`);
    });

    session.on(Events.Close, () => abort.abort());
    ctx.addShutdownCallback(async () => abort.abort());

    await session.start({ agent, room: ctx.room });

    // Режим Голос / Чат (D-0011): атрибут goko.mode участника. Применяется после start, см. mode.ts.
    const mode = followMode({ participant, session, log });
    ctx.room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => mode.onAttributes(p));
    ctx.room.on(RoomEvent.ParticipantConnected, (p) => mode.onAttributes(p)); // вернулся после обрыва с тем же identity
    session.generateReply({ instructions: GREETING_INSTRUCTIONS });

    watch = watchSession({
      client,
      state,
      signal: abort.signal,
      log,
      speak: async (instructions) => {
        session.generateReply({ instructions });
      },
    });
    void watch.done;
  },
});

// Остановка (SIGTERM от compose, режим start): drain ждёт идущие сеансы не дольше DRAIN_TIMEOUT_MS
// (по умолчанию у @livekit/agents 1.8 — 60 минут: разговор мог бы держать деплой час), затем close даёт
// процессу сеанса SHUTDOWN_PROCESS_TIMEOUT_MS на shutdown-колбэки и убивает его. Сумма с закрытием
// процесса инференса (5 с в библиотеке) — около 30 с; stop_grace_period у voice-agent в compose — 60 с (задача 10).
const DRAIN_TIMEOUT_MS = 5_000;
const SHUTDOWN_PROCESS_TIMEOUT_MS = 20_000;

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    drainTimeout: DRAIN_TIMEOUT_MS,
    shutdownProcessTimeout: SHUTDOWN_PROCESS_TIMEOUT_MS,
  }),
);
