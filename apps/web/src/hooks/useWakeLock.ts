// Экран телефона у доски не гаснет: Screen Wake Lock после касания страницы. Браузер сам отпускает блокировку,
// когда вкладка скрыта, поэтому при возврате вкладки запрашиваем снова. Нет API (Firefox, старый Safari), нет
// разрешения или включено энергосбережение — молча ничего: экран гаснет как обычно.
import { useCallback, useEffect, useRef } from 'react';

export function useWakeLock(): () => void {
  const wanted = useRef(false); // было касание: только после него блокировку просим и при возврате вкладки
  const sentinel = useRef<WakeLockSentinel | null>(null);
  const pending = useRef(false);
  const alive = useRef(false);

  const request = useCallback(async () => {
    if (pending.current || (sentinel.current && !sentinel.current.released)) return;
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    pending.current = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (alive.current) sentinel.current = lock;
      else await lock.release(); // размонтировали, пока ждали ответа
    } catch {
      // отказ браузера (политика, энергосбережение, вкладка скрылась) — не ошибка для человека
    } finally {
      pending.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const onVisibility = () => {
      if (wanted.current && document.visibilityState === 'visible') void request();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      const lock = sentinel.current;
      sentinel.current = null;
      lock?.release().catch(() => undefined);
    };
  }, [request]);

  // Вызывать из обработчика касания: часть браузеров даёт блокировку только рядом с жестом.
  return useCallback(() => {
    wanted.current = true;
    void request();
  }, [request]);
}
