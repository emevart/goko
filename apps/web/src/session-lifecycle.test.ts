import { describe, expect, it, vi } from 'vitest';
import { ConversationEndBarrier, ConversationRestart, SessionGate, preflightVoice, publishGestureTrack, voiceFailureMode, waitForAgentReady } from './session-lifecycle.ts';

describe('явный запуск разговора', () => {
  it('объединяет параллельный первый текст и запуск доски в одну создаваемую сессию', async () => {
    let release!: (value: string) => void;
    const create = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const gate = new SessionGate(create);
    const text = gate.ensure();
    const board = gate.ensure();
    expect(create).toHaveBeenCalledOnce();
    release('session-1');
    await expect(Promise.all([text, board])).resolves.toEqual(['session-1', 'session-1']);
  });

  it('после отказа создания разрешает явную повторную попытку', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('session-2');
    const gate = new SessionGate(create);
    await expect(gate.ensure()).rejects.toThrow('offline');
    await expect(gate.ensure()).resolves.toBe('session-2');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('ждёт готовности агента ограниченно и отвергает результат старого поколения', async () => {
    vi.useFakeTimers();
    let ready = false;
    let notify = () => {};
    const waiting = waitForAgentReady(() => ready, (fn) => ((notify = fn), () => {}), () => true, 1000);
    ready = true;
    notify();
    await expect(waiting).resolves.toBe(true);

    const stale = waitForAgentReady(() => true, () => () => {}, () => false, 1000);
    await expect(stale).resolves.toBe(false);

    const timeout = waitForAgentReady(() => false, () => () => {}, () => true, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(timeout).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('End немедленно прекращает ожидание агента и снимает listener', async () => {
    const abort = new AbortController();
    const unsubscribe = vi.fn();
    const waiting = waitForAgentReady(() => false, () => unsubscribe, () => true, 8000, abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('запрашивает audio unlock и разрешение микрофона до сетевого продолжения', async () => {
    const order: string[] = [];
    let release!: () => void;
    const pending = preflightVoice(
      () => { order.push('audio'); },
      () => { order.push('permission'); return new Promise<null>((resolve) => (release = () => resolve(null))); },
    );
    order.push('network-may-start');
    expect(order).toEqual(['audio', 'permission', 'network-may-start']);
    release();
    await pending;
  });

  it('при отказе любой ветки preflight дожидается второй и освобождает уже полученный stream', async () => {
    const stream = { stop: vi.fn() };
    await expect(preflightVoice(() => { throw new Error('audio'); }, async () => stream, (value) => value.stop())).rejects.toThrow('audio');
    expect(stream.stop).toHaveBeenCalledOnce();
    await expect(preflightVoice(async () => {}, async () => { throw new Error('mic'); }, vi.fn())).rejects.toThrow('mic');
  });

  it('mic failure сохраняет явно начатый параллельный чат, а без него возвращает idle', () => {
    expect(voiceFailureMode(false, true)).toBe('chat');
    expect(voiceFailureMode(true, false)).toBe('chat');
    expect(voiceFailureMode(false, false)).toBe('idle');
  });

  it('передаёт LiveKit исходный gesture track, а stale и publish failure останавливают его ровно раз', async () => {
    const live = { stop: vi.fn() };
    const publish = vi.fn(async (track: typeof live) => ({ track }));
    await expect(publishGestureTrack(live, publish, vi.fn(async () => {}), () => true)).resolves.toMatchObject({ track: live });
    expect(publish).toHaveBeenCalledWith(live);
    expect(live.stop).not.toHaveBeenCalled();

    const stale = { stop: vi.fn() };
    const unpublish = vi.fn(async () => {});
    await expect(publishGestureTrack(stale, async () => ({ ok: true }), unpublish, () => false)).resolves.toBeNull();
    expect(unpublish).toHaveBeenCalledOnce();
    expect(stale.stop).toHaveBeenCalledOnce();

    const failed = { stop: vi.fn() };
    await expect(publishGestureTrack(failed, async () => { throw new Error('publish'); }, vi.fn(), () => true)).rejects.toThrow('publish');
    expect(failed.stop).toHaveBeenCalledOnce();
  });
});

describe('перезапуск завершённого разговора', () => {
  it('новый Start делает gesture preflight сразу, но ждёт полного cleanup старого End до сети', async () => {
    let release!: () => void;
    const barrier = new ConversationEndBarrier();
    const order: string[] = [];
    const ending = barrier.begin(() => new Promise<void>((resolve) => { release = () => { order.push('end-clean'); resolve(); }; }));
    order.push('gesture');
    const starting = barrier.wait().then(() => order.push('network'));
    expect(order).toEqual(['gesture']);
    release();
    await Promise.all([ending, starting]);
    expect(order).toEqual(['gesture', 'end-clean', 'network']);
  });

  it('после End делает один restart с устойчивым requestId и сохраняет session/game', async () => {
    const restart = new ConversationRestart(() => 'restart-1');
    const info = { session: { id: 's1', currentGameId: 'g1' }, livekit: { token: 'old' } };
    restart.ended('s1');
    const call = vi.fn(async (_sid: string, request: { requestId: string }) => ({ ...info, livekit: { token: request.requestId } }));
    const [a, b] = await Promise.all([restart.prepare(info, call), restart.prepare(info, call)]);
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('s1', { requestId: 'restart-1' });
    expect(a.session.currentGameId).toBe('g1');
    expect(b.livekit.token).toBe('restart-1');
  });

  it('после сетевого отказа повторяет тот же requestId', async () => {
    const restart = new ConversationRestart(() => 'restart-stable');
    const info = { session: { id: 's1' }, livekit: { token: 'old' } };
    restart.ended('s1');
    const call = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...info, livekit: { token: 'fresh' } });
    await expect(restart.prepare(info, call)).rejects.toThrow('offline');
    await expect(restart.prepare(info, call)).resolves.toMatchObject({ livekit: { token: 'fresh' } });
    expect(call.mock.calls.map((args) => args[1])).toEqual([{ requestId: 'restart-stable' }, { requestId: 'restart-stable' }]);
  });

  it('End во время restart не позволяет старому ответу снять marker нового поколения', async () => {
    let resolve!: (value: { session: { id: string }; livekit: { token: string } }) => void;
    const restart = new ConversationRestart(() => `r-${Math.random()}`);
    const info = { session: { id: 's1' }, livekit: { token: 'old' } };
    restart.ended('s1');
    const pending = restart.prepare(info, () => new Promise((done) => (resolve = done)));
    restart.ended('s1');
    resolve({ ...info, livekit: { token: 'stale' } });
    await pending;
    expect(restart.needs('s1')).toBe(true);
  });
});
