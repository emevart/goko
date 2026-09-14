export const RECORDING_MAX_MS = 20 * 60 * 1000;
export const RECORDING_STOP_BYTES = 64 * 1024 * 1024;
export const TRACE_MAX_EVENTS = 10_000;
export const TRACE_MAX_PAYLOAD_CHARS = 8_000;
export const TRACE_MAX_JSON_BYTES = 4 * 1024 * 1024;

export type RecordingStopReason = 'user' | 'duration' | 'size' | 'mode-off' | 'disconnect' | 'track-change' | 'error';
export type TraceEvent = { t: number; type: string; payload?: unknown };
export type RecorderTrack = Pick<MediaStreamTrack, 'id' | 'kind' | 'readyState' | 'clone' | 'stop'>;
export type RecorderLike = Pick<MediaRecorder, 'state' | 'mimeType' | 'start' | 'stop' | 'addEventListener' | 'removeEventListener'>;

export type RecordingResult = {
  startedAt: string;
  durationMs: number;
  totalBytes: number;
  stopReason: RecordingStopReason;
  partial: boolean;
  mic: { blob: Blob; url: string; mimeType: string; startOffsetMs: number };
  agent: { blob: Blob; url: string; mimeType: string; startOffsetMs: number };
  manifest: { blob: Blob; url: string };
};

export type RecordingSnapshot = {
  phase: 'idle' | 'recording' | 'stopping' | 'ready' | 'failed';
  startedAtMs: number | null;
  elapsedMs: number;
  bytes: number;
  error: string | null;
  result: RecordingResult | null;
};

type Deps = {
  now: () => number;
  createRecorder: (track: RecorderTrack, mimeType?: string) => RecorderLike;
  supported: (mimeType: string) => boolean;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer: (id: ReturnType<typeof setInterval>) => void;
};

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const encoder = new TextEncoder();

function defaults(): Deps {
  return {
    now: () => performance.now(),
    createRecorder: (track, mimeType) => {
      if (typeof MediaRecorder === 'undefined') throw new Error('браузер не поддерживает MediaRecorder');
      return new MediaRecorder(new MediaStream([track as MediaStreamTrack]), mimeType ? { mimeType } : undefined);
    },
    supported: (mimeType) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType),
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    setTimer: (fn, ms) => setInterval(fn, ms),
    clearTimer: (id) => clearInterval(id),
  };
}

type Side = { label: 'mic' | 'agent'; clone: RecorderTrack; recorder: RecorderLike; chunks: Blob[]; startOffsetMs: number; stopped: Promise<void>; resolveStopped: () => void };

