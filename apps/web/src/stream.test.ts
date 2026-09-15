import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type EventsTarget, type GameEvent, type GameState, RETRY_MS, STABLE_CONNECTION_MS } from '@goko/protocol';
import { type StreamHandle, needsRetry, streamEvents } from './stream.ts';

// Живой поток, который ничего не шлёт и кончается только отменой своего сигнала — как fetch SSE.
// Уже отменённый сигнал (reopen прямо из onEvent) обрывает сразу: событие abort второй раз не придёт.
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamEvents', () => {
  it('отдаёт события, переподключается с паузой, останавливается по сигналу', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) {
          yield { type: 'session.game', gameId: 'g1' };
          throw new TypeError('network error');
        }
        yield { type: 'engine.thinking', gameId: 'g1', color: 'W' };
        abort.abort();
      },
    };
    const got: string[] = [];
    const conn: boolean[] = [];
    const slept: number[] = [];
    await streamEvents(client, 's1', abort.signal, { onEvent: (ev) => got.push(ev.type), onConnected: (c) => conn.push(c), onLost: () => got.push('LOST') }, async (ms) => void slept.push(ms), () => 0).done;
    expect(got).toEqual(['session.game', 'engine.thinking']);
    expect(conn).toEqual([true, false, true]);
    expect(slept).toEqual([RETRY_MS[0]]);
    expect(connects).toBe(2);
  });
  it('растит паузу 1, 2, 4, 8 с до потолка 15 с', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects < 8) throw new Error('down');
        yield { type: 'engine.thinking', gameId: 'g1', color: 'B' };
        abort.abort();
      },
    };
    const slept: number[] = [];
    await streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, async (ms) => void slept.push(ms), () => 0).done;
    expect(slept).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
  it('сбрасывает паузу только после соединения, прожившего 15 с, а не на первом событии', async () => {
    const abort = new AbortController();
    let t = 0;
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 4) {
          abort.abort();
          return;
        }
        if (connects === 3) t += STABLE_CONNECTION_MS;
        yield { type: 'session.game', gameId: 'g1' }; // sync и сразу обрыв — не повод сбрасывать паузу
        throw new TypeError('network error');
      },
    };
    const slept: number[] = [];
    await streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, async (ms) => void slept.push(ms), () => t).done;
    expect(slept).toEqual([1000, 2000, 1000]);
  });
  it('rate_limited: пауза по Retry-After, «Повторить» раньше срока не переоткрывает (D-0012)', async () => {
    const abort = new AbortController();
    let t = 0;
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) throw new ApiError('rate_limited', 'too many requests, retry in 30 s', { retryAfterSeconds: 30 });
        yield { type: 'session.game', gameId: 'g1' };
        abort.abort();
      },
    };
    const slept: number[] = [];
    // Управляемая пауза: тест ждёт её начала по сигналу, без реальных таймеров.
    let paused: () => void = () => {};
    const pauseStarted = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const handle = streamEvents(
      client,
      's1',
      abort.signal,
      { onEvent: () => {}, onLost: () => {} },
      (ms) => {
        slept.push(ms);
        paused();
        return new Promise<void>(() => {}); // пауза, которая сама не кончится
      },
      () => t,
    );
    await pauseStarted;
    expect(slept).toEqual([30_000]);
    handle.reopen(); // раньше Retry-After — ничего
    // Макрозадача, а не одна микрозадача: если бы reopen сработал, цепочка от пробуждения до нового соединения
    // успела бы пройти, и connects стал бы 2.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(connects).toBe(1);
    t = 30_000;
    handle.reopen();
    await handle.done;
    expect(connects).toBe(2);
  });
  it('not_found — сессия истекла: onLost и выход без повторов', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        throw new ApiError('not_found', 'session not found');
      },
    };
    let lost = 0;
    const slept: number[] = [];
    // Пауза останавливает поток: без выхода после onLost тест упадёт на проверках, а не зависнет.
    const pause = async (ms: number): Promise<void> => {
      slept.push(ms);
      abort.abort();
    };
    await streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => lost++ }, pause, () => 0).done;
    expect(lost).toBe(1);
    expect(slept).toEqual([]);
    expect(connects).toBe(1);
  });
  it('not_found во время reopen — сразу onLost, без переоткрытия', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) yield { type: 'session.game', gameId: 'g1' };
        throw new ApiError('not_found', 'session not found');
      },
    };
    let lost = 0;
    const slept: number[] = [];
    let handle: StreamHandle | null = null;
    const pause = async (ms: number): Promise<void> => {
      slept.push(ms);
      abort.abort();
    };
    // reopen из onEvent: следующий шаг потока уже отвечает not_found.
    handle = streamEvents(client, 's1', abort.signal, { onEvent: () => handle?.reopen(), onLost: () => lost++ }, pause, () => 0);
    await handle.done;
    expect(lost).toBe(1);
    expect(connects).toBe(1);
    expect(slept).toEqual([]);
  });
  it('исключение в onEvent и onConnected — не обрыв сети: поток не переподключается, ошибка в консоли', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        yield { type: 'session.game', gameId: 'g1' };
        yield { type: 'engine.thinking', gameId: 'g1', color: 'W' };
        abort.abort();
      },
    };
    const got: string[] = [];
    const slept: number[] = [];
    const handlers = {
      onEvent: (ev: GameEvent) => {
        got.push(ev.type);
        throw new Error(`render failed on ${ev.type}`);
      },
      onConnected: () => {
        throw new Error('connected handler failed');
      },
      onLost: () => {},
    };
    const pause = async (ms: number): Promise<void> => {
      slept.push(ms);
      abort.abort();
    };
    await expect(streamEvents(client, 's1', abort.signal, handlers, pause, () => 0).done).resolves.toBeUndefined();
    expect(got).toEqual(['session.game', 'engine.thinking']);
    expect(connects).toBe(1);
    expect(slept).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(3);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('onConnected'),
      expect.stringContaining('onEvent'),
      expect.stringContaining('onEvent'),
    ]);
  });
  it('исключение в onConnected(false) и onLost не отклоняет done', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) throw new TypeError('network error');
        throw new ApiError('not_found', 'session not found');
      },
    };
    const slept: number[] = [];
    let lost = 0;
    const handlers = {
      onEvent: () => {},
      onConnected: () => {
        throw new Error('connected handler failed');
      },
      onLost: () => {
        lost++;
        throw new Error('lost handler failed');
      },
    };
    const pause = async (ms: number): Promise<void> => {
      slept.push(ms);
      if (slept.length > 1) abort.abort();
    };
    await expect(streamEvents(client, 's1', abort.signal, handlers, pause, () => 0).done).resolves.toBeUndefined();
    expect(slept).toEqual([1000]);
    expect(connects).toBe(2);
    expect(lost).toBe(1);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining('onConnected'), expect.stringContaining('onLost')]);
  });
  it('reopen на живом потоке (кнопка «Повторить», D-0006): закрывает соединение и сразу открывает новое', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(_target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) {
          yield { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'engine move retries exhausted' };
          await untilAborted(signal);
        }
        yield { type: 'session.game', gameId: 'g1' };
        abort.abort();
      },
    };
    const got: string[] = [];
    const conn: boolean[] = [];
    const slept: number[] = [];
    // Сигнал о первом событии вместо ожидания на реальных таймерах.
    let received: () => void = () => {};
    const firstEvent = new Promise<void>((resolve) => {
      received = resolve;
    });
    const onEvent = (ev: GameEvent) => {
      got.push(ev.type);
      received();
    };
    const handle = streamEvents(client, 's1', abort.signal, { onEvent, onConnected: (c) => conn.push(c), onLost: () => got.push('LOST') }, async (ms) => void slept.push(ms));
    await firstEvent;
    expect(got).toEqual(['error']);
    handle.reopen();
    await handle.done;
    expect(got).toEqual(['error', 'session.game']);
    expect(connects).toBe(2);
    expect(slept).toEqual([]);
    expect(conn).toEqual([true, true]);
  });
  it('reopen во время паузы между попытками не ждёт конца паузы', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects === 1) throw new TypeError('network error');
        yield { type: 'session.game', gameId: 'g1' };
        abort.abort();
      },
    };
    const slept: number[] = [];
    const handle = streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, (ms) => {
      slept.push(ms);
      handle.reopen();
      return new Promise<void>(() => {}); // пауза, которая сама не кончится
    });
    await handle.done;
    expect(slept).toEqual([RETRY_MS[0]]);
    expect(connects).toBe(2);
  });
  it('reopen в паузе сбрасывает ступень: следующий обрыв — снова с первой паузы', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        throw new TypeError('network error');
      },
    };
    const slept: number[] = [];
    const pause = (ms: number): Promise<void> => {
      slept.push(ms);
      if (slept.length === 2) {
        handle.reopen();
        return new Promise<void>(() => {}); // пауза, которая сама не кончится
      }
      if (slept.length === 3) abort.abort();
      return Promise.resolve();
    };
    const handle = streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, pause, () => 0);
    await handle.done;
    expect(slept).toEqual([1000, 2000, 1000]);
    expect(connects).toBe(3);
  });
  it('reopen на живом потоке сбрасывает ступень паузы', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(_target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        if (connects !== 3) throw new TypeError('network error');
        yield { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'engine move retries exhausted' };
        await untilAborted(signal);
      },
    };
    const slept: number[] = [];
    let handle: StreamHandle | null = null;
    const onEvent = () => handle?.reopen();
    handle = streamEvents(client, 's1', abort.signal, { onEvent, onLost: () => {} }, async (ms) => {
      slept.push(ms);
      if (slept.length === 3) abort.abort();
    }, () => 0);
    await handle.done;
    expect(slept).toEqual([1000, 2000, 1000]);
    expect(connects).toBe(4);
  });
  it('остановка во время паузы завершает поток, не дожидаясь конца паузы', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        throw new TypeError('network error');
      },
    };
    const pause = (): Promise<void> => {
      abort.abort();
      return new Promise<void>(() => {}); // пауза, которая сама не кончится
    };
    await streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, pause).done;
    expect(connects).toBe(1);
  });
  it('reopen после остановки ничего не делает', async () => {
    const abort = new AbortController();
    let connects = 0;
    const client = {
      async *events(_target: EventsTarget, signal?: AbortSignal): AsyncGenerator<GameEvent, void, undefined> {
        connects++;
        await untilAborted(signal);
      },
    };
    const handle = streamEvents(client, 's1', abort.signal, { onEvent: () => {}, onLost: () => {} }, async () => {});
    abort.abort();
    handle.reopen();
    await handle.done;
    expect(connects).toBe(1);
  });
});

