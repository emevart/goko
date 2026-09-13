// Текст исключения для лога вместе с цепочкой cause. ApiError клиента движка несёт наружу
// фиксированный текст, а исходное исключение (адрес, путь, текст KataGo) лежит в cause.
const MAX_CAUSE_DEPTH = 5;

export function errorDetail(e: unknown): string {
  const parts: string[] = [];
  let current: unknown = e;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth++) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ');
}
