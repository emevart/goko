import { COLUMN_LETTERS, COLUMN_NAMES_RU, normalizeCoordText } from '@goko/go-core';
import { cleanSpeechTranscript } from '@goko/protocol';

export type MutationIntent = 'start_game' | 'play_move' | 'correct_last_move' | 'pass' | 'resign' | 'undo' | 'redo' | 'set_rank';
type Turn = { turnId: number; text: string; intents: Set<MutationIntent>; at: number };
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

// Это не классификатор намерения: модель уже выбрала инструмент. Якоря нужны
// только для безопасного примирения короткой/слегка искажённой user_utterance с
// последней финальной расшифровкой, чтобы разговорная команда не превращалась в
// просьбу повторить её из-за «отмени»/«отмена» или пропавшего вводного слова.
const intentAnchors: Record<MutationIntent, readonly string[]> = {
  start_game: ['нов', 'нач', 'парт', 'игр', 'старт'],
  play_move: [],
  correct_last_move: ['исправ', 'поправ', 'точн'],
  pass: ['пас'],
  resign: ['сда', 'капитул'],
  undo: ['отмен', 'назад', 'откат', 'переигр'],
  redo: ['верн', 'впер', 'повтор'],
  set_rank: ['ранг', 'кю', 'дан'],
};
const fillerWords = new Set(['а', 'и', 'в', 'во', 'да', 'давай', 'же', 'ну', 'пожалуйста', 'просто', 'я', 'мне', 'можно', 'хочу', 'теперь', 'последний', 'ход', 'хода', 'ходов']);

const hasAnchor = (text: string, anchors: readonly string[]): boolean =>
  words(text).some((token) => anchors.some((anchor) => token.startsWith(anchor)));

const hasNegatedAnchor = (text: string, anchors: readonly string[]): boolean => {
  const tokens = words(text);
  return tokens.some((token, index) => {
    if (!['не', 'нет', 'ничего', 'никогда'].includes(token)) return false;
    return tokens.slice(index, index + 5).some((candidate) => anchors.some((anchor) => candidate.startsWith(anchor)));
  });
};

// Модель может передать в tool сокращённую реплику («D4», «отмена»), хотя
// финальный STT-текст был длиннее. Разрешаем только такой вариант, где уже
// выбранный аргумент подтверждается самой финальной репликой и смысловой якорь
// не отрицается. Полное совпадение IntentLedger по-прежнему проверяется первым.
function tolerantMutationMatch(intent: MutationIntent, turnText: string, utterance: string, args: IntentArgs): boolean {
  const actual = canonical(turnText);
  const requested = canonical(utterance);
  if (!actual || !requested || actual === requested) return actual === requested;
  if (intent === 'play_move' || intent === 'correct_last_move') {
    const target = args.coord?.toUpperCase();
    if (!target) return false;
    const actualCoords = coordinatesIn(actual);
    const requestedCoords = coordinatesIn(requested);
    return actualCoords.includes(target) && (requestedCoords.length === 0 || requestedCoords.includes(target));
  }
  const anchors = intentAnchors[intent];
  if (anchors.length === 0 || hasNegatedAnchor(actual, anchors) || !hasAnchor(actual, anchors)) return false;
  // Достаточно любого якоря этого уже выбранного инструмента: «отмотаем
  // назад» и «отмена», например, описывают одно действие разными словами.
  if (hasAnchor(requested, anchors)) return true;
  const actualWords = words(actual).filter((word) => !fillerWords.has(word));
  const requestedWords = words(requested).filter((word) => !fillerWords.has(word));
  return requestedWords.some((word) => actualWords.some((other) => word.length >= 4 && other.startsWith(word.slice(0, 4))));
}

const historyUnits = new Set(['шаг', 'шага', 'шагов', 'ход', 'хода', 'ходов', 'раз', 'порция', 'порции', 'порций']);
const historyCountWords: Record<string, number> = Object.fromEntries(
  Object.entries(numberValues)
    .filter(([, value]) => Number(value) <= 8)
    .map(([word, value]) => [word, Number(value)]),
);

// Извлекает число повторений для undo/redo только рядом с явным счётчиком;
// координаты и номера ходов сами по себе сюда не попадают. «Несколько» —
// короткая разговорная просьба на две порции.
export function historyCountIn(text: string): number | undefined {
  const tokens = words(text);
  if (tokens.includes('несколько')) return 2;
  for (let i = 0; i < tokens.length; i++) {
    const value = historyCountWords[tokens[i] ?? ''] ?? (/^\d+$/u.test(tokens[i] ?? '') ? Number(tokens[i]) : undefined);
    if (value === undefined || value < 1 || value > 8) continue;
    const nearby = tokens.slice(Math.max(0, i - 1), i + 4);
    if (nearby.some((token) => historyUnits.has(token)) || tokens[i - 1] === 'на' || tokens[i - 1] === 'по') return value;
  }
  return undefined;
}

function colorIn(text: string): 'black' | 'white' | null {
  const colors = words(text).filter((word) => word.startsWith('бел') || word.startsWith('черн') || word.startsWith('чёрн'));
  const last = colors.at(-1);
  return last ? (last.startsWith('бел') ? 'white' : 'black') : null;
}

// Намерение определяет модель по контексту, а не список разрешённых оборотов речи.
// Здесь только сверка явно распознанных координат. Самоисправление может
// содержать несколько координат; выбор последней намеренной делает модель.
// Незнакомое произношение не запрещаем: модель может понять его лучше парсера.
export function mutationArgumentsMatch(intent: MutationIntent, utterance: string, args: IntentArgs = {}): boolean {
  if (!canonical(utterance)) return false;
  if (intent === 'start_game' && args.my_color) {
    const explicit = colorIn(utterance);
    if (explicit && explicit !== args.my_color) return false;
  }
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
    const turn = { turnId: this.nextTurnId++, text: normalized, intents: new Set<MutationIntent>(), at: Date.now() };
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
        // Одна финальная реплика может содержать несколько действий (например,
        // «новая партия, я чёрными, первый ход D4»). Она подтверждает каждый
        // различный инструмент один раз, но повтор того же инструмента остаётся
        // заблокированным. Неполностью использованный turn не является барьером
        // для следующего действия этой же реплики.
        if (turn.intents.has(intent)) {
          if (tail.length === 0) return undefined;
          break;
        }
        if (tail.length && Date.now() - turn.at > 8_000) break;
        tail.unshift(turn);
        if (canonical(tail.map(t => t.text).join(' ')) === expected) return tail;
      }
      // Короткая user_utterance часто приходит из той же модели, но без
      // вводных слов. Примиряем её только с самым свежим финальным turn — так
      // случайное «угу» не воскресит старую команду через склейку turn'ов.
      const latest = this.turns.at(-1);
      if (latest && !latest.intents.has(intent) && Date.now() - latest.at <= 8_000 && tolerantMutationMatch(intent, latest.text, utterance, args)) return [latest];
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
    if (!turn) return { ok: false, reason: 'не удалось подтвердить последнюю команду человека' };
    // Смысл определяет модель; код сверяет аргумент с исходной репликой.
    if (!mutationArgumentsMatch(intent, turn.map(t => t.text).join(' '), args)) return { ok: false, reason: 'координата действия не совпадает с названной человеком' };
    for (const part of turn) part.intents.add(intent);
    return { ok: true, turnId: turn.at(-1)!.turnId };
  }
}