describe('needsRetry', () => {
  it('«Повторить» видна после retries_exhausted и до следующего состояния партии', () => {
    const exhausted: GameEvent = { type: 'error', gameId: 'g1', code: 'retries_exhausted', message: 'engine move retries exhausted' };
    const other: GameEvent = { type: 'error', gameId: 'g1', code: 'engine_unavailable', message: 'engine is down' };
    expect(needsRetry(false, exhausted)).toBe(true);
    expect(needsRetry(true, other)).toBe(true);
    expect(needsRetry(false, other)).toBe(false);
    expect(needsRetry(true, { type: 'engine.thinking', gameId: 'g1', color: 'W' })).toBe(true);
    expect(needsRetry(true, { type: 'session.game', gameId: 'g2' })).toBe(false);
  });
  it('state.updated (в том числе sync после переоткрытия) прячет «Повторить»', () => {
    const state: GameState = {
      id: 'g1',
      createdAt: 't',
      revision: 1,
      settings: { boardSize: 13, rules: 'chinese', komi: 7.5 },
      seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } },
      status: 'playing',
      toPlay: 'W',
      moves: [],
      board: '.'.repeat(169),
      captures: { B: 0, W: 0 },
      ko: null,
      consecutivePasses: 0,
      pendingEngineMove: true,
      canRedo: false,
    };
    expect(needsRetry(true, { type: 'state.updated', state, cause: 'sync', by: 'system' })).toBe(false);
  });
});
