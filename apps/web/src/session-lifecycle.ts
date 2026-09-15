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

export function waitForAgentReady(
  ready: () => boolean,
  subscribe: (notify: () => void) => () => void,
  current: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (!current()) return Promise.resolve(false);
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
      resolve(result);
    };
    unsubscribe = subscribe(() => {
      if (!current()) finish(false);
      else if (ready()) finish(true);
    });
    timer = setTimeout(() => finish(false), timeoutMs);
    if (!current()) finish(false);
    else if (ready()) finish(true);
  });
}

export async function preflightVoice<T>(unlockAudio: () => void | Promise<void>, requestMicrophone: () => Promise<T>): Promise<T> {
  // Обе операции вызываются синхронно из обработчика жеста; сеть начинается вызывающей стороной только после await.
  const unlocked = Promise.resolve(unlockAudio());
  const permission = requestMicrophone();
  await unlocked;
  return permission;
}
