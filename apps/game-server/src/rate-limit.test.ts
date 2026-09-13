import { describe, expect, it } from 'vitest';
import { API_RATE, CREATE_RATE, MAX_RATE_KEYS, RateLimiter } from './rate-limit.ts';

// Часы — простая переменная: окно считается только от переданного времени.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) };
}

describe('RateLimiter', () => {
  it('пределы D-0012: 60 в минуту на /api/*, 10 за 10 минут на создание, не больше 10 000 адресов', () => {
    expect(API_RATE).toEqual({ limit: 60, windowMs: 60_000 });
    expect(CREATE_RATE).toEqual({ limit: 10, windowMs: 600_000 });
    expect(MAX_RATE_KEYS).toBe(10_000);
  });

  it('limit попаданий проходит, следующее — отказ с Retry-After до конца окна в целых секундах, отказ не считается', () => {
    const c = clock();
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 }, { now: c.now });
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('a')]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    c.advance(10_500);
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 50 });
    c.advance(49_000);
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
    // Меньше секунды до конца окна — всё равно 1, а не 0.
    c.advance(499);
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
    c.advance(1);
    expect(limiter.hit('a')).toEqual({ ok: true });
    expect(limiter.hit('a')).toEqual({ ok: true });
    expect(limiter.hit('a')).toEqual({ ok: true });
    expect(limiter.hit('a')).toMatchObject({ ok: false });
  });

  it('адреса считаются раздельно', () => {
    const c = clock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 }, { now: c.now });
    expect(limiter.hit('a')).toEqual({ ok: true });
    expect(limiter.hit('b')).toEqual({ ok: true });
    expect(limiter.hit('a')).toMatchObject({ ok: false });
    expect(limiter.hit('b')).toMatchObject({ ok: false });
  });

  it('устаревшие окна вычищаются лениво, не чаще раза в окно', () => {
    const c = clock(0);
    const limiter = new RateLimiter({ limit: 5, windowMs: 1000 }, { now: c.now });
    for (let i = 0; i < 100; i++) limiter.hit(`ip${i}`);
    expect(limiter.size).toBe(100);
    c.advance(999);
    limiter.hit('late');
    expect(limiter.size).toBe(101);
    c.advance(1);
    limiter.hit('fresh');
    // Все, кроме late (его окно ещё идёт) и fresh.
    expect(limiter.size).toBe(2);
    // Окно late истекло, но с чистки прошло меньше окна: следующая чистка ещё не пришла, late на месте.
    c.advance(999);
    limiter.hit('next');
    expect(limiter.size).toBe(3);
    c.advance(1);
    limiter.hit('after');
    // Чистка: late и fresh истекли, остаются next и after.
    expect(limiter.size).toBe(2);
  });

  it('потолок адресов: при заполнении вытесняется самое старое окно, число записей не растёт', () => {
    const c = clock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000 }, { now: c.now, maxKeys: 3 });
    limiter.hit('a');
    c.advance(1);
    limiter.hit('b');
    c.advance(1);
    limiter.hit('c');
    c.advance(1);
    expect(limiter.hit('d')).toEqual({ ok: true });
    expect(limiter.size).toBe(3);
    // a вытеснен и начинает окно заново; b и c ещё в своих окнах.
    expect(limiter.hit('b')).toMatchObject({ ok: false });
    expect(limiter.hit('c')).toMatchObject({ ok: false });
    expect(limiter.hit('a')).toEqual({ ok: true });
    expect(limiter.size).toBe(3);
    expect(limiter.hit('b')).toEqual({ ok: true });
  });

  it('окно, истёкшее между чистками, начинается заново и уходит в конец очереди вытеснения', () => {
    const c = clock(0);
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 }, { now: c.now, maxKeys: 3 });
    c.set(100);
    limiter.hit('a');
    c.set(600);
    limiter.hit('b');
    c.set(1100);
    // Чистка: окно a истекло и начинается заново в конце; окну b 500 мс, оно остаётся первым.
    expect(limiter.hit('a')).toEqual({ ok: true });
    c.set(1700);
    // До следующей чистки ещё 400 мс, а окно b уже истекло: оно начинается заново, самое старое теперь a.
    expect(limiter.hit('b')).toEqual({ ok: true });
    c.set(1800);
    limiter.hit('c');
    c.set(1900);
    // Потолок: вытесняется a (окно с 1100), а не b (окно с 1700), хотя b попал в карту раньше.
    limiter.hit('d');
    expect(limiter.size).toBe(3);
    expect(limiter.hit('b')).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(limiter.hit('a')).toEqual({ ok: true });
  });

  it('часы ушли назад: окно из будущего начинается заново, а не блокирует адрес надолго', () => {
    const c = clock(10_000_000);
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000 }, { now: c.now });
    limiter.hit('a');
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 60 });
    c.set(10_000_000 - 3_600_000);
    expect(limiter.hit('a')).toEqual({ ok: true });
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 60 });
  });

  it('по умолчанию часы — Date.now в момент вызова', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.hit('a')).toEqual({ ok: true });
    expect(limiter.hit('a')).toMatchObject({ ok: false });
  });

  it('пределы проверяются: limit и windowMs — положительные целые', () => {
    expect(() => new RateLimiter({ limit: 0, windowMs: 1000 })).toThrow('RateLimiter: limit and windowMs must be positive integers');
    expect(() => new RateLimiter({ limit: 1, windowMs: 0 })).toThrow('RateLimiter');
    expect(() => new RateLimiter({ limit: 1.5, windowMs: 1000 })).toThrow('RateLimiter');
    expect(() => new RateLimiter({ limit: 1, windowMs: 1000 }, { maxKeys: 0 })).toThrow('RateLimiter: maxKeys must be a positive integer');
  });
});
