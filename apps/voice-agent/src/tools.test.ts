import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, ClientTimeoutError, type GameState, HttpError, humanText } from '@goko/protocol';
import { type AgentState, newAgentState } from './state.ts';
import { createFakeClient, fakeGame } from './testing/fake-client.ts';
import {
  ASSESSMENT_VISITS,
  FINISH_POLL_MS,
  FINISH_TICK_MS,
  FINISH_WAIT_MS,
  KOMI_TEXT,
  NETWORK_TEXT,
  type ToolClient,
  type ToolFns,
  createToolFns,
  createTools,
} from './tools.ts';

type FakeOpts = Parameters<typeof createFakeClient>[0];
type OnTick = (now: number, state: AgentState) => void;

// Часы тестов двигает только sleep: ожидание итога и Retry-After проверяются без настоящего времени.
// onTick — что «пришло из потока» к этому моменту (events.ts кладёт итог в state.finished).
function setup(opts: FakeOpts = {}, onTick?: OnTick) {
  const client = createFakeClient(opts);
  const state = newAgentState('s1');
  const clock = { t: 0 };
  const slept: number[] = [];
  const controller = new AbortController();
  const sleep = async (ms: number) => {
    slept.push(ms);
    clock.t += ms;
    onTick?.(clock.t, state);
  };
  const fns = createToolFns({ client, state, sleep, now: () => clock.t, signal: controller.signal });
  return { client, state, fns, slept, clock, controller };
}

async function withGame(opts: FakeOpts = {}, onTick?: OnTick) {
  const t = setup(opts, onTick);
  await t.fns.startGame({ my_color: 'black' });
  t.client.calls.length = 0;
  t.client.signals.length = 0;
  return t;
}

// Партия фейкового клиента без non-null `!`: нет партии — тест падает понятной ошибкой.
function gameOf(client: { game: GameState | null }): GameState {
  if (!client.game) throw new Error('фейковый клиент: партии нет');
  return client.game;
}

describe('без партии', () => {
  it('инструменты партии отвечают ok:false с подсказкой', async () => {
    const { fns, client } = setup();
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: 'партия не начата: предложи начать' });
    expect(await fns.pass()).toMatchObject({ ok: false });
    expect(await fns.getPosition()).toContain('партия не начата');
    expect(client.calls).toEqual([]);
  });
  it('set_rank без партии запоминает ранг для следующей', async () => {
    const { fns, state, client } = setup();
    expect(await fns.setRank({ rank: '5 кю' })).toEqual({ ok: true, rank: '5 кю', note: 'применится к следующей партии' });
    expect(state.rank).toBe('5k');
    expect(client.calls).toEqual([]);
  });
});

describe('start_game', () => {
  it('человек чёрными: движок белыми с рангом по умолчанию, первого хода нет', async () => {
    const { fns, state, client } = setup();
    const res = await fns.startGame({});
    expect(res).toEqual({ ok: true, gameId: 'g1', youPlay: 'black', rank: '10 кю', komi: 7.5, firstMove: null, firstMoveSpoken: null });
    expect(client.calls[0]).toMatchObject({
      method: 'newGame',
      args: ['s1', { black: { controller: 'human' }, white: { controller: 'engine', rank: '10k' }, settings: { komi: 7.5 }, waitForReply: true }],
    });
    expect(state.gameId).toBe('g1');
    expect(state.humanColor).toBe('B');
    expect(state.toolGames.has('g1')).toBe(true);
    expect(state.startingGame).toBe(false);
  });
  it('на время newGame выставляет startingGame и снимает его после ошибки', async () => {
    const { fns, state, client } = setup();
    let during: boolean | null = null;
    const newGame = client.newGame;
    client.newGame = async (...args) => {
      during = state.startingGame;
      return newGame(...args);
    };
    await fns.startGame({});
    expect(during).toBe(true);
    // Лимит незавершённых партий на клиента (D-0012, задача 9): текст — из humanText по details.
    const details = { max: 3, scope: 'client' };
    client.failNext(new ApiError('too_many_games', 'limit of 3 unfinished games per client reached', details));
    expect(await fns.startGame({})).toEqual({ ok: false, reason: humanText('too_many_games', details) });
    expect(state.startingGame).toBe(false);
  });
  it('коми не с половиной или вне 0,5–13,5 — ok:false без запроса', async () => {
    const { fns, client } = setup();
    for (const komi of [7, 0, 14.5, -0.5, Number.NaN]) expect(await fns.startGame({ komi })).toEqual({ ok: false, reason: KOMI_TEXT });
    expect(client.calls).toEqual([]);
    expect(await fns.startGame({ komi: 0.5 })).toMatchObject({ ok: true, komi: 0.5 });
  });
  it('человек белыми с рангом: первый ход движка в ответе', async () => {
    const { fns, state } = setup({ replies: ['K10'] });
    const res = await fns.startGame({ my_color: 'white', rank: '3 кю', komi: 6.5 });
    expect(res).toMatchObject({ ok: true, youPlay: 'white', rank: '3 кю', komi: 6.5, firstMove: 'K10', firstMoveSpoken: 'ка десять' });
    expect(state.humanColor).toBe('W');
    expect(state.rank).toBe('3k');
  });
  it('непонятный ранг — ok:false, партия не создаётся', async () => {
    const { fns, client } = setup();
    expect(await fns.startGame({ rank: 'сильно' })).toEqual({ ok: false, reason: 'не понял ранг «сильно»: назови число и кю или дан' });
    expect(client.calls).toEqual([]);
  });
  it('таймаут первого хода — note и awaitingReply', async () => {
    const { fns, state, client } = setup();
    client.replyTimedOut = true;
    const res = await fns.startGame({ my_color: 'white' });
    expect(res).toMatchObject({ ok: true, firstMove: null, note: 'Гоко ещё думает над первым ходом и назовёт его сам' });
    expect(state.awaitingReply).toBe(true);
  });
});

