import { describe, expect, it } from 'vitest';
import { type Line, MAX_LINES, acceptLine, isTrustedTranscriptSender, lineId, upsertLine, whoOf } from './transcript.ts';

const line = (id: string, text: string, who: 'me' | 'goko' = 'goko', final = true): Line => ({ id, who, text, final });

it('поздний финал не переставляет реплику и не заменяется старым промежуточным текстом', () => {
  let rows = upsertLine([], {...line('u','мой', 'me',false), startedAt:10});
  rows = upsertLine(rows,{...line('a','K10'),startedAt:20});
  rows = upsertLine(rows,{...line('u','мой ход D4','me'),startedAt:30});
  rows = upsertLine(rows,{...line('u','мой ход','me',false),startedAt:15});
  expect(rows.map(r=>r.id)).toEqual(['u','a']);
  expect(rows[0]?.text).toBe('мой ход D4');
});
it('поздно доставленный ранний поток занимает своё место', () => {
  const rows = upsertLine([{...line('a','ответ'),startedAt:20}],{...line('u','вопрос','me'),startedAt:10});
  expect(rows.map(r=>r.id)).toEqual(['u','a']);
});

describe('upsertLine', () => {
  it('добавляет новые и заменяет по id (потоковая реплика дописывается)', () => {
    let lines = upsertLine([], line('a', 'При', 'goko', false));
    lines = upsertLine(lines, line('a', 'Привет', 'goko', true));
    lines = upsertLine(lines, line('b', 'дэ четыре', 'me'));
    expect(lines).toEqual([line('a', 'Привет'), line('b', 'дэ четыре', 'me')]);
  });
  it('хранит не больше MAX_LINES последних', () => {
    let lines: Line[] = [];
    for (let i = 0; i < MAX_LINES + 5; i++) lines = upsertLine(lines, line(`l${i}`, String(i)));
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines[0]?.id).toBe('l5');
  });
});

describe('whoOf / lineId', () => {
  const mine = new Set(['TR_mic']);
  it('транскрипт моего трека — я; речь агента — Гоко', () => {
    expect(whoOf({ 'lk.transcribed_track_id': 'TR_mic' }, mine, 'agent-1', 'phone-s1')).toBe('me');
    expect(whoOf({ 'lk.transcribed_track_id': 'TR_agent' }, mine, 'agent-1', 'phone-s1')).toBe('goko');
    expect(whoOf({}, mine, 'agent-1', 'phone-s1')).toBe('goko');
    expect(whoOf({}, mine, 'phone-s1', 'phone-s1')).toBe('me');
  });
  it('id строки — сегмент, иначе id потока', () => {
    expect(lineId({ 'lk.segment_id': 'SG_1' }, 'ST_9')).toBe('SG_1');
    expect(lineId({}, 'ST_9')).toBe('ST_9');
  });
});

describe('isTrustedTranscriptSender', () => {
  it('принимает bound agent и пересланную им речь с логическим identity телефона', () => {
    expect(isTrustedTranscriptSender('goko', 'goko', 'phone-s1', true)).toBe(true);
    expect(isTrustedTranscriptSender('me', 'phone-s1', 'phone-s1', false)).toBe(true);
  });
  it('не принимает неизвестного remote sender, даже если track attrs классифицировали строку как мою', () => {
    expect(isTrustedTranscriptSender('me', 'stranger', 'phone-s1', false)).toBe(false);
    expect(isTrustedTranscriptSender('goko', 'stranger', 'phone-s1', false)).toBe(false);
  });
});

describe('acceptLine (D-0011: лента — диалог без дублей)', () => {
  it('реплику Гоко берёт всегда, реплику человека — только финальный сегмент', () => {
    expect(acceptLine({ 'lk.transcription_final': 'false' }, 'goko')).toBe(true);
    expect(acceptLine({}, 'goko')).toBe(true);
    expect(acceptLine({ 'lk.transcription_final': 'false' }, 'me')).toBe(false);
    expect(acceptLine({}, 'me')).toBe(false);
    expect(acceptLine({ 'lk.transcription_final': 'true' }, 'me')).toBe(true);
  });
  it('промежуточные куски человека отброшены, финал того же сегмента — одна строка', () => {
    const chunks: Array<[Record<string, string>, string]> = [
      [{ 'lk.segment_id': 'SG_7', 'lk.transcription_final': 'false' }, 'дэ'],
      [{ 'lk.segment_id': 'SG_7', 'lk.transcription_final': 'false' }, 'дэ чет'],
      [{ 'lk.segment_id': 'SG_7', 'lk.transcription_final': 'true' }, 'дэ четыре'],
      [{ 'lk.segment_id': 'SG_7', 'lk.transcription_final': 'true' }, 'дэ четыре'],
    ];
    let lines: Line[] = [];
    for (const [attrs, text] of chunks) {
      if (acceptLine(attrs, 'me')) lines = upsertLine(lines, { id: lineId(attrs, 'ST_x'), who: 'me', text, final: true });
    }
    expect(lines).toEqual([line('SG_7', 'дэ четыре', 'me')]);
  });
});
