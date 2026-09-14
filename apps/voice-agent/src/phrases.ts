// Русские формулировки для модели и событий. Всё, что Гоко говорит о партии словами, собрано здесь,
// чтобы модель не переводила коды и не придумывала форму слов.
import { speakCoord } from '@goko/go-core';
import { type Color, RANKS, type Rank, type Result } from '@goko/protocol';

export const colorName = (c: Color): string => (c === 'B' ? 'чёрные' : 'белые');
export const colorNameInstrumental = (c: Color): string => (c === 'B' ? 'чёрными' : 'белыми');

// «10 кю», «10k», «3 дан», «3d», «1-й дан» -> Rank; null, если не разобрали или ранга нет в списке.
// Конец слова — просмотр вперёд по буквам и цифрам Unicode: \b в JS знает только [A-Za-z0-9_]
// и после «кю» или «дан» границы не видит.
export function parseRank(text: string): Rank | null {
  const m = /(\d{1,2})\s*(?:-?\s*(?:й|го|ый|ого))?\s*(k|kyu|кю|d|dan|дан)(?![\p{L}\p{N}])/iu.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const kyu = /^(k|kyu|кю)$/iu.test(m[2] ?? '');
  const rank = `${n}${kyu ? 'k' : 'd'}`;
  return (RANKS as readonly string[]).includes(rank) ? (rank as Rank) : null;
}

export function speakRank(rank: Rank): string {
  const n = Number(rank.slice(0, -1));
  return rank.endsWith('k') ? `${n} кю` : `${n} дан`;
}

// Ход для произношения: «дэ четыре», «пас». Правила произношения живут в go-core.
export const speakMove = (coord: string): string => speakCoord(coord);

// «1 очко», «2 очка», «5 очков», «5,5 очка».
export function formatPoints(n: number): string {
  const abs = Math.abs(n);
  const whole = Math.floor(abs);
  const fractional = abs !== whole;
  const text = fractional ? abs.toFixed(1).replace('.', ',') : String(whole);
  let word = 'очков';
  if (fractional) word = 'очка';
  else {
    const tens = whole % 100;
    const last = whole % 10;
    if (tens < 11 || tens > 14) {
      if (last === 1) word = 'очко';
      else if (last >= 2 && last <= 4) word = 'очка';
    }
  }
  return `${text} ${word}`;
}

const colorNameGenitive = (c: Color): string => (c === 'B' ? 'чёрных' : 'белых');

// Результат словами Гоко: «я» — Гоко, «ты» — человек, без рода для человека.
// humanColor = null — партия двух людей (D-0005): Гоко не участник, называем цвета.
export function describeResult(result: Result, humanColor: Color | null): string {
  if (humanColor === null) {
    const loser: Color = result.winner === 'B' ? 'W' : 'B';
    const who = `победа ${colorNameGenitive(result.winner)}`;
    if (result.reason === 'resign') return `${who}: ${colorName(loser)} сдались`;
    return `${who}, разница ${formatPoints(result.margin ?? 0)}`;
  }
  const humanWon = result.winner === humanColor;
  const who = humanWon ? 'победа за тобой' : 'победа за мной';
  if (result.reason === 'resign') return `${who}: ${humanWon ? 'я сдался' : 'партия сдана'}`;
  return `${who}, разница ${formatPoints(result.margin ?? 0)}`;
}
