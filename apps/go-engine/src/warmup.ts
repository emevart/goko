// Прогрев движка при старте. Первый запрос к KataGo на машине тюнит ядра OpenCL и занимает
// минуты, следующие — десятки миллисекунд. Без прогрева этот тюнинг пришёлся бы на первый
// ход человека у доски, а бюджет genmove — 8 секунд: вместо хода получился бы таймаут.
// Поэтому сервис не начинает слушать порт, пока движок не ответил на служебный запрос.
import type { KataGo } from './katago.ts';

// Заметно больше любого боевого бюджета: тюнинг ядер — разовая операция на новой машине.
export const WARMUP_TIMEOUT_MS = 300_000;

// Самый дешёвый осмысленный запрос: пустая доска 13x13, один просмотр. Своего id здесь быть
// не должно — KataGo.query подставляет собственный, а поле из запроса его перезаписало бы.
export const WARMUP_QUERY = {
  rules: 'chinese',
  komi: 7.5,
  boardXSize: 13,
  boardYSize: 13,
  moves: [],
  maxVisits: 1,
};

// Код выхода при провале прогрева: 2 занят отсутствующими переменными окружения.
export const WARMUP_EXIT_CODE = 3;

export type WarmupDeps = {
  katago: Pick<KataGo, 'query' | 'stop'>;
  timeoutMs?: number;
  log?: (line: string) => void;
  exit?: (code: number) => void;
  // Остановка по сигналу, пока идёт прогрев: отклонённый запрос тогда не отказ, а штатный
  // выход, и печатать [X] или выходить с кодом 3 поверх кода 0 нельзя.
  cancelled?: () => boolean;
};

// Ждёт первого ответа движка; возвращает true, если движок готов. Движок не поднялся — это
// видимый отказ с внятной причиной и выход с кодом, а не тихо висящий процесс, который
// слушает порт и не умеет ходить. false нужен только тому, кто подменил exit в тесте.
export async function warmupOrExit(deps: WarmupDeps): Promise<boolean> {
  const timeoutMs = deps.timeoutMs ?? WARMUP_TIMEOUT_MS;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const started = performance.now();
  deps.log?.('[WIP] go-engine: прогрев движка; первый запуск KataGo на машине тюнит ядра и занимает минуты');
  try {
    await deps.katago.query(WARMUP_QUERY, timeoutMs);
  } catch (err) {
    if (deps.cancelled?.() === true) return false;
    const reason = err instanceof Error ? err.message : String(err);
    // Прошедшее время и бюджет — разные числа: мёртвый бинарник отказывает за миллисекунды,
    // и строка «за 300000 мс» заставила бы думать, что ждали пять минут.
    const elapsed = Math.round(performance.now() - started);
    deps.log?.(`[X] go-engine: прогрев не удался через ${elapsed} мс (бюджет ${timeoutMs} мс): ${reason}`);
    await deps.katago.stop();
    exit(WARMUP_EXIT_CODE);
    return false;
  }
  // Сигнал пришёл, когда ответ уже был в пути: порт не откроется, и строка «прогрет» сбила бы
  // читающего лог. true остаётся: решение о порте принимает вызывающий по своему флагу остановки.
  if (deps.cancelled?.() !== true) deps.log?.(`[OK] go-engine: движок прогрет за ${Math.round(performance.now() - started)} мс`);
  return true;
}
