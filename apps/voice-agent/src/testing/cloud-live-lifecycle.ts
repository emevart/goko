// Один provider на попытку. close вызывается до первого await: SDK иначе reconnect при session.closed.
type Provider = {
  close(): Promise<void>;
  on?(event: string, listener: (event: { type?: string }) => void): unknown;
};
type Options = { abort: AbortController; closeAgent: () => Promise<void>; closeTransport: () => void; startTimeoutMs?: number; workMs?: number; closeMs?: number };
export class ProbeLifecycle {
  readonly signal: AbortSignal;
  private readonly options: Options;
  private provider?: Provider;
  private providerClose?: Promise<void>;
  private closeTask?: Promise<boolean>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private workTimer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private factoryUsed = false;
  constructor(options: Options) { this.options = options; this.signal = options.abort.signal; }
  attach(provider: Provider): void {
    if (this.factoryUsed || this.closing) throw new Error('CLOUD_PROVIDER_USED');
    this.factoryUsed = true; this.provider = provider;
    provider.on?.('openai_server_event_received', event => {
      if (event.type === 'session.closed' || event.type === 'error') this.stop();
    });
    provider.on?.('error', () => this.stop());
    provider.on?.('session_reconnected', () => this.stop());
  }
  stop(): void {
    if (this.closing) return;
    this.closing = true;
    // Promise.resolve не откладывает сам provider.close на microtask.
    try { this.providerClose = this.provider?.close() ?? Promise.resolve(); }
    catch { this.providerClose = Promise.reject(new Error('CLOUD_PROVIDER_CLOSE_FAILED')); }
    this.providerClose.catch(() => {});
    this.options.abort.abort(new Error('CLOUD_PROBE_STOPPED'));
    clearTimeout(this.startTimer); clearTimeout(this.workTimer);
  }
  async start(start: () => Promise<void>): Promise<void> {
    if (this.closing) throw new Error('CLOUD_PROBE_STOPPED');
    const stopped = new Promise<never>((_resolve, reject) => {
      this.signal.addEventListener('abort', () => reject(new Error('CLOUD_START_FAILED')), { once: true });
    });
    this.startTimer = setTimeout(() => this.stop(), this.options.startTimeoutMs ?? 10_000);
    this.workTimer = setTimeout(() => this.stop(), this.options.workMs ?? 80_000);
    try { await Promise.race([start(), stopped]); clearTimeout(this.startTimer); }
    catch { this.stop(); throw new Error('CLOUD_START_FAILED'); }
  }
  close(): Promise<boolean> {
    if (this.closeTask) return this.closeTask;
    this.stop();
    this.closeTask = this.drain(); return this.closeTask;
  }
  private async drain(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Provider всегда первый; AgentSession.close сам provider не гарантирует.
      return await Promise.race([
        (async () => { await this.providerClose; await this.options.closeAgent(); return true; })(),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.options.closeMs ?? 5_000); }),
      ]);
    } catch { return false; }
    finally { clearTimeout(timer); this.options.closeTransport(); }
  }
}
