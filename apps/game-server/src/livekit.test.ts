import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenVerifier } from 'livekit-server-sdk';
import { mintToken } from './livekit.ts';

describe('mintToken', () => {
  it('гранты на комнату, roomCreate, и диспетчеризация агента с sessionId в metadata', async () => {
    const token = await mintToken({ apiKey: 'devkey', apiSecret: 'secret-of-at-least-32-characters-long', room: 'goko-s1', identity: 'phone-s1', agentName: 'goko', sessionId: 's1' });
    const claims = await new TokenVerifier('devkey', 'secret-of-at-least-32-characters-long').verify(token);
    expect(claims.sub).toBe('phone-s1');
    expect(claims.video).toMatchObject({ roomJoin: true, roomCreate: true, room: 'goko-s1', canPublish: true, canSubscribe: true, canPublishData: true });
    const agents = (claims.roomConfig as { agents: Array<{ agentName: string; metadata: string }> }).agents;
    expect(agents[0]?.agentName).toBe('goko');
    expect(JSON.parse(agents[0]?.metadata ?? '{}')).toEqual({ sessionId: 's1' });
  });
});

const KEY = 'devkey';
const SECRET = 'secret-of-at-least-32-characters-long';
const base = { apiKey: KEY, apiSecret: SECRET, room: 'goko-s1', identity: 'phone-s1', agentName: 'goko', sessionId: 's1' };

describe('mintToken: точный состав токена', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('права ровно на одну комнату без лишних, издатель — ключ, агент ровно один', async () => {
    const claims = await new TokenVerifier(KEY, SECRET).verify(await mintToken(base));
    expect(claims.iss).toBe(KEY);
    expect(claims.video).toEqual({ roomJoin: true, roomCreate: true, room: 'goko-s1', canPublish: true, canSubscribe: true, canPublishData: true });
    const agents = (claims.roomConfig as { agents: Array<{ agentName: string; metadata: string }> }).agents;
    expect(agents).toHaveLength(1);
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

  it('срок жизни по умолчанию 14400 секунд, ttlSeconds переопределяет (часы заморожены)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-07T10:00:00.999Z'));
    const verifier = new TokenVerifier(KEY, SECRET);
    const def = await verifier.verify(await mintToken(base));
    expect(def.nbf).toBe(Date.parse('2026-09-07T10:00:00Z') / 1000);
    expect(def.exp).toBe(Date.parse('2026-09-07T14:00:00Z') / 1000);
    const short = await verifier.verify(await mintToken({ ...base, ttlSeconds: 600 }));
    expect(short.exp).toBe(Date.parse('2026-09-07T10:10:00Z') / 1000);
  });

  it('ttlSeconds не положительное целое -> отказ, SDK не подставляет свои 6 часов', async () => {
    for (const ttlSeconds of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(mintToken({ ...base, ttlSeconds })).rejects.toThrow('mintToken: ttlSeconds должен быть положительным целым');
    }
    // Граница: 1 секунда — допустимо. Часы заморожены, иначе токен на 1 с мог бы истечь до verify.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-07T10:00:00.000Z'));
    const claims = await new TokenVerifier(KEY, SECRET).verify(await mintToken({ ...base, ttlSeconds: 1 }));
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(1);
  });

  it('пустые apiKey и apiSecret не берутся из окружения, текст ошибки без значений', async () => {
    const envKey = 'env-key-must-not-be-used';
    const envSecret = 'env-secret-must-not-leak-into-anything-32';
    vi.stubEnv('LIVEKIT_API_KEY', envKey);
    vi.stubEnv('LIVEKIT_API_SECRET', envSecret);
    const cases: Array<[Partial<typeof base>, string]> = [
      [{ apiSecret: '' }, 'mintToken: пустой apiSecret'],
      [{ apiSecret: '   ' }, 'mintToken: пустой apiSecret'],
      [{ apiKey: '' }, 'mintToken: пустой apiKey'],
      [{ identity: '' }, 'mintToken: пустой identity'],
    ];
    for (const [patch, message] of cases) {
      const err = await mintToken({ ...base, ...patch }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const text = String((err as Error).message);
      expect(text).toBe(message);
      for (const leaked of [envKey, envSecret, SECRET]) expect(text).not.toContain(leaked);
    }
  });
});
