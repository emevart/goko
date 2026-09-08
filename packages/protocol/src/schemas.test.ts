// Часть защиты этого пакета держится не на рантайме, а на типах: объявления вида
// `const input: PlayRequest = { coord: 'D4' }` ловят подмену z.input на z.infer только
// при `tsc`. Поэтому запускать `vitest` без `npm run typecheck` для протокола бессмысленно.
// Правило покрытия: у каждого поля, ссылающегося на другую схему, есть негативный случай,
// проверенный через внешнюю схему, а не только через вложенную.
import { describe, expect, it } from 'vitest';
import * as protocol from './index.ts';
import {
  EngineAnalyzeRequest,
  EngineAnalyzeResponse,
  EngineGenmoveRequest,
  EngineGenmoveResponse,
  EngineHealth,
  EngineMove,
  EngineMoveInfo,
  EnginePositionRequest,
  EngineScoreRequest,
  EngineScoreResponse,
} from './engine.ts';
import { ApiError, apiErrorFromBody, ERROR_CODES, ERROR_STATUS, ErrorBody, HttpError } from './errors.ts';
import { GameEvent, StateCause } from './events.ts';
import {
  BoardSize,
  By,
  Color,
  Controller,
  GameSettings,
  GameState,
  GameStatus,
  GameSummary,
  Move,
  RANKS,
  Rank,
  Result,
  Score,
  Seat,
  Session,
  Via,
} from './game.ts';
import {
  Analysis,
  AnalyzeRequest,
  CorrectRequest,
  CreateSessionResponse,
  GroupInfo,
  ListGamesResponse,
  NewGameRequest,
  NewGameResponse,
  PassRequest,
  PlayRequest,
  PlayResponse,
  ResignRequest,
  SetRankRequest,
  StateResponse,
  UndoRequest,
  UndoResponse,
} from './ops.ts';

const state = {
  id: 'g1',
  createdAt: '2026-09-07T10:00:00.000Z',
  revision: 0,
  settings: { boardSize: 13, rules: 'chinese', komi: 7.5 },
  seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } },
  status: 'playing',
  toPlay: 'B',
  moves: [],
  board: '.'.repeat(169),
  captures: { B: 0, W: 0 },
  ko: null,
  consecutivePasses: 0,
  pendingEngineMove: false,
};

const move = { n: 1, color: 'B', coord: 'D4', captured: 0, at: state.createdAt };

// Хелпер: схема обязана отвергнуть объект без каждого перечисленного поля.
function requiresKeys(schema: { parse: (v: unknown) => unknown }, sample: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    const partial: Record<string, unknown> = { ...sample };
    delete partial[key];
    expect(() => schema.parse(partial), 'без поля ' + key).toThrow();
  }
}

