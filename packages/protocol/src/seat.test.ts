import { describe, expect, it } from 'vitest';
import { type Seat, hasEngine, humanColorOf, seatColor } from './game.ts';
import * as protocol from './index.ts';

describe('seatColor', () => {
  it('находит цвет по контроллеру', () => {
    const seats = { B: { controller: 'human' as const }, W: { controller: 'engine' as const, rank: '10k' as const } };
    expect(seatColor(seats, 'human')).toBe('B');
    expect(seatColor(seats, 'engine')).toBe('W');
    expect(seatColor(seats, 'external')).toBeNull();
  });
  it('при двух одинаковых берёт чёрных', () => {
    const seats = { B: { controller: 'engine' as const }, W: { controller: 'engine' as const } };
    expect(seatColor(seats, 'engine')).toBe('B');
  });
});

describe('hasEngine / humanColorOf', () => {
  const human: Seat = { controller: 'human' };
  const engine: Seat = { controller: 'engine', rank: '10k' };
  it('место человека, по умолчанию чёрные; Гоко в партии есть', () => {
    expect(humanColorOf({ seats: { B: human, W: engine }, toPlay: 'W' })).toBe('B');
    expect(humanColorOf({ seats: { B: engine, W: human }, toPlay: 'B' })).toBe('W');
    expect(humanColorOf({ seats: { B: engine, W: { controller: 'external' } }, toPlay: 'B' })).toBe('B');
    expect(hasEngine({ seats: { B: human, W: engine } })).toBe(true);
    expect(protocol.hasEngine).toBe(hasEngine);
    expect(protocol.humanColorOf).toBe(humanColorOf);
  });
  it('партия двух людей (D-0005): движка нет, «человек» — тот, чей ход', () => {
    const seats = { B: human, W: human };
    expect(hasEngine({ seats })).toBe(false);
    expect(humanColorOf({ seats, toPlay: 'W' })).toBe('W');
    expect(humanColorOf({ seats, toPlay: 'B' })).toBe('B');
  });
});
