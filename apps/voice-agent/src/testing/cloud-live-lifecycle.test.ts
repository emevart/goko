import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { ProbeLifecycle } from './cloud-live-lifecycle.ts';
afterEach(()=>vi.useRealTimers());
it('timers installed before hanging start; provider closes synchronously before agent', async()=>{
  vi.useFakeTimers(); const order:string[]=[]; const abort=new AbortController();
  const lifecycle=new ProbeLifecycle({abort,closeAgent:()=>{order.push('agent');return Promise.resolve();},closeTransport:()=>order.push('transport'),startTimeoutMs:10,workMs:80,closeMs:5});
  lifecycle.attach({close:()=>{order.push('provider');return Promise.resolve();}} as never);
  const start=lifecycle.start(()=>{expect(vi.getTimerCount()).toBe(2);return new Promise<void>(()=>{});}).catch(()=>{});
  await vi.advanceTimersByTimeAsync(10); await start; await lifecycle.close();
  expect(order).toEqual(['provider','agent','transport']);expect(abort.signal.aborted).toBe(true);
});
it('early raw session.closed stops clean reconnect before provider continuation',async()=>{
  vi.useFakeTimers();const provider=Object.assign(new EventEmitter(),{closing:false,close(){this.closing=true;return Promise.resolve();}});
  const lifecycle=new ProbeLifecycle({abort:new AbortController(),closeAgent:async()=>{},closeTransport:()=>{},startTimeoutMs:10,workMs:80,closeMs:5});
  lifecycle.attach(provider as never);
  provider.emit('openai_server_event_received',{type:'session.closed'});
  expect(provider.closing).toBe(true);expect(()=>lifecycle.attach(provider as never)).toThrow('CLOUD_PROVIDER_USED');
  expect(lifecycle.signal.aborted).toBe(true);await lifecycle.close();
});
it('failed start and hanging provider close are bounded and cannot report clean closure',async()=>{
  vi.useFakeTimers(); const lifecycle=new ProbeLifecycle({abort:new AbortController(),closeAgent:async()=>{},closeTransport:()=>{},startTimeoutMs:10,workMs:80,closeMs:5});
  lifecycle.attach({close:()=>new Promise<void>(()=>{})} as never);
  await expect(lifecycle.start(()=>Promise.reject(new Error('private raw message')))).rejects.toThrow('CLOUD_START_FAILED');
  const close=lifecycle.close();await vi.advanceTimersByTimeAsync(5);
  expect(await close).toBe(false);expect(lifecycle.signal.aborted).toBe(true);
});
