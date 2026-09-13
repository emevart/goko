import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomAgentDispatch, RoomServiceClient, TokenVerifier } from 'livekit-server-sdk';
import { ROOM_EMPTY_TIMEOUT_SECONDS, createRoomService, createSessionRoom, livekitHttpUrl, mintToken } from './livekit.ts';

const KEY = 'devkey';
const SECRET = 'secret-of-at-least-32-characters-long';
const base = { apiKey: KEY, apiSecret: SECRET, room: 'goko-s1', identity: 'phone-s1', ttlSeconds: 7200 };

describe('mintToken (D-0001): только roomJoin на комнату сессии', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('права ровно на одну комнату: без roomCreate и без roomConfig, издатель — ключ', async () => {
    const claims = await new TokenVerifier(KEY, SECRET).verify(await mintToken(base));
    expect(claims.iss).toBe(KEY);
    expect(claims.sub).toBe('phone-s1');
    expect(claims.video).toEqual({ roomJoin: true, room: 'goko-s1', canPublish: true, canSubscribe: true, canPublishData: true });
    expect(claims.roomConfig).toBeUndefined();
  });

  it('другие комната и участник попадают в токен как есть', async () => {
    const claims = await new TokenVerifier(KEY, SECRET).verify(await mintToken({ ...base, room: 'goko-s2', identity: 'phone-s2' }));
    expect(claims.sub).toBe('phone-s2');
    expect(claims.video?.room).toBe('goko-s2');
  });

  it('токен с чужим секретом не проходит проверку', async () => {
    const token = await mintToken(base);
    await expect(new TokenVerifier(KEY, 'another-secret-of-at-least-32-characters').verify(token)).rejects.toThrow();
  });

  it('срок жизни ровно ttlSeconds (часы заморожены)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-07T10:00:00.999Z'));
    const verifier = new TokenVerifier(KEY, SECRET);
    const claims = await verifier.verify(await mintToken(base));
    expect(claims.nbf).toBe(Date.parse('2026-09-07T10:00:00Z') / 1000);
    expect(claims.exp).toBe(Date.parse('2026-09-07T12:00:00Z') / 1000);
    const short = await verifier.verify(await mintToken({ ...base, ttlSeconds: 600 }));
    expect(short.exp).toBe(Date.parse('2026-09-07T10:10:00Z') / 1000);
  });

  it('ttlSeconds не положительное целое -> отказ, SDK не подставляет свои 6 часов', async () => {
    for (const ttlSeconds of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(mintToken({ ...base, ttlSeconds })).rejects.toThrow('mintToken: ttlSeconds must be a positive integer');
    }
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
      [{ apiSecret: '' }, 'mintToken: empty apiSecret'],
      [{ apiSecret: '   ' }, 'mintToken: empty apiSecret'],
      [{ apiKey: '' }, 'mintToken: empty apiKey'],
      [{ identity: '' }, 'mintToken: empty identity'],
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

describe('createSessionRoom (D-0001): комнату и агента создаёт сервер', () => {
  it('имя комнаты, emptyTimeout 300 и ровно один агент с sessionId в metadata', async () => {
    const calls: unknown[] = [];
    const rooms = {
      createRoom: async (options: unknown) => {
        calls.push(options);
        return {};
      },
    };
    await createSessionRoom(rooms, { room: 'goko-s1', agentName: 'goko', sessionId: 's1' });
    expect(ROOM_EMPTY_TIMEOUT_SECONDS).toBe(300);
    expect(calls).toHaveLength(1);
    const options = calls[0] as { name: string; emptyTimeout: number; agents: RoomAgentDispatch[] };
    expect(Object.keys(options).sort()).toEqual(['agents', 'emptyTimeout', 'name']);
    expect(options.name).toBe('goko-s1');
    expect(options.emptyTimeout).toBe(300);
    expect(options.agents).toHaveLength(1);
    expect(options.agents[0]).toBeInstanceOf(RoomAgentDispatch);
    expect(options.agents[0]?.agentName).toBe('goko');
    expect(JSON.parse(options.agents[0]?.metadata ?? '')).toEqual({ sessionId: 's1' });
  });

  it('другие агент и сессия — как есть; отказ клиента доходит до вызывающего', async () => {
    const calls: Array<{ agents: RoomAgentDispatch[]; name: string }> = [];
    await createSessionRoom(
      {
        createRoom: async (options) => {
          calls.push(options as never);
          return {};
        },
      },
      { room: 'goko-s2', agentName: 'goko-dev', sessionId: 's2' },
    );
    expect(calls[0]?.name).toBe('goko-s2');
    expect(calls[0]?.agents[0]?.agentName).toBe('goko-dev');
    expect(JSON.parse(calls[0]?.agents[0]?.metadata ?? '')).toEqual({ sessionId: 's2' });
    const boom = new Error('twirp down');
    await expect(createSessionRoom({ createRoom: () => Promise.reject(boom) }, { room: 'goko-s3', agentName: 'goko', sessionId: 's3' })).rejects.toBe(boom);
  });
});

describe('RoomServiceClient из LIVEKIT_URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('livekitHttpUrl: wss -> https, ws -> http, http(s) без изменений', () => {
    expect(livekitHttpUrl('wss://lk.test')).toBe('https://lk.test');
    expect(livekitHttpUrl('ws://127.0.0.1:7880')).toBe('http://127.0.0.1:7880');
    expect(livekitHttpUrl('https://lk.test/')).toBe('https://lk.test/');
    expect(livekitHttpUrl('http://lk.test')).toBe('http://lk.test');
    expect(livekitHttpUrl('https://proxy.test/?to=ws://x')).toBe('https://proxy.test/?to=ws://x');
  });

  it('createRoomService ходит на http(s)-адрес с подписью ключом и правом roomCreate, без сети', async () => {
    const seen: Array<{ url: string; auth: string; body: string; hasSignal: boolean }> = [];
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ url: String(url), auth: headers.Authorization ?? '', body: String(init.body), hasSignal: init.signal !== undefined });
      return new Response(JSON.stringify({ name: 'goko-s1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = createRoomService({ url: 'wss://lk.test', apiKey: KEY, apiSecret: SECRET });
    expect(client).toBeInstanceOf(RoomServiceClient);
    await createSessionRoom(client, { room: 'goko-s1', agentName: 'goko', sessionId: 's1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://lk.test/twirp/livekit.RoomService/CreateRoom');
    expect(seen[0]?.hasSignal).toBe(true); // запрос ограничен по времени
    const token = (seen[0]?.auth ?? '').replace(/^Bearer /, '');
    const claims = await new TokenVerifier(KEY, SECRET).verify(token);
    expect(claims.video?.roomCreate).toBe(true);
    const body = JSON.parse(seen[0]?.body ?? '{}') as { name: string; emptyTimeout: number; agents: Array<{ agentName: string; metadata: string }> };
    expect(body.name).toBe('goko-s1');
    expect(body.emptyTimeout).toBe(300);
    expect(body.agents).toEqual([{ agentName: 'goko', metadata: '{"sessionId":"s1"}' }]);
  });

  it('createRoomService: пустой ключ или секрет — отказ без значений, SDK не берёт их из окружения', () => {
    expect(() => createRoomService({ url: 'wss://lk.test', apiKey: ' ', apiSecret: SECRET })).toThrow('createRoomService: empty apiKey');
    expect(() => createRoomService({ url: 'wss://lk.test', apiKey: KEY, apiSecret: '' })).toThrow('createRoomService: empty apiSecret');
  });
});
