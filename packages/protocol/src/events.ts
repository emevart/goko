// События SSE (раздел 5 спеки). На проводе: `event: <type>` и `data: <JSON всего объекта>`.
import { z } from 'zod';
import { By, Color, GameState, Result, Via } from './game.ts';

// Ровно девять причин. Автоматический счёт после двух пасов публикуется с причиной 'pass'.
export const StateCause = z.enum(['play', 'pass', 'undo', 'correct', 'rank', 'engine', 'resign', 'new', 'sync']);
export type StateCause = z.infer<typeof StateCause>;

export const GameEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.game'), gameId: z.string() }),
  z.object({ type: z.literal('state.updated'), state: GameState, cause: StateCause, by: By, via: Via.optional() }),
  z.object({ type: z.literal('engine.thinking'), color: Color }),
  z.object({ type: z.literal('game.finished'), result: Result }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type GameEvent = z.infer<typeof GameEvent>;