describe('схемы партии', () => {
  it('GameSettings подставляет умолчания', () => {
    expect(GameSettings.parse({})).toEqual({ boardSize: 13, rules: 'chinese', komi: 7.5 });
    expect(() => GameSettings.parse({ boardSize: 12 })).toThrow();
    expect(() => GameSettings.parse({ rules: 'japanese' })).toThrow();
    expect(() => GameSettings.parse({ komi: '7.5' })).toThrow();
  });

  it('BoardSize — только 9, 13, 19', () => {
    expect([9, 13, 19].map((n) => BoardSize.parse(n))).toEqual([9, 13, 19]);
    for (const bad of [7, 12, 21, '13']) expect(() => BoardSize.parse(bad)).toThrow();
  });

  it('ранги 20k..1k, 1d..9d', () => {
    expect(RANKS).toHaveLength(29);
    expect(RANKS[0]).toBe('20k');
    expect(RANKS[19]).toBe('1k');
    expect(RANKS[20]).toBe('1d');
    expect(RANKS[28]).toBe('9d');
    expect(Rank.parse('10k')).toBe('10k');
    expect(() => Rank.parse('10d')).toThrow();
    expect(() => Rank.parse('21k')).toThrow();
    expect(Seat.parse({ controller: 'engine', rank: '5k' })).toEqual({ controller: 'engine', rank: '5k' });
    expect(() => Seat.parse({ controller: 'engine', rank: '10d' })).toThrow();
  });

  it('перечисления цвета, контроллера, статуса, via, by', () => {
    expect(Color.options).toEqual(['B', 'W']);
    expect(Controller.options).toEqual(['human', 'engine', 'external']);
    expect(GameStatus.options).toEqual(['playing', 'finished']);
    expect(Via.options).toEqual(['voice', 'tap', 'api']);
    expect(By.options).toEqual(['human', 'engine', 'external', 'system']);
    expect(() => Color.parse('X')).toThrow();
    expect(() => By.parse('robot')).toThrow();
  });

  it('Seat: контроллер обязателен, ранг и метка нет', () => {
    expect(Seat.parse({ controller: 'human' })).toEqual({ controller: 'human' });
    expect(Seat.parse({ controller: 'human', label: 'Павел' })).toEqual({ controller: 'human', label: 'Павел' });
    expect(() => Seat.parse({})).toThrow();
    expect(() => Seat.parse({ controller: 'bot' })).toThrow();
    expect(() => Seat.parse({ controller: 'human', label: 'x'.repeat(41) })).toThrow();
  });

  it('Move: номер с единицы, захваты неотрицательны', () => {
    expect(Move.parse(move)).toEqual(move);
    expect(Move.parse({ ...move, coord: 'pass' }).coord).toBe('pass');
    expect(() => Move.parse({ ...move, n: 0 })).toThrow();
    expect(() => Move.parse({ ...move, captured: -1 })).toThrow();
    expect(() => Move.parse({ ...move, n: 1.5 })).toThrow();
    expect(() => Move.parse({ ...move, color: 'X' })).toThrow();
    requiresKeys(Move, move, ['n', 'color', 'coord', 'captured', 'at']);
  });

  it('Score и Result', () => {
    const score = { areaB: 90, areaW: 79, komi: 7.5, dead: ['D4'], ownership: [0.5] };
    expect(Score.parse(score)).toEqual(score);
    requiresKeys(Score, score, Object.keys(score));
    expect(Result.parse({ winner: 'B', reason: 'resign' })).toEqual({ winner: 'B', reason: 'resign' });
    expect(Result.parse({ winner: 'W', margin: 3.5, reason: 'score', score })).toEqual({
      winner: 'W',
      margin: 3.5,
      reason: 'score',
      score,
    });
    expect(() => Result.parse({ winner: 'B', reason: 'timeout' })).toThrow();
    expect(() => Result.parse({ reason: 'score' })).toThrow();
    expect(() => Result.parse({ winner: 'B' })).toThrow();
    expect(() => Result.parse({ winner: 'X', reason: 'resign' })).toThrow();
    expect(() => Result.parse({ winner: 'B', reason: 'score', score: { ...score, areaB: 'много' } })).toThrow();
  });

  it('GameState принимает полное состояние и отвергает мусор', () => {
    expect(GameState.parse(state)).toEqual(state);
    expect(() => GameState.parse({ ...state, toPlay: 'X' })).toThrow();
    expect(GameState.parse({ ...state, ko: 'D4' }).ko).toBe('D4');
    expect(GameState.parse({ ...state, result: { winner: 'B', reason: 'resign' } }).result).toEqual({
      winner: 'B',
      reason: 'resign',
    });
    expect(() => GameState.parse({ ...state, revision: -1 })).toThrow();
    expect(() => GameState.parse({ ...state, ko: undefined })).toThrow();
    expect(() => GameState.parse({ ...state, seats: { B: { controller: 'human' } } })).toThrow();
    expect(() => GameState.parse({ ...state, captures: { B: 0 } })).toThrow();
    requiresKeys(GameState, state, Object.keys(state));
  });

  it('GameState отвергает неверные значения вложенных схем', () => {
    const badSeatW = { B: { controller: 'human' }, W: { controller: 'bot' } };
    const badSeatB = { B: { controller: 'bot' }, W: { controller: 'human' } };
    expect(() => GameState.parse({ ...state, seats: badSeatW })).toThrow();
    expect(() => GameState.parse({ ...state, seats: badSeatB })).toThrow();
    expect(() => GameState.parse({ ...state, settings: { ...state.settings, boardSize: 12 } })).toThrow();
    expect(() => GameState.parse({ ...state, status: 'paused' })).toThrow();
    expect(() => GameState.parse({ ...state, moves: [{ ...move, color: 'X' }] })).toThrow();
    expect(() => GameState.parse({ ...state, result: { winner: 'X', reason: 'resign' } })).toThrow();
  });

  it('GameState сверяет доску с размером и алфавитом', () => {
    expect(GameState.parse({ ...state, settings: { boardSize: 9 }, board: '.'.repeat(81) }).settings.boardSize).toBe(9);
    expect(GameState.parse({ ...state, board: 'B'.repeat(84) + 'W'.repeat(85) }).board).toHaveLength(169);
    // потеря boardSize в ответе сервера не должна молча превращать партию 9x9 в 13x13
    expect(() => GameState.parse({ ...state, board: '.'.repeat(81) })).toThrow(/81[\s\S]*13|13[\s\S]*81/);
    expect(() => GameState.parse({ ...state, settings: {}, board: '.'.repeat(81) })).toThrow();
    expect(() => GameState.parse({ ...state, board: '.'.repeat(168) })).toThrow();
    expect(() => GameState.parse({ ...state, board: 'x'.repeat(169) })).toThrow();
    expect(() => GameState.parse({ ...state, board: '.'.repeat(168) + 'b' })).toThrow();
  });

  it('GameSummary и Session', () => {
    const summary = {
      id: 'g1',
      createdAt: state.createdAt,
      status: 'finished',
      moveCount: 42,
      seats: state.seats,
      result: { winner: 'B', reason: 'resign' },
    };
    expect(GameSummary.parse(summary)).toEqual(summary);
    const withoutResult = { ...summary, result: undefined };
    delete withoutResult.result;
    expect(GameSummary.parse(withoutResult)).toEqual(withoutResult);
    requiresKeys(GameSummary, summary, ['id', 'createdAt', 'status', 'moveCount', 'seats']);
    expect(() => GameSummary.parse({ ...summary, status: 'paused' })).toThrow();
    const badB = { B: { controller: 'bot' }, W: { controller: 'human' } };
    const badW = { B: { controller: 'human' }, W: { controller: 'bot' } };
    expect(() => GameSummary.parse({ ...summary, seats: badB })).toThrow();
    expect(() => GameSummary.parse({ ...summary, seats: badW })).toThrow();
    expect(() => GameSummary.parse({ ...summary, result: { winner: 'X', reason: 'resign' } })).toThrow();

    const session = { id: 's1', room: 'goko-s1', currentGameId: null, createdAt: state.createdAt };
    expect(Session.parse(session)).toEqual(session);
    expect(Session.parse({ ...session, currentGameId: 'g1' }).currentGameId).toBe('g1');
    requiresKeys(Session, session, Object.keys(session));
  });
});

