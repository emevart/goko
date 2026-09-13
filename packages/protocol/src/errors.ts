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
  // Серия повторов фоновой задачи исчерпана (только событие error; партия остаётся playing).
  'retries_exhausted',
  'unsupported_controller',
  'not_found',
  'bad_request',
  'limit_reached',
  // Лимит частоты запросов с одного адреса (D-0012); details.retryAfterSeconds и заголовок Retry-After.
  'rate_limited',
  // Слишком много незавершённых партий на сервере (D-0012); details.max.
  'too_many_games',
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
  rate_limited: 429,
  too_many_games: 429,
  internal: 500,
  engine_busy: 503,
  engine_unavailable: 503,
  retries_exhausted: 503,
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

  // options.cause — исходное исключение для лога; в тело ответа и в событие не попадает.
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
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

// Сервер не ответил за отведённое операции время (клиент, раздел 5 спеки). Код не из ERROR_CODES:
// сервер его не отдаёт, его рождает клиент; текст для человека — humanText('client_timeout').
export class ClientTimeoutError extends Error {
  readonly code = 'client_timeout';
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`client timeout: ${operation} did not finish in ${timeoutMs} ms`);
    this.name = 'ClientTimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

// Ответ не по протоколу (прокси, падение): статус и сырое тело.
export class HttpError extends Error {
  readonly status: number;
  readonly body?: string;

  // options.cause — исходная ошибка разбора (SyntaxError, ZodError), если ответ не разобрался.
  constructor(status: number, body?: string, options?: ErrorOptions) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`, options);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}
