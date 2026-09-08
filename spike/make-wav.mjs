// Временный генератор тестового звука для аудио-спайка.
// 3 секунды, 48 кГц, моно, 16 бит PCM: синусоида 440 Гц с двумя паузами.
// Речь не нужна: проверяем медиапуть, а не распознавание.
import { writeFile } from 'node:fs/promises';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const BITS = 16;
const DURATION_SEC = 3;
const FREQ_HZ = 440;

// Тон / пауза / тон / пауза / тон — по порядку, в секундах.
const SEGMENTS = [
  { kind: 'tone', sec: 0.8 },
  { kind: 'silence', sec: 0.4 },
  { kind: 'tone', sec: 0.8 },
  { kind: 'silence', sec: 0.4 },
  { kind: 'tone', sec: 0.6 },
];

const totalSamples = SAMPLE_RATE * DURATION_SEC;
const pcm = new Int16Array(totalSamples);

let offset = 0;
for (const segment of SEGMENTS) {
  const count = Math.round(segment.sec * SAMPLE_RATE);
  for (let i = 0; i < count && offset + i < totalSamples; i += 1) {
    const t = (offset + i) / SAMPLE_RATE;
    // Затухание по краям сегмента, чтобы не было щелчков на стыках.
    const fade = Math.min(1, i / 240, (count - i) / 240);
    pcm[offset + i] =
      segment.kind === 'tone' ? Math.round(0.6 * fade * 32767 * Math.sin(2 * Math.PI * FREQ_HZ * t)) : 0;
  }
  offset += count;
}

const byteRate = (SAMPLE_RATE * CHANNELS * BITS) / 8;
const blockAlign = (CHANNELS * BITS) / 8;
const dataBytes = pcm.length * 2;
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + dataBytes, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(CHANNELS, 22);
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(byteRate, 28);
header.writeUInt16LE(blockAlign, 32);
header.writeUInt16LE(BITS, 34);
header.write('data', 36);
header.writeUInt32LE(dataBytes, 40);

const out = process.argv[2] ?? 'spike/tone.wav';
await writeFile(out, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes)]));
console.log(`[OK] ${out}: ${DURATION_SEC} c, ${SAMPLE_RATE} Гц, моно, ${BITS} бит, ${44 + dataBytes} байт`);
