// Модель партии (раздел 4 спеки). Схемы zod — источник типов для всех клиентов.
import { z } from 'zod';

export const BoardSize = z.union([z.literal(9), z.literal(13), z.literal(19)]);
export type BoardSize = z.infer<typeof BoardSize>;

export const GameSettings = z.object({
  boardSize: BoardSize.default(13),
  rules: z.literal('chinese').default('chinese'),
  komi: z.number().default(7.5),
});
export type GameSettings = z.infer<typeof GameSettings>;

export const RANKS = [
  '20k', '19k', '18k', '17k', '16k', '15k', '14k', '13k', '12k', '11k',
  '10k', '9k', '8k', '7k', '6k', '5k', '4k', '3k', '2k', '1k',
  '1d', '2d', '3d', '4d', '5d', '6d', '7d', '8d', '9d',
] as const;
export const Rank = z.enum(RANKS);
export type Rank = z.infer<typeof Rank>;

export const Color = z.enum(['B', 'W']);
export type Color = z.infer<typeof Color>;

export const Controller = z.enum(['human', 'engine', 'external']);
export type Controller = z.infer<typeof Controller>;

export const Seat = z.object({
  controller: Controller,
  rank: Rank.optional(),
  label: z.string().max(40).optional(),
});
export type Seat = z.infer<typeof Seat>;

export const Move = z.object({
  n: z.number().int().min(1),
  color: Color,
  coord: z.string(), // 'D4' | 'pass'
  captured: z.number().int().min(0),
  at: z.string(), // ISO-время
});
export type Move = z.infer<typeof Move>;

export const Score = z.object({
  areaB: z.number(),
  areaW: z.number(),
  komi: z.number(),
  dead: z.array(z.string()),
  ownership: z.array(z.number()),
});
export type Score = z.infer<typeof Score>;

export const Result = z.object({
  winner: Color,
  margin: z.number().optional(),
  reason: z.enum(['score', 'resign']),
  score: Score.optional(),
});
export type Result = z.infer<typeof Result>;

export const GameStatus = z.enum(['playing', 'finished']);
export type GameStatus = z.infer<typeof GameStatus>;

export const GameState = z.object({
  id: z.string(),
  createdAt: z.string(),
  revision: z.number().int().min(0),
  settings: GameSettings,
  seats: z.object({ B: Seat, W: Seat }),
  status: GameStatus,
  toPlay: Color,
  moves: z.array(Move),
  board: z.string(),
  captures: z.object({ B: z.number().int().min(0), W: z.number().int().min(0) }),
  ko: z.string().nullable(),
  consecutivePasses: z.number().int().min(0),
  pendingEngineMove: z.boolean(),
  result: Result.optional(),
}).superRefine((value, ctx) => {
  // Инвариант раздела 4 спеки: доска — строка из boardSize^2 символов '.', 'B', 'W'.
  // Без него ответ, потерявший settings.boardSize, молча становится партией 13x13.
  const expectedLength = value.settings.boardSize ** 2;
  if (value.board.length !== expectedLength) {
    const message =
      `длина board ${value.board.length} не совпадает с boardSize ${value.settings.boardSize}` +
      ` (ожидается ${expectedLength})`;
    ctx.addIssue({ code: 'custom', path: ['board'], message });
  }
  if (!/^[.BW]*$/.test(value.board)) {
    ctx.addIssue({ code: 'custom', path: ['board'], message: "board содержит символы вне '.', 'B', 'W'" });
  }
});
export type GameState = z.infer<typeof GameState>;

export const GameSummary = z.object({
  id: z.string(),
  createdAt: z.string(),
  status: GameStatus,
  moveCount: z.number().int().min(0),
  seats: z.object({ B: Seat, W: Seat }),
  result: Result.optional(),
});
export type GameSummary = z.infer<typeof GameSummary>;

export const Session = z.object({
  id: z.string(),
  room: z.string(),
  currentGameId: z.string().nullable(),
  createdAt: z.string(),
});
export type Session = z.infer<typeof Session>;

export const Via = z.enum(['voice', 'tap', 'api']);
export type Via = z.infer<typeof Via>;

export const By = z.enum(['human', 'engine', 'external', 'system']);
export type By = z.infer<typeof By>;
