// Минимальный SGF: одна ветка, заголовок и ходы. Координаты SGF: буквы a.., строки сверху.
import { formatCoord, parseCoord } from './coords.ts';
import type { MoveInput } from './replay.ts';

export type SgfGame = {
  size: number;
  komi: number;
  rules?: string;
  black?: string;
  white?: string;
  result?: string;
  moves: MoveInput[];
};

const SGF_LETTERS = 'abcdefghijklmnopqrs';

export function toSgfPoint(coord: string, size: number): string {
  const p = parseCoord(coord, size);
  if (p === 'pass') return '';
  return SGF_LETTERS.charAt(p.col) + SGF_LETTERS.charAt(size - 1 - p.row);
}

export function fromSgfPoint(text: string, size: number): string {
  if (text === '' || (size < 20 && text === 'tt')) return 'pass';
  const col = SGF_LETTERS.indexOf(text.charAt(0));
  const rowFromTop = SGF_LETTERS.indexOf(text.charAt(1));
  if (col < 0 || rowFromTop < 0) throw new Error(`bad sgf point "${text}"`);
  // Координаты приходят извне: за доску они выйти не должны, иначе formatCoord
  // бросит невнятную ошибку про диапазон букв.
  if (col >= size || rowFromTop >= size) throw new Error(`sgf point "${text}" is outside the ${size}x${size} board`);
  return formatCoord({ col, row: size - 1 - rowFromTop });
}

function escapeValue(s: string): string {
  return s.replace(/[\]\\]/g, (c) => `\\${c}`);
}

export function toSgf(g: SgfGame): string {
  const head = ['FF[4]', 'GM[1]', 'CA[UTF-8]', `SZ[${g.size}]`, `KM[${g.komi}]`, `RU[${escapeValue(g.rules ?? 'Chinese')}]`];
  if (g.black) head.push(`PB[${escapeValue(g.black)}]`);
  if (g.white) head.push(`PW[${escapeValue(g.white)}]`);
  if (g.result) head.push(`RE[${escapeValue(g.result)}]`);
  const moves = g.moves.map((m) => `;${m.color}[${toSgfPoint(m.coord, g.size)}]`).join('');
  return `(;${head.join('')}${moves})`;
}

export function fromSgf(text: string): SgfGame {
  const game: SgfGame = { size: 19, komi: 7.5, moves: [] };
  const re = /([A-Z]+)((?:\[(?:\\.|[^\]])*\])+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const id = m[1] ?? '';
    const values = [...(m[2] ?? '').matchAll(/\[((?:\\.|[^\]])*)\]/g)].map((v) => (v[1] ?? '').replace(/\\(.)/g, '$1'));
    const v = values[0] ?? '';
    switch (id) {
      case 'SZ':
        game.size = Number(v);
        break;
      case 'KM':
        game.komi = Number(v);
        break;
      case 'RU':
        game.rules = v;
        break;
      case 'PB':
        game.black = v;
        break;
      case 'PW':
        game.white = v;
        break;
      case 'RE':
        game.result = v;
        break;
      case 'B':
      case 'W':
        game.moves.push({ color: id, coord: fromSgfPoint(v, game.size) });
        break;
      default:
        break;
    }
  }
  return game;
}
