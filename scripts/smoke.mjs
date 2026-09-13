#!/usr/bin/env node
// Сценарная партия по HTTP против game-server: по умолчанию фейковый движок, с --real — go-engine + KataGo.
// Печатает [OK]/[X] на каждый шаг и ascii-доску; код возврата 0 только если все шаги прошли.
// Флаги: --real — go-engine с KataGo (нужен KATAGO_BIN в .env); --slow-sse — остановка
// game-server при медленном клиенте SSE (см. slowClientShutdown).
// Это глаза агента-разработчика: экран телефона он не видит.
//
// Границы (D-0001): smoke не вызывает /api/sessions — это создало бы платную комнату с агентом — и не
// передаёт в game-server настоящие LIVEKIT_* из .env: всегда заглушки (gameServerEnv, тест smoke.test.ts).
// Значения переменных окружения не печатаются.
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@goko/protocol';
import { STOP_CEILING_MS, hasExited, isWindows, loadRootEnv, startLogged, stopWithCeiling, withoutEmpty } from './processes.mjs';

export const SMOKE_APP_KEY = 'smoke';

// Заглушки LiveKit: проходят проверку старта game-server (непустые, адрес wss://), но никуда не ведут.
// Домен .invalid зарезервирован и не резолвится, поэтому даже случайный вызов API комнат не уйдёт.
export const LIVEKIT_STUB = Object.freeze({
  LIVEKIT_URL: 'wss://lk.invalid',
  LIVEKIT_API_KEY: 'smoke-livekit-key',
  LIVEKIT_API_SECRET: 'smoke-livekit-secret-not-a-real-one',
});

// Переменные родителя, которые game-server в smoke не получает никогда: ключи LiveKit и OpenAI, и то, что
// smoke задаёт сам: ключи приложения и движка свои, оба процесса локальные (иначе чужой SESSION_TTL_MS или MAX_SESSIONS из .env уронил бы запуск).
const SERVER_OWNED = ['APP_KEY', 'ENGINE_KEY', 'PORT', 'HOST', 'DATA_DIR', 'FAKE_ENGINE', 'ENGINE_URL', 'AGENT_NAME', 'MAX_SESSIONS', 'SESSION_TTL_MS'];
const isForeignSecret = (name) => name.startsWith('LIVEKIT_') || name.startsWith('OPENAI_');

// Окружение game-server для smoke. parentEnv — process.env (после .env) или {} для сервера в процессе.
/**
 * @param {Record<string, string | undefined>} parentEnv
 * @param {{ port: number, dataDir: string, real?: boolean, engineUrl?: string, engineKey?: string }} opts
 * @returns {Record<string, string>}
 */
export function gameServerEnv(parentEnv, { port, dataDir, real = false, engineUrl = '', engineKey = '' }) {
  const env = withoutEmpty(parentEnv);
  for (const name of Object.keys(env)) if (isForeignSecret(name) || SERVER_OWNED.includes(name)) delete env[name];
  Object.assign(env, LIVEKIT_STUB, { APP_KEY: SMOKE_APP_KEY, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, AGENT_NAME: 'goko-smoke' });
  if (real) {
    env.ENGINE_URL = engineUrl;
    env.ENGINE_KEY = engineKey;
  } else {
    env.FAKE_ENGINE = '1';
  }
  return env;
}

// Окружение go-engine для smoke --real: KATAGO_* из .env, ключ, порт и адрес свои, ключей LiveKit нет.
/**
 * @param {Record<string, string | undefined>} parentEnv
 * @param {{ port: number, engineKey: string }} opts
 * @returns {Record<string, string>}
 */
export function goEngineEnv(parentEnv, { port, engineKey }) {
  const env = withoutEmpty(parentEnv);
  for (const name of Object.keys(env)) if (isForeignSecret(name)) delete env[name];
  return { ...env, ENGINE_KEY: engineKey, ENGINE_PORT: String(port), ENGINE_HOST: '127.0.0.1' };
}

