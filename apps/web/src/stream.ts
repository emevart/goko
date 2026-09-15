// Поток событий сессии с переподключением. После обрыва сервер первым сообщением шлёт session.game и sync
// с полным состоянием — это и есть «get_game при переподключении» из раздела 10 спеки.
// reopen() — кнопка «Повторить» (D-0006): открытие потока сессии заново запускает серию повторов сервера
// после retries_exhausted. Живое соединение закрывается своим AbortController, пауза между попытками прерывается.
// Поток сессии несёт события только текущей партии; старую партию смотрят её собственным потоком events({ gameId }).
// Паузы RETRY_MS (1, 2, 4, 8, потолок 15 с) — общие с голосовым агентом, из @goko/protocol (задача 1). Сброс — только
// если соединение прожило STABLE_CONNECTION_MS: sync приходит первым событием и при обрыве сразу после него,
// сбрасывать на нём нельзя, иначе сервер, который принимает и тут же рвёт поток, получит переподключение раз в секунду.
// rate_limited (D-0012): пауза не короче Retry-After, и reopen() до этого срока ничего не делает.
import { ApiError, type GameEvent, type GokoClient, RETRY_MS, STABLE_CONNECTION_MS } from '@goko/protocol';
import { retryDelayMs } from './text.ts';

export type StreamHandlers = {
  onEvent: (ev: GameEvent) => void;
  onConnected?: (connected: boolean) => void;
  onLost: () => void; // сессия истекла (not_found): нужна новая
};

export type StreamHandle = { done: Promise<void>; reopen: () => void };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Исключение обработчика — ошибка страницы, а не сети. Попади оно в catch цикла, поток переподключался бы по кругу
// (sync снова роняет обработчик), а из onConnected(false) или onLost отклонило бы done. Пишем в консоль и идём дальше.
function callHandler(name: string, call: () => void): void {
  try {
    call();
  } catch (e) {
    console.error(`streamEvents: ${name} handler threw`, e);
  }
}

export function streamEvents(
  client: Pick<GokoClient, 'events'>,
  sessionId: string,
  signal: AbortSignal,
  handlers: StreamHandlers,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
): StreamHandle {
  let conn: AbortController | null = null;
  let wake: (() => void) | null = null;
  let reopening = false;
  let blockedUntil = 0;
  signal.addEventListener('abort', () => wake?.(), { once: true });

  const reopen = (): void => {
    if (signal.aborted || reopening || now() < blockedUntil) return;
    reopening = true;
    conn?.abort();
    wake?.();
  };

  const done = (async () => {
    let attempt = 0;
    while (!signal.aborted) {
      const current = new AbortController();
      conn = current;
      const stop = () => current.abort();
      signal.addEventListener('abort', stop, { once: true });
      const openedAt = now();
      let wait = 0;
      try {
        let first = true;
        for await (const ev of client.events({ sessionId }, current.signal)) {
          if (first) {
            first = false;
            callHandler('onConnected', () => handlers.onConnected?.(true));
          }
          callHandler('onEvent', () => handlers.onEvent(ev));
        }
      } catch (e) {
        if (signal.aborted) return;
        // not_found и во время reopen: сессии с этим id уже нет, переоткрытие получило бы тот же ответ.
        if (e instanceof ApiError && e.code === 'not_found') {
          callHandler('onLost', () => handlers.onLost());
          return;
        }
        wait = retryDelayMs(e);
      } finally {
        signal.removeEventListener('abort', stop);
        conn = null;
      }
      if (signal.aborted) return;
      if (reopening) {
        reopening = false;
        attempt = 0;
        continue;
      }
      callHandler('onConnected', () => handlers.onConnected?.(false));
      if (now() - openedAt >= STABLE_CONNECTION_MS) attempt = 0;
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 15_000;
      blockedUntil = wait > 0 ? now() + wait : 0;
      // Промис пробуждения создаётся до вызова sleep: reopen() может прийти прямо из него.
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      await Promise.race([sleep(Math.max(wait, delay)), woken]);
      wake = null;
      if (reopening) {
        reopening = false;
        attempt = 0;
        continue;
      }
      attempt++;
    }
  })();

  return { done, reopen };
}

// Показывать ли «Повторить»: после error с кодом retries_exhausted — да, до следующего состояния партии
// (session.game или state.updated, в том числе sync после переоткрытия). Прочие события флаг не меняют.
export function needsRetry(prev: boolean, ev: GameEvent): boolean {
  if (ev.type === 'error') return ev.code === 'retries_exhausted' ? true : prev;
  if (ev.type === 'state.updated' || ev.type === 'session.game') return false;
  return prev;
}
