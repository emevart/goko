import { describe, expect, it } from 'vitest';
import { TokenVerifier } from 'livekit-server-sdk';
import { mintToken } from './livekit.ts';

const KEY = 'devkey';
const SECRET = 'secret-of-at-least-32-characters-long';
const base = { apiKey: KEY, apiSecret: SECRET, room: 'goko-s1', identity: 'phone-s1', agentName: 'goko', sessionId: 's1' };

describe('mintToken', () => {
  it('гранты на комнату, roomCreate, и диспетчеризация агента с sessionId в metadata', async () => {
    const token = await mintToken(base);
    const claims = await new TokenVerifier(KEY, SECRET).verify(token);
    expect(claims.sub).toBe('phone-s1');
    expect(claims.iss).toBe(KEY);
    expect(claims.video).toMatchObject({ roomJoin: true, roomCreate: true, room: 'goko-s1', canPublish: true, canSubscribe: true, canPublishData: true });
    const agents = (claims.roomConfig as { agents: Array<{ agentName: string; metadata: string }> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentName).toBe('goko');
    expect(JSON.parse(agents[0]?.metadata ?? '{}')).toEqual({ sessionId: 's1' });
  });

  it('другие комната, агент и сессия попадают в токен как есть', async () => {
    const token = await mintToken({ ...base, room: 'goko-s2', identity: 'phone-s2', agentName: 'goko-dev', sessionId: 's2' });
    const claims = await new TokenVerifier(KEY, SECRET).verify(token);
    expect(claims.sub).toBe('phone-s2');
    expect(claims.video?.room).toBe('goko-s2');
    const agents = (claims.roomConfig as { agents: Array<{ agentName: string; metadata: string }> }).agents;
    expect(agents[0]?.agentName).toBe('goko-dev');
    expect(JSON.parse(agents[0]?.metadata ?? '{}')).toEqual({ sessionId: 's2' });
  });

  it('токен с чужим секретом не проходит проверку', async () => {
    const token = await mintToken(base);
    await expect(new TokenVerifier(KEY, 'another-secret-of-at-least-32-characters').verify(token)).rejects.toThrow();
  });

  it('срок жизни по умолчанию 14400 секунд, ttlSeconds переопределяет', async () => {
    const verifier = new TokenVerifier(KEY, SECRET);
    const def = await verifier.verify(await mintToken(base));
    expect((def.exp ?? 0) - (def.nbf ?? 0)).toBe(14400);
    const short = await verifier.verify(await mintToken({ ...base, ttlSeconds: 600 }));
    expect((short.exp ?? 0) - (short.nbf ?? 0)).toBe(600);
  });
});
