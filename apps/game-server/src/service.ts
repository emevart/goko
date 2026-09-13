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
  type ErrorCode,
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
import { errorDetail } from './error-detail.ts';
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
// Серия повторов фоновой задачи: пауза перед k-м повтором — k-е число. Отказ после последней
// паузы даёт одно событие retries_exhausted, и партия ждёт действия человека (resume).
export const ENGINE_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000];
export const RETRIES_EXHAUSTED_MESSAGE = 'background task retries are exhausted';
// Бюджет ожидания вопросов «кто впереди» и «оцени позицию». Цели спеки (10 с и 4 с)
// описывают норму, бюджет обязан покрыть замер на сервере (счёт на 400 просмотрах —
// 5,3 с) с запасом. Без бюджета вызывающий ждал бы два таймаута клиента: 60,2 и 30,2 с.
export const SCORE_BUDGET_MS = 15_000;
export const ANALYZE_BUDGET_MS = 10_000;
export const DEFAULT_RANK = '10k' as const;
// Тексты события error для сырых исключений: наружу только код и общий английский текст,
// подробности (путь к снапшоту, адрес движка) — только в лог.
export const INTERNAL_MESSAGE = 'internal server error';
export const ENGINE_UNAVAILABLE_MESSAGE = 'engine is unavailable';

export type GameServiceDeps = {
  store: GameStore;
  engine: Engine;
  bus: EventBus;
  now?: () => Date;
  replyTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  scoreBudgetMs?: number;
  analyzeBudgetMs?: number;
  log?: (line: string) => void;
};

// Ожидающий ответа движка на состояние с ревизией revision.
type Waiter = { revision: number; resolve: (move: Move | null) => void };

// ApiError уходит как есть: его message пишется в коде сервера по-английски и без путей, а
// текст чужого исключения (клиент движка) лежит в cause и попадает только в лог.
// Сырое исключение (fs, fetch) несёт путь или адрес, поэтому наружу — код и общий текст.
function publicError(e: unknown, code: ErrorCode, message: string): GameEvent {
  return e instanceof ApiError ? { type: 'error', code: e.code, message: e.message } : { type: 'error', code, message };
}

