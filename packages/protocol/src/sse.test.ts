import { describe, expect, it } from 'vitest';
import { parseSseStream } from './sse.ts';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function streamOfBytes(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of parseSseStream(stream)) out.push(d);
  return out;
}

describe('parseSseStream', () => {
  it('склеивает блоки, разорванные между чанками, и пропускает комментарии', async () => {
    const data = await collect(streamOf(['event: state.updated\ndata: {"a":', '1}\n\n: ping\n\nevent: x\ndata: {"b":2}\n\n']));
    expect(data).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('несколько строк data в одном блоке и CRLF', async () => {
    const data = await collect(streamOf(['data: one\r\ndata: two\r\n\r\n']));
    expect(data).toEqual(['one\ntwo']);
  });

  it('CRLF, разорванный между чанками', async () => {
    const data = await collect(streamOf(['data: one\r', '\ndata: two\r', '\n\r\n']));
    expect(data).toEqual(['one\ntwo']);
  });

  it('многобайтовый символ, разорванный между чанками', async () => {
    // 'data: ' — 6 байт, 'д' — 2 байта: рез приходится на середину буквы.
    // Без stream: true декодер подставил бы сюда U+FFFD.
    const bytes = new TextEncoder().encode('data: дэ\n\n');
    const data = await collect(streamOfBytes([bytes.slice(0, 7), bytes.slice(7)]));
    expect(data).toEqual(['дэ']);
  });

  it('незавершённый хвост без пустой строки не отдаётся', async () => {
    const data = await collect(streamOf(['data: one\n\ndata: tw']));
    expect(data).toEqual(['one']);
  });

  it('блок без строк data пропускается целиком', async () => {
    const data = await collect(streamOf(['event: ping\nid: 7\n\ndata: one\n\n']));
    expect(data).toEqual(['one']);
  });

  it('два блока в одном чанке разбираются оба', async () => {
    const data = await collect(streamOf(['data: one\n\ndata: two\n\n']));
    expect(data).toEqual(['one', 'two']);
  });

  it('после data: обрезается ровно один пробел, внутренние сохраняются', async () => {
    const data = await collect(streamOf(['data:  {"a": 1, "b": 2}\n\n']));
    expect(data).toEqual([' {"a": 1, "b": 2}']);
  });
});
