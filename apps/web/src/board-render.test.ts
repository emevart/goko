import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { coordToIndex, withCells } from '@goko/go-core';
import type { GameState } from '@goko/protocol';
import { Board } from './components/Board.tsx';

it('объёмные камни сохраняют контрастную последнюю метку, территорию и мёртвые камни', () => {
  const ownership = Array(169).fill(0);
  ownership[coordToIndex('E5', 13)] = 1;
  ownership[coordToIndex('K11', 13)] = -1;
  const state: GameState = { id: 'g1', createdAt: '2026-10-05T00:00:00Z', revision: 2,
    settings: { boardSize: 13, rules: 'chinese', komi: 7.5 },
    seats: { B: { controller: 'human' }, W: { controller: 'engine' } },
    status: 'finished', toPlay: 'B', captures: { B: 0, W: 0 }, ko: null,
    consecutivePasses: 2, pendingEngineMove: false, canRedo: false,
    board: withCells('.'.repeat(169), [[coordToIndex('D4', 13), 'B'], [coordToIndex('K10', 13), 'W']]),
    moves: [{ n: 1, color: 'B', coord: 'D4', captured: 0, at: 't' }, { n: 2, color: 'W', coord: 'K10', captured: 0, at: 't' }],
    result: { winner: 'W', margin: 7.5, reason: 'score', score: { ownership, dead: ['D4'], areaB: 2, areaW: 2, komi: 7.5 } },
  };
  const markup = renderToStaticMarkup(createElement(Board, { state, size: 13, onTap: () => {} }));
  expect(markup).toContain('последний ход K10');
  for (const layer of ['stone-b', 'stone-w', 'mark-on-w', 'territory-b', 'territory-w', 'dead']) expect(markup).toContain(`class="${layer}"`);
  expect(markup).not.toContain('class="mark-on-b"');
  const empty = renderToStaticMarkup(createElement(Board, { state: null, size: 13, onTap: () => {} }));
  expect(empty).not.toContain('class="mark-on-w"');
  expect(empty).not.toContain('class="territory-b"');
});
