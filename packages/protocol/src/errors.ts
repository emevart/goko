// Коды ошибок и HTTP-статусы (раздел 5 спеки). Одна таблица на сервер и клиентов.
import { z } from 'zod';

export const ERROR_CODES = [
  'invalid_coord',
  'illegal_move',
  'not_your_turn',
  'game_finished',
  'nothing_to_undo',
  'revision_conflict',
  'engine_busy',
  'engine_unavailable',
  'unsupported_controller',
  'not_found',
  'bad_request',
  'limit_reached',
  'unauthorized',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_coord: 400,
  illegal_move: 400,
  unsupported_controller: 400,
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  not_your_turn: 409,
  game_finished: 409,
  nothing_to_undo: 409,
  revision_conflict: 409,
  limit_reached: 429,
  internal: 500,
  engine_busy: 503,
  engine_unavailable: 503,
};

export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

// Разбор тела ответа с ошибкой в ApiError: одна реализация на клиент сервера и клиент движка.
// null — тело не по протоколу; что делать со статусом, решает вызывающий (HttpError или engine_unavailable).
export function apiErrorFromBody(body: string, status: number): ApiError | null {
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(body));
    if (parsed.success) return new ApiError(parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
  } catch {
    // не JSON: null, дальше по статусу
  }
  return null;
}

// Ответ не по протоколу (прокси, падение): статус и сырое тело.
export class HttpError extends Error {
  readonly status: number;
  readonly body?: string;

  constructor(status: number, body?: string) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}
