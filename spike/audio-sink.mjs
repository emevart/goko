// Спайк: приём аудиодорожек в комнате LiveKit и подсчёт принятого звука.
// Запуск: node --env-file-if-exists=../.env audio-sink.mjs <room> [секунды ожидания]
import { AccessToken } from 'livekit-server-sdk';
import { AudioStream, Room, RoomEvent, dispose } from '@livekit/rtc-node';

const REQUIRED = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`[X] нет переменных: ${missing.join(', ')}`);
  process.exit(1);
}

const room = process.argv[2];
const waitSec = Number(process.argv[3] ?? 20);
if (!room) {
  console.error('[X] использование: audio-sink.mjs <room> [секунды]');
  process.exit(1);
}

const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
  identity: 'sink',
  ttl: '10m',
});
at.addGrant({ roomJoin: true, roomCreate: true, room, canPublish: false, canSubscribe: true });
const token = await at.toJwt();

const T0 = Date.now();
const rtcRoom = new Room();
const stats = new Map(); // sid -> { frames, samples, sampleRate, nonSilent, firstAt, lastAt }

rtcRoom.on(RoomEvent.TrackUnsubscribed, (_t, publication) =>
  console.log(`[!] отписка от ${publication.sid.slice(0, 6)} на ${((Date.now() - T0) / 1000).toFixed(2)} c`),
);

rtcRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
  console.log(
    `[OK] подписался на ${track.kind === 1 ? 'audio' : 'other'} от ${participant.identity} ` +
      `на ${((Date.now() - T0) / 1000).toFixed(2)} c от старта`,
  );
  const key = publication.sid;
  const st = { frames: 0, samples: 0, sampleRate: 0, nonSilent: 0, firstAt: 0, lastAt: 0 };
  stats.set(key, st);
  (async () => {
    const stream = new AudioStream(track);
    for await (const frame of stream) {
      st.frames += 1;
      st.samples += frame.samplesPerChannel;
      st.sampleRate = frame.sampleRate;
      st.channels = frame.channels;
      // Кадр считаем «со звуком», если пик выше порога: так видно, что паузы
      // тоже доехали, а не были вырезаны.
      let peak = 0;
      for (let i = 0; i < frame.data.length; i += 1) {
        const v = Math.abs(frame.data[i]);
        if (v > peak) peak = v;
      }
      if (peak > 500) st.nonSilent += 1;
      const now = Date.now();
      if (st.firstAt === 0) {
        st.firstAt = now;
        console.log(`[!] первый кадр на ${((now - T0) / 1000).toFixed(2)} c от старта`);
      }
      st.lastAt = now;
    }
  })().catch((err) => console.error(`[!] поток прерван, тип: ${err?.constructor?.name ?? typeof err}`));
});

try {
  await rtcRoom.connect(process.env.LIVEKIT_URL, token, { autoSubscribe: true, dynacast: false });
  console.log(`[OK] подключён к комнате ${room}, слушаю ${waitSec} c`);
  await new Promise((r) => setTimeout(r, waitSec * 1000));
} catch (err) {
  console.error(`[X] ошибка приёма, тип: ${err?.constructor?.name ?? typeof err}`);
  process.exitCode = 1;
} finally {
  await rtcRoom.disconnect();
}

if (stats.size === 0) {
  console.log('[X] аудиодорожек не принято');
  process.exitCode = 1;
} else {
  for (const [sid, st] of stats) {
    const ms = st.sampleRate ? (st.samples / st.sampleRate) * 1000 : 0;
    const wall = st.lastAt - st.firstAt;
    console.log(
      `[OK] дорожка ${sid.slice(0, 6)}...: кадров ${st.frames}, из них со звуком ${st.nonSilent}, ` +
        `${st.sampleRate} Гц ${st.channels} кан., принято ${ms.toFixed(0)} мс звука за ${wall} мс реального времени`,
    );
  }
}
await dispose();