// Таймаут одного запроса /health. Сервис на петле отвечает за миллисекунды, а порт до готовности закрыт
// (отказ соединения сразу), поэтому 3 с — с запасом на загруженную машину и меньше самого короткого
// потолка waitHealth (10 с): зависшая попытка не съедает весь срок ожидания.
export const HEALTH_REQUEST_MS = 3_000;
// Таймаут одного запроса клиента smoke. Больше самого долгого бюджета вызова в game-server (клиент
// go-engine — до 30 с, ход ждёт ответ 8 с, score — 15 с) и меньше потолка settled (60 с).
export const CLIENT_REQUEST_MS = 45_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(step);
  }
  return false;
}

/**
 * Ждёт /health не дольше ms. gone — процесс сервиса уже вышел: тогда ждать нечего, сразу false
 * (иначе с --real и ошибкой конфигурации go-engine это 310 с пустого опроса после строки [X]).
 * Остальные параметры — швы для теста: запрос, таймаут запроса, часы и сон.
 * @param {string} url
 * @param {number} ms
 * @param {{
 *   pred?: (body: unknown) => boolean,
 *   gone?: () => boolean,
 *   fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
 *   timeoutSignal?: (ms: number) => AbortSignal,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   step?: number,
 * }} [opts]
 */
export async function waitHealth(url, ms, opts = {}) {
  const { pred = () => true, gone = () => false, fetchImpl = fetch, timeoutSignal = (t) => AbortSignal.timeout(t), now = Date.now, sleep: nap = sleep, step = 300 } = opts;
  const t0 = now();
  while (now() - t0 < ms) {
    if (gone()) return false;
    try {
      const res = await fetchImpl(url, { signal: timeoutSignal(HEALTH_REQUEST_MS) });
      if (res.ok && pred(await res.json())) return true;
    } catch {
      // порт ещё закрыт или запрос не уложился в HEALTH_REQUEST_MS — следующая попытка
    }
    if (gone()) return false;
    await nap(step);
  }
  return false;
}

/**
 * fetch с таймаутом на каждый запрос. Запрос со своим сигналом (поток SSE) не трогаем: поток длится
 * дольше любого таймаута и ограничен AbortController вызывающего.
 * @param {number} ms
 * @param {(url: string | URL | Request, init?: RequestInit) => Promise<Response>} [base]
 * @param {(ms: number) => AbortSignal} [timeoutSignal]
 * @returns {typeof fetch}
 */
export function timedFetch(ms, base = fetch, timeoutSignal = (t) => AbortSignal.timeout(t)) {
  return (url, init) => (init?.signal ? base(url, init) : base(url, { ...init, signal: timeoutSignal(ms) }));
}

/**
 * Ожидание /health процесса-ребёнка: прерывается, как только он вышел.
 * @param {{ exitCode: number | null, signalCode: string | null }} child
 * @param {string} url
 * @param {number} ms
 * @param {Parameters<typeof waitHealth>[2]} [opts]
 */
export function waitChildHealth(child, url, ms, opts = {}) {
  return waitHealth(url, ms, { ...opts, gone: () => hasExited(child) });
}

/**
 * Клиент smoke: ключ smoke и таймаут CLIENT_REQUEST_MS на каждый запрос. base — шов для теста.
 * @param {string} baseUrl
 * @param {(url: string | URL | Request, init?: RequestInit) => Promise<Response>} [base]
 */
export function smokeClient(baseUrl, base = fetch) {
  return createClient({ baseUrl, appKey: SMOKE_APP_KEY, fetch: timedFetch(CLIENT_REQUEST_MS, base) });
}

/**
 * Опции запуска ребёнка smoke. На POSIX ребёнок — лидер своей группы: killTree шлёт сигнал группе, и
 * KataGo не остаётся сиротой после go-engine. На Windows дерево гасит taskkill /T.
 * @param {string} root
 * @param {Record<string, string>} env
 * @param {boolean} [windows]
 */
