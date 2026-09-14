// Ограничитель частоты запросов (D-0012): фиксированное окно на ключ (адрес клиента).
// Память ограничена: устаревшие окна вычищаются не чаще раза в окно, а при потолке ключей
// вытесняется самое старое окно. Порядок Map — порядок начала окон: новое окно всегда в конце.
import { isIPv4, isIPv6 } from 'node:net';

export type RateRule = { limit: number; windowMs: number };
export type RateVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

// Все запросы /api/* с одного адреса.
export const API_RATE: RateRule = { limit: 60, windowMs: 60_000 };
// Создание сессий и партий (POST /api/sessions, /api/games, /api/sessions/:sid/games) — сверх API_RATE.
export const CREATE_RATE: RateRule = { limit: 10, windowMs: 10 * 60_000 };
export const MAX_RATE_KEYS = 10_000;

type Window = { start: number; count: number };

// Ключ лимитера по адресу клиента (D-0012). IPv4 — адрес целиком. IPv6 — префикс /64: провайдер
// выдаёт клиенту всю /64, и перебор адресов внутри неё не должен давать свежее окно. IPv4-mapped
// IPv6 (::ffff:a.b.c.d — так сокет с двойным стеком показывает IPv4) — как IPv4. Не адрес — как есть.
export function addressKey(address: string): string {
  if (!isIPv6(address)) return address;
  const groups = ipv6Groups(address);
  const [hi = 0, lo = 0] = groups.slice(6);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

// Восемь групп адреса IPv6, уже проверенного isIPv6: зона (%eth0) отбрасывается, IPv4 в конце
// записи становится двумя группами, :: разворачивается нулями.
function ipv6Groups(address: string): number[] {
  const text = address.split('%')[0] ?? '';
  const parts = text.split(':');
  const last = parts.at(-1) ?? '';
  if (isIPv4(last)) {
    const [a = 0, b = 0, c = 0, d = 0] = last.split('.').map(Number);
    parts.splice(-1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }
  const gap = parts.indexOf('');
  if (gap !== -1) {
    // '::' даёт пустые части: одну в середине, две в начале или в конце, три у адреса '::' целиком.
    const head = parts.slice(0, gap);
    const tail = parts.slice(gap).filter((p) => p !== '');
    return [...head, ...new Array<string>(8 - head.length - tail.length).fill('0'), ...tail].map((g) => parseInt(g, 16));
  }
  return parts.map((g) => parseInt(g, 16));
}

export class RateLimiter {
  readonly #rule: RateRule;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();
  #sweptAt: number;

  constructor(rule: RateRule, opts: { maxKeys?: number; now?: () => number } = {}) {
    if (!isPositiveInteger(rule.limit) || !isPositiveInteger(rule.windowMs)) throw new Error('RateLimiter: limit and windowMs must be positive integers');
    const maxKeys = opts.maxKeys ?? MAX_RATE_KEYS;
    if (!isPositiveInteger(maxKeys)) throw new Error('RateLimiter: maxKeys must be a positive integer');
    this.#rule = rule;
    this.#maxKeys = maxKeys;
    this.#now = opts.now ?? (() => Date.now());
    this.#sweptAt = this.#now();
  }

  get size(): number {
    return this.#windows.size;
  }

  // Засчитывает запрос. Отказ не засчитывается: клиент, который долбит после отказа, окно не продлевает.
  hit(key: string): RateVerdict {
    const now = this.#now();
    const { limit, windowMs } = this.#rule;
    if (this.#expired(this.#sweptAt, now)) this.#sweep(now);
    let window = this.#windows.get(key);
    if (window !== undefined && this.#expired(window.start, now)) {
      // Окно истекло между чистками: начинается заново и уходит в конец порядка вытеснения.
      this.#windows.delete(key);
      window = undefined;
    }
    if (window === undefined) {
      if (this.#windows.size >= this.#maxKeys) {
        const oldest = this.#windows.keys().next();
        if (!oldest.done) this.#windows.delete(oldest.value);
      }
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    }
    if (window.count >= limit) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + windowMs - now) / 1000)) };
    window.count++;
    return { ok: true };
  }

  // Часы, ушедшие назад (перевод системного времени), тоже считаются истечением: иначе окно
  // «из будущего» держало бы адрес под отказом до тех пор, пока часы его не догонят.
  #expired(since: number, now: number): boolean {
    return now < since || now - since >= this.#rule.windowMs;
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) if (this.#expired(window.start, now)) this.#windows.delete(key);
    this.#sweptAt = now;
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
