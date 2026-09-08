// Выпуск токена участника с диспетчеризацией агента.
// Ссылку на страницу спайка пишет в spike/last-url.txt и НЕ печатает: она содержит
// живой токен и адрес сервера, а stdout уходит в транскрипты и журналы задач.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const url = `https://${process.env.WEB_HOST}/#url=${encodeURIComponent(process.env.LIVEKIT_URL)}&token=${token}`;

// Ссылка содержит три вещи, которых не должно быть ни в консоли, ни в транскрипте
// агента, ни в журнале задачи: значение WEB_HOST (реальный хостнейм founder'а),
// значение LIVEKIT_URL и живой токен с правом roomCreate и TTL 2 часа. Поэтому в
// stdout уходит только имя комнаты и путь к файлу, а сама ссылка пишется в
// spike/last-url.txt (в .gitignore, режим 600) — founder открывает файл сам.
const outFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'last-url.txt');
await writeFile(outFile, `${url}\n`, { encoding: 'utf8', mode: 0o600 });

console.log(`room: ${room}`);
console.log('[OK] ссылка записана в spike/last-url.txt (действует 2 часа)');
console.log('[!] файл содержит токен и адрес сервера: открывать самому, никуда не вставлять');
