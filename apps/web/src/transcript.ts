// Лента диалога из текстовых потоков LiveKit (lk.transcription). Чистые функции без React.
export type Who = 'me' | 'goko';
export type Line = { id: string; who: Who; text: string; final: boolean; error?: boolean; startedAt?: number };

export const MAX_LINES = 200;

// Потоковая реплика приходит кусками под одним id: заменяем строку, а не добавляем новую.
export function upsertLine(lines: readonly Line[], line: Line): Line[] {
  const i = lines.findIndex((l) => l.id === line.id);
  const previous = lines[i];
  if (previous?.final && !line.final) return [...lines];
  const updated = previous?.startedAt !== undefined ? {...line, startedAt: previous.startedAt} : line;
  const next = i >= 0 ? lines.map((l, j) => (j === i ? updated : l)) : [...lines, updated];
  next.sort((a,b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

// Транскрипт моей речи публикует агент с lk.transcribed_track_id = sid моего микрофона; свою речь агент
// помечает своим треком. Без трека — по отправителю; свои строки чата веб добавляет сам (chat.ts).
export function whoOf(
  attrs: Readonly<Record<string, string>>,
  myTrackSids: ReadonlySet<string>,
  senderIdentity: string,
  myIdentity: string,
): Who {
  const trackId = attrs['lk.transcribed_track_id'];
  if (trackId) return myTrackSids.has(trackId) ? 'me' : 'goko';
  return senderIdentity === myIdentity ? 'me' : 'goko';
}

// Обычные транскрипты публикует bound agent. Пользовательский STT он пересылает тем же data stream,
// но LiveKit подставляет в callback логический senderIdentity телефона; его принимаем только как `me`
// и только при точном совпадении с identity текущего local participant.
export function isTrustedTranscriptSender(who: Who, senderIdentity: string, myIdentity: string, boundAgent: boolean): boolean {
  return boundAgent || (who === 'me' && senderIdentity === myIdentity);
}

export const lineId = (attrs: Readonly<Record<string, string>>, streamId: string): string => attrs['lk.segment_id'] ?? streamId;

// Лента — диалог без дублей (D-0011). Реплика Гоко идёт дельта-потоком с lk.transcription_final навсегда 'false'
// (agents 1.8.0), поэтому её берём всегда и держим строку по сегменту. Реплика человека: каждый промежуточный
// результат STT — отдельный закрытый поток того же сегмента, атрибут у него честный; берём только финал.
export const acceptLine = (attrs: Readonly<Record<string, string>>, who: Who): boolean =>
  who === 'goko' || attrs['lk.transcription_final'] === 'true';
