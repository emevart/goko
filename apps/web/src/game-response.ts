import type { GameState } from '@goko/protocol';

// HTTP-ответ может прийти после undo/redo или смены партии. Применяем только состояние
// той же партии с ревизией не старше уже показанной.
export function guardedGameResponse(currentGameId: string | null, current: GameState | null, response: GameState): GameState | null {
  if (currentGameId !== response.id) return null;
  if (current && current.id === response.id && current.revision > response.revision) return null;
  return response;
}
