// Сервис партий (раздел 7 спеки): мьютекс на партию, автоматика мест engine, ожидание ответа,
// автосчёт после двух пасов, снапшоты и события. Единственное место, где меняется GameState.
import type { z } from 'zod';
import { groupsWithOwnership, toAscii, toSgf } from '@goko/go-core';
import {
  type Analysis,
  AnalyzeRequest,
  ApiError,
  type By,
  type Color,
  CorrectRequest,
  type GameEvent,
  GameSettings,
  type GameState,
  type GameSummary,
  type Move,
  NewGameRequest,
  type NewGameResponse,
  PassRequest,
  PlayRequest,
  type PlayResponse,
  ResignRequest,
  type Result,
  SetRankRequest,
  type StateCause,
  type StateResponse,
  UndoRequest,
  type UndoResponse,
  type Via,
} from '@goko/protocol';
import type { Engine } from './engine-client.ts';
import type { EventBus } from './events.ts';
import { applyMove, finishByScore, newGame, positionOf, resign as resignGame, setRank as setRankGame, undo as undoGame } from './game.ts';
import { newId } from './ids.ts';
import type { GameStore } from './store.ts';

// Входы операций — уже разобранные схемой тела (z.output): defaults подставлены.
export type NewGameInput = z.output<typeof NewGameRequest>;
export type PlayInput = z.output<typeof PlayRequest>;
export type PassInput = z.output<typeof PassRequest>;
export type ResignInput = z.output<typeof ResignRequest>;
export type UndoInput = z.output<typeof UndoRequest>;
export type CorrectInput = z.output<typeof CorrectRequest>;
export type SetRankInput = z.output<typeof SetRankRequest>;
export type AnalyzeInput = z.output<typeof AnalyzeRequest>;

export const REPLY_TIMEOUT_MS = 8000;
export const ENGINE_RESIGN_AFTER_MOVE = 60;
export const ENGINE_RESIGN_WINRATE = 0.03;
// ENGINE_RESIGN_LEAD: число не из спеки, решение реализации; фиксируется в `docs/decisions/` после стадии 1.
export const ENGINE_RESIGN_LEAD = -25;
export const GENMOVE_VISITS = 10;
export const ENGINE_RETRY_MS = 5000;
export const DEFAULT_RANK = '10k' as const;

export type GameServiceDeps = {
  store: GameStore;
  engine: Engine;
  bus: EventBus;
  now?: () => Date;
  replyTimeoutMs?: number;
  engineRetryMs?: number;
  log?: (line: string) => void;
};

