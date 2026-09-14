import { describe, expect, it, vi } from 'vitest';
import { DiagnosticRecorder, TRACE_MAX_EVENTS, TRACE_MAX_PAYLOAD_CHARS, watchTrackEnd, type RecorderLike, type RecorderTrack } from './recording.ts';

class FakeRecorder extends EventTarget implements RecorderLike {
  state: RecordingState = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  timeslice = 0;
  start(timeslice?: number) {
    this.state = 'recording';
    this.timeslice = timeslice ?? 0;
  }
  emit(size: number) {
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([new Uint8Array(size)]) }));
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => this.dispatchEvent(new Event('stop')));
  }
  beginNaturalStop() {
    this.state = 'inactive';
  }
  finishNaturalStop(size: number) {
    this.emit(size);
    this.dispatchEvent(new Event('stop'));
  }
}

function track(id: string) {
  const originalStop = vi.fn();
  const cloneStop = vi.fn();
  const clone = { id: `${id}-clone`, kind: 'audio', readyState: 'live', clone: vi.fn(), stop: cloneStop } as unknown as RecorderTrack;
  const original = { id, kind: 'audio', readyState: 'live', clone: vi.fn(() => clone), stop: originalStop } as unknown as RecorderTrack;
  return { original, originalStop, cloneStop };
}

function fixture() {
  let now = 100;
  const recorders: FakeRecorder[] = [];
  const revoked: string[] = [];
  const recorder = new DiagnosticRecorder({
    now: () => now,
    supported: (mime) => mime.includes('webm;codecs=opus'),
    createRecorder: () => {
      const item = new FakeRecorder();
      recorders.push(item);
      return item;
    },
    createUrl: (_blob) => `blob:${recorders.length}:${Math.random()}`,
    revokeUrl: (url) => revoked.push(url),
    setTimer: (() => 1) as never,
    clearTimer: () => {},
  });
  return { recorder, recorders, revoked, advance: (ms: number) => (now += ms) };
}