export class GameService {
  private readonly deps: GameServiceDeps;
  private readonly games = new Map<string, GameState>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly sessionsByGame = new Map<string, string>();
  private readonly engineTasks = new Map<string, Promise<void>>();
  private readonly scoringTasks = new Map<string, Promise<void>>();
  // Досрочные пробуждения фоновых пауз: close не должен ждать паузу перед повтором.
  private readonly wakeups = new Set<() => void>();
  // Число отказов подряд в текущей серии повторов партии; удачная задача обнуляет.
  private readonly failures = new Map<string, number>();
  // Партии, чья серия исчерпана: kick их не трогает до действия человека.
  private readonly gaveUp = new Set<string>();
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
    // Пауза перед повтором обрывается: иначе остановка сервера ждала бы её целиком.
    for (const wake of [...this.wakeups]) wake();
    await Promise.allSettled([...this.engineTasks.values(), ...this.scoringTasks.values()]);
  }

  list(): GameSummary[] {
    return [...this.games.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((g) => ({ id: g.id, createdAt: g.createdAt, status: g.status, moveCount: g.moves.length, seats: g.seats, ...(g.result ? { result: g.result } : {}) }));
  }

  // Действие человека на партии (мутирующий запрос, открытие потока событий): исчерпанная серия
  // повторов начинается заново. Во время идущей серии и для незнакомой партии ничего не делает.
  resume(id: string): void {
    if (!this.gaveUp.delete(id)) return;
    const state = this.games.get(id);
    if (state) this.kick(state);
  }

  // Мутирующее действие человека: отметка исчерпанной серии снимается до операции, а задача
  // ставится после неё. Удачный коммит поставит задачу сам и уже по новому состоянию: после сдачи
  // движок не зовётся. Отклонённая операция (not_your_turn, nothing_to_undo, отказ записи) задачу
  // ставит здесь, и серия идёт заново. resume (открытие потока) ставит задачу сразу: операции нет.
  private async humanAction<T>(id: string, human: boolean, op: () => Promise<T>): Promise<T> {
    const resumed = human && this.gaveUp.delete(id);
    try {
      return await op();
    } finally {
      const state = resumed ? this.games.get(id) : undefined;
      if (state) this.kick(state);
    }
  }

  // Шов для тестов на утечки: размеры внутренних таблиц, которые публичным API не видны.
  internalSizes(): { sessionsByGame: number; waiters: number; gaveUp: number } {
    let waiters = 0;
    for (const list of this.waiters.values()) waiters += list.length;
    return { sessionsByGame: this.sessionsByGame.size, waiters, gaveUp: this.gaveUp.size };
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
    // v1 — только человек против движка (раздел 4 спеки): партия машины с машиной шла бы без
    // человека и без предела, а серия повторов перезапускается только действием человека.
    if (req.black.controller === 'engine' && req.white.controller === 'engine') {
      throw new ApiError('unsupported_controller', 'two engine seats are not supported', { black: 'engine', white: 'engine' });
    }
    const withRank = (seat: NewGameInput['black']) => (seat.controller === 'engine' && !seat.rank ? { ...seat, rank: DEFAULT_RANK } : seat);
    const id = newId();
    const state = newGame({
      id,
      createdAt: this.now(),
      settings: GameSettings.parse(req.settings ?? {}),
      seats: { B: withRank(req.black), W: withRank(req.white) },
    });
    // session.game шлёт commit: после записи снапшота, раньше событий партии (раздел 5 спеки).
    if (opts.sessionId) this.sessionsByGame.set(id, opts.sessionId);
    const waiter = state.pendingEngineMove && req.waitForReply ? this.registerWaiter(id, state.revision) : null;
    try {
      await this.commit(state, 'new', 'system');
    } catch (e) {
      // Партии нет и не будет: id больше не встретится, поэтому привязка к сессии и ожидающий
      // первого хода снимаются здесь, а не висят до close.
      this.sessionsByGame.delete(id);
      this.releaseWaiters(id);
      throw e;
    }
    if (!waiter) return { state };
    const firstMove = await this.waitForReply(waiter);
    const latest = this.get(id);
    if (firstMove) return { state: latest, firstMove };
    return latest.revision > state.revision ? { state: latest } : { state: latest, replyTimedOut: true };
  }

  async play(id: string, req: PlayInput, by: By = 'human'): Promise<PlayResponse> {
    // На ходе движка ход человека отклоняется (not_your_turn), но серию всё равно перезапускает.
    const { state, move, waiter } = await this.humanAction(id, by === 'human', () => this.locked(id, async () => {
      const prev = this.get(id);
      this.checkRevision(prev, req.expectedRevision);
      const color = req.color ?? prev.toPlay;
      this.checkSeat(prev, color, by);
      const next = applyMove(prev, color, req.coord, this.now());
      const waiter = req.waitForReply && next.state.pendingEngineMove ? this.registerWaiter(id, next.state.revision) : null;
      await this.commitOrReleaseWaiter(next.state, next.move.coord === 'pass' ? 'pass' : 'play', by, req.via);
      return { ...next, waiter };
    }));
    return this.withReply(id, state, move, waiter);
  }

  pass(id: string, req: PassInput, by: By = 'human'): Promise<PlayResponse> {
    return this.play(id, { ...req, coord: 'pass' }, by);
  }

  async resign(id: string, req: ResignInput, by: By = 'human'): Promise<StateResponse> {
    return this.humanAction(id, by === 'human', () => this.locked(id, async () => {
      const next = resignGame(this.get(id), req.color);
      await this.commit(next, 'resign', by, req.via);
      return { state: next };
    }));
  }

  async undo(id: string, req: UndoInput, by: By = 'human'): Promise<UndoResponse> {
    return this.humanAction(id, by === 'human', () => this.locked(id, async () => {
      const prev = this.get(id);
      this.checkRevision(prev, req.expectedRevision);
      const rolled = undoGame(prev);
      await this.commit(rolled.state, 'undo', by, req.via);
      return { state: this.get(id), removed: rolled.removed };
    }));
  }

  // Атомарно: откат пары, новый ход человека, новый ответ движка. Одно событие state.updated cause 'correct'.
  async correct(id: string, req: CorrectInput, by: By = 'human'): Promise<PlayResponse> {
    const { state, move, waiter } = await this.humanAction(id, by === 'human', () => this.locked(id, async () => {
      const rolled = undoGame(this.get(id));
      const color = rolled.state.toPlay;
      this.checkSeat(rolled.state, color, by);
      const next = applyMove(rolled.state, color, req.coord, this.now());
      const waiter = req.waitForReply && next.state.pendingEngineMove ? this.registerWaiter(id, next.state.revision) : null;
      await this.commitOrReleaseWaiter(next.state, 'correct', by, req.via);
      return { ...next, waiter };
    }));
    return this.withReply(id, state, move, waiter);
  }

  async setRank(id: string, req: SetRankInput): Promise<StateResponse> {
    return this.humanAction(id, true, () => this.locked(id, async () => {
      const next = setRankGame(this.get(id), req.color, req.rank);
      await this.commit(next, 'rank', 'human');
      return { state: next };
    }));
  }

  async analyze(id: string, req: AnalyzeInput): Promise<Analysis> {
    const state = this.get(id);
    const r = await this.withBudget(this.deps.engine.analyze({ ...this.engineRequest(state), maxVisits: req.maxVisits, includeOwnership: true }), this.deps.analyzeBudgetMs ?? ANALYZE_BUDGET_MS);
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
    const r = await this.withBudget(this.deps.engine.score(this.engineRequest(state)), this.deps.scoreBudgetMs ?? SCORE_BUDGET_MS);
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

  // Пауза, прерываемая на close. После close пауза не начинается вовсе: close уже обошёл
  // набор пробуждений, и новую паузу будить было бы некому.
  private sleep(ms: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakeups.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakeups.add(wake);
    });
  }

  // Дедлайн вызывающего: движок сам повторяет запрос, и без бюджета «кто впереди»
  // молчал бы десятки секунд. Отказ того же вида, что и таймаут ответа движка.
  private async withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApiError('engine_busy', `engine did not respond within ${ms} ms`)), ms);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Сломанный лог (запись в закрытый поток) не вправе менять ход партии: строка теряется, а отказ
  // идёт обычным путём — событие error, пауза, повтор; нелегальный ход движка — всё равно пас.
  private log(line: string): void {
    try {
      this.deps.log?.(line);
    } catch {
      // сообщить о сломанном логе некуда
    }
  }

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
  // humanFallback передаёт только ход движка: признак относится к одному ходу, а не к партии.
  private async commit(next: GameState, cause: StateCause, by: By, via?: Via, humanFallback?: boolean): Promise<void> {
    const prev = this.games.get(next.id);
    // Снапшот пишется до публикации состояния: читатель, увидевший новое состояние
    // (или дождавшийся его опросом), уже не может опередить запись на диск.
    await this.deps.store.save(next);
    this.games.set(next.id, next);
    // Новая партия сессии объявляется только когда она уже есть в сервисе: подписчик на session.game
    // (currentGameId, поток сессии) сразу читает её состояние. При отказе записи события нет.
    const sessionId = this.sessionsByGame.get(next.id);
    if (cause === 'new' && sessionId) this.deps.bus.emit(`session:${sessionId}`, { type: 'session.game', gameId: next.id });
    this.emitGame(next.id, { type: 'state.updated', state: next, cause, by, ...(via ? { via } : {}), ...(humanFallback === undefined ? {} : { humanFallback }) });
    if (next.status === 'finished' && prev?.status !== 'finished' && next.result) this.emitGame(next.id, { type: 'game.finished', result: next.result });
    this.settleWaiters(next, cause, prev);
    this.kick(next);
  }

  // Коммит хода с ожидающим ответа на его ревизию: при отказе записи ревизии не будет, и ожидающий
  // снимается сразу. Ожидающие прежних ревизий (ответ движка на прошлый ход) остаются.
  private async commitOrReleaseWaiter(next: GameState, cause: StateCause, by: By, via?: Via): Promise<void> {
    try {
      await this.commit(next, cause, by, via);
    } catch (e) {
      this.releaseWaitersFrom(next.id, next.revision);
      throw e;
    }
  }

  private releaseWaitersFrom(id: string, revision: number): void {
    const list = this.waiters.get(id);
    if (!list) return;
    this.waiters.set(
      id,
      list.filter((w) => {
        if (w.revision < revision) return true;
        w.resolve(null);
        return false;
      }),
    );
  }

  private emitGame(id: string, event: GameEvent): void {
    this.deps.bus.emit(`game:${id}`, event);
    const sessionId = this.sessionsByGame.get(id);
    if (sessionId) this.deps.bus.emit(`session:${sessionId}`, event);
  }

  private registerWaiter(id: string, revision: number): Promise<Move | null> {
    // После close движок не ответит: ожидающий получает null сразу, а не по таймауту.
    if (this.closed) return Promise.resolve(null);
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
    if (this.closed || state.status !== 'playing' || this.gaveUp.has(state.id)) return;
    if (state.consecutivePasses >= 2) {
      if (!this.scoringTasks.has(state.id)) this.startTask(this.scoringTasks, state.id, this.runScoring(state.id));
      return;
    }
    if (state.pendingEngineMove && !this.engineTasks.has(state.id)) {
      this.startTask(this.engineTasks, state.id, this.runEngine(state.id));
    }
  }

  // Фоновую задачу никто не ждёт до close, поэтому её отказ обязан быть перехвачен здесь:
  // иначе отказ записи снапшота (диск полон) уходит в unhandledRejection и убивает процесс.
  // Перехваченный отказ не должен и оставлять партию без задачи: ход движка ждал бы
  // вечно, а человек получал бы not_your_turn. Поэтому после события error и паузы задача
  // ставится заново. Состояние в памяти при этом не расходится с диском: commit публикует
  // новое состояние только после удачной записи, так что повтор начинается с того, что лежит на диске.
  private startTask(tasks: Map<string, Promise<void>>, id: string, task: Promise<void>): void {
    const run = async (): Promise<void> => {
      try {
        // await task обязан быть первой инструкцией run: run() вызывается до tasks.set, и finally с
        // tasks.delete не должен выполниться раньше set. Синхронный выход до этого await оставил бы
        // запись в карте навсегда, и для партии не поставилась бы ни одна задача.
        await task;
        // Задача дошла до конца без броска: серия отказов прервана.
        this.failures.delete(id);
      } catch (e) {
        await this.onFailure(id, e, 'internal', INTERNAL_MESSAGE, (detail) => `[X] background task for game ${id} failed: ${detail}`);
      } finally {
        // Запись снимается при любом исходе, даже если бросил сам обработчик отказа:
        // иначе для партии больше не поставилась бы ни одна задача.
        tasks.delete(id);
      }
      // kick после любого исхода, а не только после отказа: коммит, случившийся пока запись задачи
      // была в карте (ход движка за движок, коммит в зазоре до delete), новую задачу не поставил.
      // Лишнего kick не бывает: он сам проверяет, нужна ли задача, и ничего не делает после close.
      // После отказа kick идёт только когда пауза перед повтором прошла.
      const state = this.games.get(id);
      if (state) this.kick(state);
    };
    // Бросок обработчика отказа (лог уже не бросает, но защита на будущее) сообщить некуда.
    // Гасим, чтобы не уронить процесс.
    tasks.set(
      id,
      run().catch(() => undefined),
    );
  }

  // Ожидающие ответа получают null: клиент увидит replyTimedOut сразу, а не через 8 с.
  private releaseWaiters(id: string): void {
    for (const w of this.waiters.get(id) ?? []) w.resolve(null);
    this.waiters.delete(id);
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
        // Партия изменилась, пока движок думал (сдача, undo), или сервер закрывается: отказ по старой
        // ревизии не в счёт — ни события, ни паузы. Следующий виток перечитает состояние.
        if (this.outdated(id, state)) continue;
        if (await this.onEngineFailure(id, e)) continue;
        return;
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
          this.log(`[!] the engine suggested an illegal move ${reply.move}: ${e instanceof Error ? e.message : String(e)}; passing instead`);
          next = applyMove(current, color, 'pass', this.now());
        }
        await this.commit(next.state, 'engine', 'engine', undefined, reply.humanFallback);
        return true;
      });
      if (applied) return;
    }
  }

  // Отказ в серии повторов: событие error, ожидающие получают null (клиент увидит replyTimedOut),
  // пауза очередной длины. Отказ после последней паузы — одно событие retries_exhausted, партия
  // остаётся playing и ждёт resume. Возвращает true, если нужен повтор.
  private async onFailure(id: string, e: unknown, code: ErrorCode, message: string, logLine: (detail: string) => string): Promise<boolean> {
    const detail = errorDetail(e);
    const delays = this.deps.retryDelaysMs ?? ENGINE_RETRY_DELAYS_MS;
    const count = (this.failures.get(id) ?? 0) + 1;
    const retryMs = delays[count - 1];
    if (retryMs === undefined) {
      this.failures.delete(id);
      this.gaveUp.add(id);
      this.log(`${logLine(detail)}; gave up after ${delays.length} retries`);
      this.emitGame(id, { type: 'error', code: 'retries_exhausted', message: RETRIES_EXHAUSTED_MESSAGE });
      this.releaseWaiters(id);
      return false;
    }
    this.failures.set(id, count);
    this.log(`${logLine(detail)}; retrying in ${retryMs} ms`);
    this.emitGame(id, publicError(e, code, message));
    this.releaseWaiters(id);
    await this.sleep(retryMs);
    return true;
  }

  private outdated(id: string, state: GameState): boolean {
    return this.closed || this.games.get(id)?.revision !== state.revision;
  }

  private onEngineFailure(id: string, e: unknown): Promise<boolean> {
    return this.onFailure(id, e, 'engine_unavailable', ENGINE_UNAVAILABLE_MESSAGE, (detail) => `[!] engine: ${detail}`);
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
        if (this.outdated(id, state)) continue;
        if (await this.onEngineFailure(id, e)) continue;
        return;
      }
      // Партия изменилась, пока движок считал (setRank, третий пас): результат отбрасывается,
      // и счёт повторяется по новой ревизии. Выйти здесь нельзя: коммит, сменивший ревизию,
      // новую задачу счёта не поставил — эта ещё числилась в карте, и партия осталась бы без итога.
      const applied = await this.locked(id, async () => {
        const current = this.games.get(id);
        if (this.closed || !current || current.revision !== state.revision) return false;
        // причина `pass`: спека не вводит отдельной причины для автосчёта
        await this.commit(finishByScore(current, result), 'pass', 'system');
        return true;
      });
      if (applied) return;
    }
  }
}
