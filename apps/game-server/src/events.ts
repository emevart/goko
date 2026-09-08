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
    return () => {
      set.delete(listener);
      if (set.size === 0) this.channels.delete(channel);
    };
  }

  emit(channel: string, event: GameEvent): void {
    // Копия набора: слушатель вправе отписаться прямо в обработчике.
    for (const listener of [...(this.channels.get(channel) ?? [])]) {
      try {
        listener(event);
      } catch (e) {
        console.error(`[!] events: слушатель ${channel} упал: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Крючок для тестов: сколько слушателей у канала (проверяем, что подписка снимается).
  count(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}
