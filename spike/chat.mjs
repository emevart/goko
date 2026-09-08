// Текстовый канал к агенту без микрофона: stdin -> lk.chat, lk.transcription -> stdout.
import readline from 'node:readline';
import { Room, RoomEvent } from '@livekit/rtc-node';
// Классы протокола берём из реэкспорта livekit-server-sdk: в дереве две версии
// @livekit/protocol, прямой импорт может подцепить не ту.
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';

// Fail-fast как в token.mjs: печатаем только имена переменных, значения — никогда.
const REQUIRED = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`[X] нет переменных: ${missing.join(', ')}`);
  console.error('Задайте их в .env в корне репозитория или в окружении.');
  process.exit(1);
}

const roomName = process.argv[2] ?? `chat-${Date.now().toString(36)}`;
const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
  identity: 'dev-chat',
  ttl: '1h',
});
// roomCreate обязателен: в livekit.yaml auto_create=false, комнату создаёт первый вход.
at.addGrant({ roomJoin: true, roomCreate: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
at.roomConfig = new RoomConfiguration({
  agents: [new RoomAgentDispatch({ agentName: process.env.AGENT_NAME ?? 'goko', metadata: JSON.stringify({ sessionId: roomName }) })],
});
const token = await at.toJwt();

const room = new Room();
room.registerTextStreamHandler('lk.transcription', async (reader, participantInfo) => {
  let text = '';
  for await (const chunk of reader) text += chunk;
  // Один поток = один сегмент речи; дочитали до конца — значит сегмент закончен.
  // Атрибут lk.transcription_final здесь не фильтр: @livekit/agents 1.8.0 открывает
  // транскрипт агента дельта-потоком с "false" в заголовке и уже не меняет его,
  // так что проверка из брифа отбрасывала бы все реплики.
  if (!text) return;
  console.log(`[${participantInfo.identity}] ${text}`);
});
room.on(RoomEvent.Disconnected, () => process.exit(0));
await room.connect(process.env.LIVEKIT_URL, token, { autoSubscribe: true, dynacast: false });
console.log(`[OK] в комнате ${roomName}; пиши фразы, Ctrl+C — выход`);

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  await room.localParticipant.sendText(line, { topic: 'lk.chat' });
}
// Печатаем до disconnect: разрыв поднимает RoomEvent.Disconnected, а тот сразу выходит.
console.log('[OK] сессия закрыта');
await room.disconnect();
process.exit(0);