describe('play_move / correct_last_move', () => {
  it('ход и ответ движка с произношением', async () => {
    const { fns, client } = await withGame({ replies: ['K10'] });
    const res = await fns.playMove({ coord: 'D4' });
    expect(res).toEqual({ ok: true, yourMove: 'D4', yourMoveSpoken: 'дэ четыре', myMove: 'K10', myMoveSpoken: 'ка десять', captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 2 });
    expect(client.calls[0]).toMatchObject({ method: 'play', args: ['g1', { coord: 'D4', via: 'voice' }] });
  });
  it('нелегальный ход — причина из humanText по details.reason, не message', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ApiError('illegal_move', 'illegal move D4: occupied', { reason: 'occupied', coord: 'D4' }));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: 'точка занята' });
  });
  it('движок занят — просьба повторить, не исключение', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ApiError('engine_busy', 'engine did not respond within 10000 ms'));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: humanText('engine_busy') });
  });
  it('не наш ход — русский текст по коду, английский message не просачивается', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ApiError('not_your_turn', 'it is Goko to play', { toPlay: 'W' }));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: humanText('not_your_turn') });
  });
  it('таймаут ответа — note, myMove null, awaitingReply', async () => {
    const { fns, state, client } = await withGame();
    client.replyTimedOut = true;
    const res = await fns.playMove({ coord: 'D4' });
    expect(res).toMatchObject({ ok: true, yourMove: 'D4', myMove: null, note: 'Гоко ещё думает: свой ход он назовёт сам, когда решит' });
    expect(state.awaitingReply).toBe(true);
  });
  it('correct_last_move зовёт correct и отвечает как play', async () => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10'] });
    await fns.playMove({ coord: 'D4' });
    const res = await fns.correctLastMove({ coord: 'D5' });
    expect(res).toMatchObject({ ok: true, yourMove: 'D5', myMove: 'D10', myMoveSpoken: 'дэ десять', moveNumber: 2 });
    expect(client.calls.at(-1)).toMatchObject({ method: 'correct', args: ['g1', { coord: 'D5', via: 'voice' }] });
  });
  it('сдача движка после хода — finished и result', async () => {
    const { fns, state, client } = await withGame();
    client.play = async () => {
      const move = { n: 1, color: 'B' as const, coord: 'D4', captured: 0, at: 't' };
      const g = fakeGame({ id: 'g1', status: 'finished', result: { winner: 'B', reason: 'resign' }, moves: [move], toPlay: 'W', revision: 1 });
      return { state: g, move };
    };
    const res = await fns.playMove({ coord: 'D4' });
    expect(res).toMatchObject({ ok: true, finished: true, result: 'победа за тобой: я сдался' });
    expect(state.announcedFinish).toBe('g1');
    expect(state.awaitingReply).toBe(false);
  });
  // Инструменты, что сперва читают партию: отказ адресован названному методу (failOn), а не первому getGame.
  it.each<[string, keyof ToolClient, string, (f: ToolFns) => Promise<unknown>, () => Error, unknown, string[]]>([
    ['get_assessment', 'analyze', 'fetch failed', (f) => f.getAssessment(), () => new TypeError('fetch failed'), { ok: false, reason: NETWORK_TEXT }, ['getGame', 'analyze']],
    ['get_assessment', 'analyze', 'таймаут', (f) => f.getAssessment(), () => new ClientTimeoutError('analyze', 15_000), { ok: false, reason: humanText('client_timeout') }, ['getGame', 'analyze']],
    ['get_position', 'ascii', 'HttpError', (f) => f.getPosition(), () => new HttpError(502, '<html>Bad Gateway</html>'), NETWORK_TEXT, ['getGame', 'ascii']],
    ['get_position', 'getGame', 'fetch failed', (f) => f.getPosition(), () => new TypeError('fetch failed'), NETWORK_TEXT, ['getGame', 'ascii']],
    ['resign', 'resign', 'terminated', (f) => f.resign(), () => new TypeError('terminated'), { ok: false, reason: NETWORK_TEXT }, ['getGame', 'resign']],
    ['set_rank', 'setRank', 'таймаут', (f) => f.setRank({ rank: '5 кю' }), () => new ClientTimeoutError('setRank', 15_000), { ok: false, reason: humanText('client_timeout') }, ['getGame', 'setRank']],
  ])('%s: отказ на %s (%s) — «нет связи с сервером» или «сервер не отвечает», партия и ранг не тронуты', async (_tool, method, _err, run, err, expected, methods) => {
    const { fns, client, state } = await withGame();
    client.failOn(method, err());
    expect(await run(fns)).toEqual(expected);
    expect(client.calls.map((c) => c.method)).toEqual(methods);
    expect(gameOf(client)).toMatchObject({ status: 'playing', revision: 0 });
    expect(state.rank).toBe('10k');
    expect(humanText('client_timeout')).not.toBe(NETWORK_TEXT);
  });
  it('ошибка кода пробрасывается: её увидит лог воркера, а не человек', async () => {
    const { fns, client } = await withGame();
    client.failNext(new Error('bug in tool'));
    await expect(fns.playMove({ coord: 'D4' })).rejects.toThrow('bug in tool');
  });
  it('сигнал сеанса уходит в каждый вызов клиента; отменённый сигнал обрывает инструмент', async () => {
    const { fns, client, controller } = await withGame({ replies: ['K10'] });
    await fns.playMove({ coord: 'D4' });
    await fns.getPosition();
    expect(client.signals).toEqual([controller.signal, controller.signal, controller.signal]);
    controller.abort();
    const err = await fns.playMove({ coord: 'E5' }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
  });
  it('rate_limited: текст из humanText, до Retry-After инструменты партии к серверу не ходят', async () => {
    const { fns, client, state, clock } = await withGame({ replies: ['K10'] });
    client.failNext(new ApiError('rate_limited', 'too many requests, retry in 30 s', { retryAfterSeconds: 30 }));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: humanText('rate_limited') });
    expect(state.blockedUntil).toBe(30_000);
    client.calls.length = 0;
    clock.t = 29_999;
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: humanText('rate_limited') });
    expect(await fns.getPosition()).toBe(humanText('rate_limited'));
    expect(await fns.getAssessment()).toEqual({ ok: false, reason: humanText('rate_limited') });
    expect(client.calls).toEqual([]);
    clock.t = 30_000;
    expect(await fns.playMove({ coord: 'D4' })).toMatchObject({ ok: true, myMove: 'K10' });
  });
  it('rate_limited: срок — от текущих часов; более короткий отказ параллельного вызова его не сокращает', async () => {
    const { fns, client, state, clock } = await withGame();
    clock.t = 1_000;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Ход ждёт сервер, параллельная оценка получает отказ на 30 с, а ответ хода позже — отказ на 5 с.
    client.play = async () => {
      await gate;
      throw new ApiError('rate_limited', 'too many requests, retry in 5 s', { retryAfterSeconds: 5 });
    };
    client.analyze = async () => {
      throw new ApiError('rate_limited', 'too many requests, retry in 30 s', { retryAfterSeconds: 30 });
    };
    const move = fns.playMove({ coord: 'D4' });
    expect(await fns.getAssessment()).toEqual({ ok: false, reason: humanText('rate_limited') });
    expect(state.blockedUntil).toBe(31_000);
    release();
    expect(await move).toEqual({ ok: false, reason: humanText('rate_limited') });
    expect(state.blockedUntil).toBe(31_000);
  });
  it('до Retry-After к серверу не ходит ни один инструмент партии', async () => {
    const { fns, client, state, clock } = await withGame();
    state.blockedUntil = 10_000;
    clock.t = 9_999;
    const busy = { ok: false, reason: humanText('rate_limited') };
    expect(await fns.startGame({})).toEqual(busy);
    expect(await fns.playMove({ coord: 'D4' })).toEqual(busy);
    expect(await fns.correctLastMove({ coord: 'D5' })).toEqual(busy);
    expect(await fns.pass()).toEqual(busy);
    expect(await fns.resign()).toEqual(busy);
    expect(await fns.undo()).toEqual(busy);
    expect(await fns.getPosition()).toBe(busy.reason);
    expect(await fns.getAssessment()).toEqual(busy);
    expect(await fns.setRank({ rank: '5 кю' })).toEqual(busy);
    expect(client.calls).toEqual([]);
    expect(state.rank).toBe('10k');
  });
  it('ошибка кода с сетевым типом или сетевым текстом — всё равно баг: пробрасывается', async () => {
    const { fns, client } = await withGame();
    client.failNext(new TypeError('Cannot read properties of undefined'));
    await expect(fns.playMove({ coord: 'D4' })).rejects.toThrow('Cannot read properties of undefined');
    client.failNext(new Error('fetch failed'));
    await expect(fns.playMove({ coord: 'D4' })).rejects.toThrow('fetch failed');
    expect(client.calls.map((c) => c.method)).toEqual(['play', 'play']);
  });
});

