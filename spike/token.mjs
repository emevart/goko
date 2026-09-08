// Выпуск токена участника с диспетчеризацией агента. Печатает URL страницы спайка.
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';

// Fail-fast: без любой из этих переменных ссылка получится нерабочей или ошибка вылезет
// из toJwt() без подсказки. Печатаем только имена, значения не печатаем никогда.
const REQUIRED = ['LIVEKIT_URL', 'WEB_HOST', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`[X] нет переменных: ${missing.join(', ')}`);
  console.error('Задайте их в .env в корне репозитория или в окружении.');
  process.exit(1);
}

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
