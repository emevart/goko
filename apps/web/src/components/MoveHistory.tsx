import type { GameState } from '@goko/protocol';

export function MoveHistory({ state }: { state: GameState | null }) {
  const moves = state?.moves ?? [];
  return (
    <details className="move-history">
      <summary>История ходов{moves.length ? ` · ${moves.length}` : ''}</summary>
      {moves.length === 0 ? <p className="muted">Ходов пока нет</p> : (
        <ol>
          {moves.map((move, index) => (
            <li key={`${move.n}-${move.at}`} className={index === moves.length - 1 ? 'move-last' : ''}>
              <span className={`move-stone move-${move.color}`} aria-hidden="true" />
              <span>{move.color === 'B' ? 'Чёрные' : 'Белые'} · {move.coord === 'pass' ? 'пас' : move.coord}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
