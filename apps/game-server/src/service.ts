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
import { SESSION_TTL_MS } from './sessions.ts';
import type { AbandonMarks, SnapshotStore } from './store.ts';

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
// Порог сдачи движка — раздел 5 спеки: после 60-го хода winrate ниже 3 % и отставание больше 25 очков.
export const ENGINE_RESIGN_LEAD = -25;
export const GENMOVE_VISITS = 10;
// Серия повторов фоновой задачи: пауза перед k-м повтором — k-е число. Отказ после последней
// паузы даёт одно событие retries_exhausted, и партия ждёт действия человека (resume).
export const ENGINE_RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000];
export const RETRIES_EXHAUSTED_MESSAGE = 'background task retries are exhausted';
// Бюджет ожидания вопросов «кто впереди» и «оцени позицию». Цели спеки (10 с и 4 с)
// описывают норму, бюджет обязан покрыть замер на сервере (счёт на 400 просмотрах —
// 5,3 с) с запасом. Правило «движок < клиент < сервис» (D-0010): go-engine 15 и 6 с, клиент
// движка 18 и 8 с, сервис 20 и 10 с. По дедлайну вызов движка отменяется (abort), поздний ответ
// никому не отдаётся.
export const SCORE_BUDGET_MS = 20_000;
export const ANALYZE_BUDGET_MS = 10_000;
// Не больше стольких незавершённых партий на сервере (D-0012): лишний create — too_many_games.
export const MAX_ACTIVE_GAMES = 20;
// Не больше стольких незавершённых партий на клиента (D-0012): ключ — тот же, что у лимита частоты
// (IPv4, IPv6 /64); у партии сессии — ключ владельца сессии. Лишний create — too_many_games со scope client.
export const MAX_GAMES_PER_CLIENT = 3;
// Незавершённая партия без активности дольше срока сессии брошена (D-0012): в лимите не считается,
// init не ставит ей фоновую задачу. Порог в сервере — SESSION_TTL_MS из env, здесь его умолчание.
export const STALE_GAME_MS = SESSION_TTL_MS;
// Снапшот завершённой партии живёт столько после последней активности (последний ход, иначе
// создание); более старые init удаляет с диска (D-0012).
export const FINISHED_RETENTION_MS = 30 * 24 * 3600 * 1000;
// Попыток выдать свободный id партии: совпадение случайных id почти невозможно, цикл лишь страховка (D-0009).
export const MAX_ID_ATTEMPTS = 8;
export const DEFAULT_RANK = '10k' as const;
// Тексты события error для сырых исключений: наружу только код и общий английский текст,
// подробности (путь к снапшоту, адрес движка) — только в лог.
export const INTERNAL_MESSAGE = 'internal server error';
export const ENGINE_UNAVAILABLE_MESSAGE = 'engine is unavailable';

export type GameServiceDeps = {
  store: SnapshotStore;
  // Отметки брошенных сменой партий на диске (D-0012); без них отметка живёт только в памяти.
  marks?: AbandonMarks;
  engine: Engine;
  bus: EventBus;
  now?: () => Date;
  replyTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  scoreBudgetMs?: number;
  analyzeBudgetMs?: number;
  maxActiveGames?: number;
  maxGamesPerClient?: number;
  finishedRetentionMs?: number;
  staleGameMs?: number;
  newId?: () => string;
  log?: (line: string) => void;
};

// Вызов движка под бюджетом: result отказывает по дедлайну или отмене сразу, settled оседает,
// когда осел сам вызов движка (движок, не слушающий abort, может ещё считать).
type Budgeted<T> = { result: Promise<T>; settled: Promise<void> };

// Ожидающий ответа движка на состояние с ревизией revision.
type Waiter = { revision: number; resolve: (move: Move | null) => void };

// ApiError уходит как есть: его message пишется в коде сервера по-английски и без путей, а
// текст чужого исключения (клиент движка) лежит в cause и попадает только в лог.
// Сырое исключение (fs, fetch) несёт путь или адрес, поэтому наружу — код и общий текст.
function publicError(gameId: string, e: unknown, code: ErrorCode, message: string): GameEvent {
  return e instanceof ApiError ? { type: 'error', gameId, code: e.code, message: e.message } : { type: 'error', gameId, code, message };
}

