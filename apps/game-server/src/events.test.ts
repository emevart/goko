import { describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '@goko/protocol';
import { EventBus } from './events.ts';

describe('EventBus', () => {
  it('доставляет по каналу, отписка работает, count считает слушателей', () => {
    const bus = new EventBus();
    const got: GameEvent[] = [];
    const off = bus.subscribe('game:g1', (e) => got.push(e));
    bus.subscribe('game:g2', () => {
      throw new Error('wrong channel');
    });
    bus.emit('game:g1', { type: 'engine.thinking', gameId: 'g1', color: 'W' });
    expect(got).toEqual([{ type: 'engine.thinking', gameId: 'g1', color: 'W' }]);
    expect(bus.count('game:g1')).toBe(1);
    off();
    bus.emit('game:g1', { type: 'engine.thinking', gameId: 'g1', color: 'B' });
    expect(got).toHaveLength(1);
    expect(bus.count('game:g1')).toBe(0);
  });

  it('несколько слушателей одного канала получают событие, отписка снимает только своего', () => {
    const bus = new EventBus();
    let a = 0;
    let b = 0;
    const offA = bus.subscribe('session:s1', () => a++);
    bus.subscribe('session:s1', () => b++);
    expect(bus.count('session:s1')).toBe(2);
    bus.emit('session:s1', { type: 'session.game', gameId: 'g1' });
    expect([a, b]).toEqual([1, 1]);
    offA();
    expect(bus.count('session:s1')).toBe(1);
    bus.emit('session:s1', { type: 'session.game', gameId: 'g2' });
    expect([a, b]).toEqual([1, 2]);
  });

  it('повторная отписка ничего не ломает и не роняет чужих слушателей', () => {
    const bus = new EventBus();
    let delivered = 0;
    const off = bus.subscribe('game:g1', () => delivered++);
    off();
    off();
    bus.subscribe('game:g1', () => delivered++);
    bus.emit('game:g1', { type: 'session.game', gameId: 'g1' });
    expect(delivered).toBe(1);
    expect(bus.count('game:g1')).toBe(1);
  });

  it('устаревшая отписка не сносит канал, созданный заново', () => {
    // Порядок off(); subscribe(); off(): старая отписка держит осиротевший набор
    // и не должна выбрасывать из карты набор нового подписчика.
    const bus = new EventBus();
    let delivered = 0;
    const off1 = bus.subscribe('game:g1', () => delivered++);
    off1();
    bus.subscribe('game:g1', () => delivered++);
    off1();
    expect(bus.count('game:g1')).toBe(1);
    bus.emit('game:g1', { type: 'session.game', gameId: 'g1' });
    expect(delivered).toBe(1);
  });

  it('повторная отписка не снимает заново подписанного слушателя', () => {
    // Тот же слушатель подписан второй раз, набор в карте прежний: старая отписка
    // уже отработала и второй раз трогать набор не должна.
    const bus = new EventBus();
    let a = 0;
    let b = 0;
    const listener = () => a++;
    const offA = bus.subscribe('game:g1', listener);
    bus.subscribe('game:g1', () => b++);
    offA();
    bus.subscribe('game:g1', listener);
    offA();
    expect(bus.count('game:g1')).toBe(2);
    bus.emit('game:g1', { type: 'session.game', gameId: 'g1' });
    expect([a, b]).toEqual([1, 1]);
  });

it('первая отписка дважды подписанного слушателя не отбирает канал у нового подписчика', () => {
    // Set хранит по идентичности: одна и та же функция, подписанная дважды, лежит в
    // наборе один раз, а замыканий отписки создано два. Первая отписка опустошает
    // набор и убирает канал из карты, вторая держит осиротевший набор и не должна
    // сносить канал, созданный заново.
    const bus = new EventBus();
    let a = 0;
    let b = 0;
    const listener = () => a++;
    const off1 = bus.subscribe('game:g1', listener);
    const off2 = bus.subscribe('game:g1', listener);
    off1();
    expect(bus.count('game:g1')).toBe(0);
    bus.subscribe('game:g1', () => b++);
    off2();
    expect(bus.count('game:g1')).toBe(1);
    bus.emit('game:g1', { type: 'session.game', gameId: 'g1' });
    expect([a, b]).toEqual([0, 1]);
  });

  it('отписка во время рассылки не сносит канал у остальных', () => {
    const bus = new EventBus();
    let delivered = 0;
    const offSelf = bus.subscribe('game:g1', () => {
      offSelf();
      offSelf();
    });
    bus.subscribe('game:g1', () => delivered++);
    bus.emit('game:g1', { type: 'session.game', gameId: 'g1' });
    expect(delivered).toBe(1);
    expect(bus.count('game:g1')).toBe(1);
  });

  it('канал без слушателей: count ноль, emit молчит', () => {
    const bus = new EventBus();
    expect(bus.count('game:none')).toBe(0);
    expect(() => bus.emit('game:none', { type: 'session.game', gameId: 'g1' })).not.toThrow();
  });

  it('исключение слушателя не ломает остальных', () => {
    const bus = new EventBus();
    let delivered = 0;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bus.subscribe('game:g1', () => {
      throw new Error('boom');
    });
    bus.subscribe('game:g1', () => delivered++);
    bus.emit('game:g1', { type: 'session.game', gameId: 'g1' });
    expect(delivered).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('отписка себя во время доставки не пропускает следующего слушателя', () => {
    const bus = new EventBus();
    let delivered = 0;
    const off = bus.subscribe('game:g1', () => off());
    bus.subscribe('game:g1', () => delivered++);
    bus.emit('game:g1', { type: 'session.game', gameId: 'g1' });
    expect(delivered).toBe(1);
    expect(bus.count('game:g1')).toBe(1);
  });

  it('событие уходит всем, кто был подписан на момент emit', () => {
    // Набор слушателей копируется перед обходом: снятая по ходу доставки подписка
    // всё равно получает текущее событие и не получает следующее.
    const bus = new EventBus();
    const second: string[] = [];
    let offSecond = () => undefined as void;
    bus.subscribe('game:g1', () => offSecond());
    offSecond = bus.subscribe('game:g1', (e) => second.push(e.type));
    bus.emit('game:g1', { type: 'session.game', gameId: 'g1' });
    expect(second).toEqual(['session.game']);
    expect(bus.count('game:g1')).toBe(1);
    bus.emit('game:g1', { type: 'session.game', gameId: 'g2' });
    expect(second).toHaveLength(1);
  });
});