// Ожидающий ответа движка на состояние с ревизией revision.
type Waiter = { revision: number; resolve: (move: Move | null) => void };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class GameService {
  private readonly deps: GameServiceDeps;
  private readonly games = new Map<string, GameState>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly sessionsByGame = new Map<string, string>();
  private readonly engineTasks = new Map<string, Promise<void>>();
  private readonly scoringTasks = new Map<string, Promise<void>>();
  private closed = false;

  constructor(deps: GameServiceDeps) {
    this.deps = deps;
  }

  async init(): Promise<void> {
    for (const state of await this.deps.store.load()) this.games.set(state.id, state);
    for (const state of this.games.values()) this.kick(state);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const list of this.waiters.values()) for (const w of list) w.resolve(null);
    this.waiters.clear();
    await Promise.allSettled([...this.engineTasks.values(), ...this.scoringTasks.values()]);
  }

  list(): GameSummary[] {
    return [...this.games.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((g) => ({ id: g.id, createdAt: g.createdAt, status: g.status, moveCount: g.moves.length, seats: g.seats, ...(g.result ? { result: g.result } : {}) }));
  }

  get(id: string): GameState {
    const state = this.games.get(id);
    if (!state) throw new ApiError('not_found', `game ${id} does not exist`);
    return state;
  }

  async create(req: NewGameInput, opts: { sessionId?: string } = {}): Promise<NewGameResponse> {
    for (const seat of [req.black, req.white]) {
      if (seat.controller === 'external') throw new ApiError('unsupported_controller', 'the external seat arrives at stage 2');
    }
    const withRank = (seat: NewGameInput['black']) => (seat.controller === 'engine' && !seat.rank ? { ...seat, rank: DEFAULT_RANK } : seat);
    const id = newId();
    const state = newGame({
      id,
      createdAt: this.now(),
      settings: GameSettings.parse(req.settings ?? {}),
      seats: { B: withRank(req.black), W: withRank(req.white) },
    });
    if (opts.sessionId) {
      // session.game идёт раньше событий партии (раздел 5 спеки).
      this.sessionsByGame.set(id, opts.sessionId);
      this.deps.bus.emit(`session:${opts.sessionId}`, { type: 'session.game', gameId: id });
    }
    const waiter = state.pendingEngineMove && req.waitForReply ? this.registerWaiter(id, state.revision) : null;
    await this.commit(state, 'new', 'system');
    if (!waiter) return { state: this.get(id) };
    const firstMove = await this.waitForReply(waiter);
    const latest = this.get(id);
    if (firstMove) return { state: latest, firstMove };
    return latest.revision > state.revision ? { state: latest } : { state: latest, replyTimedOut: true };
  }

  async play(id: string, req: PlayInput, by: By = 'human'): Promise<PlayResponse> {
    const { state, move, waiter } = await this.locked(id, async () => {
      const prev = this.get(id);
      this.checkRevision(prev, req.expectedRevision);
      const color = req.color ?? prev.toPlay;
      this.checkSeat(prev, color, by);
      const next = applyMove(prev, color, req.coord, this.now());
      const waiter = req.waitForReply && next.state.pendingEngineMove ? this.registerWaiter(id, next.state.revision) : null;
      await this.commit(next.state, next.move.coord === 'pass' ? 'pass' : 'play', by, req.via);
      return { ...next, waiter };
    });
    return this.withReply(id, state, move, waiter);
  }

  pass(id: string, req: PassInput, by: By = 'human'): Promise<PlayResponse> {
    return this.play(id, { ...req, coord: 'pass' }, by);
  }

  async resign(id: string, req: ResignInput, by: By = 'human'): Promise<StateResponse> {
    return this.locked(id, async () => {
      const next = resignGame(this.get(id), req.color);
      await this.commit(next, 'resign', by, req.via);
      return { state: next };
    });
  }

  async undo(id: string, req: UndoInput, by: By = 'human'): Promise<UndoResponse> {
    return this.locked(id, async () => {
      const prev = this.get(id);
      this.checkRevision(prev, req.expectedRevision);
      const rolled = undoGame(prev);
      await this.commit(rolled.state, 'undo', by, req.via);
      return { state: this.get(id), removed: rolled.removed };
    });
  }

  // Атомарно: откат пары, новый ход человека, новый ответ движка. Одно событие state.updated cause 'correct'.
  async correct(id: string, req: CorrectInput, by: By = 'human'): Promise<PlayResponse> {
    const { state, move, waiter } = await this.locked(id, async () => {
      const rolled = undoGame(this.get(id));
      const color = rolled.state.toPlay;
      this.checkSeat(rolled.state, color, by);
      const next = applyMove(rolled.state, color, req.coord, this.now());
      const waiter = req.waitForReply && next.state.pendingEngineMove ? this.registerWaiter(id, next.state.revision) : null;
      await this.commit(next.state, 'correct', by, req.via);
      return { ...next, waiter };
    });
    return this.withReply(id, state, move, waiter);
  }

  async setRank(id: string, req: SetRankInput): Promise<StateResponse> {
    return this.locked(id, async () => {
      const next = setRankGame(this.get(id), req.color, req.rank);
      await this.commit(next, 'rank', 'human');
      return { state: next };
    });
  }

  async analyze(id: string, req: AnalyzeInput): Promise<Analysis> {
    const state = this.get(id);
    const r = await this.deps.engine.analyze({ ...this.engineRequest(state), maxVisits: req.maxVisits, includeOwnership: true });
    const ownership = r.ownership ?? new Array<number>(state.board.length).fill(0);
    return {
      visits: r.visits,
      winrateB: r.winrateB,
      scoreLeadB: r.scoreLeadB,
      topMoves: r.moveInfos.slice(0, 5).map((m) => ({ coord: m.coord, winrateB: m.winrateB, scoreLeadB: m.scoreLeadB, visits: m.visits })),
      ownership,
      groups: groupsWithOwnership(positionOf(state), ownership),
    };
  }

  // Счёт без завершения партии («кто впереди по площади»); автосчёт после двух пасов использует его же.
  async score(id: string): Promise<Result> {
    const state = this.get(id);
    const r = await this.deps.engine.score(this.engineRequest(state));
    return {
      winner: r.winner,
      margin: r.margin,
      reason: 'score',
      score: { areaB: r.areaB, areaW: r.areaW, komi: state.settings.komi, dead: r.dead, ownership: r.ownership },
    };
  }

  ascii(id: string): string {
    const state = this.get(id);
    const header = `# ${state.id} rev ${state.revision} ${state.status} toPlay ${state.toPlay} moves ${state.moves.length}`;
    return `${header}\n${toAscii(positionOf(state), { lastMove: state.moves.at(-1)?.coord ?? null })}`;
  }

  sgf(id: string): string {
    const state = this.get(id);
    const label = (color: Color): string => {
      const seat = state.seats[color];
      if (seat.controller === 'engine') return `Goko ${seat.rank ?? DEFAULT_RANK}`;
      return seat.label ?? (seat.controller === 'human' ? 'Human' : 'External');
    };
    const result = state.result ? `${state.result.winner}+${state.result.reason === 'resign' ? 'R' : String(state.result.margin ?? '')}` : undefined;
    return toSgf({
      size: state.settings.boardSize,
      komi: state.settings.komi,
      rules: 'Chinese',
      black: label('B'),
      white: label('W'),
      ...(result ? { result } : {}),
      moves: state.moves.map((m) => ({ color: m.color, coord: m.coord })),
    });
  }

  // ---- внутреннее ----

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private engineRequest(state: GameState) {
    return {
      boardSize: state.settings.boardSize,
      rules: 'chinese' as const,
      komi: state.settings.komi,
      moves: state.moves.map((m) => [m.color, m.coord] as [Color, string]),
    };
  }

  private checkRevision(state: GameState, expected: number | undefined): void {
    if (expected !== undefined && expected !== state.revision) {
      throw new ApiError('revision_conflict', `the game has already changed: revision ${state.revision}`, { revision: state.revision });
    }
  }

  private checkSeat(state: GameState, color: Color, by: By): void {
    const seat = state.seats[color];
    if (seat.controller === 'external') throw new ApiError('unsupported_controller', 'the external seat arrives at stage 2');
    if (seat.controller === 'engine' && by !== 'engine') throw new ApiError('not_your_turn', 'it is Goko to play', { toPlay: state.toPlay });
  }

  // Мьютекс на партию: операции над одной партией выполняются по очереди.
  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  // Фиксирует новое состояние: снапшот, событие, пробуждение ожидающих, запуск движка или счёта.
  private async commit(next: GameState, cause: StateCause, by: By, via?: Via): Promise<void> {
    const prev = this.games.get(next.id);
    // Снапшот пишется до публикации состояния: читатель, увидевший новое состояние
    // (или дождавшийся его опросом), уже не может опередить запись на диск.
    await this.deps.store.save(next);
    this.games.set(next.id, next);
    this.emitGame(next.id, { type: 'state.updated', state: next, cause, by, ...(via ? { via } : {}) });
    if (next.status === 'finished' && prev?.status !== 'finished' && next.result) this.emitGame(next.id, { type: 'game.finished', result: next.result });
    this.settleWaiters(next, cause, prev);
    this.kick(next);
  }

  private emitGame(id: string, event: GameEvent): void {
    this.deps.bus.emit(`game:${id}`, event);
    const sessionId = this.sessionsByGame.get(id);
    if (sessionId) this.deps.bus.emit(`session:${sessionId}`, event);
  }

  private registerWaiter(id: string, revision: number): Promise<Move | null> {
    return new Promise<Move | null>((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push({ revision, resolve });
      this.waiters.set(id, list);
    });
  }

  // Ожидающий ревизии R получает ход движка, если движок ответил ровно на R; любое другое изменение
  // после R (undo, второй ход, сдача) отдаёт null. Коммит самой ревизии R (или более ранней) его не трогает.
  private settleWaiters(next: GameState, cause: StateCause, prev: GameState | undefined): void {
    const list = this.waiters.get(next.id);
    if (!list?.length) return;
    this.waiters.set(
      next.id,
      list.filter((w) => {
        if (next.revision <= w.revision) return true;
        const engineReply = cause === 'engine' && prev?.revision === w.revision ? (next.moves.at(-1) ?? null) : null;
        w.resolve(engineReply);
        return false;
      }),
    );
  }

  private async waitForReply(waiter: Promise<Move | null>): Promise<Move | null> {
    const timeoutMs = this.deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([waiter, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async withReply(id: string, state: GameState, move: Move, waiter: Promise<Move | null> | null): Promise<PlayResponse> {
    if (!waiter) return { state, move };
    const reply = await this.waitForReply(waiter);
    const latest = this.get(id);
    if (reply) return { state: latest, move, reply };
    // Партия успела измениться иначе (undo, сдача движка) — это не таймаут.
    return latest.revision > state.revision ? { state: latest, move } : { state: latest, move, replyTimedOut: true };
  }

  // Запускает задачу движка или счёта, если она нужна и ещё не идёт. Повторная задача на ту же ревизию не ставится.
  private kick(state: GameState): void {
    if (this.closed || state.status !== 'playing') return;
    if (state.consecutivePasses >= 2) {
      if (!this.scoringTasks.has(state.id)) this.scoringTasks.set(state.id, this.runScoring(state.id).finally(() => this.scoringTasks.delete(state.id)));
      return;
    }
    if (state.pendingEngineMove && !this.engineTasks.has(state.id)) {
      this.engineTasks.set(state.id, this.runEngine(state.id).finally(() => this.engineTasks.delete(state.id)));
    }
  }

  // Цикл хода движка: думает вне мьютекса, применяет под мьютексом только если ревизия не изменилась.
  private async runEngine(id: string): Promise<void> {
    while (!this.closed) {
      const state = this.games.get(id);
      if (!state || state.status !== 'playing' || !state.pendingEngineMove) return;
      const color = state.toPlay;
      const rank = state.seats[color].rank ?? DEFAULT_RANK;
      this.emitGame(id, { type: 'engine.thinking', color });
      let reply: Awaited<ReturnType<Engine['genmove']>>;
      try {
        reply = await this.deps.engine.genmove({ ...this.engineRequest(state), rank, maxVisits: GENMOVE_VISITS });
      } catch (e) {
        await this.onEngineFailure(id, e);
        continue;
      }
      const applied = await this.locked(id, async () => {
        const current = this.games.get(id);
        if (this.closed || !current || current.revision !== state.revision) return false; // партия изменилась, пока движок думал
        const engineWinrate = color === 'B' ? reply.winrateB : 1 - reply.winrateB;
        const engineLead = color === 'B' ? reply.scoreLeadB : -reply.scoreLeadB;
        // Спека говорит «после 60-го хода», поэтому строгое `>`, а не `>=`.
        if (current.moves.length > ENGINE_RESIGN_AFTER_MOVE && engineWinrate < ENGINE_RESIGN_WINRATE && engineLead < ENGINE_RESIGN_LEAD) {
          await this.commit(resignGame(current, color), 'resign', 'engine');
          return true;
        }
        let next: ReturnType<typeof applyMove>;
        try {
          next = applyMove(current, color, reply.move, this.now());
        } catch (e) {
          this.deps.log?.(`[!] the engine suggested an illegal move ${reply.move}: ${e instanceof Error ? e.message : String(e)}; passing instead`);
          next = applyMove(current, color, 'pass', this.now());
        }
        await this.commit(next.state, 'engine', 'engine');
        return true;
      });
      if (applied) return;
    }
  }

  // Движок недоступен: событие error, ожидающие получают null (клиент увидит replyTimedOut), пауза, повтор.
  private async onEngineFailure(id: string, e: unknown): Promise<void> {
    const message = e instanceof Error ? e.message : String(e);
    const code = e instanceof ApiError ? e.code : 'engine_unavailable';
    const retryMs = this.deps.engineRetryMs ?? ENGINE_RETRY_MS;
    this.deps.log?.(`[!] engine: ${message}; retrying in ${retryMs} ms`);
    this.emitGame(id, { type: 'error', code, message });
    for (const w of this.waiters.get(id) ?? []) w.resolve(null);
    this.waiters.delete(id);
    await sleep(retryMs);
  }

  // Два паса: счёт и завершение. При недоступности движка — повтор, партия остаётся playing.
  private async runScoring(id: string): Promise<void> {
    while (!this.closed) {
      const state = this.games.get(id);
      if (!state || state.status !== 'playing' || state.consecutivePasses < 2) return;
      let result: Result;
      try {
        result = await this.score(id);
      } catch (e) {
        await this.onEngineFailure(id, e);
        continue;
      }
      await this.locked(id, async () => {
        const current = this.games.get(id);
        if (this.closed || !current || current.revision !== state.revision) return;
        // причина `pass`: спека не вводит отдельной причины для автосчёта
        await this.commit(finishByScore(current, result), 'pass', 'system');
      });
      return;
    }
  }
}
