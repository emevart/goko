import { describe, expect, it } from 'vitest';
import { ApiError, type CallOptions, ClientTimeoutError, type GameState, HttpError, humanText } from '@goko/protocol';
import {
  NETWORK_TEXT,
  TIMEOUT_NOT_APPLIED_TEXT,
  capturesText,
  describeError,
  rankText,
  resultText,
  retryDelayMs,
  sendTapMove,
  statusText,
} from './text.ts';

function game(over: Partial<GameState> = {}): GameState {
  return {
    id: 'g1',
    createdAt: 't',
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
    ...over,
  };
}

describe('text', () => {
  it('describeError', () => {
    expect(describeError(new ApiError('not_your_turn', 'it is Goko to play', { toPlay: 'W' }))).toBe('сейчас не твой ход');
    expect(describeError(new ApiError('illegal_move', 'illegal move D4: ko', { reason: 'ko', coord: 'D4' }))).toBe('ко: сразу забрать нельзя');
    expect(describeError(new TypeError('Failed to fetch'))).toBe('нет связи с сервером');
    expect(describeError(new HttpError(502, 'Bad Gateway'))).toBe(NETWORK_TEXT);
  });
  it('describeError различает таймаут и потерю сети, берёт reason и scope из details', () => {
    expect(describeError(new ClientTimeoutError('play', 15_000))).toBe('сервер не отвечает');
    expect(describeError(new ApiError('rate_limited', 'too many requests', { retryAfterSeconds: 30 }))).toBe(humanText('rate_limited'));
    expect(describeError(new ApiError('too_many_games', 'limit of 3 unfinished games per client reached', { max: 3, scope: 'client' }))).toBe(
      humanText('too_many_games', { max: 3, scope: 'client' }),
    );
    expect(describeError(new ApiError('bad_request', 'seat is not controlled by a human', { reason: 'not_your_seat' }))).toBe('это не твой цвет');
    expect(describeError(new ApiError('bad_request', 'invalid body'))).toBe('запрос не по форме');
  });
  it('retryDelayMs: Retry-After только у rate_limited', () => {
    expect(retryDelayMs(new ApiError('rate_limited', 'too many requests', { retryAfterSeconds: 30 }))).toBe(30_000);
    expect(retryDelayMs(new ApiError('rate_limited', 'too many requests'))).toBe(1000);
    expect(retryDelayMs(new ApiError('engine_busy', 'engine is busy'))).toBe(0);
    expect(retryDelayMs(new TypeError('Failed to fetch'))).toBe(0);
  });
  // Фейковый клиент для перечитывания: отдаёт состояния по очереди, пишет чтения с сигналом.
  function reader(queue: Array<GameState | Error>) {
    const reads: Array<{ id: string; signal: AbortSignal | undefined }> = [];
    return {
      reads,
      getGame: async (id: string, o?: CallOptions): Promise<GameState> => {
        reads.push({ id, signal: o?.signal });
        const next = queue.shift();
        if (!next) throw new Error('лишнее чтение');
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }
  it('sendTapMove: ответ пришёл — null без чтения; ошибка сервера — наружу без чтения; отказ перечитывания — наружу; запрос не повторяется', async () => {
    const before = game({ revision: 3 });
    const c = reader([new TypeError('Failed to fetch')]);
    const signal = new AbortController().signal;
    let sent = 0;
    expect(await sendTapMove(c, before, async () => void sent++, { signal })).toBeNull();
    expect(c.reads).toEqual([]);
    const refuse = async () => {
      sent++;
      throw new ApiError('not_your_turn', 'it is Goko to play', { toPlay: 'W' });
    };
    await expect(sendTapMove(c, before, refuse, { signal })).rejects.toMatchObject({ code: 'not_your_turn' });
    expect(c.reads).toEqual([]);
    const timeout = async () => {
      sent++;
      throw new ClientTimeoutError('play', 15_000);
    };
    await expect(sendTapMove(c, before, timeout, { signal })).rejects.toThrow('Failed to fetch');
    expect(c.reads).toEqual([{ id: 'g1', signal }]);
    expect(sent).toBe(3);
  });
  it('sendTapMove: таймаут — партия перечитана тем же сигналом; ревизия та же — текст «ход пока не записан», сменилась — партия без текста', async () => {
    const before = game({ revision: 3 });
    const same = game({ revision: 3 });
    const moved = game({ revision: 5, toPlay: 'W', pendingEngineMove: true, moves: [{ n: 1, color: 'B', coord: 'D4', captured: 0, at: 't' }] });
    const c = reader([same, moved]);
    const signal = new AbortController().signal;
    let sent = 0;
    const timeout = async (o: CallOptions) => {
      sent++;
      expect(o.signal).toBe(signal);
      throw new ClientTimeoutError('play', 15_000);
    };
    expect(await sendTapMove(c, before, timeout, { signal })).toEqual({ state: same, text: TIMEOUT_NOT_APPLIED_TEXT });
    expect(TIMEOUT_NOT_APPLIED_TEXT).toBe('сервер не отвечает: ход пока не записан');
    expect(await sendTapMove(c, before, timeout, { signal })).toEqual({ state: moved, text: null });
    expect(sent).toBe(2);
    expect(c.reads).toEqual([
      { id: 'g1', signal },
      { id: 'g1', signal },
    ]);
  });
  it('statusText', () => {
    expect(statusText(null, false)).toBe('Партии нет: нажми «Новая партия» или попроси Гоко');
    expect(statusText(game(), false)).toBe('Ход 1, твой ход (чёрные)');
    expect(statusText(game({ toPlay: 'W', pendingEngineMove: true, moves: [{ n: 1, color: 'B', coord: 'D4', captured: 0, at: 't' }] }), false)).toBe('Ход 2, ход Гоко (белые)');
    expect(statusText(game({ toPlay: 'W', pendingEngineMove: true }), true)).toBe('Ход 1, Гоко думает (белые)');
    expect(statusText(game({ status: 'finished', result: { winner: 'B', margin: 3.5, reason: 'score' } }), false)).toBe('Победа твоя: +3,5');
  });
  it('resultText, capturesText, rankText', () => {
    expect(resultText(game({ status: 'finished', result: { winner: 'W', reason: 'resign' } }))).toBe('Победа Гоко: сдача');
    expect(resultText(game({ status: 'finished', result: { winner: 'W', margin: 12, reason: 'score' } }))).toBe('Победа Гоко: +12');
    expect(capturesText(game({ captures: { B: 3, W: 1 } }))).toBe('Пленные: чёрные 3, белые 1');
    expect(rankText(game())).toBe('Гоко 10k');
    expect(rankText(game({ seats: { B: { controller: 'engine' }, W: { controller: 'human' } } }))).toBe('Гоко');
  });
  it('человек против человека (D-0005): «ты» — тот, чей ход, победа по цвету', () => {
    const hvh = { B: { controller: 'human' as const }, W: { controller: 'human' as const } };
    const d4 = { n: 1, color: 'B' as const, coord: 'D4', captured: 0, at: 't' };
    expect(statusText(game({ seats: hvh, toPlay: 'W', moves: [d4] }), false)).toBe('Ход 2, ходят белые');
    expect(resultText(game({ seats: hvh, status: 'finished', result: { winner: 'B', reason: 'resign' } }))).toBe('Победа чёрных: сдача');
    expect(resultText(game({ seats: hvh, status: 'finished', result: { winner: 'W', margin: 2.5, reason: 'score' } }))).toBe('Победа белых: +2,5');
    expect(rankText(game({ seats: hvh }))).toBe('Два игрока');
  });
});
