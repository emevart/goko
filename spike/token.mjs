// Выпуск токена участника с диспетчеризацией агента. Печатает URL страницы спайка.
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { AccessToken } from 'livekit-server-sdk';

const room = process.argv[2] ?? `spike-${Date.now().toString(36)}`;
const agentName = process.env.AGENT_NAME ?? 'goko';
const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: 'phone', ttl: '2h' });
// roomCreate обязателен: в livekit.yaml auto_create=false, комнату создаёт первый вход с этим правом и roomConfig.
at.addGrant({ roomJoin: true, roomCreate: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
at.roomConfig = new RoomConfiguration({
  agents: [new RoomAgentDispatch({ agentName, metadata: JSON.stringify({ sessionId: room }) })],
});
const token = await at.toJwt();
const url = process.env.LIVEKIT_URL;
const webHost = process.env.WEB_HOST;
console.log(`room: ${room}`);
console.log(`https://${webHost}/#url=${encodeURIComponent(url)}&token=${token}`);
