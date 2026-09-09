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
    const reason = err instanceof Error ? err.message : String(err);
    deps.log?.(`[X] go-engine: движок не ответил на прогрев за ${timeoutMs} мс: ${reason}`);
    await deps.katago.stop();
    exit(WARMUP_EXIT_CODE);
    return false;
  }
  deps.log?.(`[OK] go-engine: движок прогрет за ${Math.round(performance.now() - started)} мс`);
  return true;
}
