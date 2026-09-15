// Фейковый клиент протокола для тестов voice-agent: держит одну партию в памяти, отвечает ходами из сценария,
// пишет журнал вызовов. Правил го здесь нет — только формы ответов game-server.
import {
  type Analysis,
  ApiError,
  type CallOptions,
  type CorrectRequest,
  type GameState,
  type Move,
  type NewGameRequest,
  type NewGameResponse,
  type PassRequest,
  type PlayRequest,
  type PlayResponse,
  type ResignRequest,
  type RedoRequest,
  type RedoResponse,
  type SetRankRequest,
  type StateResponse,
  type UndoRequest,
  type UndoResponse,
  seatColor,
} from '@goko/protocol';
import type { ToolClient } from '../tools.ts';

export function fakeGame(overrides: Partial<GameState> = {}): GameState {
  return {
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
    canRedo: false,
    ...overrides,
  };
}

export type FakeClientOptions = {
  replies?: string[]; // ходы движка по очереди; 'pass' — пас; когда кончились — 'pass'
  ascii?: string;
  analysis?: Partial<Analysis>;
  finishAfterPolls?: number; // после двух пасов партия завершается через столько getGame
};

export type FakeClient = ToolClient & {
  calls: Array<{ method: string; args: unknown[] }>; // аргументы без CallOptions
  signals: Array<AbortSignal | undefined>; // сигнал каждого вызова по порядку: инструменты передают deps.signal
  game: GameState | null;
  replyTimedOut: boolean; // следующий play/pass/correct вернёт replyTimedOut без ответа движка
  // Следующий вызов любого метода бросает err. 'before' (по умолчанию) — до всякой работы; 'after' — только
  // play, pass и correct: ход и ответ движка уже записаны, а вызов бросает (таймаут клиента после записи на
  // сервере). 'after', а следующим позван другой метод — ошибка самого теста.
  failNext(err: Error, when?: 'before' | 'after'): void;
  // Следующий вызов метода method бросает err до всякой работы; остальные методы идут как обычно. Для
  // инструментов, что сперва читают партию: отказ падает на названном методе, а не на первом getGame.
  failOn(method: keyof ToolClient, err: Error): void;
};