export class DiagnosticRecorder {
  private readonly deps: Deps;
  private snapshot: RecordingSnapshot = { phase: 'idle', startedAtMs: null, elapsedMs: 0, bytes: 0, error: null, result: null };
  private listeners = new Set<(snapshot: RecordingSnapshot) => void>();
  private sides: Side[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private traceEvents: TraceEvent[] = [];
  private traceTruncated = false;
  private traceBytes = 2;
  private finishing: Promise<void> | null = null;
  private wallStartedAt = '';
  private readonly available: boolean;

  constructor(deps: Partial<Deps> = {}) {
    this.deps = { ...defaults(), ...deps };
    this.available = Boolean(deps.createRecorder || typeof MediaRecorder !== 'undefined');
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: (snapshot: RecordingSnapshot) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<RecordingSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  trace(type: string, payload?: unknown) {
    if (this.snapshot.phase !== 'recording') return;
    if (this.traceEvents.length >= TRACE_MAX_EVENTS) return void (this.traceTruncated = true);
    let safePayload = payload;
    if (payload !== undefined) {
      let json: string;
      try {
        json = JSON.stringify(payload);
      } catch {
        json = '"[не сериализуется]"';
        this.traceTruncated = true;
      }
      if (json.length > TRACE_MAX_PAYLOAD_CHARS) {
        safePayload = { truncated: true, preview: json.slice(0, TRACE_MAX_PAYLOAD_CHARS - 64) };
        this.traceTruncated = true;
      }
    }
    const event = { t: Math.max(0, this.deps.now() - (this.snapshot.startedAtMs ?? this.deps.now())), type, ...(safePayload === undefined ? {} : { payload: safePayload }) };
    const eventBytes = encoder.encode(JSON.stringify(event)).byteLength + 1;
    if (this.traceBytes + eventBytes > TRACE_MAX_JSON_BYTES) return void (this.traceTruncated = true);
    this.traceBytes += eventBytes;
    this.traceEvents.push(event);
  }

  async start(mic: RecorderTrack | null, agent: RecorderTrack | null) {
    if (this.snapshot.phase === 'recording' || this.snapshot.phase === 'stopping') throw new Error('запись уже идёт');
    if (this.snapshot.result) throw new Error('сначала удалите предыдущую несохранённую запись');
    if (!this.available) throw new Error('браузер не поддерживает запись звука (MediaRecorder)');
    if (!mic || !agent || mic.readyState !== 'live' || agent.readyState !== 'live') throw new Error('для записи нужны живые дорожки микрофона и Гоко');
    const mime = MIME_TYPES.find(this.deps.supported);
    const startedAtMs = this.deps.now();
    this.wallStartedAt = new Date().toISOString();
    this.traceEvents = [];
    this.traceTruncated = false;
    this.traceBytes = 2;
    const clones: RecorderTrack[] = [];
    try {
      for (const [label, original] of [['mic', mic], ['agent', agent]] as const) {
        const clone = original.clone() as RecorderTrack;
        clones.push(clone);
        const recorder = this.deps.createRecorder(clone, mime);
        const chunks: Blob[] = [];
        let resolveStopped!: () => void;
        const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));
        recorder.addEventListener('dataavailable', ((event: BlobEvent) => {
          if (event.data.size > 0) chunks.push(event.data);
          const bytes = this.sides.reduce((sum, side) => sum + side.chunks.reduce((n, chunk) => n + chunk.size, 0), 0);
          this.publish({ bytes });
          if (bytes >= RECORDING_STOP_BYTES) void this.stop('size');
        }) as EventListener);
        recorder.addEventListener('error', (() => void this.stop('error')) as EventListener);
        recorder.addEventListener('stop', resolveStopped as EventListener);
        this.sides.push({ label, clone, recorder, chunks, startOffsetMs: Math.max(0, this.deps.now() - startedAtMs), stopped, resolveStopped });
        recorder.start(1000);
      }
    } catch (error) {
      for (const side of this.sides) {
        if (side.recorder.state !== 'inactive') {
          try { side.recorder.stop(); } catch { side.resolveStopped(); }
        } else side.resolveStopped();
      }
      await Promise.all(this.sides.map((side) => side.stopped));
      for (const clone of clones) clone.stop();
      this.sides = [];
      this.publish({ phase: 'failed', error: error instanceof Error ? error.message : 'не удалось начать запись' });
      throw error;
    }
    this.publish({ phase: 'recording', startedAtMs, elapsedMs: 0, bytes: 0, error: null });
    this.trace('recorder.started', { mime: this.sides.map((side) => side.recorder.mimeType), offsets: this.sides.map((side) => side.startOffsetMs) });
    this.timer = this.deps.setTimer(() => {
      const elapsedMs = this.deps.now() - startedAtMs;
      this.publish({ elapsedMs });
      if (elapsedMs >= RECORDING_MAX_MS) void this.stop('duration');
    }, 250);
  }