describe('операции', () => {
  it('PlayRequest: waitForReply и via по умолчанию', () => {
    expect(PlayRequest.parse({ coord: 'D4' })).toEqual({ coord: 'D4', waitForReply: true, via: 'api' });
    expect(() => PlayRequest.parse({})).toThrow();
    expect(() => PlayRequest.parse({ coord: '' })).toThrow();
    expect(
      PlayRequest.parse({ coord: 'D4', color: 'W', expectedRevision: 3, waitForReply: false, via: 'voice' }),
    ).toEqual({ coord: 'D4', color: 'W', expectedRevision: 3, waitForReply: false, via: 'voice' });
    expect(() => PlayRequest.parse({ coord: 'D4', via: 'sms' })).toThrow();
    expect(() => PlayRequest.parse({ coord: 'D4', expectedRevision: 1.5 })).toThrow();
    expect(() => PlayRequest.parse({ coord: 'D4', color: 'X' })).toThrow();
    // тип запроса — z.input: поля с умолчанием необязательны у клиента
    const input: PlayRequest = { coord: 'D4' };
    expect(PlayRequest.parse(input).waitForReply).toBe(true);
  });

  it('PassRequest — PlayRequest без coord', () => {
    expect(PassRequest.parse({})).toEqual({ waitForReply: true, via: 'api' });
    // схема строгая: coord у паса — лишний ключ, а не молча отбрасываемый
    expect(() => PassRequest.parse({ coord: 'D4' })).toThrow();
    expect(PassRequest.parse({ via: 'voice', waitForReply: false })).toEqual({ via: 'voice', waitForReply: false });
    expect(() => PassRequest.parse({ via: 'sms' })).toThrow();
    expect(() => PassRequest.parse({ color: 'X' })).toThrow();
    const input: PassRequest = {};
    expect(PassRequest.parse(input).via).toBe('api');
  });

  it('NewGameRequest: места обязательны, настройки частичные', () => {
    const r = NewGameRequest.parse({
      black: { controller: 'human' },
      white: { controller: 'engine', rank: '10k' },
      settings: { komi: 6.5 },
    });
    expect(r.waitForReply).toBe(true);
    expect(r.settings).toEqual({ komi: 6.5 });
    expect(
      NewGameRequest.parse({ black: { controller: 'human' }, white: { controller: 'engine' } }).settings,
    ).toBeUndefined();
    expect(() => NewGameRequest.parse({ black: { controller: 'human' } })).toThrow();
    expect(() => NewGameRequest.parse({ white: { controller: 'engine' } })).toThrow();
    expect(() =>
      NewGameRequest.parse({
        black: { controller: 'human' },
        white: { controller: 'engine' },
        settings: { boardSize: 12 },
      }),
    ).toThrow();
    expect(() => NewGameRequest.parse({ black: { controller: 'bot' }, white: { controller: 'engine' } })).toThrow();
    expect(() =>
      NewGameRequest.parse({ black: { controller: 'human' }, white: { controller: 'engine', rank: '10d' } }),
    ).toThrow();
    const input: NewGameRequest = { black: { controller: 'human' }, white: { controller: 'engine' } };
    expect(NewGameRequest.parse(input).waitForReply).toBe(true);
  });

  it('NewGameResponse: первый ход и флаг таймаута необязательны', () => {
    expect(NewGameResponse.parse({ state })).toEqual({ state });
    expect(NewGameResponse.parse({ state, firstMove: move, replyTimedOut: true })).toEqual({
      state,
      firstMove: move,
      replyTimedOut: true,
    });
    expect(() => NewGameResponse.parse({ state, replyTimedOut: false })).toThrow();
    expect(() => NewGameResponse.parse({})).toThrow();
    expect(() => NewGameResponse.parse({ state: { ...state, toPlay: 'X' } })).toThrow();
    expect(() => NewGameResponse.parse({ state, firstMove: { ...move, color: 'X' } })).toThrow();
  });

  it('PlayResponse допускает replyTimedOut только true', () => {
    expect(PlayResponse.parse({ state, move, replyTimedOut: true }).replyTimedOut).toBe(true);
    expect(() => PlayResponse.parse({ state, move, replyTimedOut: false })).toThrow();
    expect(PlayResponse.parse({ state, move })).toEqual({ state, move });
    expect(PlayResponse.parse({ state, move, reply: { ...move, n: 2, color: 'W' } }).reply?.n).toBe(2);
    expect(() => PlayResponse.parse({ state })).toThrow();
    expect(() => PlayResponse.parse({ move })).toThrow();
    expect(() => PlayResponse.parse({ state: { ...state, toPlay: 'X' }, move })).toThrow();
    expect(() => PlayResponse.parse({ state, move: { ...move, color: 'X' } })).toThrow();
    expect(() => PlayResponse.parse({ state, move, reply: { ...move, color: 'X' } })).toThrow();
  });

  it('ResignRequest, UndoRequest, CorrectRequest, SetRankRequest, AnalyzeRequest', () => {
    expect(ResignRequest.parse({ color: 'B' })).toEqual({ color: 'B', via: 'api' });
    expect(() => ResignRequest.parse({})).toThrow();
    expect(() => ResignRequest.parse({ color: 'X' })).toThrow();
    expect(() => ResignRequest.parse({ color: 'B', via: 'sms' })).toThrow();

    expect(UndoRequest.parse({})).toEqual({ via: 'api' });
    expect(UndoRequest.parse({ expectedRevision: 7, via: 'tap' })).toEqual({ expectedRevision: 7, via: 'tap' });
    expect(() => UndoRequest.parse({ via: 'sms' })).toThrow();

    expect(CorrectRequest.parse({ coord: 'D4' })).toEqual({ coord: 'D4', waitForReply: true, via: 'api' });
    expect(() => CorrectRequest.parse({})).toThrow();
    expect(() => CorrectRequest.parse({ coord: 'D4', via: 'sms' })).toThrow();

    expect(SetRankRequest.parse({ color: 'W', rank: '3d' })).toEqual({ color: 'W', rank: '3d' });
    expect(() => SetRankRequest.parse({ color: 'W' })).toThrow();
    expect(() => SetRankRequest.parse({ color: 'W', rank: '10d' })).toThrow();
    expect(() => SetRankRequest.parse({ color: 'X', rank: '3d' })).toThrow();

    expect(AnalyzeRequest.parse({})).toEqual({ maxVisits: 50 });
    expect(() => AnalyzeRequest.parse({ maxVisits: 0 })).toThrow();
    expect(() => AnalyzeRequest.parse({ maxVisits: 1001 })).toThrow();

    const undoInput: UndoRequest = {};
    const analyzeInput: AnalyzeRequest = {};
    const correctInput: CorrectRequest = { coord: 'D4' };
    const resignInput: ResignRequest = { color: 'B' };
    expect([
      UndoRequest.parse(undoInput).via,
      AnalyzeRequest.parse(analyzeInput).maxVisits,
      CorrectRequest.parse(correctInput).via,
      ResignRequest.parse(resignInput).via,
    ]).toEqual(['api', 50, 'api', 'api']);
  });

  it('ответы: StateResponse, UndoResponse, ListGamesResponse, CreateSessionResponse', () => {
    expect(StateResponse.parse({ state })).toEqual({ state });
    expect(() => StateResponse.parse({})).toThrow();
    expect(() => StateResponse.parse({ state: { ...state, toPlay: 'X' } })).toThrow();

    expect(UndoResponse.parse({ state, removed: [move] })).toEqual({ state, removed: [move] });
    expect(() => UndoResponse.parse({ state })).toThrow();
    expect(() => UndoResponse.parse({ state, removed: [{ ...move, color: 'X' }] })).toThrow();
    expect(() => UndoResponse.parse({ state: { ...state, toPlay: 'X' }, removed: [] })).toThrow();

    const summary = { id: 'g1', createdAt: state.createdAt, status: 'playing', moveCount: 0, seats: state.seats };
    expect(ListGamesResponse.parse({ games: [summary] })).toEqual({ games: [summary] });
    expect(() => ListGamesResponse.parse({})).toThrow();
    expect(() => ListGamesResponse.parse({ games: [{ ...summary, status: 'paused' }] })).toThrow();

    const session = { id: 's1', room: 'goko-s1', currentGameId: null, createdAt: state.createdAt };
    const created = { session, livekit: { url: 'wss://example', token: 'jwt' } };
    expect(CreateSessionResponse.parse(created)).toEqual(created);
    expect(() => CreateSessionResponse.parse({ session })).toThrow();
    expect(() => CreateSessionResponse.parse({ session, livekit: { url: 'wss://example' } })).toThrow();
    const badSession = { ...session, currentGameId: undefined };
    expect(() => CreateSessionResponse.parse({ ...created, session: badSession })).toThrow();
  });

  it('GroupInfo и Analysis', () => {
    const group = { color: 'B', stones: ['D4'], liberties: 4, ownershipAvg: 0.9, status: 'safe' };
    expect(GroupInfo.parse(group)).toEqual(group);
    expect(GroupInfo.parse({ ...group, status: 'unsettled' }).status).toBe('unsettled');
    expect(GroupInfo.parse({ ...group, status: 'dead' }).status).toBe('dead');
    expect(() => GroupInfo.parse({ ...group, status: 'alive' })).toThrow();
    expect(() => GroupInfo.parse({ ...group, color: 'X' })).toThrow();
    requiresKeys(GroupInfo, group, Object.keys(group));

    const analysis = {
      visits: 50,
      winrateB: 0.52,
      scoreLeadB: 1.5,
      topMoves: [{ coord: 'D4', winrateB: 0.52, scoreLeadB: 1.5, visits: 30 }],
      ownership: [0.1],
      groups: [group],
    };
    expect(Analysis.parse(analysis)).toEqual(analysis);
    requiresKeys(Analysis, analysis, Object.keys(analysis));
    expect(() => Analysis.parse({ ...analysis, topMoves: [{ coord: 'D4', winrateB: 0.5, scoreLeadB: 1 }] })).toThrow();
    expect(() => Analysis.parse({ ...analysis, groups: [{ ...group, status: 'alive' }] })).toThrow();
    expect(() => Analysis.parse({ ...analysis, groups: [{ ...group, color: 'X' }] })).toThrow();
  });
});