export function smokeStartOptions(root, env, windows = isWindows) {
  return { cwd: root, env, prefix: '  ', detached: !windows };
}

/**
 * Запуск ребёнка smoke: node с опциями smokeStartOptions. start — шов для теста.
 * @param {string} name
 * @param {string[]} args
 * @param {string} root
 * @param {Record<string, string>} env
 * @param {Function} [start]
 */
export function startChild(name, args, root, env, start = startLogged) {
  return start(name, process.execPath, args, smokeStartOptions(root, env));
}

// Ошибка операции: проверяем code, status и details, а не текст — message английский и для разработчика.
async function errorOf(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

async function main() {
  const root = path.resolve(import.meta.dirname, '..');
  loadRootEnv(root);

  const real = process.argv.includes('--real');
  const slowSse = process.argv.includes('--slow-sse');
  const PORT = Number(process.env.SMOKE_PORT ?? 18787);
  const ENGINE_PORT = Number(process.env.SMOKE_ENGINE_PORT ?? 18788);
  const SLOW_PORT = Number(process.env.SMOKE_SLOW_PORT ?? 18789);
  const engineKey = randomBytes(24).toString('hex');
  const children = [];
  let stopping = false;
  let failed = 0;

  const ok = (msg) => console.log(`[OK] ${msg}`);
  const warn = (msg) => console.log(`[!] ${msg}`);
  const fail = (msg) => {
    failed++;
    console.log(`[X] ${msg}`);
  };
  const check = (cond, msg) => {
    (cond ? ok : fail)(msg);
    return cond;
  };

  function start(name, args, env) {
    const child = startChild(name, args, root, env);
    child.on('exit', (code) => {
      if (!stopping) fail(`${name} завершился с кодом ${code}`);
    });
    children.push({ name, child });
    return child;
  }

  // Детям — мягкий SIGTERM (на Windows его нет: дерево гасится силой), ожидание с потолком, затем силой.
  async function stopAll() {
    stopping = true;
    const results = await Promise.all(children.map(async ({ name, child }) => ({ name, result: await stopWithCeiling(child, { soft: 'SIGTERM' }) })));
    for (const { name, result } of results) {
      if (result === 'killed') warn(`${name} не вышел за ${STOP_CEILING_MS} мс, погашен силой`);
      if (result === 'stuck') fail(`${name} не удалось остановить`);
    }
  }

  // Ctrl+C во время smoke: дети в своих группах (POSIX, detached) или в скрытых консолях (Windows) сигнала
  // терминала не получают. Гасим их сами, а не оставляем сиротами на портах smoke. Повторный сигнал — выход сразу.
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.once(signal, () => {
      if (stopping) return;
      fail(`smoke: прерван сигналом ${signal}, останавливаю процессы`);
      void stopAll().finally(() => process.exit(1));
    });
  }

  const dataDir = await mkdtemp(path.join(tmpdir(), 'goko-smoke-'));
  try {
    if (real) {
      if (!process.env.KATAGO_BIN?.trim()) throw new Error('--real: нужна переменная KATAGO_BIN в .env');
      const engine = start('go-engine', ['apps/go-engine/src/main.ts'], goEngineEnv(process.env, { port: ENGINE_PORT, engineKey }));
      // Прогрев KataGo до открытия порта: первый запуск на машине тюнит OpenCL, потолок go-engine — 300 с.
      if (!check(await waitChildHealth(engine, `http://127.0.0.1:${ENGINE_PORT}/health`, 310_000, { pred: (h) => h?.ok === true }), 'go-engine: /health ok (KataGo прогрет)')) throw new Error('движок не поднялся');
    }
    const server = start('game-server', ['apps/game-server/src/main.ts'], gameServerEnv(process.env, { port: PORT, dataDir, real, engineUrl: `http://127.0.0.1:${ENGINE_PORT}`, engineKey }));
    if (!check(await waitChildHealth(server, `http://127.0.0.1:${PORT}/health`, 30_000), `game-server: /health на :${PORT} (движок ${real ? 'KataGo' : 'fake'})`)) throw new Error('game-server не поднялся');

    const client = smokeClient(`http://127.0.0.1:${PORT}`);
    const seats = { black: { controller: 'human' }, white: { controller: 'engine', rank: '10k' } };
    // Если ответ движка не уложился в 8 с (replyTimedOut), дожидаемся его по состоянию.
    const settled = async (id, res) => {
      if (!res.replyTimedOut) return res.state;
      let state = res.state;
      const done = await waitFor(async () => {
        state = await client.getGame(id);
        return !state.pendingEngineMove;
      }, 60_000);
      if (!done) throw new Error('движок так и не ответил');
      return state;
    };

    // --- отказы по протоколу: смысл в code, status и details ---
    const bots = await errorOf(client.createGame({ black: { controller: 'engine' }, white: { controller: 'engine' } }));
    check(bots?.code === 'unsupported_controller' && bots?.status === 400, `движок против движка отклонён (${bots?.code})`);

    // --- партия 1: ход, исправление, откат, отказы, оценка, счёт, сдача ---
    const g1 = await client.createGame(seats);
    const id = g1.state.id;
    check(g1.state.status === 'playing' && g1.state.toPlay === 'B', `партия ${id} создана, ход чёрных`);

    const p1 = await client.play(id, { coord: 'D4' });
    let s = await settled(id, p1);
    check(p1.move.coord === 'D4' && s.moves.length === 2, `D4 сыгран, ответ Гоко ${s.moves[1]?.coord}`);

    const p2 = await client.play(id, { coord: 'K10' });
    s = await settled(id, p2);
    check(p2.move.n === 3 && s.moves.length === 4, `K10 сыгран, ответ ${s.moves[3]?.coord}`);

    const c1 = await client.correct(id, { coord: 'K4' });
    s = await settled(id, c1);
    check(c1.move.n === 3 && c1.move.coord === 'K4' && s.moves.length === 4 && s.moves[2]?.coord === 'K4', `correct K10 -> K4, новый ответ ${s.moves[3]?.coord}`);

    const u1 = await client.undo(id);
    check(u1.removed.length === 2 && u1.state.moves.length === 2 && u1.state.toPlay === 'B', 'undo снял пару ходов, ход чёрных');

    const occupied = await errorOf(client.play(id, { coord: 'D4' }));
    check(occupied?.code === 'illegal_move' && occupied?.status === 400 && occupied?.details?.reason === 'occupied', `D4 повторно -> 400 illegal_move, details.reason ${occupied?.details?.reason}`);
    const badCoord = await errorOf(client.play(id, { coord: 'I5' }));
    check(badCoord?.code === 'invalid_coord' && badCoord?.status === 400, `I5 -> 400 ${badCoord?.code}`);
    // Схемы запросов строгие: опечатка в имени поля — отказ, а не молча снятая защита от гонки.
    const typo = await errorOf(client.play(id, { coord: 'E5', expectedRevison: 0 }));
    check(typo?.code === 'bad_request' && typo?.status === 400, `лишнее поле expectedRevison -> 400 ${typo?.code}`);
    const stale = await errorOf(client.play(id, { coord: 'E5', expectedRevision: 0 }));
    check(stale?.code === 'revision_conflict' && stale?.status === 409 && typeof stale?.details?.revision === 'number', `устаревшая expectedRevision -> 409 ${stale?.code}`);

    const a = await client.analyze(id);
    check(a.ownership.length === 169 && a.groups.length >= 1, `analyze: winrateB ${a.winrateB.toFixed(2)}, lead ${a.scoreLeadB.toFixed(1)}, групп ${a.groups.length}, topMoves ${a.topMoves.map((m) => m.coord).join(' ')}`);

    const sc = await client.score(id);
    const afterScore = await client.getGame(id);
    check(sc.reason === 'score' && sc.score !== undefined && afterScore.status === 'playing', `score без завершения: ${sc.winner}+${sc.margin}`);

    const r = await client.resign(id, { color: 'B', via: 'api' });
    check(r.state.status === 'finished' && r.state.result?.reason === 'resign' && r.state.result?.winner === 'W', 'resign: W+R');
    const afterResign = await errorOf(client.play(id, { coord: 'E5' }));
    check(afterResign?.code === 'game_finished' && afterResign?.status === 409, `ход после сдачи -> 409 ${afterResign?.code}`);

    // --- партия 2: SSE, пасы, автосчёт ---
    const g2 = await client.createGame(seats);
    const id2 = g2.state.id;
    const ac = new AbortController();
    const events = [];
    const listening = (async () => {
      try {
        for await (const e of client.events({ gameId: id2 }, ac.signal)) events.push(e);
      } catch {
        // обрыв по abort
      }
    })();
    check(await waitFor(() => events.length >= 1, 3000, 50), 'SSE: поток партии открыт');
    check(events[0]?.type === 'state.updated' && events[0]?.cause === 'sync', 'SSE: первым пришло состояние (sync)');

    const pp = await client.pass(id2, { via: 'api' });
    s = await settled(id2, pp);
    const engineReply = s.moves[1];
    check(engineReply !== undefined, `пас сыгран, ответ Гоко ${engineReply?.coord}`);
    if (engineReply?.coord === 'pass') {
      const finished = await waitFor(async () => (await client.getGame(id2)).status === 'finished', 60_000);
      const final = await client.getGame(id2);
      check(finished && final.result?.reason === 'score', `два паса -> автосчёт: ${final.result?.winner}+${final.result?.margin}`);
      check(await waitFor(() => events.some((e) => e.type === 'game.finished'), 3000, 50), 'SSE: пришло game.finished');
    } else {
      ok(`Гоко на пас ответил ${engineReply?.coord}; доигрывать не будем, сдаёмся`);
      await client.resign(id2, { color: 'B', via: 'api' });
      check((await client.getGame(id2)).status === 'finished', 'resign завершил партию 2');
    }
    const updates = events.filter((e) => e.type === 'state.updated').length;
    check(updates >= 3, `SSE: событий state.updated ${updates}`);
    ac.abort();
    await listening;

    // --- текстовые представления первой партии ---
    console.log(await client.ascii(id));
    const sgf = await client.sgf(id);
    check(sgf.startsWith('(;FF[4]GM[1]') && sgf.includes('RE[W+R]') && sgf.includes(';B[dj]'), 'sgf первой партии: W+R, первый ход D4 = dj');
    check((await client.listGames()).games.length === 2, 'list_games: две партии');

    // --- остановка сервера при медленном клиенте SSE на настоящем TCP ---
    // Только по флагу: шаг поднимает второй сервер и гоняет ~58 МБ через сокет. Регрессия здесь — выход по
    // дедлайну SHUTDOWN_MS (25 с реального ожидания) с кодом 1: остановка снова ждёт застрявшее соединение.
    if (slowSse) await slowClientShutdown({ port: SLOW_PORT, ok, warn, fail, check });
  } catch (e) {
    fail(`сценарий прерван: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await stopAll();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  console.log(failed ? `[X] smoke: ошибок ${failed}` : '[OK] smoke: все шаги прошли');
  process.exit(failed ? 1 : 0);
}

// Клиент открыл поток и не читает, сервер получает сигнал остановки: game-server обязан выйти штатно
// (код 0), не дожидаясь дедлайна SHUTDOWN_MS. Застрявшую запись обрывает stream.abort() в app.ts; тесты
// приложения проверяют это через app.request без сокета, а здесь — настоящий сокет @hono/node-server.
// Сервер поднимается в этом же процессе через startServer: так сигнал доставляется обработчику на любой ОС
// (на Windows мягкого сигнала другому процессу нет). Чтобы запись застряла, в канал партии уходят события
// по 64 КБ — больше, чем вмещают буферы сокета, но меньше предела очереди SSE_QUEUE_LIMIT (1000).
async function slowClientShutdown({ port, ok, warn, fail, check }) {
  const { startServer, SHUTDOWN_MS } = await import('../apps/game-server/src/start-server.ts');
  const { GameService } = await import('../apps/game-server/src/service.ts');
  const { SSE_QUEUE_LIMIT } = await import('../apps/game-server/src/app.ts');
  const EVENTS = Math.min(900, SSE_QUEUE_LIMIT - 1);
  const PAD = 'x'.repeat(64_000);
  const dir = await mkdtemp(path.join(tmpdir(), 'goko-smoke-slow-'));
  const handlers = [];
  let bus = null;
  let onExit;
  const exited = new Promise((resolve) => {
    onExit = (code) => resolve({ code, at: performance.now() });
  });
  const socket = new net.Socket();
  try {
    const started = await startServer({
      env: gameServerEnv({}, { port, dataDir: dir }),
      on: (_signal, handler) => handlers.push(handler),
      exit: (code) => onExit(code),
      log: (line) => console.log(`  [slow-sse] ${line}`),
      createService: (deps) => {
        bus = deps.bus;
        return new GameService(deps);
      },
    });
    if (!check(started !== null && bus !== null && (await waitHealth(`http://127.0.0.1:${port}/health`, 10_000)), `медленный клиент: game-server в процессе на :${port}`)) return;

    const client = smokeClient(`http://127.0.0.1:${port}`);
    const { state } = await client.createGame({ black: { controller: 'human' }, white: { controller: 'engine' } });

    let received = 0;
    socket.on('data', (chunk) => {
      received += chunk.length;
    });
    socket.on('error', () => {}); // обрыв сервером после остановки — ожидаемый исход
    const firstChunk = new Promise((resolve) => socket.once('data', resolve));
    socket.connect(port, '127.0.0.1', () => {
      socket.write(`GET /api/games/${state.id}/events HTTP/1.1\r\nHost: 127.0.0.1\r\nx-app-key: ${SMOKE_APP_KEY}\r\naccept: text/event-stream\r\n\r\n`);
    });
    const opened = await Promise.race([firstChunk.then(() => true), sleep(3000).then(() => false)]);
    socket.pause(); // дальше клиент не читает: буферы сокета заполняются, запись сервера встаёт
    if (!check(opened, 'медленный клиент: поток открыт, клиент перестал читать')) return;

    for (let i = 0; i < EVENTS; i++) bus.emit(`game:${state.id}`, { type: 'error', code: 'internal', message: PAD });
    const emittedBytes = EVENTS * PAD.length;
    await sleep(500);

    const t0 = performance.now();
    handlers[0]?.();
    const result = await Promise.race([exited, sleep(SHUTDOWN_MS + 5_000).then(() => null)]);
    const elapsed = result ? Math.round(result.at - t0) : null;
    check(result !== null && result.code === 0 && elapsed < SHUTDOWN_MS, `медленный клиент: остановка с кодом ${result?.code} за ${elapsed} мс (дедлайн ${SHUTDOWN_MS} мс)`);

    // Показательность: клиент получил меньше, чем ушло в канал, — значит запись действительно стояла.
    socket.resume();
    await Promise.race([new Promise((resolve) => socket.once('close', resolve)), sleep(5_000)]);
    if (received < emittedBytes) ok(`медленный клиент: запись стояла (получено ${received} из ${emittedBytes} байт), соединение закрыто`);
    else warn(`медленный клиент: буферы вместили все ${emittedBytes} байт, застрявшая запись не воспроизведена`);
  } catch (e) {
    fail(`медленный клиент: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    socket.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
