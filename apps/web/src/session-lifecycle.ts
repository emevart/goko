// Небольшие примитивы явного запуска вынесены из React-хука, чтобы гонки жизненного цикла проверялись без DOM.
export class SessionGate<T> {
  private pending: Promise<T> | null = null;
  private value: T | null = null;
  private readonly create: () => Promise<T>;

  constructor(create: () => Promise<T>) {
    this.create = create;
  }

  seed(value: T | null) {
    this.value = value;
    if (!value) this.pending = null;
  }

  ensure(): Promise<T> {
    if (this.value) return Promise.resolve(this.value);
    if (this.pending) return this.pending;
    this.pending = this.create().then((value) => {
      this.value = value;
      return value;
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
}

export class ConversationRestart {
  private endedSessionId: string | null = null;
  private requestId: string | null = null;
  private pending: { version: number; promise: Promise<unknown> } | null = null;
  private version = 0;
  private readonly newRequestId: () => string;

  constructor(newRequestId: () => string) {
    this.newRequestId = newRequestId;
  }

  ended(sessionId: string) {
    this.version++;
    this.requestId = null;
    this.endedSessionId = sessionId;
  }

  needs(sessionId: string): boolean {
    return this.endedSessionId === sessionId;
  }

  async prepare<T extends { session: { id: string } }>(
    info: T,
    restart: (sessionId: string, request: { requestId: string }) => Promise<T>,
  ): Promise<T> {
    if (!this.needs(info.session.id)) return info;
    this.requestId ??= this.newRequestId();
    const version = this.version;
    if (!this.pending || this.pending.version !== version) {
      const requestId = this.requestId;
      const promise = restart(info.session.id, { requestId }).then((fresh) => {
        if (this.version === version && this.endedSessionId === info.session.id && this.requestId === requestId) {
          this.endedSessionId = null;
          this.requestId = null;
        }
        return fresh;
      }).finally(() => {
        if (this.pending?.promise === promise) this.pending = null;
      });
      this.pending = { version, promise };
    }
    return this.pending.promise as Promise<T>;
  }
}

export class ConversationEndBarrier {
  private cleanup: Promise<void> = Promise.resolve();

  begin(run: () => Promise<void>): Promise<void> {
    const cleanup = run();
    this.cleanup = cleanup.then(() => {}, () => {});
    return cleanup;
  }

  wait(): Promise<void> {
    return this.cleanup;
  }
}

export function waitForAgentReady(
  ready: () => boolean,
  subscribe: (notify: () => void) => () => void,
  current: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!current() || signal?.aborted) return Promise.resolve(false);
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe = () => {};
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish(false);
    unsubscribe = subscribe(() => {
      if (!current()) finish(false);
      else if (ready()) finish(true);
    });
    timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (!current()) finish(false);
    else if (ready()) finish(true);
  });
}

export async function preflightVoice<T>(unlockAudio: () => void | Promise<void>, requestMicrophone: () => Promise<T>, cleanup: (value: T) => void = () => {}): Promise<T> {
  // Обе операции вызываются синхронно из обработчика жеста; сеть начинается вызывающей стороной только после await.
  let unlocked: Promise<void>;
  let permission: Promise<T>;
  try { unlocked = Promise.resolve(unlockAudio()); } catch (error) { unlocked = Promise.reject(error); }
  try { permission = requestMicrophone(); } catch (error) { permission = Promise.reject(error); }
  const [audioResult, permissionResult] = await Promise.allSettled([unlocked, permission]);
  if (audioResult.status === 'rejected' || permissionResult.status === 'rejected') {
    if (permissionResult.status === 'fulfilled') cleanup(permissionResult.value);
    throw (audioResult.status === 'rejected' ? audioResult.reason : permissionResult.status === 'rejected' ? permissionResult.reason : new Error('voice preflight failed'));
  }
  return permissionResult.value;
}

export async function publishGestureTrack<T extends { stop: () => void }, R>(
  track: T,
  publish: (track: T) => Promise<R>,
  unpublish: (track: T) => Promise<void>,
  current: () => boolean,
): Promise<R | null> {
  try {
    const publication = await publish(track);
    if (current()) return publication;
    await unpublish(track).catch(() => {});
    track.stop();
    return null;
  } catch (error) {
    track.stop();
    throw error;
  }
}

export const voiceFailureMode = (chatWasActive: boolean, chatRequestedSince: boolean, chatInFlight: boolean): 'chat' | 'idle' =>
  chatWasActive || chatRequestedSince || chatInFlight ? 'chat' : 'idle';
