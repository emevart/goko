// Операции протокола (таблица раздела 5 спеки): тела запросов и ответов.
// Схемы запросов строгие (z.strictObject): неизвестный ключ — всегда ошибка, потому что
// аргументы формируют наши же клиенты, в том числе языковая модель голосового агента,
// и опечатка вроде `expectedRevison` иначе молча снимает защиту от гонки голоса и тапа.
// Схемы ответов и событий остаются нестрогими: старый клиент должен переживать
// добавление полей на сервере.
import { z } from 'zod';
import { BoardSize, Color, GameState, GameSummary, Komi, Move, Rank, Seat, Session, Via } from './game.ts';

// settings описаны явно как optional, а не GameSettings.partial(): в zod 4 partial() сохраняет default,
// и тогда клиент не смог бы отличить «не прислали» от «прислали 13».
export const NewGameRequest = z.strictObject({
  black: Seat,
  white: Seat,
  settings: z
    .strictObject({ boardSize: BoardSize.optional(), rules: z.literal('chinese').optional(), komi: Komi.optional() })
    .optional(),
  waitForReply: z.boolean().default(true),
});
export type NewGameRequest = z.input<typeof NewGameRequest>;

export const NewGameResponse = z.object({
  state: GameState,
  firstMove: Move.optional(),
  replyTimedOut: z.literal(true).optional(),
});
export type NewGameResponse = z.infer<typeof NewGameResponse>;

export const PlayRequest = z.strictObject({
  coord: z.string().min(1).max(8),
  color: Color.optional(),
  expectedRevision: z.number().int().optional(),
  waitForReply: z.boolean().default(true),
  via: Via.default('api'),
});
export type PlayRequest = z.input<typeof PlayRequest>;

export const PassRequest = PlayRequest.omit({ coord: true });
export type PassRequest = z.input<typeof PassRequest>;

export const PlayResponse = z.object({
  state: GameState,
  move: Move,
  reply: Move.optional(),
  replyTimedOut: z.literal(true).optional(),
});
export type PlayResponse = z.infer<typeof PlayResponse>;

export const ResignRequest = z.strictObject({ color: Color, via: Via.default('api') });
export type ResignRequest = z.input<typeof ResignRequest>;

export const StateResponse = z.object({ state: GameState });
export type StateResponse = z.infer<typeof StateResponse>;

export const UndoRequest = z.strictObject({ expectedRevision: z.number().int().optional(), via: Via.default('api') });
export type UndoRequest = z.input<typeof UndoRequest>;

export const UndoResponse = z.object({ state: GameState, removed: z.array(Move) });
export type UndoResponse = z.infer<typeof UndoResponse>;

export const CorrectRequest = z.strictObject({
  coord: z.string().min(1).max(8),
  waitForReply: z.boolean().default(true),
  via: Via.default('api'),
});
export type CorrectRequest = z.input<typeof CorrectRequest>;

export const SetRankRequest = z.strictObject({ color: Color, rank: Rank });
export type SetRankRequest = z.input<typeof SetRankRequest>;

export const AnalyzeRequest = z.strictObject({ maxVisits: z.number().int().min(1).max(1000).default(50) });
export type AnalyzeRequest = z.input<typeof AnalyzeRequest>;

export const GroupInfo = z.object({
  color: Color,
  stones: z.array(z.string()),
  liberties: z.number().int(),
  ownershipAvg: z.number(),
  status: z.enum(['safe', 'unsettled', 'dead']),
});
export type GroupInfo = z.infer<typeof GroupInfo>;

export const Analysis = z.object({
  visits: z.number().int(),
  winrateB: z.number(),
  scoreLeadB: z.number(),
  topMoves: z.array(
    z.object({ coord: z.string(), winrateB: z.number(), scoreLeadB: z.number(), visits: z.number().int() }),
  ),
  ownership: z.array(z.number()),
  groups: z.array(GroupInfo),
});
export type Analysis = z.infer<typeof Analysis>;

export const CreateSessionResponse = z.object({
  session: Session,
  livekit: z.object({ url: z.string(), token: z.string() }),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const ListGamesResponse = z.object({ games: z.array(GameSummary) });
export type ListGamesResponse = z.infer<typeof ListGamesResponse>;

// Ответ score — Result из game.ts (без завершения партии).