describe('таймаут клиента на ходе, пасе и поправке: перечитывание вместо повтора', () => {
  const NOT_APPLIED_TAIL = 'Не повторяй ход сам: скажи человеку и дождись его слов';
  const CHANGED_TAIL = 'Не повторяй ход сам: посмотри позицию и скажи человеку';
  // Пас — теми же хвостами со словом «пас», во всех трёх ветках: ревизия та же, партия изменилась, перечитать не вышло.
  const NOT_APPLIED_PASS_TAIL = 'Не повторяй пас сам: скажи человеку и дождись его слов';
  const CHANGED_PASS_TAIL = 'Не повторяй пас сам: посмотри позицию и скажи человеку';

  it('ход не записан: партия перечитана тем же сигналом, ход не повторён, модель слышит, чей ход на самом деле', async () => {
    const { fns, client, state, controller } = await withGame();
    client.failNext(new ClientTimeoutError('play', 15_000));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({
      ok: false,
      reason: `сервер не отвечает: хода D4 в партии пока нет, сейчас ход: чёрные (твой). ${NOT_APPLIED_TAIL}`,
    });
    expect(client.calls.map((c) => c.method)).toEqual(['play', 'getGame']);
    expect(client.signals).toEqual([controller.signal, controller.signal]);
    expect(gameOf(client).moves).toEqual([]);
    expect(state.awaitingReply).toBe(false);
  });

  it('ход записан, ответ не дошёл: результат по перечитанной партии — с ответом Гоко или с note, пока он думает', async () => {
    const { fns, client, state } = await withGame({ replies: ['K10'] });
    client.failNext(new ClientTimeoutError('play', 15_000), 'after');
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: true, yourMove: 'D4', yourMoveSpoken: 'дэ четыре', myMove: 'K10', myMoveSpoken: 'ка десять', captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 2 });
    expect(state.awaitingReply).toBe(false);
    client.replyTimedOut = true;
    client.failNext(new ClientTimeoutError('play', 15_000), 'after');
    expect(await fns.playMove({ coord: 'E5' })).toMatchObject({ ok: true, yourMove: 'E5', myMove: null, note: 'Гоко ещё думает: свой ход он назовёт сам, когда решит' });
    expect(state.awaitingReply).toBe(true);
    expect(client.calls.map((c) => c.method)).toEqual(['play', 'getGame', 'play', 'getGame']);
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['D4', 'K10', 'E5']);
  });

  it('пас не записан, хотя прежний ход человека тоже пас: ревизия та же — паса нет', async () => {
    const { fns, client } = await withGame({ replies: ['K10'] });
    expect(await fns.pass()).toMatchObject({ ok: true, myMove: 'K10' });
    client.failNext(new ClientTimeoutError('pass', 15_000));
    // По одним ходам (пас человека, за ним ход Гоко) пас выглядел бы записанным: решает ревизия из ответа пасу.
    expect(await fns.pass()).toEqual({ ok: false, reason: `сервер не отвечает: паса в партии пока нет, сейчас ход: чёрные (твой). ${NOT_APPLIED_PASS_TAIL}` });
    expect(client.calls.map((c) => c.method)).toEqual(['pass', 'pass', 'getGame']);
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['pass', 'K10']);
  });

  it('пас и поправка записаны, ответ не дошёл: обычные ответы по перечитанной партии', async () => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10', 'K4'] });
    client.failNext(new ClientTimeoutError('pass', 15_000), 'after');
    expect(await fns.pass()).toEqual({ ok: true, myMove: 'K10', myMoveSpoken: 'ка десять', toPlay: 'B' });
    await fns.playMove({ coord: 'D4' });
    client.failNext(new ClientTimeoutError('correct', 15_000), 'after');
    expect(await fns.correctLastMove({ coord: 'D5' })).toEqual({ ok: true, yourMove: 'D5', yourMoveSpoken: 'дэ пять', myMove: 'K4', myMoveSpoken: 'ка четыре', captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 4 });
    expect(client.calls.map((c) => c.method)).toEqual(['pass', 'getGame', 'play', 'correct', 'getGame']);
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['pass', 'K10', 'D5', 'K4']);
  });

  it('перечитать не вышло — отказ перечитывания; ход не повторён', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ClientTimeoutError('play', 15_000));
    client.getGame = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: `${NETWORK_TEXT}. ${NOT_APPLIED_TAIL}` });
    expect(client.calls.map((c) => c.method)).toEqual(['play']);
  });

  it.each([
    ['play_move', 'play', (f: ToolFns) => f.playMove({ coord: 'E5' }), () => new ClientTimeoutError('play', 15_000), () => new ClientTimeoutError('getGame', 10_000), `сервер не отвечает. ${NOT_APPLIED_TAIL}`],
    ['pass', 'pass', (f: ToolFns) => f.pass(), () => new TypeError('fetch failed'), () => new TypeError('fetch failed'), `${NETWORK_TEXT}. ${NOT_APPLIED_PASS_TAIL}`],
    ['correct_last_move', 'correct', (f: ToolFns) => f.correctLastMove({ coord: 'D5' }), () => new HttpError(502, 'Bad Gateway'), () => new TypeError('terminated'), `нет связи с сервером. ${NOT_APPLIED_TAIL}`],
  ])('%s: после таймаута или обрыва перечитать не вышло — к причине добавлено «не повторяй» (круг 2)', async (_name, method, run, callErr, readErr, reason) => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10'] });
    await fns.playMove({ coord: 'D4' });
    client.failNext(callErr());
    client.getGame = async () => {
      throw readErr();
    };
    expect(await run(fns)).toEqual({ ok: false, reason });
    expect(client.calls.at(-1)?.method).toBe(method);
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['D4', 'K10']);
  });

  it('таймаут паса, пока в известной партии думал Гоко: записанный пас человека засчитан (круг 2)', async () => {
    const { fns, client } = await withGame();
    client.replyTimedOut = true;
    expect(await fns.pass()).toMatchObject({ ok: true, myMove: null, toPlay: 'W' }); // свой ответ: ход белых
    const g = gameOf(client);
    g.moves = [...g.moves, { n: 2, color: 'W', coord: 'K10', captured: 0, at: 't' }];
    g.toPlay = 'B';
    g.pendingEngineMove = false;
    g.revision++;
    client.replyTimedOut = true;
    client.failNext(new ClientTimeoutError('pass', 15_000), 'after');
    expect(await fns.pass()).toMatchObject({ ok: true, myMove: null, toPlay: 'W', note: 'Гоко ещё думает: свой ход он назовёт сам, когда решит' });
  });

  it('ревизия перечитанной партии запоминается: следующий незаписанный пас не принят за записанный', async () => {
    const { fns, client } = await withGame({ replies: ['K10'] });
    client.failNext(new ClientTimeoutError('pass', 15_000), 'after');
    expect(await fns.pass()).toMatchObject({ ok: true, myMove: 'K10' });
    client.failNext(new ClientTimeoutError('pass', 15_000));
    expect(await fns.pass()).toEqual({ ok: false, reason: `сервер не отвечает: паса в партии пока нет, сейчас ход: чёрные (твой). ${NOT_APPLIED_PASS_TAIL}` });
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['pass', 'K10']);
  });

  it('ревизия запоминается по партии: после новой партии сверка идёт по ней, а не по прежней', async () => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10'] });
    await fns.playMove({ coord: 'D4' }); // g1, ревизия 2
    expect(await fns.startGame({})).toMatchObject({ ok: true, gameId: 'g2' });
    expect(await fns.pass()).toMatchObject({ ok: true, myMove: 'D10' }); // g2, ревизия 2
    client.failNext(new ClientTimeoutError('pass', 15_000));
    expect(await fns.pass()).toEqual({ ok: false, reason: `сервер не отвечает: паса в партии пока нет, сейчас ход: чёрные (твой). ${NOT_APPLIED_PASS_TAIL}` });
  });

  it('партию сменили не инструментом: ревизия прежней партии в сверку не идёт', async () => {
    const { fns, client, state } = await withGame({ replies: ['K10', 'D10'] });
    await fns.playMove({ coord: 'D4' }); // g1, ревизия 2
    // Новую партию начали с экрана (gameId сменил поток); ход голосом записан, ответ не дошёл.
    client.game = fakeGame({ id: 'g2' });
    state.gameId = 'g2';
    client.failNext(new ClientTimeoutError('play', 15_000), 'after');
    expect(await fns.playMove({ coord: 'E5' })).toEqual({ ok: true, yourMove: 'E5', yourMoveSpoken: 'е пять', myMove: 'D10', myMoveSpoken: 'дэ десять', captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 2 });
  });

  it('ревизия не откатывается устаревшим чтением параллельного инструмента', async () => {
    const { fns, client } = await withGame({ replies: ['K10'] });
    const getGame = client.getGame;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // get_position прочитал партию до хода (ревизия 0), а ответ дошёл до инструмента уже после хода.
    client.getGame = async () => {
      const snapshot = structuredClone(gameOf(client));
      await gate;
      return snapshot;
    };
    const position = fns.getPosition();
    client.getGame = getGame;
    expect(await fns.playMove({ coord: 'D4' })).toMatchObject({ ok: true, myMove: 'K10' }); // ревизия 2
    release();
    await position;
    client.failNext(new ClientTimeoutError('play', 15_000));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({
      ok: false,
      reason: `сервер не отвечает: хода D4 в партии пока нет, сейчас ход: чёрные (твой). ${NOT_APPLIED_TAIL}`,
    });
  });

  it('партию изменил другой ход (тап), а ход голосом не записан — хода нет', async () => {
    const { fns, client } = await withGame({ replies: ['K10'] });
    // С экрана сыграли E5, Гоко ответил K10: ревизия уже не та, что видели инструменты.
    expect(await client.play('g1', { coord: 'E5', via: 'tap' })).toMatchObject({ reply: { coord: 'K10' } });
    client.failNext(new ClientTimeoutError('play', 15_000));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({
      ok: false,
      reason: `сервер не отвечает, а партия за это время изменилась: хода D4 в конце партии нет, сейчас ход: чёрные (твой). ${CHANGED_TAIL}`,
    });
  });

  it('пас не записан, а последним стоит пас Гоко — это не пас человека', async () => {
    const { fns, client } = await withGame({ replies: ['pass'] });
    // С экрана сыграли D4, Гоко спасовал.
    await client.play('g1', { coord: 'D4', via: 'tap' });
    client.failNext(new ClientTimeoutError('pass', 15_000));
    expect(await fns.pass()).toEqual({
      ok: false,
      reason: `сервер не отвечает, а партия за это время изменилась: паса в конце партии не видно, сейчас ход: чёрные (твой). ${CHANGED_PASS_TAIL}`,
    });
  });

  it('ход не записан, а партия уже окончена — так и сказано вместо «чей ход»', async () => {
    const { fns, client } = await withGame();
    // Пока ход шёл, человек сдался с экрана.
    await client.resign('g1', { color: 'B', via: 'tap' });
    client.failNext(new ClientTimeoutError('play', 15_000));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({
      ok: false,
      reason: `сервер не отвечает, а партия за это время изменилась: хода D4 в конце партии нет, партия окончена. ${CHANGED_TAIL}`,
    });
  });

  it('ход не записан, ревизия та же, а партия окончена — фраза брифа с «партия окончена»', async () => {
    const { fns, client } = await withGame();
    gameOf(client).status = 'finished';
    client.failNext(new ClientTimeoutError('play', 15_000));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: `сервер не отвечает: хода D4 в партии пока нет, партия окончена. ${NOT_APPLIED_TAIL}` });
  });

  it('пас не записан, а ревизию сменил ход Гоко после прежнего паса — по числу ходов пас не принят за записанный', async () => {
    const { fns, client } = await withGame();
    client.replyTimedOut = true;
    expect(await fns.pass()).toMatchObject({ ok: true, myMove: null }); // [pass], ревизия 1, Гоко думает
    // Гоко сходил K10: инструменты узнали бы об этом только из события потока.
    const g = gameOf(client);
    g.moves = [...g.moves, { n: 2, color: 'W', coord: 'K10', captured: 0, at: 't' }];
    g.toPlay = 'B';
    g.pendingEngineMove = false;
    g.revision++;
    client.failNext(new ClientTimeoutError('pass', 15_000));
    expect(await fns.pass()).toEqual({
      ok: false,
      reason: `сервер не отвечает, а партия за это время изменилась: паса в конце партии не видно, сейчас ход: чёрные (твой). ${CHANGED_PASS_TAIL}`,
    });
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['pass', 'K10']);
  });

  it('пас с ответом Гоко в партии, по которой своих ответов не было, — не принят за записанный: прежнее число ходов неизвестно', async () => {
    const { fns, client, state } = await withGame({ replies: ['K10'] });
    client.game = fakeGame({ id: 'g2' });
    state.gameId = 'g2';
    client.failNext(new ClientTimeoutError('pass', 15_000), 'after');
    expect(await fns.pass()).toEqual({
      ok: false,
      reason: `сервер не отвечает, а партия за это время изменилась: паса в конце партии не видно, сейчас ход: чёрные (твой). ${CHANGED_PASS_TAIL}`,
    });
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['pass', 'K10']);
  });

  it.each([
    ['fetch failed', () => new TypeError('fetch failed')],
    ['terminated', () => new TypeError('terminated')],
    ['HttpError', () => new HttpError(502, '<html>Bad Gateway</html>')],
  ])('сеть на ходе (%s), ход не записан — партия перечитана, ход не повторён', async (_name, err) => {
    const { fns, client } = await withGame();
    client.failNext(err());
    expect(await fns.playMove({ coord: 'D4' })).toEqual({
      ok: false,
      reason: `${NETWORK_TEXT}: хода D4 в партии пока нет, сейчас ход: чёрные (твой). ${NOT_APPLIED_TAIL}`,
    });
    expect(client.calls.map((c) => c.method)).toEqual(['play', 'getGame']);
    expect(gameOf(client).moves).toEqual([]);
  });

  it('сеть на пасе и поправке после записи — обычные ответы по перечитанной партии', async () => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10', 'K4'] });
    client.failNext(new TypeError('terminated'), 'after');
    expect(await fns.pass()).toEqual({ ok: true, myMove: 'K10', myMoveSpoken: 'ка десять', toPlay: 'B' });
    await fns.playMove({ coord: 'D4' });
    client.failNext(new HttpError(502, 'Bad Gateway'), 'after');
    expect(await fns.correctLastMove({ coord: 'D5' })).toMatchObject({ ok: true, yourMove: 'D5', myMove: 'K4' });
    client.failNext(new TypeError('fetch failed'));
    await fns.pass();
    expect(client.calls.map((c) => c.method)).toEqual(['pass', 'getGame', 'play', 'correct', 'getGame', 'pass', 'getGame']);
  });

  it('сеть на ходе, перечитать тоже не вышло — «нет связи с сервером», не повторять; ход не повторён', async () => {
    const { fns, client } = await withGame();
    client.failNext(new TypeError('terminated'));
    client.getGame = async () => {
      throw new TypeError('terminated');
    };
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: `${NETWORK_TEXT}. ${NOT_APPLIED_TAIL}` });
    expect(client.calls.map((c) => c.method)).toEqual(['play']);
  });
});