export function createFakeClient(opts: FakeClientOptions = {}): FakeClient {
  const replies = [...(opts.replies ?? ['K10', 'D10', 'K4'])];
  let pending: Error | null = null;
  let pendingAfter = false;
  const failures = new Map<keyof ToolClient, Error>();
  let pollsLeft = -1;
  let n = 0;
  const redoStack: Array<{ state: GameState; restored: Move[] }> = [];

  const self: FakeClient = {
    calls: [],
    signals: [],
    game: null,
    replyTimedOut: false,
    failNext(err, when = 'before') {
      pending = err;
      pendingAfter = when === 'after';
    },
    failOn(method, err) {
      failures.set(method, err);
    },
    async newGame(sessionId: string, req: NewGameRequest, o?: CallOptions): Promise<NewGameResponse> {
      record('newGame', o, sessionId, req);
      throwPendingAny();
      redoStack.length = 0;
      const komi = req.settings?.komi ?? 7.5;
      self.game = fakeGame({
        id: `g${++n}`,
        seats: { B: req.black, W: req.white },
        settings: { boardSize: 13, rules: 'chinese', komi },
        pendingEngineMove: req.black.controller === 'engine',
      });
      let firstMove: Move | undefined;
      if (self.game.pendingEngineMove && !self.replyTimedOut) firstMove = engineMove();
      const res: NewGameResponse = { state: self.game, ...(firstMove ? { firstMove } : {}) };
      if (self.game.pendingEngineMove && self.replyTimedOut) res.replyTimedOut = true;
      self.replyTimedOut = false;
      return res;
    },
    async play(id: string, req: PlayRequest, o?: CallOptions): Promise<PlayResponse> {
      record('play', o, id, req);
      return humanMove(req.coord);
    },
    async correct(id: string, req: CorrectRequest, o?: CallOptions): Promise<PlayResponse> {
      record('correct', o, id, req);
      throwPendingBefore();
      const g = need();
      g.moves = g.moves.slice(0, -2);
      return humanMove(req.coord);
    },
    async pass(id: string, req: PassRequest = {}, o?: CallOptions): Promise<PlayResponse> {
      record('pass', o, id, req);
      return humanMove('pass');
    },
    async resign(id: string, req: ResignRequest, o?: CallOptions): Promise<StateResponse> {
      record('resign', o, id, req);
      throwPendingAny();
      redoStack.length = 0;
      const g = need();
      g.status = 'finished';
      g.result = { winner: req.color === 'B' ? 'W' : 'B', reason: 'resign' };
      g.revision++;
      return { state: g };
    },
    async undo(id: string, req: UndoRequest = {}, o?: CallOptions): Promise<UndoResponse> {
      record('undo', o, id, req);
      throwPendingAny();
      const g = need();
      if (req.expectedRevision !== undefined && req.expectedRevision !== g.revision) {
        throw new ApiError('revision_conflict', 'game revision changed');
      }
      if (g.moves.length === 0) throw new ApiError('nothing_to_undo', 'nothing to undo');
      const removed = g.moves.slice(-2);
      redoStack.push({ state: structuredClone(g), restored: structuredClone(removed) });
      g.moves = g.moves.slice(0, -2);
      g.toPlay = seatColor(g.seats, 'human') ?? 'B';
      // Как у сервера после счёта: партия снова идёт, итога нет.
      g.status = 'playing';
      delete g.result;
      g.revision++;
      g.canRedo = true;
      return { state: g, removed };
    },
    async redo(id: string, req: RedoRequest = {}, o?: CallOptions): Promise<RedoResponse> {
      record('redo', o, id, req);
      throwPendingAny();
      const current = need();
      if (req.expectedRevision !== undefined && req.expectedRevision !== current.revision) {
        throw new ApiError('revision_conflict', 'game revision changed');
      }
      const entry = redoStack.pop();
      if (!entry) throw new ApiError('nothing_to_redo', 'nothing to redo');
      self.game = { ...structuredClone(entry.state), revision: current.revision + 1, canRedo: redoStack.length > 0 };
      return { state: self.game, restored: structuredClone(entry.restored) };
    },
    async getGame(id: string, o?: CallOptions): Promise<GameState> {
      record('getGame', o, id);
      throwPendingAny();
      const g = need();
      if (pollsLeft > 0) pollsLeft--;
      if (pollsLeft === 0) {
        pollsLeft = -1;
        g.status = 'finished';
        g.result = { winner: 'W', margin: 3.5, reason: 'score' };
      }
      return g;
    },
    async ascii(id: string, o?: CallOptions): Promise<string> {
      record('ascii', o, id);
      throwPendingAny();
      return opts.ascii ?? '# g1 rev 2 playing toPlay B moves 2\n   A B C\n 3 . . .\n 2 . . .\n 1 . . .\n';
    },
    async analyze(id: string, req = {}, o?: CallOptions): Promise<Analysis> {
      record('analyze', o, id, req);
      throwPendingAny();
      return {
        gameId: self.game?.id ?? id,
        revision: self.game?.revision ?? 0,
        visits: 50,
        winrateB: 0.7,
        scoreLeadB: 6.2,
        topMoves: [
          { coord: 'K10', winrateB: 0.71, scoreLeadB: 6.5, visits: 20 },
          { coord: 'D10', winrateB: 0.69, scoreLeadB: 6.0, visits: 15 },
          { coord: 'G7', winrateB: 0.68, scoreLeadB: 5.8, visits: 10 },
          { coord: 'C3', winrateB: 0.6, scoreLeadB: 4.0, visits: 5 },
        ],
        ownership: [],
        // Слабая группа — не на лучших ходах: eval «кто впереди» (задача 4) запрещает в ответе K10 и D10,
        // а место слабой группы модель называет законно.
        groups: [
          { color: 'B', stones: ['D4'], liberties: 4, ownershipAvg: 0.9, status: 'safe' },
          { color: 'W', stones: ['C3', 'C4'], liberties: 2, ownershipAvg: -0.1, status: 'unsettled' },
          { color: 'B', stones: ['M3'], liberties: 1, ownershipAvg: -0.8, status: 'dead' },
        ],
        ...opts.analysis,
      };
    },
    async setRank(id: string, req: SetRankRequest, o?: CallOptions): Promise<StateResponse> {
      record('setRank', o, id, req);
      throwPendingAny();
      const g = need();
      g.seats[req.color] = { ...g.seats[req.color], rank: req.rank };
      g.revision++;
      return { state: g };
    },
  };

  // Журнал без CallOptions (сигналы — отдельно); отменённый сигнал ведёт себя как у настоящего клиента:
  // вызов бросает причину отмены до всякой работы. Затем — отказ, адресованный этому методу (failOn).
  function record(method: keyof ToolClient, o: CallOptions | undefined, ...args: unknown[]) {
    self.calls.push({ method, args });
    self.signals.push(o?.signal);
    o?.signal?.throwIfAborted();
    const failure = failures.get(method);
    if (failure) {
      failures.delete(method);
      throw failure;
    }
  }
  // Ход, пас и поправка: 'before' бросается здесь, 'after' — в throwPendingAfter после записи хода.
  function throwPendingBefore() {
    if (pending && !pendingAfter) {
      const e = pending;
      pending = null;
      throw e;
    }
  }
  // Остальные методы: 'after' им не положен.
  function throwPendingAny() {
    if (pending && pendingAfter) {
      pending = null;
      pendingAfter = false;
      throw new Error('fake client: failNext(err, "after") works only for play, pass and correct');
    }
    throwPendingBefore();
  }
  function throwPendingAfter() {
    if (pending && pendingAfter) {
      const e = pending;
      pending = null;
      pendingAfter = false;
      throw e;
    }
  }
  function need(): GameState {
    if (!self.game) throw new ApiError('not_found', 'game not found');
    return self.game;
  }
  function stamp(): string {
    return `2026-09-07T10:0${Math.min(9, self.game?.moves.length ?? 0)}:00.000Z`;
  }
  function engineMove(): Move {
    const g = need();
    const coord = replies.shift() ?? 'pass';
    const move: Move = { n: g.moves.length + 1, color: g.toPlay, coord, captured: 0, at: stamp() };
    g.moves = [...g.moves, move];
    g.toPlay = g.toPlay === 'B' ? 'W' : 'B';
    g.revision++;
    g.pendingEngineMove = false;
    return move;
  }
  function humanMove(coord: string): PlayResponse {
    throwPendingBefore();
    const res = applyHumanMove(coord);
    throwPendingAfter();
    return res;
  }
  function applyHumanMove(coord: string): PlayResponse {
    const g = need();
    redoStack.length = 0;
    if (g.status === 'finished') throw new ApiError('game_finished', 'game is finished');
    const human = g.toPlay;
    if (g.seats[human].controller !== 'human') throw new ApiError('not_your_turn', 'it is Goko to play');
    const move: Move = { n: g.moves.length + 1, color: human, coord, captured: 0, at: stamp() };
    g.moves = [...g.moves, move];
    g.toPlay = human === 'B' ? 'W' : 'B';
    g.revision++;
    // Партия двух людей (D-0005): ответа движка нет.
    if (g.seats[g.toPlay].controller !== 'engine') return { state: g, move };
    g.pendingEngineMove = true;
    if (self.replyTimedOut) {
      self.replyTimedOut = false;
      return { state: g, move, replyTimedOut: true };
    }
    const reply = engineMove();
    if (coord === 'pass' && reply.coord === 'pass') pollsLeft = opts.finishAfterPolls ?? 2;
    return { state: g, move, reply };
  }

  return self;
}
