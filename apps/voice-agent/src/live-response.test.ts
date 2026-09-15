import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { LiveResponseCoordinator, type LiveServerEvent } from './live-response.ts';

class FakeLive extends EventEmitter {
  server(event: LiveServerEvent) { this.emit('openai_server_event_received', event); }
}
const response = (type: string, delegation_id: string | null = 'd1', item?: { type: string }) =>
  ({ type: 'response.event', delegation_id, event: { type, item } } satisfies LiveServerEvent);

describe('LiveResponseCoordinator', () => {
  it('держит очередь через function call и освобождает лишь после финального продолжения', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100 });
    coordinator.noteUserState('speaking');
    live.server(response('response.created'));
    live.server(response('response.output_item.done', 'd1', { type: 'function_call' }));
    live.server(response('response.completed'));
    coordinator.noteUserState('listening');
    let idle = false;
    const waiting = coordinator.waitUntilIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    live.server(response('response.created'));
    live.server(response('response.completed'));
    await waiting;
    expect(idle).toBe(true);
    coordinator.stop();
  });

  it('коррелирует waiter с первым response.created и ждёт его transcript + listening', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100 });
    const reply = coordinator.waitForReply();
    live.server(response('response.created', null));
    live.server(response('response.completed', null));
    coordinator.noteAssistant();
    let done = false;
    void reply.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    coordinator.noteAgentState('listening');
    await reply;
    expect(done).toBe(true);
    coordinator.stop();
  });

  it('voice commentary завершается по своему assistant item + playout без Responses backend', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100 });
    const reply = coordinator.waitForReply('voice');
    coordinator.noteAgentState('speaking');
    coordinator.noteAssistant();
    coordinator.noteAgentState('listening');
    await expect(reply).resolves.toBeUndefined();
    coordinator.stop();
  });

  it('короткий голосовой ввод без delegation не оставляет sticky busy', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100 });
    coordinator.noteUserState('speaking');
    const idle = coordinator.waitUntilIdle();
    coordinator.noteUserState('listening');
    await expect(idle).resolves.toBeUndefined();
    coordinator.stop();
  });

  it('response.failed отклоняет только связанный waiter', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100 });
    const reply = coordinator.waitForReply();
    live.server(response('response.created', 'ours'));
    live.server(response('response.failed', 'ours'));
    await expect(reply).rejects.toThrow('response.failed');
    coordinator.stop();
  });

  it('уже отменённый сигнал немедленно отклоняет idle и reply fences', async () => {
    const live = new FakeLive();
    const abort = new AbortController();
    abort.abort(new Error('ended'));
    const coordinator = new LiveResponseCoordinator({ live, signal: abort.signal, timeoutMs: 100 });
    await expect(coordinator.waitUntilIdle()).rejects.toThrow('ended');
    await expect(coordinator.waitForReply()).rejects.toThrow('ended');
    coordinator.stop();
  });
});