// Последняя активность партии для срока хранения снапшота: время последнего хода, иначе создания.
function lastActivity(state: GameState): number {
  return Date.parse(state.moves.at(-1)?.at ?? state.createdAt);
}

// Партии нужна фоновая задача: автосчёт после двух пасов или ход движка (то же условие, что в kick).
function needsTask(state: GameState): boolean {
  return state.status === 'playing' && (state.consecutivePasses >= 2 || state.pendingEngineMove);
}

export class GameService {
  private readonly deps: GameServiceDeps;
  private readonly games = new Map<string, GameState>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly sessionsByGame = new Map<string, string>();
  // Текущая партия сессии по сервису (раздел 5 спеки): в канал сессии идут события только её.
  // Ставится коммитом новой партии сессии, тем же, что шлёт session.game.
  private readonly currentGameBySession = new Map<string, string>();
  // Партии, чей create ещё пишет снапшот: занимают id и место в лимите незавершённых партий.
  private readonly pendingCreates = new Set<string>();
  // Клиент, в чей счёт идёт партия (ключ из app.ts). Только память: после рестарта партии, созданные до него,
  // в счёт клиента не идут, в общем лимите — идут. Записи завершённых партий вычищает checkClientLimit.
  private readonly clientByGame = new Map<string, string>();
  // Отмена фоновых задач партии (ход движка и счёт делят один сигнал): смена партии в сессии и close.
  private readonly taskAborts = new Map<string, AbortController>();
  private readonly engineTasks = new Map<string, Promise<void>>();
  private readonly scoringTasks = new Map<string, Promise<void>>();
  // Досрочные пробуждения фоновых пауз: close не должен ждать паузу перед повтором.
  private readonly wakeups = new Set<() => void>();
  // Число отказов подряд в текущей серии повторов партии; обнуляет любой удачный коммит.
  private readonly failures = new Map<string, number>();
  // Партии, чья серия исчерпана, задача отменена сменой партии или устарела к init: kick их не трогает
  // до действия человека или открытия потока (resume).
  private readonly gaveUp = new Set<string>();
  // Партии, брошенные сменой партии в сессии (D-0012): не в лимитах и без задачи init, как устаревшие.
  // Возврат человека (resume, humanAction) в пределах лимита снимает отметку. Записи на диск идут цепочкой, close её ждёт.
  private readonly abandoned = new Set<string>();
  // Время последнего возврата к партии вне счёта, прошедшего лимиты: для порога устаревания это активность.
  // Только память; записей не больше, чем партий в памяти.
  private readonly returnedAt = new Map<string, number>();
  private marksWrite: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(deps: GameServiceDeps) {
    this.deps = deps;
  }

  async init(): Promise<void> {
    // Срок хранения (D-0012): снапшот завершённой партии старше срока удаляется и в память не идёт.
    // Отказ удаления — строка [!] в лог, партия всё равно не загружается: следующий init попробует снова.
    const now = (this.deps.now?.() ?? new Date()).getTime();
    const cutoff = now - (this.deps.finishedRetentionMs ?? FINISHED_RETENTION_MS);
    for (const state of await this.deps.store.load()) {
      if (state.status === 'finished' && lastActivity(state) < cutoff) {
        try {
          await this.deps.store.remove(state.id);
        } catch (e) {
          this.log(`[!] could not remove the expired snapshot of game ${state.id}: ${errorDetail(e)}`);
        }
        continue;
      }
      this.games.set(state.id, state);
    }
    // Отметка идущей партии действует; отметка завершённой или удалённой партии — остаток, её снимаем.
    for (const id of (await this.deps.marks?.loadAbandoned()) ?? []) {
      if (this.games.get(id)?.status === 'playing') this.abandoned.add(id);
      else this.persistMark(id, false);
    }
    // Устаревшей или брошенной сменой партии задача не ставится (D-0012): после рестарта движок не доигрывает
    // брошенные партии. Она отмечена, как отменённая, и её снова запустит действие человека или открытие потока (resume).
    for (const state of this.games.values()) {
      if (this.isStale(state, now)) {
        if (needsTask(state)) this.gaveUp.add(state.id);
        continue;
      }
      this.kick(state);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const list of this.waiters.values()) for (const w of list) w.resolve(null);
    this.waiters.clear();
    // Пауза перед повтором обрывается: иначе остановка сервера ждала бы её целиком.
    for (const wake of [...this.wakeups]) wake();
    // Идущие вызовы движка отменяются: остановка не ждёт раздумья, результат после close не применяется.
    for (const controller of this.taskAborts.values()) controller.abort();
    await Promise.allSettled([...this.engineTasks.values(), ...this.scoringTasks.values()]);
    // Обработчик запроса может поставить запись отметки, пока close ждёт: цепочка читается заново, пока растёт.
    for (let last: Promise<void> | undefined; last !== this.marksWrite; ) {
      last = this.marksWrite;
      await last;
    }
  }

