// Клиент go-engine (раздел 7 спеки): таймауты genmove 10 с, analyze 8 с, score 18 с (D-0010).
// Повтор один и только у genmove: на ошибку соединения до ответа, не на таймаут и не после отмены.
import type { z } from 'zod';
import {
  ApiError,
  type EngineAnalyzeRequest,
  EngineAnalyzeResponse,
  type EngineGenmoveRequest,
  EngineGenmoveResponse,
  type EngineScoreRequest,
  type ErrorCode,
  EngineScoreResponse,
  apiErrorFromBody,
} from '@goko/protocol';

// signal — отмена вызывающим (дедлайн сервиса, смена партии в сессии, остановка). После отмены
// вызов отказывает с причиной сигнала, а не ApiError: результат отменённого вызова никому не нужен.
export interface Engine {
  genmove(req: EngineGenmoveRequest, signal?: AbortSignal): Promise<EngineGenmoveResponse>;
  analyze(req: EngineAnalyzeRequest, signal?: AbortSignal): Promise<EngineAnalyzeResponse>;
  score(req: EngineScoreRequest, signal?: AbortSignal): Promise<EngineScoreResponse>;
}

export type EngineClientOptions = {
  baseUrl: string;
  engineKey: string;
  fetch?: typeof globalThis.fetch;
  timeouts?: { genmove: number; analyze: number; score: number };
  retryDelayMs?: number;
};

// Правило «движок < клиент < сервис» (D-0010): go-engine 8/6/15 с, клиент 10/8/18 с, сервис analyze 10 с и score 20 с.
export const ENGINE_TIMEOUTS = { genmove: 10_000, analyze: 8_000, score: 18_000 };
export const ENGINE_RETRY_DELAY_MS = 200;

// Коды go-engine, которые проходят в публичный API как свои; остальные становятся internal.
const PASSED_ENGINE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['engine_busy', 'engine_unavailable']);

// Ошибки соединения до ответа: отказ в подключении, сброс, сокет закрыт до заголовков (undici).
// Запрос до движка не дошёл или не начал выполняться, поэтому повтор genmove безопасен.
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET']);
const MAX_CAUSE_DEPTH = 5;

// Код ищется по цепочке cause и в AggregateError (подключение по нескольким адресам): fetch бросает
// TypeError('fetch failed'), а системная ошибка лежит глубже.
export function isConnectionError(e: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true;
  const errors = (e as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.some((inner) => isConnectionError(inner, depth + 1))) return true;
  return isConnectionError((e as { cause?: unknown }).cause, depth + 1);
}

// Пауза перед повтором, прерываемая отменой: после abort второй попытки не будет.
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Ошибка одной попытки: connection — отказ соединения до ответа (единственный повод для повтора).
class AttemptError extends Error {
  readonly connection: boolean;
  readonly api: ApiError;

  constructor(connection: boolean, api: ApiError) {
    super(api.message);
    this.name = 'AttemptError';
    this.connection = connection;
    this.api = api;
  }
}

