#!/usr/bin/env node
// Текстовый диалог с Гоко без микрофона (раздел 12 спеки): сессия через game-server (он же создаёт
// комнату с агентом, D-0001), stdin -> lk.chat, lk.transcription и события SSE -> stdout. Нужны LIVEKIT
// на VPS и запущенный воркер с тем же AGENT_NAME, что у game-server (npm run dev поднимает оба под goko-dev).
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ApiError, ClientTimeoutError, createClient, humanText } from '@goko/protocol';

// Режим «Чат» (D-0011): агент выключает звук сессии и отвечает только текстом в lk.transcription.
export const CHAT_ATTRIBUTES = { 'goko.mode': 'chat' };

// Пустая строка и строка из пробелов — «не задано», как в doctor и game-server.
const env = (name) => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v;
};
const envMs = (name, fallback) => {
  const n = Number(env(name) ?? fallback);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// @livekit/rtc-node пишет свой pino-лог прямо в stdout: при NODE_ENV не production — с уровнем debug, и в каждой
// строке имя машины (hostname). Вывод прогонов попадает в отчёты публичного репозитория (правило 6 CLAUDE.md),
// а логгер библиотека не экспортирует: уровень и hostname она берёт при загрузке. Поэтому загружаем её
// динамически, выставив NODE_ENV (если не задан) и подменив имя машины для этого процесса.
// [!] Подмена работает, только пока pino ещё не загружен: pino читает os.hostname() один раз при загрузке
// своего модуля (pino/pino.js). Статических импортов чего-либо, что тянет pino (@livekit/rtc-node,
// @livekit/agents и т.п.), в этом файле быть не должно — иначе имя ПК молча вернётся в stdout.
async function loadRtc() {
  if (env('NODE_ENV') === undefined) process.env.NODE_ENV = 'production';
  os.hostname = () => 'goko-chat';
  return import('@livekit/rtc-node');
}

// Сколько ждать тишины после ответа: хвост реплики может прийти несколькими сегментами. Перед выходом по EOF
// и перед следующей строкой сценария ждём сначала начала ответа, затем тишину, — иначе ответ на последнюю
// фразу при скриптовом прогоне (echo 'дэ четыре' | npm run chat) теряется целиком.
const QUIET_MS = envMs('CHAT_QUIET_MS', 5000);
// Потолок одного ожидания: агент может замолчать или зациклиться, а висящая комната — это живые деньги
// за сессию Realtime (empty_timeout закрывает её только через 5 минут).
const MAX_WAIT_MS = envMs('CHAT_MAX_WAIT_MS', 60000);
// Потолок всего сценария из пайпа (от приглашения до выхода): зависший поток не должен держать платный
// сеанс N строк по MAX_WAIT_MS. 5 минут — порядок empty_timeout комнаты; длинный сценарий — через переменную.
const RUN_MAX_MS = envMs('CHAT_RUN_MAX_MS', 300000);
// Пауза без новых кусков сегмента, после которой считаем сегмент законченным.
const SEGMENT_DEBOUNCE_MS = 500;
// Диспетчеризация воркера занимает 3-5 с; фраза, отправленная в эту щель, до агента не доходит
// и пропадает молча — поэтому приглашение печатаем только после входа агента и начала приветствия.
// Потолок каждого из двух ожиданий: входа агента и приветствия.
const AGENT_WAIT_MS = envMs('CHAT_AGENT_WAIT_MS', 15000);
const POLL_MS = 200;

export function describeEvent(ev) {
  switch (ev.type) {
    case 'session.game':
      return `партия ${ev.gameId}`;
    case 'engine.thinking':
      return `Гоко думает за ${ev.color}`;
    case 'game.finished':
      return `конец: ${ev.result.winner}+${ev.result.reason === 'resign' ? 'R' : ev.result.margin}`;
    case 'error':
      return `ошибка ${ev.code}: ${humanText(ev.code)}`;
    case 'state.updated': {
      const last = ev.state.moves.at(-1);
      const via = ev.via ? ` via ${ev.via}` : '';
      const move = last ? `ход ${last.n} ${last.color} ${last.coord}` : `ходов ${ev.state.moves.length}`;
      return `${ev.cause} by ${ev.by}${via}: ${move}, rev ${ev.state.revision}, дальше ${ev.state.toPlay}`;
    }
    default:
      return JSON.stringify(ev);
  }
}

/**
 * Ждёт ответа и тишины: ответ начался (replied, по умолчанию true), probe() не занят (нет открытых потоков
 * и неподтверждённых сегментов) и quietMs без новой активности. Пауза вызова инструмента (ход движка до 8 с,
 * analyze до 10 с без событий SSE) бывает длиннее quietMs, поэтому до начала ответа тишина — не ответ.
 * Потолок — maxWaitMs от начала ожидания или общий deadline, что раньше; тишина проверяется до потолка.
 * 'quiet' — дождался; 'no_reply' — потолок, а ответ так и не начался; 'busy' — потолок при начатом ответе.
 * @param {() => { busy: boolean, lastActivityAt: number, replied?: boolean }} probe
 * @param {{ quietMs: number, maxWaitMs: number, deadline?: number, pollMs?: number, now?: () => number, pause?: (ms: number) => Promise<unknown> }} opts
 * @returns {Promise<'quiet' | 'no_reply' | 'busy'>}
 */
export async function waitForQuiet(probe, { quietMs, maxWaitMs, deadline = Number.POSITIVE_INFINITY, pollMs = POLL_MS, now = Date.now, pause = sleep }) {
  const startedAt = now();
  for (;;) {
    const { busy, lastActivityAt, replied = true } = probe();
    if (replied === true && busy === false && now() - lastActivityAt >= quietMs) return 'quiet';
    if (now() - startedAt >= maxWaitMs || now() >= deadline) return replied === true ? 'busy' : 'no_reply';
    await pause(pollMs);
  }
}

/**
 * Строка [!] для ожидания, кончившегося не тишиной; null — тишина.
 * @param {'quiet' | 'no_reply' | 'busy'} outcome
 * @param {{ lastSent: string | null, waitedMs: number, then: string }} ctx
 */
export function waitWarning(outcome, { lastSent, waitedMs, then }) {
  if (outcome === 'quiet') return null;
  const seconds = Math.round(waitedMs / 1000);
  if (outcome === 'no_reply') return `[!] ответа на «${lastSent}» не дождался за ${seconds} с, ${then}`;
  return `[!] тишины не дождался за ${seconds} с, ${then}`;
}

/**
 * Что делать при RoomEvent.Disconnected. Своё отключение ведёт shutdown. Чужое — всегда сбой: пока телефон
 * в комнате, сервер её не закрывает, а нативный слой сначала переподключается; значит, обрыв связи,
 * истёкший токен (D-0008) или вытеснение участника. Код 1 по брифу («сбой LiveKit»), адреса в строке нет.
 * @param {boolean} closing
 */
export function disconnectOutcome(closing) {
  if (closing) return null;
  return { code: 1, line: '[X] соединение с LiveKit потеряно, комната закрыта' };
}

/**
 * Строка [X] для исключения, дошедшего до main().catch. Текст ошибки не печатаем: у клиента он содержит адрес
 * game-server, у rtc-node — адрес LiveKit. До сессии ответ сервера по протоколу (limit_reached, rate_limited,
 * unauthorized) и таймаут клиента — фразой humanText и кодом; после сессии — только имя класса ошибки.
 * @param {unknown} e
 * @param {boolean} sessionCreated
 */
export function fatalLine(e, sessionCreated) {
  if (sessionCreated) return `[X] chat: сбой после создания сессии (${e instanceof Error ? e.name : typeof e}), выхожу`;
  if (e instanceof ApiError || e instanceof ClientTimeoutError) {
    return `[X] chat: не удалось создать сессию: ${humanText(e.code, e instanceof ApiError ? e.details : undefined)} (${e.code})`;
  }
  return '[X] chat: не удалось создать сессию; проверьте --api, APP_KEY и запущенный game-server';
}

/** @param {{ sessionCreated: boolean }} progress */
async function main(progress) {
  const root = path.resolve(import.meta.dirname, '..');
  if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const argv = process.argv.slice(2);
  const apiIndex = argv.indexOf('--api');
  const api = apiIndex >= 0 ? argv[apiIndex + 1] : (env('API_BASE') ?? 'http://127.0.0.1:8787');
  const appKey = env('APP_KEY');
  if (!appKey) {
    console.error('[X] chat: нужен APP_KEY в .env');
    process.exit(2);
  }

  // До создания сессии: без библиотеки комната с агентом создавалась бы зря.
  let rtc;
  try {
    rtc = await loadRtc();
  } catch {
    console.error('[X] chat: не загрузился @livekit/rtc-node; выполните npm install');
    process.exit(1);
  }
  const { Room, RoomEvent } = rtc;

  const client = createClient({ baseUrl: api, appKey });
  // Комнату и диспетчеризацию агента создаёт game-server в POST /api/sessions (D-0001); токен — только на эту комнату.
  const { session, livekit } = await client.createSession();
  progress.sessionCreated = true;
  // Значение AGENT_NAME не печатаем (правило 4 CLAUDE.md): агента диспетчеризует game-server по своей переменной.
  console.log(`[OK] сессия ${session.id}, комната ${session.room}, агент по AGENT_NAME game-server`);

  let gameId = session.currentGameId;
  const room = new Room();
  const abort = new AbortController();

  let lastActivityAt = Date.now();
  let activeStreams = 0;
  let closing = false;
  let agentJoined = false;
  // Первый поток lk.transcription — приветствие: агент запустил сеанс и принимает lk.chat.
  let agentSpoke = false;
  // Сколько потоков lk.transcription началось; replyBaseline — их число перед последней отправкой в lk.chat
  // (null — ответа не ждём). Ответ начался, когда счётчик вырос: тишина до этого — пауза инструмента, а не конец.
  let streamsStarted = 0;
  let replyBaseline = null;
  let lastSent = null;
  // Сегменты, уже напечатанные: повторные куски того же сегмента игнорируем.
  const printedSegments = new Set();
  // lk.segment_id -> { identity, text, timer } — сегменты в ожидании подтверждения.
  const pendingSegments = new Map();
  // Ключ потока -> { identity, text } — потоки, которые ещё не дочитаны. Без этой карты
  // накопленный текст живёт только в локальной переменной обработчика, и зависший поток
  // (главная причина выхода по потолку ожидания) теряется молча.
  const openStreams = new Map();

  const printSegment = (identity, text) => {
    lastActivityAt = Date.now();
    console.log(`[${identity}] ${text}`);
  };

  const flushSegment = (segmentId) => {
    const pending = pendingSegments.get(segmentId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSegments.delete(segmentId);
    printedSegments.add(segmentId);
    printSegment(pending.identity, pending.text);
  };

  // Выход по потолку ожидания или по Ctrl+C застаёт реплику недопечатанной двумя способами:
  // сегмент дочитан, но ждёт подтверждения, либо поток так и не закрылся. Второй случай и есть
  // обычная причина выхода по потолку, поэтому он тоже должен попасть в лог: «строки просто нет»
  // неотличимо от «агент ничего не сказал», и по такому прогону нечего разбирать.
  const reportLostSegments = () => {
    for (const [segmentId, pending] of pendingSegments) {
      clearTimeout(pending.timer);
      console.error(`[!] сегмент ${segmentId} от ${pending.identity} не подтверждён, недопечатано: ${pending.text}`);
    }
    pendingSegments.clear();
    let silentStreams = 0;
    for (const [streamKey, open] of openStreams) {
      if (!open.text) {
        silentStreams += 1;
        continue;
      }
      console.error(`[!] сегмент ${streamKey} от ${open.identity} поток не закрыт, недопечатано: ${open.text}`);
    }
    if (silentStreams > 0) console.error(`[!] открытых потоков: ${silentStreams}, хвост реплики не получен`);
    openStreams.clear();
  };

  const shutdown = async (code, announce = true) => {
    if (closing) return;
    closing = true;
    reportLostSegments();
    abort.abort();
    if (announce) console.log('[OK] сессия закрыта');
    try {
      await room.disconnect();
    } catch {
      // Отключение уже могло произойти; для выхода это не важно.
    }
    process.exit(code);
  };

  // Регистрировать до connect: первые реплики агента приходят сразу после входа.
  room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
    activeStreams += 1;
    streamsStarted += 1;
    lastActivityAt = Date.now();
    agentSpoke = true;
    const attrs = reader.info.attributes ?? {};
    const segmentId = attrs['lk.segment_id'];
    const identity = participant?.identity ?? 'agent';
    // Ключ тот же, что у сегмента, чтобы строки лога сходились между собой; на потоке без
    // сегмента берём идентификатор потока, он всегда есть.
    const streamKey = segmentId ?? reader.info.id;
    let text = '';
    try {
      // Поток отмечаем открытым сразу и обновляем на каждом куске: пока он не дочитан, хвост
      // не виден больше нигде, а диагностика на выходе печатала бы пустоту ровно тогда, когда
      // поток завис. Пустая запись тоже нужна — она отличает «поток открылся и молчит».
      openStreams.set(streamKey, { identity, text });
      for await (const chunk of reader) {
        text += chunk;
        openStreams.set(streamKey, { identity, text });
      }
      lastActivityAt = Date.now();
      if (!text) return;

      // Атрибут lk.transcription_final нельзя использовать как фильтр «печатать или нет»:
      // @livekit/agents 1.8.0 ведёт транскрипт агента дельта-потоком (isDeltaStream: true),
      // открывает его один раз с "false" в заголовке и уже не переписывает — фильтр по атрибуту
      // отбрасывал бы все реплики агента (проверено на спайке 08.09). Для агента признак финала —
      // дочитанный поток. Но транскрипт человека идёт НЕ дельта-потоком (isDeltaStream: false):
      // каждый промежуточный результат STT — отдельный закрытый поток с тем же lk.segment_id,
      // и «поток дочитан» там не значит «фраза закончена». Без дедупа по сегменту одна фраза
      // с телефона печаталась бы растущими дублями: «При», «Привет», «Привет, я»...
      // Отсечь по identity нельзя: микрофон на стадии 1 — отдельный участник с чужим именем,
      // и как раз распознанную речь человека в консоли видеть важнее всего.
      if (!segmentId) {
        printSegment(identity, text);
        return;
      }
      if (printedSegments.has(segmentId)) return;

      const pending = pendingSegments.get(segmentId);
      if (pending) clearTimeout(pending.timer);

      // У человека атрибут выставляется честно — печатаем сразу; у агента ждём паузу.
      if (attrs['lk.transcription_final'] === 'true') {
        pendingSegments.set(segmentId, { identity, text, timer: null });
        flushSegment(segmentId);
        return;
      }
      const timer = setTimeout(() => flushSegment(segmentId), SEGMENT_DEBOUNCE_MS);
      pendingSegments.set(segmentId, { identity, text, timer });
    } finally {
      activeStreams -= 1;
      openStreams.delete(streamKey);
    }
  });

  room.on(RoomEvent.ParticipantConnected, (p) => {
    // Любой удалённый участник — это воркер: в комнате goko-<sessionId> кроме него и нас никого
    // нет. Проверять identity по префиксу нельзя: имя воркера нигде в проекте не закреплено, и
    // при другом имени скрипт молча ждал бы весь AGENT_WAIT_MS и ругался бы на пустом месте.
    agentJoined = true;
    console.log(`[OK] в комнате: ${p.identity}`);
  });
  room.on(RoomEvent.ParticipantDisconnected, (p) => console.log(`[!] вышел: ${p.identity}`));
  room.on(RoomEvent.Disconnected, () => {
    // Наше собственное отключение уже ведёт shutdown; выходить здесь — оборвать хвост вывода. Чужое — сбой:
    // через shutdown, чтобы погасить SSE и напечатать недописанные сегменты (см. disconnectOutcome).
    const outcome = disconnectOutcome(closing);
    if (outcome === null) return;
    console.error(outcome.line);
    void shutdown(outcome.code, false);
  });

  try {
    await room.connect(livekit.url, livekit.token, { autoSubscribe: true, dynacast: false });
  } catch {
    // Текст ошибки rtc-node содержит адрес сервера, то есть значение LIVEKIT_URL: не печатаем
    // ни его, ни err.message — репозиторий и логи прогонов публичные.
    console.error('[X] не удалось подключиться к LiveKit; проверьте настройки сессии и воркер');
    process.exit(1);
  }
  console.log(`[OK] вошёл как ${room.localParticipant?.identity}; жду агента...`);
  // Режим «Чат» (D-0011). Агент читает атрибут, когда дождётся участника, и следит за его сменой,
  // так что выставить его сразу после connect достаточно. Без права canUpdateOwnMetadata в токене
  // (задача 5, шаг 1) сервер откажет: разговор всё равно работает, но агент ответит и голосом.
  try {
    await room.localParticipant.setAttributes(CHAT_ATTRIBUTES);
    console.log('[OK] режим чата: агент отвечает текстом');
  } catch {
    console.error('[!] не удалось выставить режим чата (goko.mode): агент будет отвечать и голосом');
  }

  // Ctrl+C без обработчика убил бы процесс молча: участник отвалился бы не по причине из
  // CLOSE_ON_DISCONNECT_REASONS, сессия Realtime висела бы до empty_timeout и стоила денег.
  const onSignal = () => {
    console.log('');
    void shutdown(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  void (async () => {
    try {
      for await (const ev of client.events({ sessionId: session.id }, abort.signal)) {
        if (ev.type === 'session.game') gameId = ev.gameId;
        lastActivityAt = Date.now();
        console.log(`[event] ${describeEvent(ev)}`);
      }
    } catch {
      // Текст ошибки клиента содержит адрес game-server — печатаем свою строку.
      if (!abort.signal.aborted) console.log('[!] SSE оборвался, события больше не приходят');
    }
  })();

  // Участник, уже стоявший в комнате к моменту connect, события ParticipantConnected не породит.
  if (room.remoteParticipants.size > 0) agentJoined = true;
  const agentDeadline = Date.now() + AGENT_WAIT_MS;
  while (!agentJoined && Date.now() < agentDeadline) await sleep(POLL_MS);
  if (!agentJoined) console.log('[!] агент не вошёл в комнату; писать можно, но ответов не будет');
  // Воркер входит в комнату раньше, чем готов слушать (D-0001: комнату с агентом создаёт сервер, агент ждёт
  // телефон): lk.chat RoomIO принимает только после session.start, фраза до этого пропадает молча. А текст
  // во время приветствия RoomIO по умолчанию прерывает его (interrupt + generateReply). Ждём начала приветствия.
  if (agentJoined) {
    const greetDeadline = Date.now() + AGENT_WAIT_MS;
    while (!agentSpoke && Date.now() < greetDeadline) await sleep(POLL_MS);
    if (!agentSpoke) console.log('[!] агент не поздоровался; писать можно, но первая фраза может пропасть');
  }

  const quietProbe = () => ({
    busy: activeStreams > 0 || pendingSegments.size > 0,
    lastActivityAt,
    replied: replyBaseline === null || streamsStarted > replyBaseline,
  });
  // Сценарий из пайпа (printf '...' | npm run chat) приходит весь сразу: без паузы следующая фраза прервала бы
  // ответ на предыдущую (interrupt в RoomIO), а /board показал бы доску до хода. С клавиатуры человек ждёт сам.
  const scripted = process.stdin.isTTY !== true;
  const me = room.localParticipant?.identity ?? 'phone';
  // Общий потолок только у сценария: интерактивный разговор длится сколько угодно, у него потолок — Ctrl+C.
  const runDeadline = scripted ? Date.now() + RUN_MAX_MS : Number.POSITIVE_INFINITY;

  console.log('[OK] пиши фразы («давай партию», «дэ четыре», «кто впереди»); /board — доска; Ctrl+C — выход');
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (closing) break;
    const text = line.trim();
    if (!text) continue;
    if (scripted) {
      const startedAt = Date.now();
      const outcome = await waitForQuiet(quietProbe, { quietMs: QUIET_MS, maxWaitMs: MAX_WAIT_MS, deadline: runDeadline });
      // Потолок сценария проверяется только когда тишины нет: успевший ответить агент сценарий не обрывает.
      const overRun = outcome !== 'quiet' && Date.now() >= runDeadline;
      const warning = waitWarning(outcome, { lastSent, waitedMs: Date.now() - startedAt, then: overRun ? 'остальные строки не отправляю' : 'отправляю следующую строку' });
      if (warning) console.error(warning);
      if (overRun) {
        console.error(`[X] сценарий не уложился в CHAT_RUN_MAX_MS (${Math.round(RUN_MAX_MS / 1000)} с), закрываю сессию`);
        await shutdown(1, false);
        return;
      }
      // Ответа на прежнюю фразу не было — не ждать его заново перед каждой следующей строкой.
      if (outcome === 'no_reply') replyBaseline = null;
      // Строка из пайпа на экране не видна: без эха в логе прогона непонятно, на что ответ.
      console.log(`[${me}] ${text}`);
    }
    if (text === '/board') {
      if (!gameId) {
        console.log('[!] партии ещё нет');
        continue;
      }
      try {
        console.log(await client.ascii(gameId));
      } catch {
        console.log('[!] не удалось получить доску от game-server');
      }
      continue;
    }
    // Число потоков до отправки: ответ, открывшийся сразу, пока sendText ещё не вернулся, тоже засчитывается.
    const baseline = streamsStarted;
    try {
      await room.localParticipant.sendText(text, { topic: 'lk.chat' });
    } catch {
      console.error('[X] не удалось отправить реплику агенту; соединение с LiveKit потеряно');
      await shutdown(1, false);
      return;
    }
    replyBaseline = baseline;
    lastSent = text;
    lastActivityAt = Date.now();
  }
  if (closing) return;

  // EOF на stdin — ещё не конец разговора. Ждём начала ответа на последнюю фразу и тишины: нет открытых
  // потоков, нет неподтверждённых сегментов, QUIET_MS без новой активности, — но не дольше MAX_WAIT_MS
  // и потолка сценария. Все строки уже отправлены, поэтому выход по потолку — [!] и код 0, как в брифе.
  const startedAt = Date.now();
  const outcome = await waitForQuiet(quietProbe, { quietMs: QUIET_MS, maxWaitMs: MAX_WAIT_MS, deadline: runDeadline });
  const warning = waitWarning(outcome, { lastSent, waitedMs: Date.now() - startedAt, then: 'закрываю сессию' });
  if (warning) console.error(warning);

  await shutdown(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Этап нужен main().catch: до createSession сбой — «не удалось создать сессию», после — другой текст.
  const progress = { sessionCreated: false };
  main(progress).catch((e) => {
    console.error(fatalLine(e, progress.sessionCreated));
    process.exit(1);
  });
}
