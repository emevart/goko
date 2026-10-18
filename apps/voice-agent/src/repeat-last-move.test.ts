import { describe, expect, it } from 'vitest';
import { ApiError, ClientTimeoutError, type Color, type GameState, HttpError, type Move } from '@goko/protocol';
import { IntentLedger } from './intent.ts';
import { newAgentState } from './state.ts';
import { createToolFns, createTools } from './tools.ts';
import { createFakeClient, fakeGame } from './testing/fake-client.ts';

const move = (n: number, color: Color, coord: string): Move => ({ n, color, coord, captured: 0, at: '2026-10-05T00:00:00Z' });

function setup(game = fakeGame({ revision: 2, moves: [move(1, 'B', 'D4'), move(2, 'W', 'K10')] })) {
  const client = createFakeClient({ replies: ['D10', 'E10'] });
  client.game = game;
  const state = newAgentState('s1');
  state.gameId = game.id;
  state.awaitingReply = true;
  state.lastTap = { cause: 'play', coord: 'D4' };
  state.announcedFinish = game.id;
  const fns = createToolFns({ client, state });
  return { client, state, fns };
}

describe('repeat_last_move — только текущая история сервера', () => {
  it.each(['B', 'W'] as const)('повторяет последний записанный ход места движка %s через один GET', async (engine) => {
    const game = fakeGame({ revision: 3, seats: {
      B: { controller: engine === 'B' ? 'engine' : 'human' },
      W: { controller: engine === 'W' ? 'engine' : 'human' },
    }, moves: [move(1, 'B', 'D4'), move(2, 'W', 'K10'), move(3, 'B', 'E5')] });
    const { client, state, fns } = setup(game);
    const before = structuredClone(state);
    expect(await fns.repeatLastMove()).toEqual({ ok: true, gameId: 'g1', revision: 3,
      moveNumber: engine === 'B' ? 3 : 2, myMove: engine === 'B' ? 'E5' : 'K10',
      myMoveSpoken: engine === 'B' ? 'е пять' : 'ка десять' });
    expect(client.calls).toEqual([{ method: 'getGame', args: ['g1'] }]);
    expect(state).toEqual(before);
  });

  it('после undo не использует удалённый ход, после correct читает новый ответ', async () => {
    const { client, fns } = setup();
    await client.play('g1', { coord: 'C3' });
    await client.undo('g1', {});
    client.calls.length = 0;
    expect(await fns.repeatLastMove()).toMatchObject({ myMove: 'K10', revision: client.game?.revision });
    await client.correct('g1', { coord: 'E5' });
    client.calls.length = 0;
    expect(await fns.repeatLastMove()).toMatchObject({ myMove: 'E10', myMoveSpoken: 'е десять', revision: client.game?.revision });
    expect(client.calls.map(c => c.method)).toEqual(['getGame']);
  });

  it('пас произносится без применения паса или объявления итога', async () => {
    const { client, state, fns } = setup(fakeGame({ revision: 2, status: 'finished', moves: [move(1, 'B', 'pass'), move(2, 'W', 'pass')] }));
    const before = structuredClone(state);
    expect(await fns.repeatLastMove()).toMatchObject({ ok: true, myMove: 'pass', myMoveSpoken: 'пас' });
    expect(client.calls.map(c => c.method)).toEqual(['getGame']);
    expect(state).toEqual(before);
  });

  it('при ожидании нового ответа честно отделяет его от уже записанного хода', async () => {
    const { fns } = setup(fakeGame({ revision: 3, pendingEngineMove: true,
      moves: [move(1, 'B', 'D4'), move(2, 'W', 'K10'), move(3, 'B', 'E5')] }));
    expect(await fns.repeatLastMove()).toMatchObject({ ok: true, myMove: 'K10', note: expect.stringContaining('новый ответ Гоко ещё ожидается') });
  });

  it.each([
    [fakeGame(), 'ещё не сделал'],
    [fakeGame({ pendingEngineMove: true, moves: [move(1, 'B', 'D4')] }), 'ответ Гоко ещё ожидается'],
    [fakeGame({ seats: { B: { controller: 'human' }, W: { controller: 'human' } } }), 'два человека'],
  ] as const)('понятный отказ без записанного хода Гоко', async (game, text) => {
    const { client, fns } = setup(game);
    expect(await fns.repeatLastMove()).toEqual({ ok: false, reason: expect.stringContaining(text) });
    expect(client.calls.map(c => c.method)).toEqual(['getGame']);
  });

  it('без игры не идёт на сервер', async () => {
    const { client, state, fns } = setup(); state.gameId = null;
    expect(await fns.repeatLastMove()).toMatchObject({ ok: false, reason: expect.stringContaining('партия не начата') });
    expect(client.calls).toEqual([]);
  });

  it.each([
    new ApiError('not_found', 'missing'),
    new ClientTimeoutError('getGame', 100),
    new TypeError('fetch failed'),
    new HttpError(502, 'bad gateway'),
  ])('ошибка GET становится понятным отказом и сохраняет флаги: %s', async (error) => {
    const { client, state, fns } = setup();
    client.failNext(error);
    const before = structuredClone(state);
    expect(await fns.repeatLastMove()).toMatchObject({ ok: false, reason: expect.any(String) });
    expect(state).toEqual(before);
    expect(client.calls.map(c => c.method)).toEqual(['getGame']);
  });

  it('queued mutation→repeat видит новый ответ, ошибка чтения освобождает orb и очередь', async () => {
    const { client, state } = setup();
    const intent = new IntentLedger();
    const text = 'E5';
    intent.add(text, 'test');
    const changes: Array<[boolean, string]> = [];
    const tools = createTools({ client, state, intent, onToolStateChange: (busy, name) => changes.push([busy, name]) });
    const played = tools.play_move.execute({ coord: 'E5', user_utterance: text }, {} as never);
    const repeated = tools.repeat_last_move.execute({}, {} as never);
    expect(await played).toMatchObject({ ok: true });
    expect(await repeated).toMatchObject({ ok: true, myMove: 'D10' });
    expect(client.calls.map(c => c.method)).toEqual(['play', 'getGame']);
    client.failNext(new TypeError('fetch failed'));
    expect(await tools.repeat_last_move.execute({}, {} as never)).toMatchObject({ ok: false });
    expect(changes.at(-1)).toEqual([false, 'repeat_last_move']);
    expect(await tools.repeat_last_move.execute({}, {} as never)).toMatchObject({ ok: true, myMove: 'D10' });
  });

  it.each(['generation', 'revision', 'gameId', 'responseId'] as const)('не отдаёт запоздалый результат: %s', async (race) => {
    const { client, state, fns } = setup();
    const snapshot = structuredClone(client.game) as GameState;
    let release!: (game: GameState) => void;
    client.getGame = () => new Promise(resolve => { release = resolve; });
    const pending = fns.repeatLastMove();
    if (race === 'generation') state.gameGeneration++;
    if (race === 'revision') state.observedRevision = { gameId: 'g1', revision: 3 };
    if (race === 'gameId') state.gameId = 'g2';
    if (race === 'responseId') snapshot.id = 'g2';
    const before = structuredClone(state);
    release(snapshot);
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringContaining('партия уже сменилась') });
    expect(state).toEqual(before);
  });

  it('production tool зарегистрирован, ждёт очередь и сообщает orb tool-state', async () => {
    const { client, state } = setup();
    const changes: Array<[boolean, string]> = [];
    const tools = createTools({ client, state, onToolStateChange: (busy, name) => changes.push([busy, name]) });
    let release!: (game: GameState) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const nativeGet = client.getGame.bind(client);
    client.getGame = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const first = tools.get_position.execute({}, {} as never);
    await started;
    const repeated = tools.repeat_last_move.execute({}, {} as never);
    expect(changes).toEqual([[true, 'get_position']]);
    client.getGame = nativeGet;
    release(structuredClone(client.game) as GameState);
    await first;
    expect(await repeated).toMatchObject({ ok: true, myMove: 'K10' });
    expect(changes).toEqual([[true, 'get_position'], [false, 'get_position'], [true, 'repeat_last_move'], [false, 'repeat_last_move']]);
    expect(client.calls.map(c => c.method)).toEqual(['getGame']);
  });
});
