// Ошибка синхронного вызова как значение: проверяем code и details через toMatchObject.
import type { ApiError, GameState } from '@goko/protocol';
import type { SnapshotStore } from './store.ts';

// Снапшоты в памяти вместо диска. Настоящая запись идёт в пуле потоков и под нагрузкой длится
// дольше любого разумного числа оборотов очереди, поэтому тесты, которые ждут фоновый коммит по
// оборотам, пишут сюда: запись здесь — только микрозадачи. saved — все записи по порядку,
// load — последнее состояние каждой партии (как после рестарта), seed — снапшоты «с прошлого запуска».
// Как и диск, хранит снимки (structuredClone) при записи и отдаёт копии при чтении: правка состояния
// на месте после коммита не должна быть видна «на диске». removed — удалённые снапшоты по порядку.
export type MemoryStore = SnapshotStore & { saved: GameState[]; removed: string[] };

export function memoryStore(seed: GameState[] = []): MemoryStore {
  const saved: GameState[] = [];
  const removed: string[] = [];
  const latest = new Map<string, GameState>(seed.map((state) => [state.id, structuredClone(state)]));
  return {
    dir: '(memory)',
    saved,
    removed,
    init: async () => undefined,
    load: async () => [...latest.values()].map((state) => structuredClone(state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    save: async (state: GameState) => {
      saved.push(structuredClone(state));
      latest.set(state.id, structuredClone(state));
    },
    remove: async (id: string) => {
      removed.push(id);
      latest.delete(id);
    },
  };
}

export function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected an error to be thrown');
}

// Наблюдение за промисом без ожидания: «уже осел или ещё нет».
export function track<T>(p: Promise<T>): { settled: boolean } {
  const state = { settled: false };
  p.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

// Настоящие таймеры, взятые до любого vi.useFakeTimers: ими ограничено закрытие сервиса.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

// Потолок закрытия: мутант, из-за которого close не возвращается (пауза не разбужена), краснеет
// утверждением за секунды, а не таймаутом vitest. Верный close укладывается в микрозадачи или в
// досчёт задержки фейкового движка на настоящих часах (сотни миллисекунд).
export const CLOSE_CEILING_MS = 3_000;
// Потолок вызовов startTask после close. После close kick задач не ставит, и любой такой вызов —
// дефект. Без потолка мутант без проверки closed в kick крутил бы задачи бесконечно и вешал прогон.
export const STARTS_AFTER_CLOSE_CEILING = 50;

type Closable = { close(): Promise<void> };
export type GuardedService<S extends Closable = Closable> = { service: S; startsAfterClose: () => number };

export async function closeWithin(service: Closable, ms = CLOSE_CEILING_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`close не вернулся за ${ms} мс`)), ms);
  });
  try {
    await Promise.race([service.close(), ceiling]);
  } finally {
    realClearTimeout(timer);
  }
}

// Обёртка сервиса партий для тестов: считает вызовы приватного startTask после close и после
// потолка перестаёт ставить задачи. Имена startTask и close — шов этого помощника.
export function guardService<S extends Closable>(service: S): GuardedService<S> {
  const probe = service as unknown as { startTask: (...args: unknown[]) => void; close: () => Promise<void> };
  const startTask = probe.startTask.bind(service);
  const close = probe.close.bind(service);
  let closeCalled = false;
  let afterClose = 0;
  probe.startTask = (...args: unknown[]) => {
    if (closeCalled && ++afterClose > STARTS_AFTER_CLOSE_CEILING) return;
    startTask(...args);
  };
  probe.close = () => {
    closeCalled = true;
    return close();
  };
  return { service, startsAfterClose: () => afterClose };
}
