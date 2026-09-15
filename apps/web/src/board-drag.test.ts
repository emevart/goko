import { expect, it } from 'vitest';
import { BoardDrag } from './board-drag.ts';
it('выбирает при движении, ставит только при отпускании и не повторяет', () => {
  const drag = new BoardDrag();
  drag.start(1, 'g:4', 'D4');
  expect(drag.move(1,'K4')).toBe('K4');
  expect(drag.end(1,'g:4','K4')).toBe('K4');
  expect(drag.end(1,'g:4','K4')).toBeNull();
});
it('отмена, выход за доску и смена позиции не ставят камень', () => {
  const drag = new BoardDrag();
  drag.start(1,'g:4','D4'); expect(drag.end(1,'g:5','D4')).toBeNull();
  drag.start(1,'g:4','D4'); expect(drag.end(1,'g:4',null)).toBeNull();
  drag.start(1,'g:4','D4'); drag.cancel(); expect(drag.end(1,'g:4','D4')).toBeNull();
});
it('второй палец не перехватывает первый', () => {
  const drag = new BoardDrag();
  drag.start(1,'g:4','D4'); drag.start(2,'g:4','K4');
  expect(drag.end(2,'g:4','K4')).toBeNull();
  expect(drag.end(1,'g:4','D4')).toBe('D4');
});