  async stop(reason: RecordingStopReason = 'user') {
    if (this.finishing) return this.finishing;
    if (this.snapshot.phase !== 'recording') return;
    this.trace('recorder.stopping', { reason });
    this.publish({ phase: 'stopping' });
    if (this.timer) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.finishing = (async () => {
      for (const side of this.sides) {
        if (side.recorder.state !== 'inactive') {
          try { side.recorder.stop(); } catch { side.resolveStopped(); }
        } else side.resolveStopped();
      }
      await Promise.all(this.sides.map((side) => side.stopped));
      const durationMs = Math.max(0, this.deps.now() - (this.snapshot.startedAtMs ?? this.deps.now()));
      const [micSide, agentSide] = this.sides;
      if (!micSide || !agentSide) return;
      const micBlob = new Blob(micSide.chunks, { type: micSide.recorder.mimeType });
      const agentBlob = new Blob(agentSide.chunks, { type: agentSide.recorder.mimeType });
      micSide.chunks.length = 0;
      agentSide.chunks.length = 0;
      for (const side of this.sides) side.clone.stop();
      const finalEvent: TraceEvent = { t: durationMs, type: 'recorder.finished', payload: { reason, micBytes: micBlob.size, agentBytes: agentBlob.size } };
      const finalBytes = encoder.encode(JSON.stringify(finalEvent)).byteLength + 1;
      while (this.traceEvents.length >= TRACE_MAX_EVENTS || this.traceBytes + finalBytes > TRACE_MAX_JSON_BYTES) {
        const removed = this.traceEvents.pop();
        if (!removed) break;
        this.traceBytes -= encoder.encode(JSON.stringify(removed)).byteLength + 1;
        this.traceTruncated = true;
      }
      this.traceEvents.push(finalEvent);
      const manifestBase = {
        version: 1,
        startedAt: this.wallStartedAt,
        durationMs,
        stopReason: reason,
        tracks: {
          mic: { mimeType: micBlob.type, bytes: micBlob.size, startOffsetMs: micSide.startOffsetMs },
          agent: { mimeType: agentBlob.type, bytes: agentBlob.size, startOffsetMs: agentSide.startOffsetMs },
        },
        trace: this.traceEvents,
        traceTruncated: this.traceTruncated,
      };
      let manifestJson = JSON.stringify(manifestBase, null, 2);
      if (encoder.encode(manifestJson).byteLength > TRACE_MAX_JSON_BYTES) {
        manifestJson = JSON.stringify({ ...manifestBase, trace: this.traceEvents.slice(0, 1), traceTruncated: true }, null, 2);
      }
      const manifestBlob = new Blob([manifestJson], { type: 'application/json' });
      const partial = reason !== 'user' || micBlob.size === 0 || agentBlob.size === 0;
      const result: RecordingResult = {
        startedAt: this.wallStartedAt,
        durationMs,
        totalBytes: micBlob.size + agentBlob.size,
        stopReason: reason,
        partial,
        mic: { blob: micBlob, url: this.deps.createUrl(micBlob), mimeType: micBlob.type, startOffsetMs: micSide.startOffsetMs },
        agent: { blob: agentBlob, url: this.deps.createUrl(agentBlob), mimeType: agentBlob.type, startOffsetMs: agentSide.startOffsetMs },
        manifest: { blob: manifestBlob, url: this.deps.createUrl(manifestBlob) },
      };
      this.sides = [];
      this.traceEvents = [];
      this.publish({ phase: 'ready', elapsedMs: durationMs, bytes: result.totalBytes, result, error: partial ? 'запись сохранена частично; проверьте размер дорожек' : null });
    })().finally(() => {
      this.finishing = null;
    });
    return this.finishing;
  }

  delete() {
    const result = this.snapshot.result;
    if (result) for (const url of [result.mic.url, result.agent.url, result.manifest.url]) this.deps.revokeUrl(url);
    this.publish({ phase: 'idle', startedAtMs: null, elapsedMs: 0, bytes: 0, error: null, result: null });
  }

  async dispose() {
    await this.stop('disconnect');
    this.delete();
  }
}
