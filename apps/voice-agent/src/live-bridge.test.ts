import { describe, expect, it, vi } from 'vitest';
import { IntentLedger } from './intent.ts';
import { LiveBridge } from './live-bridge.ts';

describe('LiveBridge', () => {
  it('фоновый контекст объединяет снимки и не запускает речь или ответ backend',async()=>{
    let release!:()=>void;const events:Array<Record<string,unknown>>=[];const thinking=vi.fn(),commentary=vi.fn(),wait=vi.fn();
    const bridge=new LiveBridge({live:{sendEvent:e=>events.push(e),appendThinking:thinking,appendCommentary:commentary},intent:new IntentLedger(),waitUntilReady:()=>new Promise<void>(r=>{release=r}),waitForReply:wait});
    bridge.context({compact:'old',detailed:'old board',current:()=>false});
    await vi.waitFor(()=>expect(release).toBeDefined());
    bridge.context({compact:'new',detailed:'new board',current:()=>true});release();
    await vi.waitFor(()=>expect(thinking).toHaveBeenCalledWith('new'));
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({type:'session.update'});
    expect(JSON.stringify(events)).toContain('new board');expect(JSON.stringify(events)).not.toContain('old board');
    expect(commentary).not.toHaveBeenCalled();expect(wait).not.toHaveBeenCalled();
  });
  it('typed turn отправляет официальный item.create перед response.create и регистрирует точный intent', async () => {
    const events: unknown[] = [];
    const ledger = new IntentLedger();
    const bridge = new LiveBridge({
      live: { sendEvent: (event) => events.push(event), appendThinking: vi.fn(), appendCommentary: vi.fn() },
      intent: ledger,
      waitForReply: async () => {},
    });
    await bridge.typed('D4', 'stream-1');
    expect(events).toEqual([
      { type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'D4' }] } },
      { type: 'response.create' },
    ]);
    await expect(ledger.consume('play_move', 'D4', { coord: 'D4' }, 0)).resolves.toMatchObject({ ok: true });
  });

  it('не начинает второй typed turn, пока первый ответ не завершён', async () => {
    const events: Array<Record<string, unknown>> = [];
    const releases: Array<() => void> = [];
    const bridge = new LiveBridge({
      live: { sendEvent: (event) => events.push(event), appendThinking: vi.fn(), appendCommentary: vi.fn() },
      intent: new IntentLedger(),
      waitForReply: () => new Promise<void>((resolve) => releases.push(resolve)),
    });
    const first = bridge.typed('первый', '1');
    const second = bridge.typed('второй', '2');
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[0]).toMatchObject({ item: { content: [{ text: 'первый' }] } });
    releases.shift()?.();
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events[2]).toMatchObject({ item: { content: [{ text: 'второй' }] } });
    releases.shift()?.();
    await Promise.all([first, second]);
  });

  it('событие партии добавляет silent context и commentary без чужого response.create', async () => {
    const calls: string[] = [];
    const bridge = new LiveBridge({
      live: {
        sendEvent: (event) => calls.push(String(event.type)),
        appendThinking: (text) => calls.push(`thinking:${text}`),
        appendCommentary: (text) => calls.push(`commentary:${text}`),
      },
      intent: new IntentLedger(),
      waitForReply: async () => {},
    });
    await bridge.commentary('скажи D4', 'Событие с экрана: D4');
    expect(calls).toEqual(['thinking:Событие с экрана: D4', 'commentary:скажи D4']);
  });

  it('greeting передаёт одноразовую полную просьбу только через commentary', async () => {
    const calls: string[] = [];
    const bridge = new LiveBridge({
      live: { sendEvent: (event) => calls.push(String(event.type)), appendThinking: vi.fn(), appendCommentary: (text) => calls.push(`commentary:${text}`) },
      intent: new IntentLedger(),
      waitForReply: async () => {},
    });
    await bridge.greet('Поздоровайся немедленно');
    expect(calls).toEqual(['commentary:Поздоровайся немедленно\nЭто одноразовая просьба: начни разговор сейчас, поздоровайся немедленно и затем слушай человека.']);
  });

  it('проверяет guard после ожидания очереди и не создаёт waiter для устаревшего события', async () => {
    const release: Array<() => void> = [];
    let current = true;
    let replies = 0;
    const commentary = vi.fn();
    const bridge = new LiveBridge({
      live: { sendEvent: vi.fn(), appendThinking: vi.fn(), appendCommentary: commentary },
      intent: new IntentLedger(),
      waitForReply: () => { replies += 1; return new Promise<void>((resolve) => release.push(resolve)); },
    });
    const first = bridge.commentary('первое');
    const stale = bridge.commentary('устаревшее', undefined, () => current);
    await vi.waitFor(() => expect(replies).toBe(1));
    current = false;
    release.shift()?.();
    await Promise.all([first, stale]);
    expect(replies).toBe(1);
    expect(commentary).toHaveBeenCalledTimes(1);
  });
});
