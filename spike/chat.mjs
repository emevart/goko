// Текстовый канал к агенту без микрофона: stdin -> lk.chat, lk.transcription -> stdout.
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
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

// Сколько ждать тишины после конца ввода, прежде чем рвать комнату.
const QUIET_MS = Number(process.env.CHAT_QUIET_MS ?? 5000);
// Потолок ожидания: не висим бесконечно, если агент молчит или зациклился.
const MAX_WAIT_MS = Number(process.env.CHAT_MAX_WAIT_MS ?? 60000);
// Пауза, после которой сегмент без пометки final считаем законченным.
const SEGMENT_DEBOUNCE_MS = 500;
const POLL_MS = 200;

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

let lastActivityAt = Date.now();
let activeStreams = 0;
let closing = false;
// Сегменты, уже напечатанные: повторные куски того же сегмента игнорируем.
const printedSegments = new Set();
// segment_id -> { identity, text, timer } — сегменты в ожидании подтверждения.
const pendingSegments = new Map();

function printSegment(identity, text) {
  lastActivityAt = Date.now();
  console.log(`[${identity}] ${text}`);
}

function flushSegment(segmentId) {
  const pending = pendingSegments.get(segmentId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingSegments.delete(segmentId);
  printedSegments.add(segmentId);
  printSegment(pending.identity, pending.text);
}

function dropPendingSegments() {
  for (const pending of pendingSegments.values()) clearTimeout(pending.timer);
  pendingSegments.clear();
}

room.registerTextStreamHandler('lk.transcription', async (reader, participantInfo) => {
  activeStreams += 1;
  lastActivityAt = Date.now();
  try {
    let text = '';
    for await (const chunk of reader) text += chunk;
    lastActivityAt = Date.now();
    if (!text) return;

    const attributes = reader.info.attributes ?? {};
    const segmentId = attributes['lk.segment_id'];
    // Атрибут lk.transcription_final нельзя использовать как фильтр «печатать или нет»:
    // @livekit/agents 1.8.0 ведёт транскрипт агента дельта-потоком (isDeltaStream: true),
    // открывает его один раз с "false" в заголовке и уже не переписывает — проверка из
    // брифа отбрасывала бы все реплики агента. При этом транскрипт пользователя идёт
    // НЕ дельта-потоком (isDeltaStream: false): каждый промежуточный результат STT —
    // отдельный закрытый поток с тем же lk.segment_id, и «поток дочитан» там не значит
    // «фраза закончена». Поэтому дедуплицируем по сегменту: печатаем один раз, либо по
    // пометке final="true", либо по паузе без новых кусков того же сегмента.
    if (!segmentId) {
      printSegment(participantInfo.identity, text);
      return;
    }
    if (printedSegments.has(segmentId)) return;

    const pending = pendingSegments.get(segmentId);
    if (pending) clearTimeout(pending.timer);

    if (attributes['lk.transcription_final'] === 'true') {
      pendingSegments.set(segmentId, { identity: participantInfo.identity, text, timer: null });
      flushSegment(segmentId);
      return;
    }
    const timer = setTimeout(() => flushSegment(segmentId), SEGMENT_DEBOUNCE_MS);
    pendingSegments.set(segmentId, { identity: participantInfo.identity, text, timer });
  } finally {
    activeStreams -= 1;
  }
});

room.on(RoomEvent.Disconnected, () => {
  // При штатном завершении выходим сами, чтобы дописать хвост вывода.
  if (!closing) process.exit(0);
});

async function shutdown(code, announce = true) {
  if (closing) return;
  closing = true;
  dropPendingSegments();
  if (announce) console.log('[OK] сессия закрыта');
  try {
    await room.disconnect();
  } catch {
    // Отключение уже могло произойти; для выхода это не важно.
  }
  process.exit(code);
}

// Ctrl+C без обработчика убивал бы процесс молча: участник отваливался бы не по
// причине из CLOSE_ON_DISCONNECT_REASONS, сессия Realtime висела бы до empty_timeout.
process.on('SIGINT', () => {
  console.log('');
  void shutdown(0);
});

try {
  await room.connect(process.env.LIVEKIT_URL, token, { autoSubscribe: true, dynacast: false });
} catch {
  // Текст ошибки rtc-node содержит адрес сервера, то есть значение LIVEKIT_URL, — не печатаем.
  console.error('[X] не удалось подключиться к LiveKit; проверьте LIVEKIT_URL и ключи');
  process.exit(1);
}
console.log(`[OK] в комнате ${roomName}; пиши фразы, Ctrl+C — выход`);

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  try {
    await room.localParticipant.sendText(line, { topic: 'lk.chat' });
  } catch {
    console.error('[X] не удалось отправить реплику агенту; соединение с LiveKit потеряно');
    await shutdown(1, false);
  }
  lastActivityAt = Date.now();
}

// EOF на stdin — ещё не конец разговора: ответ на последнюю фразу приходит позже.
// Ждём тишины (нет открытых потоков, нет неподтверждённых сегментов, QUIET_MS без
// новых реплик), но не дольше MAX_WAIT_MS.
const waitStartedAt = Date.now();
while (
  activeStreams > 0 ||
  pendingSegments.size > 0 ||
  Date.now() - lastActivityAt < QUIET_MS
) {
  if (Date.now() - waitStartedAt >= MAX_WAIT_MS) {
    console.error(`[!] тишины не дождались за ${Math.round(MAX_WAIT_MS / 1000)} с, закрываю сессию`);
    break;
  }
  await sleep(POLL_MS);
}

await shutdown(0);
