// Разбор text/event-stream: отдаёт содержимое data каждого блока. Комментарии (": ping") пропускает.
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Нормализация переводов строк на уровне буфера, а не чанка: `\r` и `\n` могут прийти в разных чанках.
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
