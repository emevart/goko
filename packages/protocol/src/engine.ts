// Внутренний протокол game-server -> go-engine (раздел 8 спеки). Всё с точки зрения чёрных.
import { z } from 'zod';
import { Color, Rank } from './game.ts';

export const EngineMove = z.tuple([Color, z.string()]);
export type EngineMove = z.infer<typeof EngineMove>;

export const EnginePositionRequest = z.object({
  boardSize: z.number().int().min(5).max(19),
  rules: z.literal('chinese'),
  komi: z.number(),
  moves: z.array(EngineMove),
});
export type EnginePositionRequest = z.infer<typeof EnginePositionRequest>;

export const EngineGenmoveRequest = EnginePositionRequest.extend({
  rank: Rank,
  maxVisits: z.number().int().min(1).max(1000).default(10),
});
export type EngineGenmoveRequest = z.input<typeof EngineGenmoveRequest>;

export const EngineGenmoveResponse = z.object({
  move: z.string(),
  winrateB: z.number(),
  scoreLeadB: z.number(),
  humanPolicyTop: z.array(z.object({ coord: z.string(), prob: z.number() })),
  ms: z.number(),
});
export type EngineGenmoveResponse = z.infer<typeof EngineGenmoveResponse>;

export const EngineAnalyzeRequest = EnginePositionRequest.extend({
  maxVisits: z.number().int().min(1).max(1000).default(50),
  includeOwnership: z.boolean().default(true),
});
export type EngineAnalyzeRequest = z.input<typeof EngineAnalyzeRequest>;

export const EngineMoveInfo = z.object({
  coord: z.string(),
  winrateB: z.number(),
  scoreLeadB: z.number(),
  visits: z.number().int(),
  order: z.number().int(),
});
export type EngineMoveInfo = z.infer<typeof EngineMoveInfo>;

export const EngineAnalyzeResponse = z.object({
  visits: z.number().int(),
  winrateB: z.number(),
  scoreLeadB: z.number(),
  moveInfos: z.array(EngineMoveInfo),
  ownership: z.array(z.number()).optional(),
});
export type EngineAnalyzeResponse = z.infer<typeof EngineAnalyzeResponse>;

export const EngineScoreRequest = EnginePositionRequest;
export type EngineScoreRequest = z.input<typeof EngineScoreRequest>;

export const EngineScoreResponse = z.object({
  ownership: z.array(z.number()),
  dead: z.array(z.string()),
  areaB: z.number(),
  areaW: z.number(),
  scoreLeadB: z.number(),
  winner: Color,
  margin: z.number(),
});
export type EngineScoreResponse = z.infer<typeof EngineScoreResponse>;

export const EngineHealth = z.object({
  ok: z.boolean(),
  models: z.object({ main: z.string(), human: z.string() }),
  queue: z.number().int(),
  restarts: z.number().int(),
});
export type EngineHealth = z.infer<typeof EngineHealth>;