describe('ошибки', () => {
  it('ровно четырнадцать кодов', () => {
    expect(ERROR_CODES).toHaveLength(14);
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'bad_request',
        'engine_busy',
        'engine_unavailable',
        'game_finished',
        'illegal_move',
        'internal',
        'invalid_coord',
        'limit_reached',
        'not_found',
        'not_your_turn',
        'nothing_to_undo',
        'revision_conflict',
        'unauthorized',
        'unsupported_controller',
      ].sort(),
    );
  });

  it('таблица код -> HTTP-статус задана целиком', () => {
    expect(ERROR_STATUS).toEqual({
      invalid_coord: 400,
      illegal_move: 400,
      unsupported_controller: 400,
      bad_request: 400,
      unauthorized: 401,
      not_found: 404,
      not_your_turn: 409,
      game_finished: 409,
      nothing_to_undo: 409,
      revision_conflict: 409,
      limit_reached: 429,
      internal: 500,
      engine_busy: 503,
      engine_unavailable: 503,
    });
    expect(Object.keys(ERROR_STATUS)).toHaveLength(14);
    for (const code of ERROR_CODES) expect(ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
  });

  it('ErrorBody принимает только известные коды', () => {
    const body = { error: { code: 'not_found', message: 'нет партии' } };
    expect(ErrorBody.parse(body)).toEqual(body);
    expect(() => ErrorBody.parse({ error: { code: 'oops', message: 'нет' } })).toThrow();
    expect(() => ErrorBody.parse({ error: { code: 'not_found' } })).toThrow();
    expect(() => ErrorBody.parse({ code: 'not_found', message: 'нет' })).toThrow();
  });

  it('ApiError превращается в тело ответа', () => {
    const e = new ApiError('illegal_move', 'точка занята', { reason: 'occupied' });
    expect(e.status).toBe(400);
    expect(e.code).toBe('illegal_move');
    expect(e.name).toBe('ApiError');
    expect(e).toBeInstanceOf(Error);
    expect(ErrorBody.parse(e.toBody())).toEqual({
      error: { code: 'illegal_move', message: 'точка занята', details: { reason: 'occupied' } },
    });
  });

  it('ApiError без details не кладёт details в тело', () => {
    const e = new ApiError('engine_busy', 'движок занят');
    expect(e.status).toBe(503);
    expect(e.details).toBeUndefined();
    expect(e.toBody()).toEqual({ error: { code: 'engine_busy', message: 'движок занят' } });
    expect('details' in e.toBody().error).toBe(false);
  });

  it('ApiError берёт статус из таблицы для каждого кода', () => {
    for (const code of ERROR_CODES) expect(new ApiError(code, 'x').status, code).toBe(ERROR_STATUS[code]);
  });

  it('apiErrorFromBody разбирает тело или отдаёт null', () => {
    const ok = apiErrorFromBody(JSON.stringify({ error: { code: 'not_your_turn', message: 'не ваш ход' } }), 409);
    expect(ok).toBeInstanceOf(ApiError);
    expect(ok?.code).toBe('not_your_turn');
    expect(ok?.status).toBe(409);
    expect(ok?.message).toBe('не ваш ход');

    const withDetails = apiErrorFromBody(
      JSON.stringify({ error: { code: 'invalid_coord', message: 'плохая точка', details: { coord: 'Z9' } } }),
      400,
    );
    expect(withDetails?.details).toEqual({ coord: 'Z9' });

    expect(apiErrorFromBody('<html>502</html>', 502)).toBeNull();
    expect(apiErrorFromBody('', 500)).toBeNull();
    expect(apiErrorFromBody(JSON.stringify({ error: { code: 'nope', message: 'x' } }), 400)).toBeNull();
    expect(apiErrorFromBody(JSON.stringify({ ok: true }), 200)).toBeNull();
  });

  it('HttpError несёт статус и обрезанное тело', () => {
    const e = new HttpError(502, 'bad gateway');
    expect(e.status).toBe(502);
    expect(e.body).toBe('bad gateway');
    expect(e.name).toBe('HttpError');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain('502');
    expect(e.message).toContain('bad gateway');
    expect(new HttpError(500).body).toBeUndefined();
    expect(new HttpError(500).message).toBe('HTTP 500');
    expect(new HttpError(500, 'x'.repeat(500)).message.length).toBeLessThan(260);
  });
});