export function createEngineClient(opts: EngineClientOptions): Engine {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeouts = opts.timeouts ?? ENGINE_TIMEOUTS;
  const retryDelay = opts.retryDelayMs ?? ENGINE_RETRY_DELAY_MS;

  async function attempt<T extends z.ZodType>(path: string, body: unknown, timeoutMs: number, schema: T, external: AbortSignal | undefined): Promise<z.output<T>> {
    external?.throwIfAborted();
    // Свой таймер вместо AbortSignal.timeout: внутренний таймер сигнала не подменяется
    // фейковыми таймерами, и тесты о времени пришлось бы писать на настоящих паузах.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(`engine did not respond within ${timeoutMs} ms`, 'TimeoutError')), timeoutMs);
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    // Прерывание узнаётся по своим сигналам, а не по ошибке fetch: fetch вправе отдать свою
    // ошибку вместо причины сигнала. Таймаут — engine_busy без повтора, отмена — причина сигнала.
    const interrupted = (): unknown => {
      if (controller.signal.aborted) return new AttemptError(false, new ApiError('engine_busy', `engine did not respond within ${timeoutMs} ms`));
      if (external?.aborted) return external.reason;
      return undefined;
    };
    // Таймер снимается только после чтения тела: заголовки без тела иначе
    // оставили бы запрос без дедлайна, и ждал бы его только внутренний таймаут fetch.
    try {
      let res: Response;
      try {
        res = await fetchFn(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-engine-key': opts.engineKey },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        const stop = interrupted();
        if (stop !== undefined) throw stop;
        // Текст исключения fetch несёт адрес движка: наружу фиксированный текст, исходное — в cause для лога.
        throw new AttemptError(isConnectionError(e), new ApiError('engine_unavailable', 'engine is unreachable', undefined, { cause: e }));
      }
      if (res.ok) {
        try {
          return schema.parse(await res.json());
        } catch (e) {
          const stop = interrupted();
          if (stop !== undefined) throw stop;
          // Мусор в успешном ответе уходит наружу как ApiError, а не сырым ZodError:
          // сырой попал бы в событие error целиком и в HTTP-слое стал бы 500 вместо 503.
          // Текст ZodError — только в cause.
          throw new AttemptError(false, new ApiError('engine_unavailable', 'engine response does not match the protocol', undefined, { cause: e }));
        }
      }
      const text = await res.text().catch(() => '');
      const stop = interrupted();
      if (stop !== undefined) throw stop;
      // Ошибка go-engine по протоколу. message и details go-engine берёт из чужого исключения (путь
      // к модели, текст KataGo), поэтому наружу только код в фиксированном тексте, исходное — в cause.
      // Своим кодом проходят лишь занятость и недоступность движка. unauthorized, bad_request и
      // internal go-engine — дефект нашей стороны (ключ, схема, отказ KataGo): для публичного API это
      // internal, иначе чужой 401 или 400 выглядел бы ошибкой вызывающего.
      const parsed = apiErrorFromBody(text, res.status);
      const api = parsed
        ? new ApiError(PASSED_ENGINE_CODES.has(parsed.code) ? parsed.code : 'internal', `engine error: ${parsed.code}`, undefined, { cause: parsed })
        : new ApiError('engine_unavailable', `engine responded with ${res.status}`);
      // Ответ получен: движок запрос видел, повтор не ставится ни на 4xx, ни на 5xx.
      throw new AttemptError(false, api);
    } finally {
      clearTimeout(timer);
    }
  }

  async function once<T extends z.ZodType>(path: string, body: unknown, timeoutMs: number, schema: T, signal: AbortSignal | undefined): Promise<z.output<T>> {
    try {
      return await attempt(path, body, timeoutMs, schema, signal);
    } catch (e) {
      throw e instanceof AttemptError ? e.api : e;
    }
  }

  // Повтор только у genmove: ход движка идёт фоновой задачей, и отказ соединения при перезапуске
  // go-engine иначе стоил бы паузы серии в 5 с. analyze и score ждёт человек под бюджетом сервиса.
  async function withConnectionRetry<T extends z.ZodType>(path: string, body: unknown, timeoutMs: number, schema: T, signal: AbortSignal | undefined): Promise<z.output<T>> {
    try {
      return await attempt(path, body, timeoutMs, schema, signal);
    } catch (e) {
      if (!(e instanceof AttemptError)) throw e;
      if (!e.connection) throw e.api;
      await pause(retryDelay, signal);
      return once(path, body, timeoutMs, schema, signal);
    }
  }

  return {
    genmove: (req, signal) => withConnectionRetry('/v1/genmove', req, timeouts.genmove, EngineGenmoveResponse, signal),
    analyze: (req, signal) => once('/v1/analyze', req, timeouts.analyze, EngineAnalyzeResponse, signal),
    score: (req, signal) => once('/v1/score', req, timeouts.score, EngineScoreResponse, signal),
  };
}
