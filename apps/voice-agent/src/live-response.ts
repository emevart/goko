export type LiveServerEvent = {
  type: string;
  delegation_id?: string | null;
  delegation?: { id?: string | null };
  event?: { type?: string; item?: { type?: string | null } | null };
};

export type LiveEventSource = {
  on(event: 'openai_server_event_received', listener: (event: LiveServerEvent) => void): unknown;
  off(event: 'openai_server_event_received', listener: (event: LiveServerEvent) => void): unknown;
};

type ResponseState = { hasCalls: boolean };
type Reply = {
  kind: 'backend' | 'voice';
  startAssistant: number;
  startListening: number;
  delegation?: string;
  backendContent: boolean;
  providerDone: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const keyOf = (id: string | null | undefined): string => id ?? '<none>';
const abortError = (signal: AbortSignal): unknown => signal.reason ?? new Error('session aborted');

// GPT Live может оставлять AgentSession в listening, пока backend Responses уже занят. Этот координатор
// следит за публичными response.event и не пускает app-реплику поверх голосовой/инструментальной.
export class LiveResponseCoordinator {
  private readonly options: { live: LiveEventSource; signal: AbortSignal; timeoutMs?: number; nativeSettleMs?: number };
  private readonly responses = new Map<string, ResponseState>();
  private readonly idleWaiters = new Set<{ resolve: () => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private reply: Reply | null = null;
  private userActive = false;
  private nativeTurnPending = false;
  private nativeSawAssistant = false;
  private nativePostStopOutput = false;
  private nativeTimer: ReturnType<typeof setTimeout> | null = null;
  private agentActive = false;
  private assistantVersion = 0;
  private listeningVersion = 0;

  constructor(options: { live: LiveEventSource; signal: AbortSignal; timeoutMs?: number; nativeSettleMs?: number }) {
    this.options = options;
    options.live.on('openai_server_event_received', this.onServerEvent);
  }

  noteUserState(state: string): void {
    this.userActive = state === 'speaking';
    if (state === 'speaking') {
      if (this.nativeTimer) clearTimeout(this.nativeTimer);
      this.nativeTimer = null;
      this.nativeTurnPending = true;
      this.nativeSawAssistant = false;
      this.nativePostStopOutput = false;
    } else if (state === 'listening' && this.nativeTurnPending && !this.nativeSawAssistant) {
      this.nativePostStopOutput = this.agentActive;
      if (this.nativeTimer) clearTimeout(this.nativeTimer);
      this.nativeTimer = setTimeout(() => {
        this.nativeTimer = null;
        if (!this.nativeSawAssistant) this.nativeTurnPending = false;
        this.notifyIdle();
      }, this.options.nativeSettleMs ?? 5_000);
    }
    this.notifyIdle();
  }

  noteAssistant(text?: string): void {
    if (text !== undefined && !text.replace(/\[(?:sigh|laugh|inhale|cough|exhale)\]/giu, '').trim()) return;
    this.assistantVersion += 1;
    if (this.nativeTurnPending && !this.userActive && this.nativePostStopOutput) {
      this.nativeSawAssistant = true;
      if (this.nativeTimer) clearTimeout(this.nativeTimer);
      this.nativeTimer = null;
    }
    this.maybeFinishReply();
  }

  noteAgentState(state: string): void {
    this.agentActive = state !== 'listening';
    if (state !== 'listening' && this.nativeTurnPending && !this.userActive) this.nativePostStopOutput = true;
    if (state === 'listening') this.listeningVersion += 1;
    if (state === 'listening' && this.nativeTurnPending && this.nativeSawAssistant) {
      this.nativeTurnPending = false;
      this.nativeSawAssistant = false;
      this.nativePostStopOutput = false;
    }
    this.maybeFinishReply();
    this.notifyIdle();
  }

  async waitUntilIdle(): Promise<void> {
    this.throwIfAborted();
    if (this.isIdle()) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { this.options.signal.removeEventListener('abort', onAbort); clearTimeout(waiter.timer); this.idleWaiters.delete(waiter); resolve(); },
        reject: (error: unknown) => { this.options.signal.removeEventListener('abort', onAbort); clearTimeout(waiter.timer); this.idleWaiters.delete(waiter); reject(error); },
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      const onAbort = () => waiter.reject(abortError(this.options.signal));
      waiter.timer = setTimeout(() => waiter.reject(new Error('GPT Live did not become idle within 60 seconds')), this.options.timeoutMs ?? 60_000);
      this.idleWaiters.add(waiter);
      this.options.signal.addEventListener('abort', onAbort, { once: true });
      if (this.options.signal.aborted) onAbort();
      else if (this.isIdle()) waiter.resolve();
    });
  }

  waitForReply(kind: 'backend' | 'voice' = 'backend'): Promise<void> {
    if (this.options.signal.aborted) return Promise.reject(abortError(this.options.signal));
    if (this.reply) return Promise.reject(new Error('GPT Live reply waiter already active'));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => finish(abortError(this.options.signal));
      const finish = (error?: unknown) => {
        const reply = this.reply;
        if (!reply) return;
        clearTimeout(reply.timer);
        this.options.signal.removeEventListener('abort', onAbort);
        this.reply = null;
        if (error) reject(error); else resolve();
      };
      this.reply = {
        kind,
        startAssistant: this.assistantVersion,
        startListening: this.listeningVersion,
        backendContent: kind === 'voice',
        providerDone: kind === 'voice',
        resolve: () => finish(),
        reject: (error) => finish(error),
        timer: setTimeout(() => finish(new Error('GPT Live reply did not finish within 60 seconds')), this.options.timeoutMs ?? 60_000),
      };
      this.options.signal.addEventListener('abort', onAbort, { once: true });
      if (this.options.signal.aborted) onAbort();
    });
  }

  stop(): void {
    this.options.live.off('openai_server_event_received', this.onServerEvent);
    const error = new Error('GPT Live coordinator stopped');
    if (this.nativeTimer) clearTimeout(this.nativeTimer);
    this.reply?.reject(error);
    for (const waiter of [...this.idleWaiters]) waiter.reject(error);
  }

  private throwIfAborted(): void {
    if (this.options.signal.aborted) throw abortError(this.options.signal);
  }

  private isIdle(): boolean {
    return !this.userActive && !this.nativeTurnPending && !this.agentActive && this.responses.size === 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    for (const waiter of [...this.idleWaiters]) waiter.resolve();
  }

  private maybeFinishReply(): void {
    const reply = this.reply;
    if (!reply || !reply.providerDone || !reply.backendContent) return;
    if (this.assistantVersion <= reply.startAssistant || this.listeningVersion <= reply.startListening) return;
    reply.resolve();
  }

  private readonly onServerEvent = (outer: LiveServerEvent): void => {
    if (outer.type === 'session.delegation.created') {
      this.responses.set(keyOf(outer.delegation?.id), { hasCalls: false });
      return;
    }
    if (outer.type !== 'response.event' || !outer.event?.type) return;
    const key = keyOf(outer.delegation_id);
    const event = outer.event;
    if (event.type === 'response.created') {
      this.responses.set(key, { hasCalls: false });
      if (this.reply && this.reply.delegation === undefined) this.reply.delegation = key;
      return;
    }
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const response = this.responses.get(key) ?? { hasCalls: false };
      response.hasCalls = true;
      this.responses.set(key, response);
      return;
    }
    if ((event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') && this.reply?.delegation === key) {
      this.reply.backendContent = true;
      return;
    }
    if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      this.responses.delete(key);
      if (this.reply?.delegation === key) this.reply.reject(new Error(`GPT Live ${event.type}`));
      this.notifyIdle();
      return;
    }
    if (event.type !== 'response.completed') return;
    const response = this.responses.get(key);
    if (response?.hasCalls) return;
    this.responses.delete(key);
    if (this.reply?.delegation === key) {
      // Filler может звучать всё время backend generation. Финальный completed — граница, после которой
      // ждём именно ConversationItem озвученного результата, а не «Секунду, сверюсь».
      this.reply.startAssistant = this.assistantVersion;
      this.reply.startListening = this.listeningVersion;
      this.reply.providerDone = true;
      this.maybeFinishReply();
    }
    this.notifyIdle();
  };
}