describe('события', () => {
  it('discriminated union по type', () => {
    expect(GameEvent.parse({ type: 'engine.thinking', color: 'W' })).toEqual({ type: 'engine.thinking', color: 'W' });
    expect(GameEvent.parse({ type: 'state.updated', state, cause: 'sync', by: 'system' }).type).toBe('state.updated');
    expect(() => GameEvent.parse({ type: 'state.updated', state, cause: 'tap', by: 'human' })).toThrow();
    expect(() => GameEvent.parse({ type: 'nope' })).toThrow();
  });

  it('девять причин обновления состояния', () => {
    expect(StateCause.options).toEqual(['play', 'pass', 'undo', 'correct', 'rank', 'engine', 'resign', 'new', 'sync']);
    for (const cause of StateCause.options) {
      expect(GameEvent.parse({ type: 'state.updated', state, cause, by: 'human', via: 'voice' })).toEqual({
        type: 'state.updated',
        state,
        cause,
        by: 'human',
        via: 'voice',
      });
    }
    expect(() => StateCause.parse('score')).toThrow();
  });

  it('все пять вариантов события', () => {
    expect(GameEvent.parse({ type: 'session.game', gameId: 'g1' })).toEqual({ type: 'session.game', gameId: 'g1' });
    expect(() => GameEvent.parse({ type: 'session.game' })).toThrow();

    const finished = { type: 'game.finished', result: { winner: 'B', reason: 'resign' } };
    expect(GameEvent.parse(finished)).toEqual(finished);
    expect(() => GameEvent.parse({ type: 'game.finished' })).toThrow();

    const err = { type: 'error', code: 'engine_busy', message: 'занят' };
    expect(GameEvent.parse(err)).toEqual(err);
    expect(() => GameEvent.parse({ type: 'error', code: 'engine_busy' })).toThrow();

    expect(() => GameEvent.parse({ type: 'engine.thinking' })).toThrow();
    expect(() => GameEvent.parse({ type: 'engine.thinking', color: 'X' })).toThrow();
    expect(() => GameEvent.parse({ type: 'state.updated', state, cause: 'play' })).toThrow();
    expect(() => GameEvent.parse({ type: 'state.updated', cause: 'play', by: 'human' })).toThrow();
    expect(() => GameEvent.parse({ type: 'state.updated', state, cause: 'play', by: 'human', via: 'sms' })).toThrow();
  });

  it('вложенные схемы события проверяются через GameEvent', () => {
    expect(() => GameEvent.parse({ type: 'state.updated', state, cause: 'play', by: 'robot' })).toThrow();
    expect(() =>
      GameEvent.parse({ type: 'state.updated', state: { ...state, toPlay: 'X' }, cause: 'play', by: 'human' }),
    ).toThrow();
    expect(() => GameEvent.parse({ type: 'game.finished', result: { winner: 'X', reason: 'resign' } })).toThrow();
    expect(() => GameEvent.parse({ type: 'game.finished', result: { winner: 'B', reason: 'timeout' } })).toThrow();
  });
});

