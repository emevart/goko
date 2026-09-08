// Ошибка синхронного вызова как значение: проверяем code и details через toMatchObject.
import type { ApiError } from '@goko/protocol';

export function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('ожидалась ошибка');
}
