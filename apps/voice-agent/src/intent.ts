import { COLUMN_LETTERS, COLUMN_NAMES_RU, normalizeCoordText } from '@goko/go-core';
import { parseRank } from './phrases.ts';

export type MutationIntent = 'start_game' | 'play_move' | 'correct_last_move' | 'pass' | 'resign' | 'undo' | 'redo' | 'set_rank';
type Turn = { turnId: number; text: string; used: boolean };
type IntentResult = { ok: true; turnId: number } | { ok: false; reason: string };

const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
const hasPhrase = (text: string, phrases: string[]): boolean => phrases.some((phrase) => text === phrase || text.startsWith(`${phrase} `) || text.includes(` ${phrase} `) || text.endsWith(` ${phrase}`));
const hypothetical = (text: string): boolean => text.includes('?') || hasPhrase(text, ['если', 'а если', 'что если', 'стоит ли', 'как насчет', 'как насчёт', 'может быть', 'не пойти ли', 'сравни', 'подскажи', 'посоветуй']);
const reported = (text: string): boolean => /(?:^|\s)(?:не\s+(?:став|ход|игр|сыгр|пас|отмен|возвращ|верн|исправ|поправ|сда|начин|начн)|как\s+(?:поставить|сыграть|сходить)|я\s+(?:поставил|сыграл|сходил|отменил|вернул|начал)|ты\s+(?:сказал|говорил)|он\s+(?:сказал|говорил)|она\s+(?:сказала|говорила))(?:\S*\s|\S*$)/u.test(text);
const numberValues: Record<string, string> = { один: '1', два: '2', три: '3', четыре: '4', пять: '5', шесть: '6', семь: '7', восемь: '8', девять: '9', десять: '10', одиннадцать: '11', двенадцать: '12', тринадцать: '13', четырнадцать: '14', пятнадцать: '15', шестнадцать: '16', семнадцать: '17', восемнадцать: '18', девятнадцать: '19' };
const letterValues: Record<string, string> = Object.fromEntries(Object.entries(COLUMN_NAMES_RU).flatMap(([letter, name]) => [[name, letter], [letter.toLocaleLowerCase('ru-RU'), letter]]));
Object.assign(letterValues, { эй: 'A', би: 'B', си: 'C', се: 'C', ди: 'D', джи: 'G', ха: 'H', кей: 'K' });
const words = (text: string): string[] => normalize(text).replace(/[.,!?;:()[\]«»"']/g, ' ').split(/\s+/u).filter(Boolean);
const coordinatesIn = (text: string): string[] => {
  const tokens = words(text);
  const result = new Set<string>();
  for (const token of tokens) {
    const compact = normalizeCoordText(token);
    if (/^[A-HJ-N]\d{1,2}$/u.test(compact)) result.add(compact);
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    const letter = letterValues[tokens[i] ?? ''];
    const number = numberValues[tokens[i + 1] ?? ''];
    if (letter && number && COLUMN_LETTERS.slice(0, 13).includes(letter)) result.add(`${letter}${number}`);
  }
  return [...result];
};
const isBareCoordinate = (text: string): boolean => words(text).length <= 2 && coordinatesIn(text).length === 1;

type IntentArgs = { coord?: string; my_color?: 'black' | 'white'; rank?: string; komi?: number };

export function intentMatches(intent: MutationIntent, utterance: string, args: IntentArgs = {}): boolean {
  const text = normalize(utterance);
  if (!text || hypothetical(text) || reported(text)) return false;
  switch (intent) {
    case 'play_move': {
      const explicit = isBareCoordinate(text) || /(?:^|\s)(?:поставь|сыграй|сходи|ходи)(?:\s|$)|(?:^|\s)мой\s+ход(?:\s|$)/u.test(text);
      return explicit && (!args.coord || coordinatesIn(text).includes(args.coord.toUpperCase()));
    }
    case 'correct_last_move': {
      const explicit = /(?:^|\s)(?:поправь|исправь|точнее)(?:\s|$)|^нет[, ]+[^?]+$/u.test(text);
      return explicit && (!args.coord || coordinatesIn(text).includes(args.coord.toUpperCase()));
    }
    case 'start_game': {
      if (!/(новая\s+партия|давай\s+(?:сыграем|партию)|начн[её]м|начать\s+партию)/u.test(text)) return false;
      const saysBlack = /(ч[её]рн|black)/u.test(text);
      const saysWhite = /(бел|white)/u.test(text);
      if (args.my_color === 'black' && saysWhite || args.my_color === 'white' && !saysWhite || saysBlack && args.my_color === 'white') return false;
      if (args.rank && parseRank(text) !== parseRank(args.rank)) return false;
      if (args.komi !== undefined) {
        const said = /(?:^|\s)коми\s+(\d{1,2}(?:[.,]\d+)?)(?:\s|[.!?,]|$)/u.exec(text)?.[1];
        if (said ? Number(said.replace(',', '.')) !== args.komi : args.komi !== 7.5) return false;
      }
      return true;
    }
    case 'pass': return /^(?:я\s+)?пас(?:ую)?[.!]?$/u.test(text);
    case 'resign': return /^(?:я\s+)?(?:сдаюсь|сдаю\s+партию|хочу\s+сдаться)[.!]?$/u.test(text);
    case 'undo': return /(?:^|\s)(?:отмени|отменить|верни\s+ход|ход\s+назад)(?:[.!]|$)/u.test(text);
    case 'redo': return /(верни\s+отмен[её]н|повтори\s+отмен[её]н|впер[её]д)/u.test(text);
    case 'set_rank': return /(играй|уровень|ранг|слабее|сильнее)/u.test(text) && (!args.rank || parseRank(text) === parseRank(args.rank));
  }
}

export class IntentLedger {
  private turns: Turn[] = [];
  private nextTurnId = 1;
  private listeners = new Set<() => void>();
  private keys = new Set<string>();

  add(text: string, key?: string | null): number | null {
    const normalized = normalize(text);
    if (!normalized) return null;
    if (key && this.keys.has(key)) return null;
    if (key) this.keys.add(key);
    const turn = { turnId: this.nextTurnId++, text: normalized, used: false };
    this.turns.push(turn);
    if (this.turns.length > 32) this.turns.shift();
    if (this.keys.size > 64) this.keys = new Set([...this.keys].slice(-32));
    for (const notify of this.listeners) notify();
    return turn.turnId;
  }

  async consume(intent: MutationIntent, utterance: string, args: IntentArgs = {}, timeoutMs = 1_500, signal?: AbortSignal): Promise<IntentResult> {
    if (signal?.aborted) return { ok: false, reason: 'разговор уже завершён' };
    const expected = normalize(utterance);
    const find = (): Turn | undefined => {
      const latest = this.turns.at(-1);
      return latest && !latest.used && latest.text === expected ? latest : undefined;
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
    turn.used = true;
    if (!intentMatches(intent, utterance, args)) return { ok: false, reason: 'эта реплика не является явной игровой командой с указанными параметрами' };
    return { ok: true, turnId: turn.turnId };
  }
}