describe('pass / resign / undo', () => {
  it('пас с ответным ходом', async () => {
    const { fns } = await withGame({ replies: ['K10'] });
    expect(await fns.pass()).toEqual({ ok: true, myMove: 'K10', myMoveSpoken: 'ка десять', toPlay: 'B' });
  });
  it('два паса: итог из game.finished потока — без опроса get_game (R2)', async () => {
    const { fns, state, client, clock } = await withGame({ replies: ['pass'], finishAfterPolls: 100 }, (now, s) => {
      expect(s.awaitingFinish).toBe('g1');
      if (now === 1_000) s.finished = { gameId: 'g1', result: { winner: 'B', margin: 3.5, reason: 'score' } };
    });
    const res = await fns.pass();
    expect(res).toMatchObject({ ok: true, myMove: 'pass', finished: true, result: 'победа за тобой, разница 3,5 очка' });
    expect(client.calls.filter((c) => c.method === 'getGame')).toEqual([]);
    expect(clock.t).toBe(1_000);
    expect(state.announcedFinish).toBe('g1');
    expect(state.awaitingFinish).toBeNull();
  });
  it('два паса: поток молчит — опрос не чаще раза в 2,5 с', async () => {
    const { fns, state, client, clock } = await withGame({ replies: ['pass'], finishAfterPolls: 2 });
    const res = await fns.pass();
    expect(res).toMatchObject({ ok: true, myMove: 'pass', myMoveSpoken: 'пас', finished: true, result: 'победа за мной, разница 3,5 очка' });
    expect(client.calls.filter((c) => c.method === 'getGame').length).toBe(2);
    expect(clock.t).toBe(2 * FINISH_POLL_MS);
    expect(state.announcedFinish).toBe('g1');
  });
  it('два паса: итога нет за FINISH_WAIT_MS — не больше 8 опросов, note, итог объявит событие', async () => {
    const { fns, state, client, clock } = await withGame({ replies: ['pass'], finishAfterPolls: 100 });
    const res = await fns.pass();
    expect(res).toEqual({ ok: true, myMove: 'pass', myMoveSpoken: 'пас', toPlay: 'B', note: 'Гоко ещё считает очки: итог назовёт сам' });
    expect(client.calls.filter((c) => c.method === 'getGame').length).toBe(Math.floor((FINISH_WAIT_MS - 1) / FINISH_POLL_MS));
    expect(clock.t).toBe(FINISH_WAIT_MS);
    expect(state.announcedFinish).toBeNull();
    expect(state.awaitingFinish).toBeNull();
  });
  it('два паса: опрос получил rate_limited — следующий опрос не раньше Retry-After', async () => {
    const { fns, client, state, clock } = await withGame({ replies: ['pass'], finishAfterPolls: 1 });
    const getGame = client.getGame;
    const polls: number[] = [];
    client.getGame = async (id, o) => {
      polls.push(clock.t);
      if (polls.length === 1) throw new ApiError('rate_limited', 'too many requests, retry in 10 s', { retryAfterSeconds: 10 });
      return getGame(id, o);
    };
    expect(await fns.pass()).toMatchObject({ ok: true, finished: true });
    expect(polls).toEqual([2_500, 12_500]);
    expect(state.blockedUntil).toBe(12_500);
  });
  it('два паса: ошибка кода в опросе не глотается, awaitingFinish снят', async () => {
    const { fns, client, state } = await withGame({ replies: ['pass'], finishAfterPolls: 100 });
    client.getGame = async () => {
      throw new Error('bug in poll');
    };
    await expect(fns.pass()).rejects.toThrow('bug in poll');
    expect(state.awaitingFinish).toBeNull();
  });
  it('два паса: итог другой партии в state.finished не принимается; итог опроса — без note о счёте', async () => {
    const { fns, state, clock } = await withGame({ replies: ['pass'], finishAfterPolls: 2 });
    state.finished = { gameId: 'g0', result: { winner: 'B', margin: 0.5, reason: 'score' } };
    expect(await fns.pass()).toEqual({ ok: true, myMove: 'pass', myMoveSpoken: 'пас', toPlay: 'B', finished: true, result: 'победа за мной, разница 3,5 очка' });
    expect(clock.t).toBe(2 * FINISH_POLL_MS);
  });
  it('два паса, итог уже в ответе паса — без ожидания и опроса', async () => {
    const { fns, client, state, slept } = await withGame();
    client.pass = async () => {
      const passMove = (n: number, color: 'B' | 'W') => ({ n, color, coord: 'pass', captured: 0, at: 't' });
      const g = fakeGame({ status: 'finished', result: { winner: 'B', margin: 3.5, reason: 'score' }, moves: [passMove(1, 'B'), passMove(2, 'W')], revision: 2 });
      return { state: g, move: passMove(1, 'B'), reply: passMove(2, 'W') };
    };
    expect(await fns.pass()).toEqual({ ok: true, myMove: 'pass', myMoveSpoken: 'пас', toPlay: 'B', finished: true, result: 'победа за тобой, разница 3,5 очка' });
    expect(slept).toEqual([]);
    expect(client.calls).toEqual([]);
    expect(state.announcedFinish).toBe('g1');
  });
  it('пас, а Гоко ещё думает — note и awaitingReply', async () => {
    const { fns, client, state } = await withGame();
    client.replyTimedOut = true;
    expect(await fns.pass()).toEqual({ ok: true, myMove: null, myMoveSpoken: null, toPlay: 'W', note: 'Гоко ещё думает: свой ход он назовёт сам, когда решит' });
    expect(state.awaitingReply).toBe(true);
  });
  it('resign сдаёт цветом человека', async () => {
    const { fns, state, client } = await withGame();
    expect(await fns.resign()).toEqual({ ok: true, result: 'победа за мной: партия сдана' });
    expect(client.calls.at(-1)).toMatchObject({ method: 'resign', args: ['g1', { color: 'B', via: 'voice' }] });
    expect(state.announcedFinish).toBe('g1');
  });
  it('resign: bad_request с reason not_your_seat — «это не твой цвет»', async () => {
    const { fns, client } = await withGame();
    client.resign = async () => {
      throw new ApiError('bad_request', 'seat is not controlled by a human', { reason: 'not_your_seat' });
    };
    expect(await fns.resign()).toEqual({ ok: false, reason: humanText('bad_request', { reason: 'not_your_seat' }) });
    expect(humanText('bad_request', { reason: 'not_your_seat' })).toBe('это не твой цвет');
  });
  it('undo возвращает снятые ходы с произношением', async () => {
    const { fns, state } = await withGame({ replies: ['K10'] });
    await fns.playMove({ coord: 'D4' });
    state.awaitingReply = true;
    expect(await fns.undo()).toEqual({ ok: true, removed: ['D4', 'K10'], removedSpoken: ['дэ четыре', 'ка десять'], toPlay: 'B', status: 'playing' });
    expect(state.awaitingReply).toBe(false);
  });
  it('undo без ходов — reason из humanText, не английский message', async () => {
    const { fns } = await withGame();
    expect(await fns.undo()).toEqual({ ok: false, reason: humanText('nothing_to_undo') });
  });
  it.each([
    ['таймаут', () => new ClientTimeoutError('undo', 15_000), humanText('client_timeout')],
    ['fetch failed', () => new TypeError('fetch failed'), NETWORK_TEXT],
    ['terminated', () => new TypeError('terminated'), NETWORK_TEXT],
    ['HttpError', () => new HttpError(502, 'Bad Gateway'), NETWORK_TEXT],
  ])('undo: %s — отмена могла пройти, без перечитывания и повтора', async (_name, err, prefix) => {
    const { fns, client } = await withGame({ replies: ['K10'] });
    await fns.playMove({ coord: 'D4' });
    client.failNext(err());
    expect(await fns.undo()).toEqual({
      ok: false,
      reason: `${prefix}: отмена могла пройти. Не повторяй отмену сам: посмотри позицию и скажи человеку`,
    });
    expect(client.calls.map((c) => c.method)).toEqual(['play', 'undo']);
  });

  it('итог, отмена, снова два паса — ждём новый итог, а не прежний (I1)', async () => {
    const { fns, state, client, clock } = await withGame({ replies: ['pass', 'pass'], finishAfterPolls: 2 }, (now, s) => {
      if (now === 1_000) s.finished = { gameId: 'g1', result: { winner: 'B', margin: 3.5, reason: 'score' } };
    });
    expect(await fns.pass()).toMatchObject({ finished: true, result: 'победа за тобой, разница 3,5 очка' });
    // Сервер досчитал ту же партию; отмена после счёта возвращает её в игру без итога.
    gameOf(client).status = 'finished';
    gameOf(client).result = { winner: 'B', margin: 3.5, reason: 'score' };
    expect(await fns.undo()).toMatchObject({ ok: true, removed: ['pass', 'pass'], status: 'playing' });
    expect(state.finished).toBeNull();
    expect(state.announcedFinish).toBeNull();
    expect(await fns.pass()).toMatchObject({ ok: true, myMove: 'pass', finished: true, result: 'победа за мной, разница 3,5 очка' });
    expect(clock.t).toBe(1_000 + 2 * FINISH_POLL_MS);
    expect(state.announcedFinish).toBe('g1');
  });

  it('resign, ход и пас, закончившие партию, запоминают ревизию итога; отмена новее итога его забывает', async () => {
    const resigned = await withGame();
    await resigned.fns.resign();
    expect(resigned.state.announcedFinish).toBe('g1');
    expect(resigned.state.finishRevision).toEqual({ gameId: 'g1', revision: gameOf(resigned.client).revision });

    const played = await withGame();
    const g = gameOf(played.client);
    const finishedState: GameState = { ...g, status: 'finished', result: { winner: 'B', reason: 'resign' }, revision: 9 };
    played.client.play = async () => ({ state: finishedState, move: { n: 1, color: 'B', coord: 'D4', captured: 0, at: 't' } });
    expect(await played.fns.playMove({ coord: 'D4' })).toMatchObject({ ok: true, finished: true });
    expect(played.state.finishRevision).toEqual({ gameId: 'g1', revision: 9 });

    const passed = await withGame({ replies: ['pass'], finishAfterPolls: 2 });
    expect(await passed.fns.pass()).toMatchObject({ finished: true });
    const scored = gameOf(passed.client);
    expect(passed.state.finishRevision).toEqual({ gameId: 'g1', revision: scored.revision });
    expect(await passed.fns.undo()).toMatchObject({ ok: true, status: 'playing' });
    expect(passed.state.announcedFinish).toBeNull();
    expect(passed.state.finishRevision).toBeNull();
  });
  it('ответ отмены, отставший от итога новее из потока, этот итог не стирает', async () => {
    const { fns, state, client } = await withGame();
    const g = gameOf(client);
    const later = { gameId: 'g1', result: { winner: 'W' as const, reason: 'resign' as const } };
    client.undo = async () => {
      // Пока шёл ответ HTTP, поток принёс итог следующей ревизии: после отмены партия закончилась снова.
      state.finished = later;
      state.announcedFinish = 'g1';
      state.finishRevision = { gameId: 'g1', revision: 11 };
      return { state: { ...g, revision: 10 }, removed: [] };
    };
    expect(await fns.undo()).toMatchObject({ ok: true });
    expect(state.finished).toBe(later);
    expect(state.announcedFinish).toBe('g1');
    expect(state.finishRevision).toEqual({ gameId: 'g1', revision: 11 });
  });
  it('отмена с отказом сервера итог партии не забывает: партия не возобновилась (I1)', async () => {
    const { fns, state } = await withGame();
    const finished = { gameId: 'g1', result: { winner: 'W' as const, reason: 'resign' as const } };
    state.finished = finished;
    state.announcedFinish = 'g1';
    expect(await fns.undo()).toEqual({ ok: false, reason: humanText('nothing_to_undo') });
    expect(state.finished).toBe(finished);
    expect(state.announcedFinish).toBe('g1');
  });

  it('пас забывает прежний итог этой партии до отправки; итог другой партии не трогает (I1)', async () => {
    const { fns, state, clock } = await withGame({ replies: ['pass'], finishAfterPolls: 2 });
    state.finished = { gameId: 'g1', result: { winner: 'B', margin: 0.5, reason: 'score' } };
    state.announcedFinish = 'g1';
    expect(await fns.pass()).toMatchObject({ ok: true, finished: true, result: 'победа за мной, разница 3,5 очка' });
    expect(clock.t).toBe(2 * FINISH_POLL_MS);
    const other = { gameId: 'g0', result: { winner: 'W' as const, margin: 1.5, reason: 'score' as const } };
    const { fns: fns2, state: state2 } = await withGame({ replies: ['K10', 'D10'] });
    state2.finished = other;
    state2.announcedFinish = 'g1';
    expect(await fns2.pass()).toMatchObject({ ok: true, myMove: 'K10' });
    expect(state2.announcedFinish).toBeNull();
    expect(state2.finished).toBe(other);
    state2.announcedFinish = 'g0';
    await fns2.pass();
    expect(state2.announcedFinish).toBe('g0');
  });

  it('два паса: отмена сеанса во время ожидания Retry-After — выход с причиной отмены, без опросов (M2)', async () => {
    const { fns, state, client, clock, controller } = await withGame({ replies: ['pass'], finishAfterPolls: 100 }, (now, s) => {
      if (now === FINISH_TICK_MS) s.blockedUntil = 60_000;
      if (now === 5_000) controller.abort();
    });
    const err = await fns.pass().catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(clock.t).toBe(5_000);
    expect(client.calls.map((c) => c.method)).toEqual(['pass']);
    expect(state.awaitingFinish).toBeNull();
  });

  it('два паса: пауза ожидания без внедрённого sleep тоже обрывается сигналом, таймер снят (M2)', async () => {
    vi.useFakeTimers();
    try {
      const client = createFakeClient({ replies: ['pass'], finishAfterPolls: 100 });
      const state = newAgentState('s1');
      const controller = new AbortController();
      const fns = createToolFns({ client, state, signal: controller.signal });
      await fns.startGame({});
      let outcome: unknown = 'pending';
      void fns.pass().then(
        () => {
          outcome = 'resolved';
        },
        (e: unknown) => {
          outcome = e;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe('pending');
      expect(vi.getTimerCount()).toBe(1);
      // Четыре паузы прошли, слушатель отмены на сигнале сеанса — только у текущей.
      await vi.advanceTimersByTimeAsync(4 * FINISH_TICK_MS);
      expect(outcome).toBe('pending');
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
      const reason = new Error('session closed');
      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe(reason);
      expect(vi.getTimerCount()).toBe(0);
      expect(state.awaitingFinish).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('два паса: без сигнала сеанса пауза по умолчанию просто ждёт', async () => {
    vi.useFakeTimers();
    try {
      const client = createFakeClient({ replies: ['pass'], finishAfterPolls: 1 });
      const fns = createToolFns({ client, state: newAgentState('s1') });
      await fns.startGame({});
      const res = fns.pass();
      await vi.advanceTimersByTimeAsync(FINISH_POLL_MS);
      expect(await res).toMatchObject({ ok: true, finished: true, result: 'победа за мной, разница 3,5 очка' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('get_position / get_assessment / set_rank', () => {
  it('позиция: доска, последние 6 ходов, пленные, чей ход', async () => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10', 'K4', 'G7'] });
    for (const c of ['D4', 'C3', 'E3', 'F4']) await fns.playMove({ coord: c });
    gameOf(client).captures = { B: 2, W: 0 };
    const text = await fns.getPosition();
    expect(text).toContain('# g1 rev');
    expect(text).toContain('Последние ходы: 3. чёрные C3; 4. белые D10; 5. чёрные E3; 6. белые K4; 7. чёрные F4; 8. белые G7');
    expect(text).not.toContain('1. чёрные D4');
    expect(text).toContain('Пленные: чёрные сняли 2, белые сняли 0');
    expect(text).toContain('Ход: чёрные (твой)');
    expect(text).not.toContain('из основного поиска');
  });
  it('позиция называет ход движка с humanFallback, пока он на доске (D-0007)', async () => {
    const { fns, state } = await withGame({ replies: ['K10'] });
    await fns.playMove({ coord: 'D4' });
    state.fallbackMove = 2;
    expect(await fns.getPosition()).toContain('Ход 2 (белые K10) Гоко взял из основного поиска, а не из человеческой сети уровня');
    state.fallbackMove = 5;
    expect(await fns.getPosition()).not.toContain('из основного поиска');
  });
  it('оценка: лидер, отрыв, шансы, слабые группы, лучшие ходы', async () => {
    const { fns, client } = await withGame();
    const res = await fns.getAssessment();
    expect(res).toEqual({
      leader: 'you',
      marginPoints: 6,
      winrateYou: 70,
      weakGroups: [
        { color: 'mine', where: 'C3, C4', whereSpoken: 'цэ три, цэ четыре', status: 'неустойчива' },
        { color: 'yours', where: 'M3', whereSpoken: 'эм три', status: 'мертва' },
      ],
      bestMoves: ['K10', 'D10', 'G7'],
      bestMovesSpoken: ['ка десять', 'дэ десять', 'гэ семь'],
      toPlay: 'you',
    });
    expect(client.calls.find((c) => c.method === 'analyze')).toMatchObject({ args: ['g1', { maxVisits: ASSESSMENT_VISITS }] });
  });
  it('оценка при отставании', async () => {
    const { fns } = await withGame({ analysis: { winrateB: 0.3, scoreLeadB: -0.2 } });
    expect(await fns.getAssessment()).toMatchObject({ leader: 'even', marginPoints: 0, winrateYou: 30 });
  });
  it.each([
    [0.2, 'even', 0],
    [-0.2, 'even', 0],
    [0.25, 'you', 0.5],
    [-0.25, 'me', 0.5],
    [0.3, 'you', 0.5],
    [-0.3, 'me', 0.5],
    [0.5, 'you', 0.5],
    [-0.5, 'me', 0.5],
    [0.7, 'you', 0.5],
    [-0.7, 'me', 0.5],
    [0.75, 'you', 1],
    [-0.75, 'me', 1],
  ] as const)('оценка: перевес чёрных %s — leader %s, marginPoints %s (одно округление, even ровно при нуле)', async (scoreLeadB, leader, marginPoints) => {
    const { fns } = await withGame({ analysis: { scoreLeadB } });
    expect(await fns.getAssessment()).toMatchObject({ leader, marginPoints });
  });
  it('set_rank меняет ранг движка в текущей партии', async () => {
    const { fns, client, state } = await withGame();
    expect(await fns.setRank({ rank: '5 дан' })).toEqual({ ok: true, rank: '5 дан' });
    expect(client.calls.at(-1)).toMatchObject({ method: 'setRank', args: ['g1', { color: 'W', rank: '5d' }] });
    expect(state.rank).toBe('5d');
  });
});

describe('createTools', () => {
  it('отдаёт девять инструментов с именами из спеки', () => {
    const { client, state } = setup();
    const tools = createTools({ client, state });
    expect(Object.keys(tools).sort()).toEqual(
      ['correct_last_move', 'get_assessment', 'get_position', 'pass', 'play_move', 'resign', 'set_rank', 'start_game', 'undo'],
    );
  });
});

describe('человек против человека (D-0005)', () => {
  function hvh() {
    const t = setup();
    t.client.game = fakeGame({
      seats: { B: { controller: 'human' }, W: { controller: 'human' } },
      toPlay: 'W',
      moves: [{ n: 1, color: 'B', coord: 'D4', captured: 0, at: 't' }],
      revision: 1,
    });
    t.state.gameId = 'g1';
    t.state.humanColor = null;
    return t;
  }
  const PASS_CHANGED =
    'сервер не отвечает, а партия за это время изменилась: паса в конце партии не видно, сейчас ход: чёрные. Не повторяй пас сам: посмотри позицию и скажи человеку';
  it('таймаут паса чёрных, а последним стоит пас белых — это не наш пас (круг 2)', async () => {
    const { fns, client } = hvh();
    expect(await fns.pass()).toMatchObject({ ok: true, toPlay: 'B' }); // белые спасовали голосом: свой ответ, ход чёрных
    // С экрана: чёрные D5, белые снова пас. Теперь пасуют голосом чёрные, пас до сервера не дошёл.
    await client.play('g1', { coord: 'D5', via: 'tap' });
    await client.pass('g1', { via: 'tap' });
    client.failNext(new ClientTimeoutError('pass', 15_000));
    expect(await fns.pass()).toEqual({ ok: false, reason: PASS_CHANGED });
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['D4', 'pass', 'D5', 'pass']);
  });
  it('таймаут паса, своих ответов по партии не было, последним стоит пас — чей он, неизвестно: не засчитан (круг 2)', async () => {
    const { fns, client } = hvh();
    await client.pass('g1', { via: 'tap' }); // белые спасовали с экрана
    client.failNext(new ClientTimeoutError('pass', 15_000));
    expect(await fns.pass()).toEqual({ ok: false, reason: PASS_CHANGED });
  });
  it('таймаут паса в известной партии: свой пас записан — ответ по перечитанной партии (круг 2)', async () => {
    const { fns, client } = hvh();
    await fns.getPosition(); // свой ответ: ход белых
    client.failNext(new ClientTimeoutError('pass', 15_000), 'after');
    expect(await fns.pass()).toEqual({ ok: true, myMove: null, myMoveSpoken: null, toPlay: 'B' });
  });
  it('таймаут хода без своих ответов: ход записан — засчитан, координата сама говорит, чей он (круг 2)', async () => {
    const { fns, client } = hvh();
    client.failNext(new ClientTimeoutError('play', 15_000), 'after');
    expect(await fns.playMove({ coord: 'K10' })).toMatchObject({ ok: true, yourMove: 'K10', myMove: null, toPlay: 'B' });
  });
  it('ход без ответа движка', async () => {
    const { fns, client, state } = hvh();
    expect(await fns.playMove({ coord: 'K10' })).toEqual({ ok: true, yourMove: 'K10', yourMoveSpoken: 'ка десять', myMove: null, myMoveSpoken: null, captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 2 });
    expect(client.calls.map((c) => c.method)).toEqual(['play']);
    expect(state.awaitingReply).toBe(false);
  });
  it('таймаут хода, а за ним в партии уже сыграл другой человек — ход Гоко не выдумывается', async () => {
    const { fns, client } = hvh();
    // Ход белых K10 дошёл до сервера, ответ — нет, а чёрные тем временем сыграли E5 с экрана.
    const g = gameOf(client);
    g.moves = [...g.moves, { n: 2, color: 'W', coord: 'K10', captured: 0, at: 't' }, { n: 3, color: 'B', coord: 'E5', captured: 0, at: 't' }];
    g.revision = 3;
    client.failNext(new ClientTimeoutError('play', 15_000));
    expect(await fns.playMove({ coord: 'K10' })).toEqual({
      ok: false,
      reason: 'сервер не отвечает, а партия за это время изменилась: хода K10 в конце партии нет, сейчас ход: белые. Не повторяй ход сам: посмотри позицию и скажи человеку',
    });
    expect(client.calls.map((c) => c.method)).toEqual(['play', 'getGame']);
  });
  it('сдаётся тот, чей ход; результат цветами', async () => {
    const { fns, client } = hvh();
    expect(await fns.resign()).toEqual({ ok: true, result: 'победа чёрных: белые сдались' });
    expect(client.calls.at(-1)).toMatchObject({ method: 'resign', args: ['g1', { color: 'W', via: 'voice' }] });
  });
  it('set_rank не трогает партию без Гоко', async () => {
    const { fns, client, state } = hvh();
    expect(await fns.setRank({ rank: '5 кю' })).toEqual({ ok: true, rank: '5 кю', note: 'в этой партии нет Гоко: уровень применится к следующей' });
    expect(state.rank).toBe('5k');
    expect(client.calls.map((c) => c.method)).toEqual(['getGame']);
  });
  it('позиция и оценка — цветами, без «твой» и «мой»', async () => {
    const { fns } = hvh();
    expect((await fns.getPosition()).split('\n').at(-1)).toBe('Ход: белые');
    expect(await fns.getAssessment()).toEqual({
      leader: 'black',
      marginPoints: 6,
      winrateBlack: 70,
      weakGroups: [
        { color: 'white', where: 'C3, C4', whereSpoken: 'цэ три, цэ четыре', status: 'неустойчива' },
        { color: 'black', where: 'M3', whereSpoken: 'эм три', status: 'мертва' },
      ],
      bestMoves: ['K10', 'D10', 'G7'],
      bestMovesSpoken: ['ка десять', 'дэ десять', 'гэ семь'],
      toPlay: 'white',
    });
  });
});

describe('сигнал сеанса в каждом инструменте (M7)', () => {
  const cases: Array<[string, (fns: ToolFns) => Promise<unknown>, string[]]> = [
    ['start_game', (f) => f.startGame({}), ['newGame']],
    ['play_move', (f) => f.playMove({ coord: 'E5' }), ['play']],
    ['correct_last_move', (f) => f.correctLastMove({ coord: 'D5' }), ['correct']],
    ['pass', (f) => f.pass(), ['pass']],
    ['resign', (f) => f.resign(), ['getGame', 'resign']],
    ['undo', (f) => f.undo(), ['undo']],
    ['get_position', (f) => f.getPosition(), ['getGame', 'ascii']],
    ['get_assessment', (f) => f.getAssessment(), ['getGame', 'analyze']],
    ['set_rank', (f) => f.setRank({ rank: '5 кю' }), ['getGame', 'setRank']],
  ];
  it.each(cases)('%s передаёт сигнал в каждый вызов клиента', async (_name, run, methods) => {
    const { fns, client, controller } = await withGame({ replies: ['K10', 'D10'] });
    await fns.playMove({ coord: 'D4' });
    client.calls.length = 0;
    client.signals.length = 0;
    await run(fns);
    expect(client.calls.map((c) => c.method)).toEqual(methods);
    expect(client.signals).toHaveLength(methods.length);
    for (const s of client.signals) expect(s).toBe(controller.signal);
  });
});

describe('фейковый клиент: failNext (M6) и failOn', () => {
  const newGameReq = { black: { controller: 'human' as const }, white: { controller: 'engine' as const, rank: '10k' as const } };
  async function ready() {
    const client = createFakeClient({ replies: ['K10', 'D10'] });
    await client.newGame('s1', newGameReq);
    await client.play('g1', { coord: 'D4', via: 'tap' });
    return client;
  }
  const calls: Record<string, (c: Awaited<ReturnType<typeof ready>>) => Promise<unknown>> = {
    newGame: (c) => c.newGame('s1', newGameReq),
    play: (c) => c.play('g1', { coord: 'E5', via: 'tap' }),
    correct: (c) => c.correct('g1', { coord: 'E5' }),
    pass: (c) => c.pass('g1'),
    resign: (c) => c.resign('g1', { color: 'B' }),
    undo: (c) => c.undo('g1'),
    getGame: (c) => c.getGame('g1'),
    ascii: (c) => c.ascii('g1'),
    analyze: (c) => c.analyze('g1'),
    setRank: (c) => c.setRank('g1', { color: 'W', rank: '5k' }),
  };
  it.each(Object.keys(calls))('failNext(err) срабатывает на следующем вызове %s, и только на нём', async (method) => {
    const client = await ready();
    const call = calls[method];
    if (!call) throw new Error(`нет вызова ${method}`);
    const err = new Error('boom');
    client.failNext(err);
    await expect(call(client)).rejects.toBe(err);
    await expect(call(client)).resolves.toBeDefined();
  });
  it.each(['newGame', 'resign', 'undo', 'getGame', 'ascii', 'analyze', 'setRank'])("failNext(err, 'after') на %s — ошибка теста, а не тихий пропуск", async (method) => {
    const client = await ready();
    const call = calls[method];
    if (!call) throw new Error(`нет вызова ${method}`);
    client.failNext(new Error('boom'), 'after');
    await expect(call(client)).rejects.toThrow('fake client: failNext(err, "after") works only for play, pass and correct');
  });
  it.each(Object.keys(calls))('failOn(%s, err): другие методы идут как обычно, срабатывает на следующем вызове этого, и только на нём', async (method) => {
    const client = await ready();
    const call = calls[method];
    const other = calls[method === 'getGame' ? 'ascii' : 'getGame'];
    if (!call || !other) throw new Error(`нет вызова ${method}`);
    const err = new Error('boom');
    client.failOn(method as keyof ToolClient, err);
    await expect(other(client)).resolves.toBeDefined();
    await expect(call(client)).rejects.toBe(err);
    await expect(call(client)).resolves.toBeDefined();
  });
});
