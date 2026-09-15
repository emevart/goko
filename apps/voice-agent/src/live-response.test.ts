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
    coordinator.noteAgentState('speaking');
    coordinator.noteAssistant();
    coordinator.noteAgentState('listening');
    await waiting;
    expect(idle).toBe(true);
    coordinator.stop();
  });

  it('коррелирует waiter с первым response.created и ждёт его transcript + listening', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100, nativeSettleMs: 1 });
    const reply = coordinator.waitForReply();
    live.server(response('response.created', null));
    live.server(response('response.output_text.delta', null));
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

  it('filler до backend content не завершает typed waiter и не выпускает следующее событие', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100 });
    const reply = coordinator.waitForReply();
    live.server(response('response.created', null));
    coordinator.noteAssistant('[sigh]');
    coordinator.noteAgentState('listening');
    live.server(response('response.output_text.done', null));
    live.server(response('response.completed', null));
    let done = false;
    void reply.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    coordinator.noteAgentState('speaking');
    coordinator.noteAssistant();
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
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100, nativeSettleMs: 1 });
    coordinator.noteUserState('speaking');
    const idle = coordinator.waitUntilIdle();
    coordinator.noteUserState('listening');
    await expect(idle).resolves.toBeUndefined();
    coordinator.stop();
  });

  it('speaking → user listening остаётся занятым до assistant + позднего agent listening', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100, nativeSettleMs: 50 });
    coordinator.noteUserState('speaking');
    coordinator.noteUserState('listening');
    let ready = false;
    const waiting = coordinator.waitUntilIdle().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    coordinator.noteAgentState('speaking');
    coordinator.noteAssistant();
    expect(ready).toBe(false);
    coordinator.noteAgentState('listening');
    await waiting;
    expect(ready).toBe(true);
    coordinator.stop();
  });

  it('не принимает хвост прерванного ответа за ответ на новую barge-in реплику', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100, nativeSettleMs: 50 });
    coordinator.noteAgentState('speaking');
    coordinator.noteUserState('speaking');
    coordinator.noteAssistant(); // partial старого ответа во время речи человека
    coordinator.noteAgentState('listening');
    coordinator.noteUserState('listening');
    let ready = false;
    const waiting = coordinator.waitUntilIdle().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    coordinator.noteAgentState('speaking');
    coordinator.noteAssistant();
    coordinator.noteAgentState('listening');
    await waiting;
    expect(ready).toBe(true);
    coordinator.stop();
  });

  it('seed текущего speaking после start не даёт приветствию пройти до listening', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100, nativeSettleMs: 1 });
    coordinator.noteUserState('speaking');
    let ready = false;
    const waiting = coordinator.waitUntilIdle().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    coordinator.noteUserState('listening');
    await waiting;
    expect(ready).toBe(true);
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

  it('away после тишины не блокирует новую typed реплику', async () => {
    const live = new FakeLive();
    const coordinator = new LiveResponseCoordinator({ live, signal: new AbortController().signal, timeoutMs: 100 });
    coordinator.noteUserState('away');
    await expect(coordinator.waitUntilIdle()).resolves.toBeUndefined();
    coordinator.stop();
  });
});