describe('движок', () => {
  it('EngineMove — пара цвет/точка', () => {
    expect(EngineMove.parse(['B', 'D4'])).toEqual(['B', 'D4']);
    expect(() => EngineMove.parse(['X', 'D4'])).toThrow();
    expect(() => EngineMove.parse(['B'])).toThrow();
    expect(() => EngineMove.parse(['B', 'D4', 'extra'])).toThrow();
  });

  it('EnginePositionRequest: размер доски 5..19, правила китайские', () => {
    const p = { boardSize: 13, rules: 'chinese', komi: 7.5, moves: [['B', 'D4']] };
    expect(EnginePositionRequest.parse(p)).toEqual(p);
    expect(() => EnginePositionRequest.parse({ ...p, boardSize: 4 })).toThrow();
    expect(() => EnginePositionRequest.parse({ ...p, boardSize: 20 })).toThrow();
    expect(() => EnginePositionRequest.parse({ ...p, rules: 'japanese' })).toThrow();
    requiresKeys(EnginePositionRequest, p, Object.keys(p));
    expect(() => EnginePositionRequest.parse({ ...p, moves: [['X', 'D4']] })).toThrow();
    expect(EngineScoreRequest.parse(p)).toEqual(p);
    expect(() => EngineScoreRequest.parse({ ...p, moves: [['X', 'D4']] })).toThrow();
  });

  it('genmove: maxVisits по умолчанию 10, ходы — пары', () => {
    const r = EngineGenmoveRequest.parse({
      boardSize: 13,
      rules: 'chinese',
      komi: 7.5,
      moves: [['B', 'D4']],
      rank: '10k',
    });
    expect(r.maxVisits).toBe(10);
    expect(() => EngineGenmoveRequest.parse({ ...r, moves: [['X', 'D4']] })).toThrow();
    expect(() => EngineGenmoveRequest.parse({ ...r, rank: undefined })).toThrow();
    expect(() => EngineGenmoveRequest.parse({ ...r, rank: '10d' })).toThrow();
    expect(() => EngineGenmoveRequest.parse({ ...r, maxVisits: 1001 })).toThrow();
    const input: EngineGenmoveRequest = { boardSize: 13, rules: 'chinese', komi: 7.5, moves: [], rank: '10k' };
    expect(EngineGenmoveRequest.parse(input).maxVisits).toBe(10);
  });

  it('analyze: maxVisits 50 и includeOwnership true по умолчанию', () => {
    const input: EngineAnalyzeRequest = { boardSize: 13, rules: 'chinese', komi: 7.5, moves: [] };
    const r = EngineAnalyzeRequest.parse(input);
    expect(r.maxVisits).toBe(50);
    expect(r.includeOwnership).toBe(true);
    expect(EngineAnalyzeRequest.parse({ ...input, includeOwnership: false }).includeOwnership).toBe(false);
    expect(() => EngineAnalyzeRequest.parse({ ...input, maxVisits: 0 })).toThrow();
  });

  it('ответы движка', () => {
    const genmove = {
      move: 'Q16',
      winrateB: 0.5,
      scoreLeadB: 0.5,
      humanPolicyTop: [{ coord: 'Q16', prob: 0.3 }],
      ms: 120,
    };
    expect(EngineGenmoveResponse.parse(genmove)).toEqual(genmove);
    requiresKeys(EngineGenmoveResponse, genmove, Object.keys(genmove));
    expect(() => EngineGenmoveResponse.parse({ ...genmove, humanPolicyTop: [{ coord: 'Q16' }] })).toThrow();

    const info = { coord: 'D4', winrateB: 0.5, scoreLeadB: 1, visits: 20, order: 0 };
    expect(EngineMoveInfo.parse(info)).toEqual(info);
    requiresKeys(EngineMoveInfo, info, Object.keys(info));

    const analyze = { visits: 50, winrateB: 0.5, scoreLeadB: 1, moveInfos: [info] };
    expect(EngineAnalyzeResponse.parse(analyze)).toEqual(analyze);
    expect(EngineAnalyzeResponse.parse({ ...analyze, ownership: [0.1] }).ownership).toEqual([0.1]);
    requiresKeys(EngineAnalyzeResponse, analyze, Object.keys(analyze));
    expect(() => EngineAnalyzeResponse.parse({ ...analyze, moveInfos: [{ ...info, order: 0.5 }] })).toThrow();

    const health = { ok: true, models: { main: 'b18', human: 'human' }, queue: 0, restarts: 2 };
    expect(EngineHealth.parse(health)).toEqual(health);
    requiresKeys(EngineHealth, health, Object.keys(health));
    expect(() => EngineHealth.parse({ ...health, models: { main: 'b18' } })).toThrow();
  });

  it('score response', () => {
    const s = EngineScoreResponse.parse({
      ownership: [0.1],
      dead: [],
      areaB: 1,
      areaW: 0,
      scoreLeadB: -6.5,
      winner: 'W',
      margin: 6.5,
    });
    expect(s.winner).toBe('W');
    const full = { ownership: [0.1], dead: ['D4'], areaB: 1, areaW: 0, scoreLeadB: -6.5, winner: 'W', margin: 6.5 };
    expect(EngineScoreResponse.parse(full)).toEqual(full);
    requiresKeys(EngineScoreResponse, full, Object.keys(full));
    expect(() => EngineScoreResponse.parse({ ...full, winner: 'black' })).toThrow();
  });
});

