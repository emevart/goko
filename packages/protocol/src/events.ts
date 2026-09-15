// События SSE (раздел 5 спеки). На проводе: `event: <type>` и `data: <JSON всего объекта>`.
import { z } from 'zod';
import { By, Color, GameState, Result, Via } from './game.ts';
import { EngineDecision } from './engine.ts';

// Ровно десять причин. Автоматический счёт после двух пасов публикуется с причиной 'pass'.
export const StateCause = z.enum(['play', 'pass', 'undo', 'redo', 'correct', 'rank', 'engine', 'resign', 'new', 'sync']);
export type StateCause = z.infer<typeof StateCause>;

export const GameEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.game'), gameId: z.string() }),
  // humanFallback — только у хода движка (cause 'engine'): ход взят из поиска, а не из человеческой сети.
  z.object({ type: z.literal('state.updated'), state: GameState, cause: StateCause, by: By, via: Via.optional(), humanFallback: z.boolean().optional(), engineDecision: EngineDecision.optional() }),
  // gameId у engine.thinking и error: поток сессии шлёт события только текущей партии, но клиент
  // всё равно может сверить событие с партией, которую показывает.
  z.object({ type: z.literal('engine.thinking'), gameId: z.string(), color: Color }),
  z.object({ type: z.literal('game.finished'), result: Result }),
  z.object({ type: z.literal('error'), gameId: z.string(), code: z.string(), message: z.string() }),
]);
export type GameEvent = z.infer<typeof GameEvent>;
