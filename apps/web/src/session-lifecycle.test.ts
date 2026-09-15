import { describe, expect, it, vi } from 'vitest';
import { SessionGate, preflightVoice, waitForAgentReady } from './session-lifecycle.ts';

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
});
