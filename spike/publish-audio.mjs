// Спайк: публикация WAV-файла в комнату LiveKit как аудиодорожки участника.
// Запуск: node --env-file-if-exists=../.env publish-audio.mjs <room> <file.wav>
// Агент в комнату НЕ диспетчеризуется: спайк проверяет только медиапуть.
import { readFile } from 'node:fs/promises';
import { AccessToken } from 'livekit-server-sdk';
import { AudioFrame, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

const REQUIRED = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`[X] нет переменных: ${missing.join(', ')}`);
  process.exit(1);
}

const room = process.argv[2];
const wavPath = process.argv[3];
if (!room || !wavPath) {
  console.error('[X] использование: publish-audio.mjs <room> <file.wav>');
  process.exit(1);
}

// Разбор WAV: ищем чанки fmt и data по всему файлу, а не по фиксированному
// смещению 44 — редакторы вставляют LIST/fact перед data.
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, pos + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
    }
    pos += 8 + size + (size % 2); // чанки выровнены по чётной границе
  }
  if (!fmt || !data) throw new Error('no fmt/data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('need uncompressed 16-bit PCM');
  if (fmt.channels !== 1) throw new Error('need mono');
  return { ...fmt, data };
}

const wav = parseWav(await readFile(wavPath));
const samples = new Int16Array(wav.data.buffer, wav.data.byteOffset, Math.floor(wav.data.length / 2));
const totalMs = (samples.length / wav.sampleRate) * 1000;
console.log(`[OK] wav: ${wav.sampleRate} Гц, ${wav.channels} кан., ${wav.bits} бит, ${totalMs.toFixed(0)} мс`);

// Токен участника-издателя. Права как в token.mjs, но без RoomAgentDispatch:
// поднимать голосового агента спайк не должен.
const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
  identity: 'publisher',
  ttl: '10m',
});
at.addGrant({ roomJoin: true, roomCreate: true, room, canPublish: true, canSubscribe: true });
const token = await at.toJwt();

const { Room } = await import('@livekit/rtc-node');
const rtcRoom = new Room();

// Кадр 10 мс — то же зерно, что использует сам LiveKit внутри.
const FRAME_MS = 10;
const samplesPerFrame = Math.round((wav.sampleRate * FRAME_MS) / 1000);

try {
  await rtcRoom.connect(process.env.LIVEKIT_URL, token, { autoSubscribe: false, dynacast: false });
  console.log(`[OK] подключён к комнате ${room}`);

  const source = new AudioSource(wav.sampleRate, wav.channels);
  const track = LocalAudioTrack.createAudioTrack('spike-wav', source);
  // dtx выключен: с ним паузы не передаются, и принятая длительность стала бы
  // короче отправленной не из-за потерь, а из-за подавления тишины.
  await rtcRoom.localParticipant.publishTrack(
    track,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: false, red: false }),
  );
  console.log('[OK] дорожка опубликована, отдаю кадры');

  const startedAt = Date.now();
  let sent = 0;
  for (let offset = 0; offset < samples.length; offset += samplesPerFrame) {
    const chunk = samples.subarray(offset, Math.min(offset + samplesPerFrame, samples.length));
    const frame = new AudioFrame(new Int16Array(chunk), wav.sampleRate, wav.channels, chunk.length);
    await source.captureFrame(frame); // очередь источника сама держит темп реального времени
    sent += chunk.length;
  }
  await source.waitForPlayout();
  const wallMs = Date.now() - startedAt;
  console.log(`[OK] отправлено ${sent} сэмплов = ${((sent / wav.sampleRate) * 1000).toFixed(0)} мс звука за ${wallMs} мс`);

  // Небольшой хвост: дать последним пакетам уйти до отписки.
  await new Promise((r) => setTimeout(r, 500));
  await source.close();
} catch (err) {
  // Текст исключения клиента LiveKit содержит адрес сервера: печатаем только тип.
  console.error(`[X] ошибка публикации, тип: ${err?.constructor?.name ?? typeof err}`);
  process.exitCode = 1;
} finally {
  await rtcRoom.disconnect();
  console.log('[OK] отключился');
  const { dispose } = await import('@livekit/rtc-node');
  await dispose();
}
