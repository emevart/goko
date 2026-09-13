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
    // Свой таймер вместо AbortSignal.timeout: внутренний таймер сигнала не подменяется
    // фейковыми таймерами, и тесты о времени пришлось бы писать на настоящих паузах.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(`engine did not respond within ${timeoutMs} ms`, 'TimeoutError')), timeoutMs);
    // Отказ по таймауту: и когда не пришли заголовки, и когда застряло тело. Стоит повтора.
    const timedOut = () => new AttemptError(true, new ApiError('engine_busy', `engine did not respond within ${timeoutMs} ms`));
    // Таймер снимается только после чтения тела: заголовки без тела иначе
    // оставили бы запрос без дедлайна, и ждал бы его только внутренний таймаут fetch.
    try {
      let res: Response;
      try {
        res = await fetchFn(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-engine-key': opts.engineKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        // Прерывание по таймауту даёт DOMException с name 'TimeoutError'; всё остальное —
        // движок недоступен. Обе причины стоят повтора.
        if (e instanceof Error && e.name === 'TimeoutError') throw timedOut();
        throw new AttemptError(true, new ApiError('engine_unavailable', `engine is unreachable: ${e instanceof Error ? e.message : String(e)}`));
      }
      if (res.ok) {
        try {
          return schema.parse(await res.json());
        } catch (e) {
          if (controller.signal.aborted) throw timedOut();
          // Мусор в успешном ответе уходит наружу как ApiError, а не сырым ZodError:
          // сырой попал бы в событие error целиком и в HTTP-слое стал бы 500 вместо 503.
          // Повтор не ставится: тело разобралось бы так же и со второй попытки.
          const detail = e instanceof Error ? e.message : String(e);
          throw new AttemptError(false, new ApiError('engine_unavailable', `engine response does not match the protocol: ${detail.slice(0, 200)}`));
        }
      }
      const text = await res.text().catch(() => '');
      if (controller.signal.aborted) throw timedOut();
      const api = apiErrorFromBody(text, res.status) ?? new ApiError('engine_unavailable', `engine responded with ${res.status}`);
      // Повторяем только 5xx: 4xx повторять бессмысленно, запрос не изменится.
      throw new AttemptError(res.status >= 500, api);
    } finally {
      clearTimeout(timer);
    }
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
