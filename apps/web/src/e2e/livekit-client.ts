// Подмена livekit-client только для Vite mode=e2e. Сохраняет текущий контракт GPT-Live,
// но не открывает сеть, не отправляет аудио и не делает платных вызовов.
type Handler = (...args: any[]) => void;

export const RoomEvent = {
  TrackSubscribed: 'TrackSubscribed', TrackUnsubscribed: 'TrackUnsubscribed',
  ParticipantConnected: 'ParticipantConnected', ParticipantDisconnected: 'ParticipantDisconnected',
  ParticipantAttributesChanged: 'ParticipantAttributesChanged', AudioPlaybackStatusChanged: 'AudioPlaybackStatusChanged',
  Reconnected: 'Reconnected', Reconnecting: 'Reconnecting', Disconnected: 'Disconnected',
} as const;
export const Track = { Kind: { Audio: 'audio' }, Source: { Microphone: 'microphone' } } as const;
export const ParticipantKind = { AGENT: 1 } as const;
export const ConnectionErrorReason = { NotAllowed: 'NotAllowed' } as const;

export class ConnectionError extends Error {
  reason: string;
  constructor(message: string, reason = ConnectionErrorReason.NotAllowed) { super(message); this.reason = reason; }
}

export class LocalAudioTrack {
  kind = Track.Kind.Audio;
  mediaStreamTrack: MediaStreamTrack;
  constructor(mediaStreamTrack: MediaStreamTrack, _constraints?: MediaTrackConstraints, _userProvided?: boolean) { this.mediaStreamTrack = mediaStreamTrack; }
  stop() { this.mediaStreamTrack.stop(); }
}

type Controls = { microphone: boolean; attributes: Record<string, string>; sent: string[]; audioSubscribed: boolean; connected: boolean; localTrackStates: string[] };
function controls(): Controls {
  const target = window as typeof window & { __gokoLiveKit?: Controls };
  return (target.__gokoLiveKit ??= { microphone: false, attributes: {}, sent: [], audioSubscribed: false, connected: false, localTrackStates: [] });
}

class RemoteAudioTrack {
  kind = Track.Kind.Audio;
  private elements: HTMLAudioElement[] = [];
  mediaStreamTrack: MediaStreamTrack;
  constructor(mediaStreamTrack: MediaStreamTrack) { this.mediaStreamTrack = mediaStreamTrack; }
  attach() {
    const element = document.createElement('audio');
    element.autoplay = true;
    element.muted = true;
    element.srcObject = new MediaStream([this.mediaStreamTrack]);
    this.elements.push(element);
    return element;
  }
  detach() { return this.elements.splice(0); }
}

class StreamReader {
  readonly info: { attributes: Record<string, string>; id: string; timestamp: number };
  private readonly text: string;
  constructor(text: string, id: string) {
    this.text = text;
    this.info = { attributes: { 'lk.segment_id': id, 'lk.transcription_final': 'false' }, id, timestamp: Date.now() };
  }
  withAbortSignal(_signal: AbortSignal) { return this; }
  async readAll() { return this.text; }
  async *[Symbol.asyncIterator]() { yield this.text; }
}

type AgentParticipant = {
  identity: string; sid: string; kind: number; attributes: Record<string, string>;
  trackPublications: Map<string, any>; audioLevel: number;
};