describe('DiagnosticRecorder', () => {
  it('останавливает общую запись при ended дорожки без зависимости от AudioContext', async () => {
    const f = fixture();
    const mic = Object.assign(new EventTarget(), track('mic').original) as unknown as RecorderTrack;
    await f.recorder.start(mic, track('agent').original);
    const unwatch = watchTrackEnd(mic, () => void f.recorder.stop('track-change'));
    (mic as unknown as EventTarget).dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(f.recorder.getSnapshot().phase).toBe('ready'));
    expect(f.recorder.getSnapshot().result).toMatchObject({ stopReason: 'track-change', partial: true });
    unwatch();
  });

  it('сохраняет обе стороны, если один MediaRecorder завершился сам', async () => {
    const f = fixture();
    await f.recorder.start(track('mic').original, track('agent').original);
    f.recorders[0]!.stop();
    await vi.waitFor(() => expect(f.recorder.getSnapshot().phase).toBe('ready'));
    expect(f.recorder.getSnapshot().result).toMatchObject({ stopReason: 'track-change', partial: true });
    expect(f.recorders[1]!.state).toBe('inactive');
  });

  it('ждёт stop после inactive и включает запоздавший финальный chunk в результат', async () => {
    const f = fixture();
    const mic = Object.assign(new EventTarget(), track('mic').original) as unknown as RecorderTrack;
    await f.recorder.start(mic, track('agent').original);
    const unwatch = watchTrackEnd(mic, () => void f.recorder.stop('track-change'));
    f.recorders[0]!.beginNaturalStop();
    (mic as unknown as EventTarget).dispatchEvent(new Event('ended'));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.recorder.getSnapshot().phase).toBe('stopping');
    f.recorders[0]!.finishNaturalStop(9);
    await vi.waitFor(() => expect(f.recorder.getSnapshot().phase).toBe('ready'));
    expect(f.recorder.getSnapshot().result?.mic.blob.size).toBe(9);
    unwatch();
  });

  it('честно отказывает без MediaRecorder вместо фиктивного успеха', async () => {
    const recorder = new DiagnosticRecorder();
    await expect(recorder.start(track('mic').original, track('agent').original)).rejects.toThrow(/MediaRecorder|запись звука/);
  });

  it('пишет две clone-дорожки timeslice=1000, сохраняет финальные chunks и не останавливает originals', async () => {
    const f = fixture();
    const mic = track('mic');
    const agent = track('agent');
    await f.recorder.start(mic.original, agent.original);
    expect(f.recorders.map((item) => item.timeslice)).toEqual([1000, 1000]);
    f.recorders[0]!.emit(5);
    f.recorders[1]!.emit(7);
    f.advance(1200);
    const stopped = f.recorder.stop('user');
    // MediaRecorder вправе прислать финальный chunk после stop() и до события stop.
    f.recorders[0]!.emit(3);
    await stopped;
    expect(f.recorder.getSnapshot().result).toMatchObject({ durationMs: 1200, totalBytes: 15, partial: false });
    expect(mic.originalStop).not.toHaveBeenCalled();
    expect(agent.originalStop).not.toHaveBeenCalled();
    expect(mic.cloneStop).toHaveBeenCalledOnce();
    expect(agent.cloneStop).toHaveBeenCalledOnce();
  });

  it('сохраняет partial при disconnect и освобождает URL только по delete', async () => {
    const f = fixture();
    const mic = track('mic');
    const agent = track('agent');
    await f.recorder.start(mic.original, agent.original);
    f.recorders[0]!.emit(4);
    await f.recorder.stop('disconnect');
    expect(f.recorder.getSnapshot().result).toMatchObject({ stopReason: 'disconnect', partial: true });
    expect(f.revoked).toEqual([]);
    f.recorder.delete();
    expect(f.revoked).toHaveLength(3);
  });

  it('откатывает half-start, не трогая originals', async () => {
    const mic = track('mic');
    const agent = track('agent');
    let calls = 0;
    const first = new FakeRecorder();
    const recorder = new DiagnosticRecorder({
      supported: () => true,
      createRecorder: () => {
        if (++calls === 2) throw new Error('second failed');
        return first;
      },
    });
    await expect(recorder.start(mic.original, agent.original)).rejects.toThrow('second failed');
    expect(first.state).toBe('inactive');
    expect(mic.cloneStop).toHaveBeenCalledOnce();
    expect(agent.cloneStop).toHaveBeenCalledOnce();
    expect(mic.originalStop).not.toHaveBeenCalled();
  });

  it('ограничивает число trace events и payload с явной отметкой', async () => {
    const f = fixture();
    await f.recorder.start(track('mic').original, track('agent').original);
    f.recorder.trace('large', { text: 'я'.repeat(TRACE_MAX_PAYLOAD_CHARS + 10) });
    for (let i = 0; i < TRACE_MAX_EVENTS + 2; i++) f.recorder.trace('tick', { i });
    f.recorders[0]!.emit(1);
    f.recorders[1]!.emit(1);
    await f.recorder.stop();
    const manifest = JSON.parse(await f.recorder.getSnapshot().result!.manifest.blob.text()) as { trace: unknown[]; traceTruncated: boolean };
    expect(manifest.trace.length).toBeLessThanOrEqual(TRACE_MAX_EVENTS);
    expect(manifest.traceTruncated).toBe(true);
  });

  it('держит JSON trace не больше 4 МиБ ещё во время сбора', async () => {
    const f = fixture();
    await f.recorder.start(track('mic').original, track('agent').original);
    for (let i = 0; i < 650; i++) f.recorder.trace('payload', { i, text: 'x'.repeat(7990) });
    f.recorders[0]!.emit(1);
    f.recorders[1]!.emit(1);
    await f.recorder.stop();
    const manifest = f.recorder.getSnapshot().result!.manifest.blob;
    expect(manifest.size).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(JSON.parse(await manifest.text()).traceTruncated).toBe(true);
  });
});
