// LiveKit по D-0001 (раздел 7 спеки): комнату сессии и диспетчеризацию агента создаёт сервер через
// RoomServiceClient.createRoom, телефон получает токен только с roomJoin на эту комнату, без roomCreate
// и без roomConfig. Токен с roomCreate дал бы любому, кто открыл веб, неограниченное число платных агентов.
// Ключ и секрет приходят только аргументами. SDK на пустой строке молча берёт LIVEKIT_API_KEY и
// LIVEKIT_API_SECRET из process.env, поэтому пустые значения отклоняем сами. Тексты ошибок называют
// только поле, значений не содержат. Это ошибки программиста: текст по-английски.
import { AccessToken, RoomAgentDispatch, RoomServiceClient } from 'livekit-server-sdk';

export type MintTokenOptions = {
  apiKey: string;
  apiSecret: string;
  room: string;
  identity: string;
  // Равен TTL сессии: токен не должен переживать сессию (D-0001).
  ttlSeconds: number;
};

// Комната без участников закрывается через 5 минут; агент в ней не платит, пока телефон не вошёл.
export const ROOM_EMPTY_TIMEOUT_SECONDS = 300;
// Запрос к LiveKit ограничен: POST /api/sessions не должен висеть на недоступном сервере.
export const ROOM_SERVICE_TIMEOUT_SECONDS = 10;

function requireNonEmpty(where: string, value: string, field: string): void {
  if (value.trim() === '') throw new Error(`${where}: empty ${field}`);
}

export async function mintToken(opts: MintTokenOptions): Promise<string> {
  requireNonEmpty('mintToken', opts.apiKey, 'apiKey');
  requireNonEmpty('mintToken', opts.apiSecret, 'apiSecret');
  requireNonEmpty('mintToken', opts.identity, 'identity');
  const ttl = opts.ttlSeconds;
  // 0 и NaN SDK заменил бы своими 6 часами (options.ttl || '6h').
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('mintToken: ttlSeconds must be a positive integer');
  const at = new AccessToken(opts.apiKey, opts.apiSecret, { identity: opts.identity, ttl });
  at.addGrant({ roomJoin: true, room: opts.room, canPublish: true, canSubscribe: true, canPublishData: true });
  return at.toJwt();
}

// Ровно то, что нужно серверу от клиента комнат; в тестах подделка.
export type RoomCreator = { createRoom(options: Parameters<RoomServiceClient['createRoom']>[0]): Promise<unknown> };

export type SessionRoomOptions = { room: string; agentName: string; sessionId: string };

export async function createSessionRoom(rooms: RoomCreator, opts: SessionRoomOptions): Promise<void> {
  await rooms.createRoom({
    name: opts.room,
    emptyTimeout: ROOM_EMPTY_TIMEOUT_SECONDS,
    agents: [new RoomAgentDispatch({ agentName: opts.agentName, metadata: JSON.stringify({ sessionId: opts.sessionId }) })],
  });
}

// LIVEKIT_URL в env — адрес для клиентов (wss://); API комнат ходит по http(s).
export function livekitHttpUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//, 'http$1://');
}

export function createRoomService(opts: { url: string; apiKey: string; apiSecret: string }): RoomCreator {
  requireNonEmpty('createRoomService', opts.apiKey, 'apiKey');
  requireNonEmpty('createRoomService', opts.apiSecret, 'apiSecret');
  // failover — только для LiveKit Cloud; у нас свой сервер, повторять запрос по регионам некуда.
  return new RoomServiceClient(livekitHttpUrl(opts.url), opts.apiKey, opts.apiSecret, { requestTimeout: ROOM_SERVICE_TIMEOUT_SECONDS, failover: false });
}