class LocalParticipant {
  identity = 'phone-preview';
  private publications: any[] = [];
  private trackHistory: MediaStreamTrack[] = [];
  private readonly room: Room;
  constructor(room: Room) { this.room = room; }
  private publishStates() { controls().localTrackStates = this.trackHistory.map((track) => track.readyState); }
  async setAttributes(attributes: Record<string, string>) { controls().attributes = { ...controls().attributes, ...attributes }; }
  async setMicrophoneEnabled(enabled: boolean) {
    controls().microphone = enabled;
    for (const publication of this.publications) {
      publication.isMuted = !enabled;
      if (publication.track?.mediaStreamTrack) {
        if (enabled && publication.track.mediaStreamTrack.readyState === 'ended') {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const replacement = stream.getAudioTracks()[0];
          for (const track of stream.getTracks()) if (track !== replacement) track.stop();
          if (!replacement) throw new Error('mock microphone has no audio track');
          publication.track = new LocalAudioTrack(replacement);
          this.trackHistory.push(replacement);
        }
        publication.track.mediaStreamTrack.enabled = enabled;
        if (!enabled && publication.track.mediaStreamTrack.readyState !== 'ended') {
          publication.track.stop();
        }
      }
    }
    this.publishStates();
  }
  getTrackPublication(source: string) { return this.publications.find((publication) => publication.source === source); }
  getTrackPublications() { return [...this.publications]; }
  async publishTrack(track: LocalAudioTrack, options: { source: string }) {
    const publication = { trackSid: `mic-${Date.now()}`, kind: Track.Kind.Audio, source: options.source, track, isMuted: false };
    this.publications.push(publication);
    this.trackHistory.push(track.mediaStreamTrack);
    controls().microphone = true;
    this.publishStates();
    this.room.publishMockAgentTrack(track.mediaStreamTrack.clone());
    return publication;
  }
  async unpublishTrack(track: LocalAudioTrack | MediaStreamTrack) {
    this.publications = this.publications.filter((publication) => publication.track !== track && publication.track?.mediaStreamTrack !== track);
    this.publishStates();
  }
  stopAllTracks() {
    for (const publication of this.publications) publication.track.stop();
    this.publishStates();
  }
  async sendText(text: string, _options?: { topic?: string }) {
    if (new URLSearchParams(location.search).get('mockSend') === 'fail') throw new Error('mock send failed');
    controls().sent.push(text);
    queueMicrotask(() => void this.room.emitAgentTranscript(`Принято: ${text}`));
  }
}

export class Room {
  localParticipant = new LocalParticipant(this);
  remoteParticipants = new Map<string, AgentParticipant>();
  canPlaybackAudio = true;
  private handlers = new Map<string, Set<Handler>>();
  private streamHandlers = new Map<string, Handler>();
  private connected = false;
  private agentTrack: RemoteAudioTrack | null = null;
  private agentPublication: any = null;
  constructor(_options?: unknown) {}
  on(event: string, handler: Handler) {
    const handlers = this.handlers.get(event) ?? new Set<Handler>();
    handlers.add(handler); this.handlers.set(event, handlers); return this;
  }
  private emit(event: string, ...args: unknown[]) { for (const handler of this.handlers.get(event) ?? []) handler(...args); }
  registerTextStreamHandler(topic: string, handler: Handler) { this.streamHandlers.set(topic, handler); }
  private agent() { return this.remoteParticipants.get('agent-preview'); }
  async emitAgentTranscript(text: string) {
    const agent = this.agent();
    const handler = this.streamHandlers.get('lk.transcription');
    if (agent && handler) await handler(new StreamReader(text, `mock-${Date.now()}`), agent);
  }
  publishMockAgentTrack(mediaStreamTrack: MediaStreamTrack) {
    const agent = this.agent();
    if (!agent) return;
    this.agentTrack = new RemoteAudioTrack(mediaStreamTrack);
    this.agentPublication = {
      kind: Track.Kind.Audio, isSubscribed: true,
      setSubscribed: (subscribed: boolean) => { this.agentPublication.isSubscribed = subscribed; controls().audioSubscribed = subscribed; },
    };
    controls().audioSubscribed = true;
    this.emit(RoomEvent.TrackSubscribed, this.agentTrack, this.agentPublication, agent);
  }
  async connect(_url: string, _token: string) {
    const query = new URLSearchParams(location.search);
    if (query.get('mockLink') === 'fail') throw new ConnectionError('mock connection rejected');
    this.connected = true; controls().connected = true;
    if (query.get('mockAgent') !== 'absent') {
      this.remoteParticipants.set('agent-preview', {
        identity: 'agent-preview', sid: 'PA_agent_preview', kind: ParticipantKind.AGENT,
        attributes: { 'lk.agent.state': 'listening', 'goko.tool': 'idle' }, trackPublications: new Map(), audioLevel: 0.15,
      });
    }
    if (query.get('mockAgent') === 'gone') setTimeout(() => {
      const participant = this.agent();
      if (!participant) return;
      this.remoteParticipants.clear();
      this.emit(RoomEvent.ParticipantDisconnected, participant);
    }, 750);
  }
  async disconnect() {
    if (!this.connected) return;
    this.connected = false; controls().connected = false; controls().microphone = false; controls().audioSubscribed = false;
    this.localParticipant.stopAllTracks();
    if (this.agentTrack) this.emit(RoomEvent.TrackUnsubscribed, this.agentTrack);
    this.agentTrack?.mediaStreamTrack.stop(); this.agentTrack = null;
    this.remoteParticipants.clear(); this.emit(RoomEvent.Disconnected);
  }
  async startAudio() { this.canPlaybackAudio = true; }
}
