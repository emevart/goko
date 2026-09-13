// Токен участника с диспетчеризацией агента (раздел 7 спеки). roomCreate обязателен: в livekit.yaml
// auto_create=false, комнату создаёт первый вход с этим правом, и вместе с ней стартует агент из roomConfig.
// Ключ и секрет приходят только аргументами и никуда, кроме подписи, не попадают.
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';

export type MintTokenOptions = {
  apiKey: string;
  apiSecret: string;
  room: string;
  identity: string;
  agentName: string;
  sessionId: string;
  ttlSeconds?: number;
};

export async function mintToken(opts: MintTokenOptions): Promise<string> {
  const at = new AccessToken(opts.apiKey, opts.apiSecret, { identity: opts.identity, ttl: opts.ttlSeconds ?? 4 * 3600 });
  at.addGrant({ roomJoin: true, roomCreate: true, room: opts.room, canPublish: true, canSubscribe: true, canPublishData: true });
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: opts.agentName, metadata: JSON.stringify({ sessionId: opts.sessionId }) })],
  });
  return at.toJwt();
}
