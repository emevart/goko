// Воркер LiveKit Agents: одна комната = одна сессия Гоко. Запуск: node apps/voice-agent/src/main.ts dev|start.
// .env берётся из корня репозитория (на VPS переменные приходят из compose). Логика — в модулях с тестами
// (config, departure, mode, events, tools); здесь только связка с LiveKit.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import { type Participant, type RemoteParticipant, RoomEvent } from '@livekit/rtc-node';
import { createClient } from '@goko/protocol';
import { GokoAgent } from './agent.ts';
import { CONFIG_EXIT_CODE, readConfig } from './config.ts';
import { attachConversationEvents } from './conversation-events.ts';
import { watchDeparture } from './departure.ts';
import { createEventSpeaker } from './event-speech.ts';
import { type WatchHandle, watchSession } from './events.ts';
import { workerPoolOptions } from './load.ts';
import { sessionIdOf } from './metadata.ts';
import { MODE_ATTRIBUTE, MODE_WAIT_MS, type ModeFollower, type ParticipantLike, followMode, waitForMode } from './mode.ts';
import { GREETING_INSTRUCTIONS } from './prompt.ts';
import { newAgentState } from './state.ts';
import { createTools } from './tools.ts';
import { sessionOptions } from './voice.ts';

const root = path.resolve(import.meta.dirname, '../../..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const { config, errors } = readConfig(process.env);
if (!config) {
  for (const line of errors) console.error(line);
  process.exit(CONFIG_EXIT_CODE);
}
const { appKey, apiBase, agentName, voiceMode } = config;

const log = (line: string) => console.log(line);
// Имена событий сеанса — из перечисления библиотеки: строковые литералы тип TypedEmitter не принимает.
const Events = voice.AgentSessionEventTypes;

const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    // Имя комнаты Room знает только после connect: до него запасной путь sessionIdOf был недостижим.
    const roomName = ctx.room.name ?? '';
    const sessionId = sessionIdOf(ctx.job.metadata, roomName);
    log(`[OK] voice-agent: комната ${roomName}, сессия ${sessionId}, речь ${voiceMode}`);
    // Сеанс — вне entry, см. runSession. Сбой запуска завершает job: немой агент не должен держать комнату.
    runSession(ctx, sessionId).catch((e: unknown) => {
      console.error(`[X] voice-agent: сеанс не запустился: ${errorText(e)}`);
      ctx.shutdown('session failed');
    });
  },
});

