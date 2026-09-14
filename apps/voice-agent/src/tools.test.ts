import { describe, expect, it } from 'vitest';
import { ApiError, ClientTimeoutError, type GameState, HttpError, humanText } from '@goko/protocol';
import { type AgentState, newAgentState } from './state.ts';
import { createFakeClient, fakeGame } from './testing/fake-client.ts';
import {
  ASSESSMENT_VISITS,
  FINISH_POLL_MS,
  FINISH_WAIT_MS,
  KOMI_TEXT,
  NETWORK_TEXT,
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
    expect(res).toEqual({ ok: true, yourMove: 'D4', myMove: 'K10', myMoveSpoken: 'ка десять', captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 2 });
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
  it('сеть и ответ не по протоколу — «нет связи с сервером» без перечитывания; таймаут чтения — «сервер не отвечает»', async () => {
    const { fns, client } = await withGame();
    client.failNext(new TypeError('fetch failed'));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: NETWORK_TEXT });
    client.failNext(new HttpError(502, '<html>Bad Gateway</html>'));
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: NETWORK_TEXT });
    client.failNext(new ClientTimeoutError('analyze', 15_000));
    expect(await fns.getAssessment()).toEqual({ ok: false, reason: humanText('client_timeout') });
    expect(humanText('client_timeout')).not.toBe(NETWORK_TEXT);
    expect(client.calls.map((c) => c.method)).toEqual(['play', 'play', 'getGame', 'analyze']);
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
});

describe('таймаут клиента на ходе, пасе и поправке: перечитывание вместо повтора', () => {
  const NOT_APPLIED_TAIL = 'Не повторяй ход сам: скажи человеку и дождись его слов';

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
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: true, yourMove: 'D4', myMove: 'K10', myMoveSpoken: 'ка десять', captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 2 });
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
    expect(await fns.pass()).toEqual({ ok: false, reason: `сервер не отвечает: паса в партии пока нет, сейчас ход: чёрные (твой). ${NOT_APPLIED_TAIL}` });
    expect(client.calls.map((c) => c.method)).toEqual(['pass', 'pass', 'getGame']);
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['pass', 'K10']);
  });

  it('пас и поправка записаны, ответ не дошёл: обычные ответы по перечитанной партии', async () => {
    const { fns, client } = await withGame({ replies: ['K10', 'D10', 'K4'] });
    client.failNext(new ClientTimeoutError('pass', 15_000), 'after');
    expect(await fns.pass()).toEqual({ ok: true, myMove: 'K10', myMoveSpoken: 'ка десять', toPlay: 'B' });
    await fns.playMove({ coord: 'D4' });
    client.failNext(new ClientTimeoutError('correct', 15_000), 'after');
    expect(await fns.correctLastMove({ coord: 'D5' })).toEqual({ ok: true, yourMove: 'D5', myMove: 'K4', myMoveSpoken: 'ка четыре', captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 4 });
    expect(client.calls.map((c) => c.method)).toEqual(['pass', 'getGame', 'play', 'correct', 'getGame']);
    expect(gameOf(client).moves.map((m) => m.coord)).toEqual(['pass', 'K10', 'D5', 'K4']);
  });

  it('перечитать не вышло — отказ перечитывания; ход не повторён', async () => {
    const { fns, client } = await withGame();
    client.failNext(new ClientTimeoutError('play', 15_000));
    client.getGame = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await fns.playMove({ coord: 'D4' })).toEqual({ ok: false, reason: NETWORK_TEXT });
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
        { color: 'mine', where: 'C3, C4', status: 'неустойчива' },
        { color: 'yours', where: 'M3', status: 'мертва' },
      ],
      bestMoves: ['K10', 'D10', 'G7'],
      toPlay: 'you',
    });
    expect(client.calls.find((c) => c.method === 'analyze')).toMatchObject({ args: ['g1', { maxVisits: ASSESSMENT_VISITS }] });
  });
  it('оценка при отставании', async () => {
    const { fns } = await withGame({ analysis: { winrateB: 0.3, scoreLeadB: -0.2 } });
    expect(await fns.getAssessment()).toMatchObject({ leader: 'even', marginPoints: 0, winrateYou: 30 });
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
  it('ход без ответа движка', async () => {
    const { fns, client, state } = hvh();
    expect(await fns.playMove({ coord: 'K10' })).toEqual({ ok: true, yourMove: 'K10', myMove: null, myMoveSpoken: null, captured: 0, myCaptured: 0, toPlay: 'B', moveNumber: 2 });
    expect(client.calls.map((c) => c.method)).toEqual(['play']);
    expect(state.awaitingReply).toBe(false);
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
        { color: 'white', where: 'C3, C4', status: 'неустойчива' },
        { color: 'black', where: 'M3', status: 'мертва' },
      ],
      bestMoves: ['K10', 'D10', 'G7'],
      toPlay: 'white',
    });
  });
});
