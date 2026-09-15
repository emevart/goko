import { describe, expect, it, vi } from 'vitest';
import { LiveSilenceClock } from './live-clock.ts';

describe('LiveSilenceClock', () => {
  it('при muted сразу и периодически подаёт mono 24k silence, при unmute останавливает', () => {
    vi.useFakeTimers();
    const provider = { muteInput: vi.fn(), unmuteInput: vi.fn(), pushAudio: vi.fn() };
    const clock = new LiveSilenceClock(provider);
    clock.setInputEnabled(false);
    expect(provider.muteInput).toHaveBeenCalledOnce();
    expect(provider.pushAudio).toHaveBeenCalledOnce();
    const frame = provider.pushAudio.mock.calls[0]?.[0];
    expect(frame).toMatchObject({ sampleRate: 24_000, channels: 1, samplesPerChannel: 2_400 });
    vi.advanceTimersByTime(200);
    expect(provider.pushAudio).toHaveBeenCalledTimes(3);
    clock.setInputEnabled(true);
    expect(provider.unmuteInput).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(200);
    expect(provider.pushAudio).toHaveBeenCalledTimes(3);
    clock.stop();
    vi.useRealTimers();
  });
});
