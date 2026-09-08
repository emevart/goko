// Шина событий в памяти: каналы game:<id> и session:<id>; SSE-обработчики подписываются здесь.
import type { GameEvent } from '@goko/protocol';

export type Listener = (event: GameEvent) => void;

export class EventBus {
  private readonly channels = new Map<string, Set<Listener>>();

  subscribe(channel: string, listener: Listener): () => void {
    // Набор берётся в const до замыкания: `let` с проверкой на undefined
    // сузился бы только снаружи, а внутри отписки тип остался бы `Set | undefined`.
    const existing = this.channels.get(channel);
    const set = existing ?? new Set<Listener>();
    if (existing === undefined) this.channels.set(channel, set);
    set.add(listener);
    let active = true;
    return () => {
      // Отписка действует один раз и только на свой набор: после переподписки
      // запоздавший вызов не должен снимать чужого слушателя.
      if (!active) return;
      active = false;
      set.delete(listener);
      // Пустой канал убирается из карты, только если там лежит именно этот набор:
      // иначе осиротевший набор снёс бы канал, созданный заново. Проверка нужна и
      // достижима: Set хранит по идентичности, поэтому один и тот же слушатель,
      // подписанный дважды, лежит в наборе один раз, а замыканий отписки создано
      // два — первая опустошает набор и убирает канал из карты, вторая остаётся
      // активной и держит осиротевший набор.
      // Саму утечку пустого канала публичным API не увидеть (count пустого канала
      // и count отсутствующего одинаковы), поэтому теста на эту строку нет.
      if (set.size === 0 && this.channels.get(channel) === set) this.channels.delete(channel);
    };
  }

  emit(channel: string, event: GameEvent): void {
    // Копия набора: слушатель вправе отписаться прямо в обработчике.
    for (const listener of [...(this.channels.get(channel) ?? [])]) {
      try {
        listener(event);
      } catch (e) {
        console.error(`[!] events: listener for ${channel} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Крючок для тестов: сколько слушателей у канала (проверяем, что подписка снимается).
  count(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}
