// Токен участника с диспетчеризацией агента (раздел 7 спеки). roomCreate обязателен: в livekit.yaml
// auto_create=false, комнату создаёт первый вход с этим правом, и вместе с ней стартует агент из roomConfig.
// Ключ и секрет приходят только аргументами. SDK на пустой строке молча берёт LIVEKIT_API_KEY и
// LIVEKIT_API_SECRET из process.env, поэтому пустые значения отклоняем сами. Тексты ошибок называют
// только поле, значений не содержат.
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

const DEFAULT_TTL_SECONDS = 14400;

function requireNonEmpty(value: string, field: 'apiKey' | 'apiSecret' | 'identity'): void {
  if (value.trim() === '') throw new Error(`mintToken: пустой ${field}`);
}

export async function mintToken(opts: MintTokenOptions): Promise<string> {
  requireNonEmpty(opts.apiKey, 'apiKey');
  requireNonEmpty(opts.apiSecret, 'apiSecret');
  requireNonEmpty(opts.identity, 'identity');
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  // 0 и NaN SDK заменил бы своими 6 часами (options.ttl || '6h').
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('mintToken: ttlSeconds должен быть положительным целым');
  const at = new AccessToken(opts.apiKey, opts.apiSecret, { identity: opts.identity, ttl });
  at.addGrant({ roomJoin: true, roomCreate: true, room: opts.room, canPublish: true, canSubscribe: true, canPublishData: true });
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: opts.agentName, metadata: JSON.stringify({ sessionId: opts.sessionId }) })],
  });
  return at.toJwt();
}
