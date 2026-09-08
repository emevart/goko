// Один процесс `katago analysis`: JSON-строки в stdin, ответы из stdout по id. Очередь с лимитом
// параллельности, таймауты с terminate, перезапуск с экспоненциальной паузой при падении.
import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export type KataProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  kill: () => void;
  on: (event: 'exit', cb: (code: number | null) => void) => void;
};

export type KataGoOptions = {
  bin: string;
  model: string;
  humanModel: string;
  config: string;
  maxConcurrent?: number;
  backoffMs?: number[];
  spawn?: (bin: string, args: string[]) => KataProcess;
  log?: (line: string) => void;
};

export type KataQuery = Record<string, unknown>;
export type KataResponse = Record<string, unknown> & { id: string };

export class KataGoError extends Error {
  readonly kind: 'crashed' | 'timeout' | 'rejected';

  constructor(kind: 'crashed' | 'timeout' | 'rejected', message: string) {
    super(message);
    this.name = 'KataGoError';
    this.kind = kind;
  }
}

type Pending = {
  id: string;
  query: KataQuery;
  timeoutMs: number;
  resolve: (r: KataResponse) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
};

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function defaultSpawn(bin: string, args: string[]): KataProcess {
  const child = nodeSpawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      child.kill();
    },
    on: (event, cb) => {
      child.on(event, cb);
    },
  };
}

export class KataGo {
  private proc: KataProcess | null = null;
  private readonly queue: Pending[] = [];
  private readonly inFlight = new Map<string, Pending>();
  private seq = 0;
  private restartCount = 0;
  private crashStreak = 0;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly opts: KataGoOptions;
  private readonly maxConcurrent: number;
  private readonly backoffMs: number[];

  constructor(opts: KataGoOptions) {
    this.opts = opts;
    this.maxConcurrent = opts.maxConcurrent ?? 1;
    this.backoffMs = opts.backoffMs ?? [...DEFAULT_BACKOFF_MS];
  }

  get alive(): boolean {
    return this.proc !== null;
  }

  // Длина очереди — всё незавершённое: и отправленное движку, и ждущее места.
  get queueLength(): number {
    return this.queue.length + this.inFlight.size;
  }

  get restarts(): number {
    return this.restartCount;
  }

  start(): void {
    if (this.proc || this.stopped) return;
    const spawnFn = this.opts.spawn ?? defaultSpawn;
    const args = [
      'analysis',
      '-config',
      this.opts.config,
      '-model',
      this.opts.model,
      '-human-model',
      this.opts.humanModel,
    ];
    const proc = spawnFn(this.opts.bin, args);
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr?.on('data', (chunk: Buffer) => this.opts.log?.(`[katago] ${String(chunk).trimEnd()}`));
    proc.on('exit', (code) => this.onExit(proc, code));
    this.pump();
  }

  query(query: KataQuery, timeoutMs = 30_000): Promise<KataResponse> {
    return new Promise((resolve, reject) => {
      // После stop() ждать некому: запрос отклоняется сразу, а не виснет в очереди навсегда.
      if (this.stopped) {
        reject(new KataGoError('crashed', 'katago stopped'));
        return;
      }
      const id = `q${++this.seq}`;
      this.queue.push({ id, query, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.stdin.end();
      proc.kill();
    }
    // Очередь чистится независимо от того, жив ли процесс: stop во время паузы
    // перезапуска тоже обязан отпустить всех ждущих.
    const err = new KataGoError('crashed', 'katago stopped');
    for (const p of [...this.inFlight.values(), ...this.queue]) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.inFlight.clear();
    this.queue.length = 0;
  }

  private pump(): void {
    while (this.proc && this.inFlight.size < this.maxConcurrent && this.queue.length) {
      const p = this.queue.shift();
      if (p === undefined) return; // длина очереди проверена выше, но сузить тип надо явно
      this.inFlight.set(p.id, p);
      p.timer = setTimeout(() => this.onTimeout(p), p.timeoutMs);
      this.proc.stdin.write(`${JSON.stringify({ id: p.id, ...p.query })}\n`);
    }
  }

  private onTimeout(p: Pending): void {
    if (!this.inFlight.delete(p.id)) return;
    this.proc?.stdin.write(`${JSON.stringify({ id: `t-${p.id}`, action: 'terminate', terminateId: p.id })}\n`);
    p.reject(new KataGoError('timeout', `katago query ${p.id} timed out after ${p.timeoutMs} ms`));
    this.pump();
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.opts.log?.(`[katago] non-json: ${line.slice(0, 200)}`);
      return;
    }
    const id = typeof msg.id === 'string' ? msg.id : undefined;
    if (id === undefined) {
      if (msg.error) this.opts.log?.(`[katago] error: ${String(msg.error)}`);
      return;
    }
    if (msg.action === 'terminate') return; // эхо нашего terminate
    if (msg.isDuringSearch === true) return;
    const p = this.inFlight.get(id);
    if (p === undefined) return; // ответ на уже отклонённый (таймаут) запрос
    if (msg.warning !== undefined && msg.error === undefined) {
      this.opts.log?.(`[katago] warning ${id}: ${String(msg.warning)} (${String(msg.field ?? '')})`);
      return; // предупреждение не завершает запрос: ответ придёт следом
    }
    this.inFlight.delete(id);
    clearTimeout(p.timer);
    this.crashStreak = 0; // движок ответил — следующее падение начинает паузы заново
    if (msg.error !== undefined) {
      const field = msg.field === undefined ? '' : ` (${String(msg.field)})`;
      p.reject(new KataGoError('rejected', `katago rejected ${id}: ${String(msg.error)}${field}`));
    } else {
      p.resolve({ ...msg, id });
    }
    this.pump();
  }

  private onExit(proc: KataProcess, code: number | null): void {
    if (this.proc !== proc) return; // выход процесса, которого мы уже отцепили
    this.proc = null;
    const err = new KataGoError('crashed', `katago exited with code ${code}`);
    // Отправленные запросы потеряны вместе с процессом; ждущие в очереди уйдут новому.
    for (const p of this.inFlight.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.inFlight.clear();
    // Проверки this.stopped здесь нет намеренно: stop() обнуляет this.proc до kill(),
    // поэтому выход остановленного процесса отсекается проверкой личности выше.
    const step = Math.min(this.crashStreak, this.backoffMs.length - 1);
    const delay = this.backoffMs[step] ?? 1000;
    this.crashStreak++;
    this.restartCount++;
    this.opts.log?.(`[!] katago exited (${code}); restart #${this.restartCount} in ${delay} ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }
}
