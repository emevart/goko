// Уход и возврат участника. RoomIO стартует с closeOnDisconnect: false: перезагрузка вкладки возвращает ту же
// сессию и ту же комнату с тем же identity (phone-<sid>), а новой диспетчеризации агента нет (D-0001).
// Поэтому сеанс при уходе не закрываем, а ждём возврата: не вернулся за RETURN_GRACE_MS — onGone
// (в main.ts — ctx.shutdown), и Realtime не живёт в комнате без человека дольше срока. Агенты комнату не
// держат: emptyTimeout (300 с) и departureTimeout (900 с) комнаты считаются только по участникам-не-агентам.
// После ухода телефона комната живёт departureTimeout 900 с (ROOM_DEPARTURE_TIMEOUT_SECONDS,
// apps/game-server/src/livekit.ts); RETURN_GRACE_MS равен ему — менять оба значения вместе.

import { type Clock, realClock } from './clock.ts';

// 15 минут: перезагрузка страницы, короткий обрыв сети, пауза на обдумывание хода у физической доски
// и погасший экран телефона (выгружает вкладку) укладываются с запасом.
export const RETURN_GRACE_MS = 15 * 60_000;

export type Identified = { identity: string };

// Ожидание одно на уход: повторный уход во время ожидания срок не продлевает. После onGone и stop — глухо.
export type DepartureWatch<P extends Identified> = {
  onDisconnected(p: Identified): void;
  onConnected(p: P): void;
  stop(): void;
};

export function watchDeparture<P extends Identified>(opts: {
  identity: string;
  onGone: () => void;
  onReturn?: (p: P) => void;
  graceMs?: number;
  clock?: Clock;
  log?: (line: string) => void;
}): DepartureWatch<P> {
  const graceMs = opts.graceMs ?? RETURN_GRACE_MS;
  const clock = opts.clock ?? realClock;
  const log = opts.log ?? (() => {});
  const seconds = Math.ceil(graceMs / 1000);
  let cancel: (() => void) | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    cancel?.();
    cancel = null;
  };

  return {
    onDisconnected(p) {
      if (stopped || p.identity !== opts.identity || cancel) return;
      log(`[!] voice-agent: участник ушёл, ждём возврата ${seconds} с`);
      cancel = clock.after(graceMs, () => {
        stop();
        log(`[!] voice-agent: участник не вернулся за ${seconds} с, завершаем работу`);
        opts.onGone();
      });
    },
    onConnected(p) {
      if (stopped || p.identity !== opts.identity || !cancel) return;
      cancel();
      cancel = null;
      log('[OK] voice-agent: участник вернулся');
      opts.onReturn?.(p);
    },
    stop,
  };
}
