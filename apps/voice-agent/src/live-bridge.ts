import { IntentLedger } from './intent.ts';
import { BACKEND_INSTRUCTIONS } from './prompt.ts';

export type LiveWire = {
  sendEvent(event: Record<string, unknown>): void;
  appendThinking(text: string): void;
  appendCommentary(text: string): void;
};

export class LiveBridge {
  private latestContext: import('./board-awareness.ts').BoardContext | null = null;
  private contextPending = false;
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

  context(value: import('./board-awareness.ts').BoardContext): void {
    this.latestContext=value;
    if(this.contextPending) return;
    this.contextPending=true;
    const run=this.tail.then(async()=>{
      await this.deps.waitUntilReady();
      const value=this.latestContext;this.latestContext=null;
      if(!value?.current()) return;
      this.deps.live.appendThinking(value.compact);
      this.deps.live.sendEvent({type:'session.update',session:{delegation:{type:'responses',responses:{instructions:BACKEND_INSTRUCTIONS+'\n\n'+value.detailed}}}});
    });
    this.tail=run.catch(()=>{}).finally(()=>{this.contextPending=false;if(this.latestContext)this.context(this.latestContext);});
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
