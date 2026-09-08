// Фейковый fetch для тестов: собирает вызовы, отвечает по списку обработчиков.
// Один обработчик — отвечает на все вызовы; список — по одному на вызов, последний повторяется.
export type Call = { url: string; init: RequestInit };
type Handler = (call: Call) => Response | Promise<Response>;

export function fakeFetch(handlers: Handler | Handler[]): { calls: Call[]; fetch: typeof globalThis.fetch } {
  const list = Array.isArray(handlers) ? handlers : [handlers];
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    // Request первым аргументом: url, метод и заголовки лежат в нём, а не в init;
    // без этого тест молча проверял бы строку '[object Request]'.
    const req = input instanceof Request ? input : undefined;
    const call: Call = req ? { url: req.url, init: { method: req.method, headers: req.headers, ...init } } : { url: String(input), init: init ?? {} };
    calls.push(call);
    const h = list[Math.min(calls.length - 1, list.length - 1)];
    // Пустой список обработчиков — ошибка теста, а не фейкового fetch: без явного
    // сообщения вызов упал бы как "h is not a function" далеко от причины.
    if (h === undefined) throw new Error('fakeFetch: no handlers provided');
    return h(call);
  };
  return { calls, fetch: fetchFn as unknown as typeof globalThis.fetch };
}