describe('строгость запросов', () => {
  // Запросы приходят от наших клиентов (в том числе от языковой модели голосового агента):
  // неизвестный ключ — всегда ошибка. Ответы и события остаются нестрогими: старый клиент
  // должен переживать добавление полей на сервере.
  it('опечатка expectedRevison в PlayRequest не проходит молча', () => {
    expect(PlayRequest.parse({ coord: 'D4', expectedRevision: 5 }).expectedRevision).toBe(5);
    expect(() => PlayRequest.parse({ coord: 'D4', expectedRevison: 5 })).toThrow();
  });

  it('каждая схема запроса отвергает лишний ключ', () => {
    const cases: [string, { parse: (v: unknown) => unknown }, Record<string, unknown>][] = [
      ['NewGameRequest', NewGameRequest, { black: { controller: 'human' }, white: { controller: 'engine' } }],
      ['PlayRequest', PlayRequest, { coord: 'D4' }],
      ['PassRequest', PassRequest, {}],
      ['ResignRequest', ResignRequest, { color: 'B' }],
      ['UndoRequest', UndoRequest, {}],
      ['CorrectRequest', CorrectRequest, { coord: 'D4' }],
      ['SetRankRequest', SetRankRequest, { color: 'W', rank: '3d' }],
      ['AnalyzeRequest', AnalyzeRequest, {}],
      ['EnginePositionRequest', EnginePositionRequest, { boardSize: 13, rules: 'chinese', komi: 7.5, moves: [] }],
      [
        'EngineGenmoveRequest',
        EngineGenmoveRequest,
        { boardSize: 13, rules: 'chinese', komi: 7.5, moves: [], rank: '10k' },
      ],
      ['EngineAnalyzeRequest', EngineAnalyzeRequest, { boardSize: 13, rules: 'chinese', komi: 7.5, moves: [] }],
      ['EngineScoreRequest', EngineScoreRequest, { boardSize: 13, rules: 'chinese', komi: 7.5, moves: [] }],
    ];
    for (const [name, schema, sample] of cases) {
      expect(() => schema.parse(sample), name + ': корректный запрос').not.toThrow();
      expect(() => schema.parse({ ...sample, unexpectedKey: 1 }), name + ': лишний ключ').toThrow();
    }
  });

  it('настройки внутри NewGameRequest тоже строгие', () => {
    const base = { black: { controller: 'human' }, white: { controller: 'engine' } };
    expect(NewGameRequest.parse({ ...base, settings: { komi: 6.5 } }).settings).toEqual({ komi: 6.5 });
    expect(() => NewGameRequest.parse({ ...base, settings: { boardSise: 9 } })).toThrow();
  });

  it('ответы и события остаются нестрогими ради совместимости вперёд', () => {
    expect(PlayResponse.parse({ state, move, futureField: 1 })).toEqual({ state, move });
    expect(GameState.parse({ ...state, futureField: 1 })).toEqual(state);
    expect(GameEvent.parse({ type: 'session.game', gameId: 'g1', futureField: 1 })).toEqual({
      type: 'session.game',
      gameId: 'g1',
    });
    const score = { ownership: [], dead: [], areaB: 1, areaW: 0, scoreLeadB: 1, winner: 'B', margin: 1 };
    expect(EngineScoreResponse.parse({ ...score, futureField: 1 }).winner).toBe('B');
  });
});

describe('публичная поверхность пакета', () => {
  it('index.ts реэкспортирует все пять модулей', () => {
    for (const name of ['GameState', 'ERROR_CODES', 'PlayRequest', 'GameEvent', 'EngineGenmoveRequest']) {
      expect(Object.keys(protocol), name).toContain(name);
    }
    expect(protocol.ERROR_CODES).toEqual(ERROR_CODES);
    expect(protocol.GameState).toBe(GameState);
    expect(protocol.PlayRequest).toBe(PlayRequest);
    expect(protocol.GameEvent).toBe(GameEvent);
    expect(protocol.EngineGenmoveRequest).toBe(EngineGenmoveRequest);
  });
});
