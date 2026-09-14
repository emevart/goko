import { describe, expect, it } from 'vitest';
import * as protocol from './index.ts';
import { RETRY_MS, STABLE_CONNECTION_MS, retryAfterMs } from './retry.ts';

describe('паузы клиентов game-server', () => {
  it('retryAfterMs: секунды из details в мс; без них или с мусором — 1 с', () => {
    expect(retryAfterMs({ retryAfterSeconds: 42 })).toBe(42_000);
    expect(retryAfterMs(undefined)).toBe(1_000);
    expect(retryAfterMs({})).toBe(1_000);
    expect(retryAfterMs({ retryAfterSeconds: 'soon' })).toBe(1_000);
    expect(retryAfterMs({ retryAfterSeconds: 0 })).toBe(1_000);
    expect(retryAfterMs({ retryAfterSeconds: -5 })).toBe(1_000);
  });
  it('retryAfterMs: строка с числом секунд, как в заголовке Retry-After, принимается; бесконечность — мусор', () => {
    expect(retryAfterMs({ retryAfterSeconds: '30' })).toBe(30_000);
    expect(retryAfterMs({ retryAfterSeconds: Number.POSITIVE_INFINITY })).toBe(1_000);
    expect(retryAfterMs({ retryAfterSeconds: 'Infinity' })).toBe(1_000);
  });
  it('ступени переподключения 1, 2, 4, 8, 15 с; порог рабочего соединения — 15 с; всё экспортирует пакет', () => {
    expect(RETRY_MS).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
    expect(STABLE_CONNECTION_MS).toBe(15_000);
    expect(protocol.retryAfterMs).toBe(retryAfterMs);
    expect(protocol.RETRY_MS).toBe(RETRY_MS);
    expect(protocol.STABLE_CONNECTION_MS).toBe(STABLE_CONNECTION_MS);
  });
});