  // Сессия удалена или истекла: привязки её партий снимаются, события в её канал больше не идут.
  // Фоновые задачи партий не трогаются: партия живёт и без сессии.
  forgetSession(sessionId: string): void {
    this.currentGameBySession.delete(sessionId);
    for (const [gameId, sid] of this.sessionsByGame) if (sid === sessionId) this.sessionsByGame.delete(gameId);
  }

  list(): GameSummary[] {
    return [...this.games.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((g) => ({ id: g.id, createdAt: g.createdAt, status: g.status, moveCount: g.moves.length, seats: g.seats, ...(g.result ? { result: g.result } : {}) }));
  }

  // Действие человека на партии (мутирующий запрос, открытие потока событий): исчерпанная серия
  // повторов начинается заново. Во время идущей серии и для незнакомой партии ничего не делает.
  // Партия вне счёта (брошенная сменой или устаревшая) сверх лимита (D-0012) остаётся вне счёта: поток открыт,
  // но задача не ставится.
  resume(id: string): void {
    if (this.reactivate(id)) return;
    if (!this.gaveUp.delete(id)) return;
    const state = this.games.get(id);
    if (state) this.kick(state);
  }

  // Мутирующее действие человека: отметка исчерпанной серии снимается до операции, а задача
  // ставится после неё. Удачный коммит поставит задачу сам и уже по новому состоянию: после сдачи
  // движок не зовётся. Отклонённая операция (not_your_turn, nothing_to_undo, отказ записи) задачу
  // ставит здесь, и серия идёт заново. resume (открытие потока) ставит задачу сразу: операции нет.
  private async humanAction<T>(id: string, human: boolean, op: () => Promise<T>): Promise<T> {
    // Возврат к партии вне счёта сверх лимита — отказ до операции: партия не меняется и остаётся вне счёта.
    const refused = human ? this.reactivate(id) : undefined;
    if (refused) throw refused;
    const resumed = human && this.gaveUp.delete(id);
    try {
      return await op();
    } finally {
      const state = resumed ? this.games.get(id) : undefined;
      if (state) this.kick(state);
    }
  }

  // Шов для тестов на утечки: размеры внутренних таблиц, которые публичным API не видны.
  internalSizes(): { sessionsByGame: number; currentGames: number; clientGames: number; waiters: number; gaveUp: number; taskAborts: number } {
    let waiters = 0;
    for (const list of this.waiters.values()) waiters += list.length;
    return {
      sessionsByGame: this.sessionsByGame.size,
      currentGames: this.currentGameBySession.size,
      clientGames: this.clientByGame.size,
      waiters,
      gaveUp: this.gaveUp.size,
      taskAborts: this.taskAborts.size,
    };
  }

  get(id: string): GameState {
    const state = this.games.get(id);
    if (!state) throw new ApiError('not_found', `game ${id} does not exist`);
    return state;
  }

  async create(req: NewGameInput, opts: { sessionId?: string; clientKey?: string } = {}): Promise<NewGameResponse> {
    for (const seat of [req.black, req.white]) {
      if (seat.controller === 'external') throw new ApiError('unsupported_controller', 'the external seat arrives at stage 2');
    }
    // D-0005: партия движка против движка шла бы без человека и без потолка ходов — отказ; человек
    // против человека принимается (движок в ней не работает), место external отклонено выше до стадии 2.
    if (req.black.controller === 'engine' && req.white.controller === 'engine') {
      throw new ApiError('unsupported_controller', 'two engine seats are not supported', { black: 'engine', white: 'engine' });
    }
    const withRank = (seat: NewGameInput['black']) => (seat.controller === 'engine' && !seat.rank ? { ...seat, rank: DEFAULT_RANK } : seat);
    const replaced = opts.sessionId === undefined ? undefined : this.currentGameBySession.get(opts.sessionId);
    const refused = this.activeLimitError(replaced) ?? (opts.clientKey === undefined ? undefined : this.clientLimitError(opts.clientKey, replaced));
    if (refused) throw refused;
    const id = this.freeId();
    const state = newGame({
      id,
      createdAt: this.now(),
      settings: GameSettings.parse(req.settings ?? {}),
      seats: { B: withRank(req.black), W: withRank(req.white) },
    });
    this.pendingCreates.add(id);
    if (opts.clientKey !== undefined) this.clientByGame.set(id, opts.clientKey);
    // session.game шлёт commit: после записи снапшота, раньше событий партии (раздел 5 спеки).
    if (opts.sessionId) this.sessionsByGame.set(id, opts.sessionId);
    const waiter = state.pendingEngineMove && req.waitForReply ? this.registerWaiter(id, state.revision) : null;
    try {
      await this.commit(state, 'new', 'system');
    } catch (e) {
      // Партии нет и не будет: id больше не встретится, поэтому привязка к сессии и ожидающий
      // первого хода снимаются здесь, а не висят до close.
      this.sessionsByGame.delete(id);
      this.clientByGame.delete(id);
      this.releaseWaiters(id);
      throw e;
    } finally {
      this.pendingCreates.delete(id);
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
      const prev = this.get(id);
      // Сдаться за место движка может только сам движок (раздел 5 спеки). Отказ связан с местом, а не
      // с очередью хода: bad_request с причиной not_your_seat, а не not_your_turn.
      if (prev.seats[req.color].controller === 'engine' && by !== 'engine') {
        throw new ApiError('bad_request', `cannot resign for the engine seat ${req.color}`, { reason: 'not_your_seat' });
      }
      this.checkSeat(prev, req.color, by);
      const next = resignGame(prev, req.color);
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
    const call = this.budgeted((signal) => this.deps.engine.analyze({ ...this.engineRequest(state), maxVisits: req.maxVisits, includeOwnership: true }, signal), this.deps.analyzeBudgetMs ?? ANALYZE_BUDGET_MS);
    const r = await call.result;
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
    return this.scoreCall(this.get(id)).result;
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
  // Отменённая задача (signal) тоже будит паузу: отмена не ждёт паузы серии.
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.closed || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakeups.delete(wake);
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakeups.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
    });
  }

