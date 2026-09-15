import { IntentLedger } from './intent.ts';

export type LiveWire = {
  sendEvent(event: Record<string, unknown>): void;
  appendThinking(text: string): void;
  appendCommentary(text: string): void;
};

export class LiveBridge {
  private tail: Promise<void> = Promise.resolve();
  private readonly deps: { live: LiveWire; intent: IntentLedger; waitUntilReady: () => Promise<void>; waitForReply: (kind: 'backend' | 'voice') => Promise<void> };

  constructor(deps: { live: LiveWire; intent: IntentLedger; waitUntilReady?: () => Promise<void>; waitForReply: (kind: 'backend' | 'voice') => Promise<void> }) {
    this.deps = { ...deps, waitUntilReady: deps.waitUntilReady ?? (async () => {}) };
  }

  private enqueue(kind: 'backend' | 'voice', send: () => void, guard?: () => boolean): Promise<void> {
    const run = this.tail.then(async () => {
      await this.deps.waitUntilReady();
      if (guard && !guard()) return;
      const reply = this.deps.waitForReply(kind);
      send();
      await reply;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  typed(text: string, eventId?: string | null): Promise<void> {
    this.deps.intent.add(text, eventId ? `item:${eventId}` : undefined);
    return this.enqueue('backend', () => {
      this.deps.live.sendEvent({
        type: 'response.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      });
      this.deps.live.sendEvent({ type: 'response.create' });
    });
  }

  commentary(instructions: string, context?: string, guard?: () => boolean): Promise<void> {
    return this.enqueue('voice', () => {
      if (context) this.deps.live.appendThinking(context);
      this.deps.live.appendCommentary(instructions);
    }, guard);
  }

  greet(instructions: string): Promise<void> {
    return this.enqueue('voice', () => {
      this.deps.live.appendCommentary(`${instructions}\nЭто одноразовая просьба: начни разговор сейчас, поздоровайся немедленно и затем слушай человека.`);
    });
  }
}
