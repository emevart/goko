import { AudioFrame } from '@livekit/rtc-node';

export type LiveAudioProvider = { muteInput(): void; unmuteInput(): void; pushAudio(frame: AudioFrame): void };

export class LiveSilenceClock {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly provider: LiveAudioProvider;

  constructor(provider: LiveAudioProvider) { this.provider = provider; }

  setInputEnabled(enabled: boolean): void {
    if (enabled) {
      this.stopPump();
      this.provider.unmuteInput();
      return;
    }
    this.provider.muteInput();
    if (this.timer) return;
    const push = () => this.provider.pushAudio(new AudioFrame(new Int16Array(2_400), 24_000, 1, 2_400));
    push();
    this.timer = setInterval(push, 100);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopPump();
  }

  private stopPump(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