  // Дедлайн вызывающего: без бюджета «кто впереди» молчал бы до таймаута клиента движка. Отказ того
  // же вида, что и таймаут ответа движка. По дедлайну и по отмене outer вызов движка получает abort:
  // запрос к go-engine обрывается, и KataGo снимает запрос. Поздний ответ result уже не меняет.
  private budgeted<T>(call: (signal: AbortSignal) => Promise<T>, ms: number, outer?: AbortSignal): Budgeted<T> {
    const controller = new AbortController();
    let work: Promise<T>;
    try {
      work = call(controller.signal);
    } catch (e) {
      work = Promise.reject(e);
    }
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    const result = (async () => {
      let timer: NodeJS.Timeout | undefined;
      let onOuterAbort: (() => void) | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        const stop = (reason: unknown) => {
          reject(reason);
          controller.abort(reason);
        };
        timer = setTimeout(() => stop(new ApiError('engine_busy', `engine did not respond within ${ms} ms`)), ms);
        if (!outer) return;
        onOuterAbort = () => stop(outer.reason);
        if (outer.aborted) onOuterAbort();
        else outer.addEventListener('abort', onOuterAbort, { once: true });
      });
      try {
        return await Promise.race([work, interrupted]);
      } finally {
        clearTimeout(timer);
        if (onOuterAbort) outer?.removeEventListener('abort', onOuterAbort);
      }
    })();
    return { result, settled };
  }

  private scoreCall(state: GameState, outer?: AbortSignal): Budgeted<Result> {
    const call = this.budgeted((signal) => this.deps.engine.score(this.engineRequest(state), signal), this.deps.scoreBudgetMs ?? SCORE_BUDGET_MS, outer);
    const result = call.result.then(
      (r): Result => ({
        winner: r.winner,
        margin: r.margin,
        reason: 'score',
        score: { areaB: r.areaB, areaW: r.areaW, komi: state.settings.komi, dead: r.dead, ownership: r.ownership },
      }),
    );
    return { result, settled: call.settled };
  }

  // Лимит незавершённых партий (D-0012). Партия, чей create ещё пишет снапшот, уже занимает место;
  // устаревшая (без активности дольше порога на момент create) и брошенная сменой — нет. replaced — текущая
  // партия сессии, в которой идёт create: новая партия её заменит, поэтому своей замене она не мешает.
  // Отказ возвращается, а не бросается: create его бросает, resume молча оставляет партию вне счёта.
  private activeLimitError(replaced?: string): ApiError | undefined {
    const max = this.deps.maxActiveGames ?? MAX_ACTIVE_GAMES;
    const now = (this.deps.now?.() ?? new Date()).getTime();
    let active = 0;
    for (const state of this.games.values()) if (state.id !== replaced && state.status !== 'finished' && !this.isStale(state, now)) active++;
    for (const id of this.pendingCreates) if (!this.games.has(id)) active++;
    return active >= max ? new ApiError('too_many_games', `limit of ${max} unfinished games reached`, { max }) : undefined;
  }

  // Лимит незавершённых партий на клиента (D-0012), счёт как у общего: создаваемая уже в счёте, завершённая,
  // устаревшая и брошенная сменой — нет, заменяемая текущая партия сессии — тоже нет. Брошенная не вычищается:
  // возврат к ней пройдёт этот же лимит и вернёт её в счёт.
  private clientLimitError(clientKey: string, replaced?: string): ApiError | undefined {
    const max = this.deps.maxGamesPerClient ?? MAX_GAMES_PER_CLIENT;
    const now = (this.deps.now?.() ?? new Date()).getTime();
    let active = 0;
    for (const [id, key] of this.clientByGame) {
      const state = this.games.get(id);
      if (state?.status === 'finished') {
        this.clientByGame.delete(id);
        continue;
      }
      if (key !== clientKey || id === replaced) continue;
      if (state ? !this.isStale(state, now) : this.pendingCreates.has(id)) active++;
    }
    return active >= max ? new ApiError('too_many_games', `limit of ${max} unfinished games per client reached`, { max, scope: 'client' }) : undefined;
  }

  // Не в счёте лимитов и без задачи init: без активности дольше порога или брошена сменой партии (D-0012).
  // Возврат к партии вне счёта в пределах лимита — тоже активность.
  private isStale(state: GameState, now: number): boolean {
    const active = Math.max(lastActivity(state), this.returnedAt.get(state.id) ?? 0);
    return this.abandoned.has(state.id) || active < now - (this.deps.staleGameMs ?? STALE_GAME_MS);
  }

  // Прежняя идущая партия сессии брошена: отметка в памяти сразу, на диск — в очередь записей.
  private abandon(id: string): void {
    if (this.games.get(id)?.status !== 'playing' || this.abandoned.has(id)) return;
    this.abandoned.add(id);
    this.persistMark(id, true);
  }

  // Человек вернулся к партии вне счёта — брошенной сменой или устаревшей: она снова в счёте, если проходит те же
  // лимиты, что create (D-0012), — сначала общий, затем клиента, в чей счёт шла партия. Иначе один адрес набрал бы
  // весь общий лимит по кругу: «новая партия в сессии → поток брошенной» или по 3 партии за порог устаревания,
  // затем возврат ко всем. Сверх лимита партия остаётся вне счёта, и отказ возвращается вызывающему. Партия без
  // записи клиента (создана до рестарта) проходит только общий лимит. Партия в счёте проверку не проходит.
  private reactivate(id: string): ApiError | undefined {
    const state = this.games.get(id);
    const now = (this.deps.now?.() ?? new Date()).getTime();
    if (state === undefined || state.status === 'finished' || !this.isStale(state, now)) return undefined;
    const clientKey = this.clientByGame.get(id);
    const refused = this.activeLimitError() ?? (clientKey === undefined ? undefined : this.clientLimitError(clientKey));
    if (refused) return refused;
    // В счёте сразу, до хода: одновременные возвраты видят друг друга.
    this.returnedAt.set(id, now);
    if (this.abandoned.delete(id)) this.persistMark(id, false);
    return undefined;
  }

  // Отказ записи — строка [!], память уже верна. После рестарта незаписанная отметка значит, что партия
  // в счёте и получит задачу, как свежая; неснятая — что партия вне счёта до следующего возврата.
  private persistMark(id: string, abandoned: boolean): void {
    const marks = this.deps.marks;
    if (!marks) return;
    this.marksWrite = this.marksWrite.then(async () => {
      try {
        await (abandoned ? marks.markAbandoned(id) : marks.clearAbandoned(id));
      } catch (e) {
        this.log(`[!] could not ${abandoned ? 'mark' : 'unmark'} game ${id} as abandoned: ${errorDetail(e)}`);
      }
    });
  }

  // Id партии не должен совпасть ни с существующей, ни с создаваемой (D-0009): совпавший
  // перезаписал бы чужой снапшот. Исчерпанные попытки — дефект генератора, это internal.
  private freeId(): string {
    const generate = this.deps.newId ?? newId;
    for (let i = 0; i < MAX_ID_ATTEMPTS; i++) {
      const id = generate();
      if (!this.games.has(id) && !this.pendingCreates.has(id)) return id;
    }
    throw new Error('could not generate a free game id');
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
    // Удачный коммит обнуляет счёт серии повторов: новая позиция — новая серия. Коммит человека —
    // после correct во время раздумья пауза снова первая, как после undo и play. Коммит движка или
    // счёта — удачный конец фоновой задачи; обнулять здесь, а не по выходу задачи: коммит паса движка
    // сам ставит задачу счёта, и её отказ мог прийти раньше выхода задачи движка, унаследовать счёт
    // её серии, а затем потерять свой. Идущую паузу это не сокращает, отметку исчерпанной серии
    // снимает humanAction, отклонённое действие и отказ записи сюда не доходят.
    this.failures.delete(next.id);
    // Новая партия сессии объявляется только когда она уже есть в сервисе: подписчик на session.game
    // (currentGameId, поток сессии) сразу читает её состояние. При отказе записи события нет.
    const sessionId = this.sessionsByGame.get(next.id);
    if (cause === 'new' && sessionId) this.switchSessionGame(sessionId, next.id);
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

  // Новая партия сессии становится текущей (раздел 5 спеки): прежняя отвязывается от сессии, её фоновая
  // задача отменяется. Статус прежней не меняется; её события идут только в её канал game:<id>.
  private switchSessionGame(sessionId: string, id: string): void {
    const previous = this.currentGameBySession.get(sessionId);
    this.currentGameBySession.set(sessionId, id);
    if (previous !== undefined && previous !== id) {
      if (this.sessionsByGame.get(previous) === sessionId) this.sessionsByGame.delete(previous);
      this.cancelBackground(previous);
      this.abandon(previous);
    }
    this.deps.bus.emit(`session:${sessionId}`, { type: 'session.game', gameId: id });
  }

  // Отмена фоновой задачи партии: вызов движка получает abort, пауза серии обрывается, поздний ответ не
  // применяется. Отменённая задача не перезапускается сама (как после retries_exhausted): её снова
  // поставит действие человека на партии или открытие её потока (resume). Ожидающие ответа получают null.
  private cancelBackground(id: string): void {
    const controller = this.taskAborts.get(id);
    this.taskAborts.delete(id);
    controller?.abort();
    if (!this.engineTasks.has(id) && !this.scoringTasks.has(id)) return;
    this.failures.delete(id);
    this.gaveUp.add(id);
    this.releaseWaiters(id);
  }

  // Сигнал фоновых задач партии; отменённый заменяется новым для следующей задачи.
  private taskSignal(id: string): AbortSignal {
    let controller = this.taskAborts.get(id);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      this.taskAborts.set(id, controller);
    }
    return controller.signal;
  }

  // Канал сессии получает событие, только если партия — текущая партия сессии в момент отправки:
  // поздние события прежней партии (ход движка, ошибка) не попадают в поток новой (раздел 5 спеки).
  private emitGame(id: string, event: GameEvent): void {
    this.deps.bus.emit(`game:${id}`, event);
    const sessionId = this.sessionsByGame.get(id);
    if (sessionId && this.currentGameBySession.get(sessionId) === id) this.deps.bus.emit(`session:${sessionId}`, event);
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
      if (!this.scoringTasks.has(state.id)) {
        const signal = this.taskSignal(state.id);
        this.startTask(this.scoringTasks, state.id, signal, this.runScoring(state.id, signal));
      }
      return;
    }
    if (state.pendingEngineMove && !this.engineTasks.has(state.id)) {
      const signal = this.taskSignal(state.id);
      this.startTask(this.engineTasks, state.id, signal, this.runEngine(state.id, signal));
    }
  }

  // Фоновую задачу никто не ждёт до close, поэтому её отказ обязан быть перехвачен здесь:
  // иначе отказ записи снапшота (диск полон) уходит в unhandledRejection и убивает процесс.
  // Перехваченный отказ не должен и оставлять партию без задачи: ход движка ждал бы
  // вечно, а человек получал бы not_your_turn. Поэтому после события error и паузы задача
  // ставится заново. Состояние в памяти при этом не расходится с диском: commit публикует
  // новое состояние только после удачной записи, так что повтор начинается с того, что лежит на диске.
  private startTask(tasks: Map<string, Promise<void>>, id: string, signal: AbortSignal, task: Promise<void>): void {
    const run = async (): Promise<void> => {
      try {
        // await task обязан быть первой инструкцией run: run() вызывается до tasks.set, и finally с
        // tasks.delete не должен выполниться раньше set. Синхронный выход до этого await оставил бы
        // запись в карте навсегда, и для партии не поставилась бы ни одна задача.
        await task;
        // Счёт серии здесь не обнуляется: удачная задача всегда кончается коммитом, и обнуляет он.
        // Задача, вышедшая без коммита, вышла из-за чужого коммита (он обнулил) или из-за close.
      } catch (e) {
        await this.onFailure(id, e, 'internal', INTERNAL_MESSAGE, (detail) => `[X] background task for game ${id} failed: ${detail}`, signal);
      } finally {
        // Запись снимается при любом исходе, даже если бросил сам обработчик отказа:
        // иначе для партии больше не поставилась бы ни одна задача.
        tasks.delete(id);
        // Сигнал делят задачи движка и счёта партии: снимается, когда не осталось ни одной.
        if (!this.engineTasks.has(id) && !this.scoringTasks.has(id)) this.taskAborts.delete(id);
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
  // signal — отмена задачи (смена партии в сессии, close): вызов движка обрывается, ответ не применяется.
  private async runEngine(id: string, signal: AbortSignal): Promise<void> {
    while (!this.closed && !signal.aborted) {
      const state = this.games.get(id);
      if (!state || state.status !== 'playing' || !state.pendingEngineMove) return;
      const color = state.toPlay;
      const rank = state.seats[color].rank ?? DEFAULT_RANK;
      this.emitGame(id, { type: 'engine.thinking', gameId: id, color });
      let reply: Awaited<ReturnType<Engine['genmove']>>;
      try {
        reply = await this.deps.engine.genmove({ ...this.engineRequest(state), rank, maxVisits: GENMOVE_VISITS }, signal);
      } catch (e) {
        // Отмена задачи — не отказ движка: ни события, ни паузы.
        if (signal.aborted) return;
        // Партия изменилась, пока движок думал (сдача, undo), или сервер закрывается: отказ по старой
        // ревизии не в счёт — ни события, ни паузы. Следующий виток перечитает состояние.
        if (this.outdated(id, state)) continue;
        if (await this.onEngineFailure(id, e, signal)) continue;
        return;
      }
      const applied = await this.locked(id, async () => {
        const current = this.games.get(id);
        // Партия изменилась, пока движок думал, или задача отменена: ответ не применяется.
        if (this.closed || signal.aborted || !current || current.revision !== state.revision) return false;
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
  private async onFailure(id: string, e: unknown, code: ErrorCode, message: string, logLine: (detail: string) => string, signal?: AbortSignal): Promise<boolean> {
    const detail = errorDetail(e);
    const delays = this.deps.retryDelaysMs ?? ENGINE_RETRY_DELAYS_MS;
    const count = (this.failures.get(id) ?? 0) + 1;
    const retryMs = delays[count - 1];
    if (retryMs === undefined) {
      this.failures.delete(id);
      this.gaveUp.add(id);
      this.log(`${logLine(detail)}; gave up after ${delays.length} retries`);
      this.emitGame(id, { type: 'error', gameId: id, code: 'retries_exhausted', message: RETRIES_EXHAUSTED_MESSAGE });
      this.releaseWaiters(id);
      return false;
    }
    this.failures.set(id, count);
    this.log(`${logLine(detail)}; retrying in ${retryMs} ms`);
    this.emitGame(id, publicError(id, e, code, message));
    this.releaseWaiters(id);
    await this.sleep(retryMs, signal);
    return true;
  }

  private outdated(id: string, state: GameState): boolean {
    return this.closed || this.games.get(id)?.revision !== state.revision;
  }

  private onEngineFailure(id: string, e: unknown, signal: AbortSignal): Promise<boolean> {
    return this.onFailure(id, e, 'engine_unavailable', ENGINE_UNAVAILABLE_MESSAGE, (detail) => `[!] engine: ${detail}`, signal);
  }

  // Два паса: счёт и завершение. При недоступности движка — повтор, партия остаётся playing.
  private async runScoring(id: string, signal: AbortSignal): Promise<void> {
    while (!this.closed && !signal.aborted) {
      const state = this.games.get(id);
      if (!state || state.status !== 'playing' || state.consecutivePasses < 2) return;
      const call = this.scoreCall(state, signal);
      let result: Result;
      try {
        result = await call.result;
      } catch (e) {
        // Отказ по бюджету или отмена обрывают ожидание, но движок может ещё считать: событие error и
        // пауза серии идут сразу, а второй счёт не начинается, пока не осел первый вызов движка.
        const retry = !signal.aborted && (this.outdated(id, state) || (await this.onEngineFailure(id, e, signal)));
        await call.settled;
        if (retry) continue;
        return;
      }
      // Партия изменилась, пока движок считал (setRank, третий пас): результат отбрасывается,
      // и счёт повторяется по новой ревизии. Выйти здесь нельзя: коммит, сменивший ревизию,
      // новую задачу счёта не поставил — эта ещё числилась в карте, и партия осталась бы без итога.
      const applied = await this.locked(id, async () => {
        const current = this.games.get(id);
        if (this.closed || signal.aborted || !current || current.revision !== state.revision) return false;
        // причина `pass`: спека не вводит отдельной причины для автосчёта
        await this.commit(finishByScore(current, result), 'pass', 'system');
        return true;
      });
      if (applied) return;
    }
  }
}
