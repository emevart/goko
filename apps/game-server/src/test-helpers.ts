// Ошибка синхронного вызова как значение: проверяем code и details через toMatchObject.
import type { ApiError } from '@goko/protocol';

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