// entry не ждёт телефон. При остановке job @livekit/agents 1.8 сначала до 15 с ждёт возврата entry
// (ENTRYPOINT_SHUTDOWN_TIMEOUT, job_lifecycle.ts) и только потом отключает комнату и зовёт shutdown-колбэки
// (job_proc_lazy_main.ts): сигнала, которым entry мог бы прервать ожидание раньше, нет. Поэтому entry
// возвращается сразу после connect, а ожидание участника живёт здесь. Остановка job или закрытие пустой
// комнаты по emptyTimeout отключают Room, waitForParticipant отклоняется — это штатный выход с одной строкой.
async function runSession(ctx: JobContext, sessionId: string): Promise<void> {
  let participant: RemoteParticipant;
  try {
    // Комнату создал game-server (D-0001), агент приходит раньше телефона: Realtime открываем только
    // при живом участнике, иначе платная сессия шла бы в пустой комнате до emptyTimeout.
    participant = await ctx.waitForParticipant();
  } catch {
    log('[!] voice-agent: участник не пришёл, комната закрыта');
    return;
  }
  const identity = participant.identity;

  // Уход участника сеанс не закрывает (closeOnDisconnect: false ниже): перезагрузка вкладки возвращает того же
  // участника в ту же комнату. Не вернулся за RETURN_GRACE_MS (15 мин) — job завершается (departure.ts).
  // Подписка сразу после ожидания: участник может уйти, пока открывается Realtime.
  let mode: ModeFollower | null = null;
  const departure = watchDeparture<RemoteParticipant>({
    identity,
    log,
    onGone: () => ctx.shutdown('participant left'),
    onReturn: (p) => mode?.onRejoin(p),
  });
  ctx.room.on(RoomEvent.ParticipantDisconnected, (p) => departure.onDisconnected(p));
  ctx.room.on(RoomEvent.ParticipantConnected, (p) => departure.onConnected(p));

  const client = createClient({ baseUrl: apiBase, appKey });
  const state = newAgentState(sessionId);
  // Сигнал сеанса: закрытие сессии или остановка воркера обрывает поток и вызовы инструментов.
  // Долгоживущий сигнал в CallOptions допустим: клиент снимает свой слушатель после каждого вызова.
  const abort = new AbortController();
  // Приветствие не в onEnter, а после применения режима: в «Чате» оно должно прийти только текстом.
  const agent = new GokoAgent(createTools({ client, state, log, signal: abort.signal }), { greet: false });
  const session = new voice.AgentSession(await sessionOptions(voiceMode));
  let watch: WatchHandle | null = null;
  const localParticipant = ctx.room.localParticipant;
  if (!localParticipant) throw new Error('local participant unavailable after connect');
  const stopConversationEvents = attachConversationEvents({
    subscribe: (listener) => {
      session.on(Events.ConversationItemAdded, listener);
      return () => void session.off(Events.ConversationItemAdded, listener);
    },
    sendText: (text, options) => localParticipant.sendText(text, options),
    destinationIdentity: identity,
    log,
  });

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

  // Закрытый сеанс (неустранимая ошибка модели, остановка job) не оживёт: job завершается, а не висит
  // в комнате молча. При остановке job повторный shutdown ничего не делает.
  session.on(Events.Close, (ev) => {
    abort.abort();
    departure.stop();
    stopConversationEvents();
    log(`[!] voice-agent: сеанс закрыт (${ev.reason}), job завершается`);
    ctx.shutdown(`session closed: ${ev.reason}`);
  });
  ctx.addShutdownCallback(async () => {
    abort.abort();
    departure.stop();
    stopConversationEvents();
  });

  const attributesChanged = (listener: (p: ParticipantLike) => void) => {
    const handler = (_changed: Record<string, string>, p: Participant) => listener(p);
    ctx.room.on(RoomEvent.ParticipantAttributesChanged, handler);
    return () => void ctx.room.off(RoomEvent.ParticipantAttributesChanged, handler);
  };

  // Режим до приветствия (D-0011): веб и chat.mjs выставляют goko.mode уже после входа. Ждём атрибут
  // параллельно с открытием Realtime, но не дольше MODE_WAIT_MS; не пришёл — здороваемся в «Голосе»,
  // поздний атрибут переключит режим через followMode, и остаток приветствия в «Чате» уйдёт текстом.
  // RoomIO привязан к участнику по identity: к нему же после перезагрузки вкладки.
  const [, modeArrived] = await Promise.all([
    session.start({ agent, room: ctx.room, inputOptions: { closeOnDisconnect: false, participantIdentity: identity } }),
    waitForMode({ participant, subscribe: attributesChanged }),
  ]);
  if (!modeArrived) log(`[!] voice-agent: ${MODE_ATTRIBUTE} не пришёл за ${MODE_WAIT_MS / 1000} с, начинаю в режиме по умолчанию`);

  // Применяется после start, см. mode.ts. Атрибуты читаются живыми с участника: пришедшее во время
  // ожидания уже в них.
  const follower = followMode({ participant, session, log });
  mode = follower;
  ctx.room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => follower.onAttributes(p));
  session.generateReply({ instructions: GREETING_INSTRUCTIONS });

  watch = watchSession({
    client,
    state,
    signal: abort.signal,
    log,
    // Реплики событий по очереди: следующее событие ждёт, пока прозвучит (или прервётся) предыдущая.
    // Текст события — в историю разговора, ответ — без инструментов (event-speech.ts, D-0013).
    // Остановку сеанса say в events.ts не ждёт: ожидание ограничено сигналом.
    speak: createEventSpeaker({ agent, session, log }),
  });
  void watch.done;
}

// Остановка (SIGTERM от compose, режим start): drain ждёт идущие сеансы не дольше DRAIN_TIMEOUT_MS
// (по умолчанию у @livekit/agents 1.8 — 60 минут: разговор мог бы держать деплой час), затем close даёт
// процессу сеанса SHUTDOWN_PROCESS_TIMEOUT_MS на shutdown-колбэки и убивает его. Сумма с закрытием
// процесса инференса (5 с в библиотеке) — около 30 с; stop_grace_period у voice-agent в compose — 60 с (задача 10).
const DRAIN_TIMEOUT_MS = 5_000;
const SHUTDOWN_PROCESS_TIMEOUT_MS = 20_000;

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName,
    drainTimeout: DRAIN_TIMEOUT_MS,
    shutdownProcessTimeout: SHUTDOWN_PROCESS_TIMEOUT_MS,
    // Загрузка по числу job, а не по CPU машины: иначе всплеск CPU в момент создания комнаты оставлял её без агента
    // навсегда. Один тёплый процесс: без него в dev завершённые job оставались в счёте (load.ts, D-0013).
    ...workerPoolOptions(),
  }),
);
