// Клиент go-engine (раздел 7 спеки): таймауты genmove 10 с, analyze 15 с, score 30 с; один повтор.
import type { z } from 'zod';
import {
  ApiError,
  type EngineAnalyzeRequest,
  EngineAnalyzeResponse,
  type EngineGenmoveRequest,
  EngineGenmoveResponse,
  type EngineScoreRequest,
  EngineScoreResponse,
  apiErrorFromBody,
} from '@goko/protocol';

export interface Engine {
  genmove(req: EngineGenmoveRequest): Promise<EngineGenmoveResponse>;
  analyze(req: EngineAnalyzeRequest): Promise<EngineAnalyzeResponse>;
  score(req: EngineScoreRequest): Promise<EngineScoreResponse>;
}

export type EngineClientOptions = {
  baseUrl: string;
  engineKey: string;
  fetch?: typeof globalThis.fetch;
  timeouts?: { genmove: number; analyze: number; score: number };
  retryDelayMs?: number;
};

export const ENGINE_TIMEOUTS = { genmove: 10_000, analyze: 15_000, score: 30_000 };
export const ENGINE_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Ошибка одной попытки: retry — стоит ли повторять.
class AttemptError extends Error {
  readonly retry: boolean;
  readonly api: ApiError;

  constructor(retry: boolean, api: ApiError) {
    super(api.message);
    this.name = 'AttemptError';
    this.retry = retry;
    this.api = api;
  }
}

export function createEngineClient(opts: EngineClientOptions): Engine {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeouts = opts.timeouts ?? ENGINE_TIMEOUTS;
  const retryDelay = opts.retryDelayMs ?? ENGINE_RETRY_DELAY_MS;

  async function attempt<T extends z.ZodType>(path: string, body: unknown, timeoutMs: number, schema: T): Promise<z.output<T>> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-engine-key': opts.engineKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Прерывание по таймауту даёт DOMException с name 'TimeoutError'; всё остальное —
      // движок недоступен. Обе причины стоят повтора.
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      const api = timeout
        ? new ApiError('engine_busy', `engine did not respond within ${timeoutMs} ms`)
        : new ApiError('engine_unavailable', `engine is unreachable: ${e instanceof Error ? e.message : String(e)}`);
      throw new AttemptError(true, api);
    }
    if (res.ok) return schema.parse(await res.json());
    const text = await res.text().catch(() => '');
    const api = apiErrorFromBody(text, res.status) ?? new ApiError('engine_unavailable', `engine responded with ${res.status}`);
    // Повторяем только 5xx: 4xx повторять бессмысленно, запрос не изменится.
    throw new AttemptError(res.status >= 500, api);
  }

  async function withRetry<T extends z.ZodType>(path: string, body: unknown, timeoutMs: number, schema: T): Promise<z.output<T>> {
    try {
      return await attempt(path, body, timeoutMs, schema);
    } catch (e) {
      if (!(e instanceof AttemptError)) throw e;
      if (!e.retry) throw e.api;
      await sleep(retryDelay);
      try {
        return await attempt(path, body, timeoutMs, schema);
      } catch (e2) {
        if (e2 instanceof AttemptError) throw e2.api;
        throw e2;
      }
    }
  }

  return {
    genmove: (req) => withRetry('/v1/genmove', req, timeouts.genmove, EngineGenmoveResponse),
    analyze: (req) => withRetry('/v1/analyze', req, timeouts.analyze, EngineAnalyzeResponse),
    score: (req) => withRetry('/v1/score', req, timeouts.score, EngineScoreResponse),
  };
}
