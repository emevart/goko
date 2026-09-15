import { COLUMN_LETTERS, COLUMN_NAMES_RU, normalizeCoordText } from '@goko/go-core';
import { cleanSpeechTranscript } from '@goko/protocol';

export type MutationIntent = 'start_game' | 'play_move' | 'correct_last_move' | 'pass' | 'resign' | 'undo' | 'redo' | 'set_rank';
type Turn = { turnId: number; text: string; used: boolean; at: number };
type IntentResult = { ok: true; turnId: number } | { ok: false; reason: string };

const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
const numberValues: Record<string, string> = { один: '1', два: '2', три: '3', четыре: '4', пять: '5', шесть: '6', семь: '7', восемь: '8', девять: '9', десять: '10', одиннадцать: '11', двенадцать: '12', тринадцать: '13', четырнадцать: '14', пятнадцать: '15', шестнадцать: '16', семнадцать: '17', восемнадцать: '18', девятнадцать: '19' };
const letterValues: Record<string, string> = Object.fromEntries(Object.entries(COLUMN_NAMES_RU).flatMap(([letter, name]) => [[name, letter], [letter.toLocaleLowerCase('ru-RU'), letter]]));
Object.assign(letterValues, { эй: 'A', би: 'B', си: 'C', се: 'C', ди: 'D', джи: 'G', ха: 'H', кей: 'K', а: 'A', б: 'B', в: 'B', с: 'C', д: 'D', е: 'E', ф: 'F', г: 'G', х: 'H', н: 'H', ж: 'J', к: 'K', л: 'L', м: 'M' });
Object.assign(letterValues, { жэ: 'J', жи: 'J', эйч: 'H', фэ: 'F', эфка: 'F' });
const words = (text: string): string[] => normalize(text).replace(/[.,!?;:()[\]«»"']/g, ' ').split(/\s+/u).filter(Boolean);
const canonical = (text: string): string => words(cleanSpeechTranscript(text)).join(' ');
const compactCoordinate = (token: string): string => {
  const joined = /^([a-zа-яё]+)(\d{1,2})$/u.exec(token);
  return joined && letterValues[joined[1]!] ? `${letterValues[joined[1]!]}${joined[2]}` : normalizeCoordText(token);
};
const rowNumber = (token: string): string | undefined => numberValues[token] ?? (/^\d{1,2}$/u.test(token) ? token : undefined);
const coordinatesIn = (text: string): string[] => {
  const tokens = words(text);
  const result = new Set<string>();
  for (const token of tokens) {
    const compact = compactCoordinate(token);
    if (/^[A-HJ-N]\d{1,2}$/u.test(compact)) result.add(compact);
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    const letter = letterValues[tokens[i] ?? ''];
    const number = rowNumber(tokens[i + 1] ?? '');
    if (letter && number && COLUMN_LETTERS.slice(0, 13).includes(letter)) result.add(`${letter}${number}`);
  }
  return [...result];
};
type IntentArgs = { coord?: string; my_color?: 'black' | 'white'; rank?: string; komi?: number };

// Намерение определяет модель по контексту, а не список разрешённых оборотов речи.
// Здесь только сверка явно распознанных координат. Самоисправление может
// содержать несколько координат; выбор последней намеренной делает модель.
// Незнакомое произношение не запрещаем: модель может понять его лучше парсера.
export function mutationArgumentsMatch(intent: MutationIntent, utterance: string, args: IntentArgs = {}): boolean {
  if (!canonical(utterance)) return false;
  if ((intent === 'play_move' || intent === 'correct_last_move') && args.coord) {
    const coords = coordinatesIn(utterance);
    return coords.length === 0 || coords.includes(args.coord.toUpperCase());
  }
  return true;
}

export class IntentLedger {
  private turns: Turn[] = [];
  private nextTurnId = 1;
  private listeners = new Set<() => void>();
  private keys = new Set<string>();

  add(text: string, key?: string | null): number | null {
    const normalized = normalize(cleanSpeechTranscript(text));
    if (!normalized) return null;
    if (key && this.keys.has(key)) return null;
    if (key) this.keys.add(key);
    const turn = { turnId: this.nextTurnId++, text: normalized, used: false, at: Date.now() };
    this.turns.push(turn);
    if (this.turns.length > 32) this.turns.shift();
    if (this.keys.size > 64) this.keys = new Set([...this.keys].slice(-32));
    for (const notify of this.listeners) notify();
    return turn.turnId;
  }

  async consume(intent: MutationIntent, utterance: string, args: IntentArgs = {}, timeoutMs = 1_500, signal?: AbortSignal): Promise<IntentResult> {
    if (signal?.aborted) return { ok: false, reason: 'разговор уже завершён' };
    const expected = canonical(utterance);
    const find = (): Turn[] | undefined => {
      const tail: Turn[] = [];
      for (const turn of this.turns.slice(-4).reverse()) {
        if (turn.used || tail.length && Date.now() - turn.at > 8_000) break;
        tail.unshift(turn);
        if (canonical(tail.map(t => t.text).join(' ')) === expected) return tail;
      }
      return undefined;
    };
    let turn = find();
    if (!turn && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); this.listeners.delete(notify); signal?.removeEventListener('abort', done); resolve(); };
        const notify = () => done();
        const timer = setTimeout(done, timeoutMs);
        this.listeners.add(notify);
        signal?.addEventListener('abort', done, { once: true });
      });
      turn = find();
    }
    if (signal?.aborted) return { ok: false, reason: 'разговор уже завершён' };
    if (!turn) return { ok: false, reason: 'не удалось подтвердить последнюю команду человека: попроси повторить её' };
    for (const part of turn) part.used = true;
    // Смысл определяет модель; код сверяет аргумент с исходной репликой.
    if (!mutationArgumentsMatch(intent, turn.map(t => t.text).join(' '), args)) return { ok: false, reason: 'координата действия не совпадает с названной человеком' };
    return { ok: true, turnId: turn.at(-1)!.turnId };
  }
}
