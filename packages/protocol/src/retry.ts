// Паузы клиентов game-server после отказов (R2, D-0012). Одно правило у voice-agent (задачи 2, 3) и веба
// (задача 6): правка ступеней или разбора Retry-After не расходится по двум копиям.

// Паузы переподключения потока по попыткам: растут до потолка 15 с.
export const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

// Соединение, прожившее столько, считается рабочим: следующий обрыв — снова с первой ступени.
export const STABLE_CONNECTION_MS = 15_000;

// Retry-After из details ошибки rate_limited (D-0012), в мс. Без поля или с мусором — 1 с: не долбить сервер сразу.
export function retryAfterMs(details?: Record<string, unknown>): number {
  const seconds = Number(details?.retryAfterSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
}
