import { EventEmitter } from 'node:events';
import { initializeLogger, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { expect, it, vi } from 'vitest';
import { applyMode } from './mode.ts';
import { prepareRoomInput } from './room-input.ts';

it('Live создаёт настоящий RoomIO input, держит его выключенным до готовности и включает для голоса', async () => {
  initializeLogger({ pretty: false, level: 'error' });
  const session = new voice.AgentSession();
  const room = Object.assign(new EventEmitter(), {
    name: 'offline-input-test', isConnected: false,
    remoteParticipants: new Map(), localParticipant: { identity: 'agent' },
    registerTextStreamHandler: vi.fn(), unregisterTextStreamHandler: vi.fn(),
  });
  const io = new voice.RoomIO({
    agentSession: session, room: room as unknown as Room,
    inputOptions: { ...prepareRoomInput(session, 'live'), textEnabled: false },
    outputOptions: { audioEnabled: false, transcriptionEnabled: false },
  });
  try {
    io.start();
    expect(session.input.audio).not.toBeNull();
    expect(session.input.audioEnabled).toBe(false);
    const input = session.input.audio!;
    const attach = vi.spyOn(input, 'onAttached');
    applyMode(session, 'voice');
    expect(attach).toHaveBeenCalledOnce();
    expect(session.input.audioEnabled).toBe(true);
    applyMode(session, 'chat');
    expect(session.input.audio).toBe(input);
    expect(session.input.audioEnabled).toBe(false);
    applyMode(session, 'voice');
    expect(attach).toHaveBeenCalledTimes(2);
  } finally {
    await io.close();
  }
});
