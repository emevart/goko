// Сессии (раздел 4 спеки): комната LiveKit + указатель на текущую партию; лимит и TTL без событий.
// Событие продлевает срок (create, setGame, touch), чтение (get, list) — нет. Сессия жива, пока
// now - lastSeen <= ttlMs. Каждый метод сначала выметает истёкшие, чтобы touch или setGame
// не воскресили сессию, которую ещё не успели убрать.
import { ApiError, type Session } from '@goko/protocol';
import { newId } from './ids.ts';

export type SessionManagerOptions = { max: number; ttlMs: number; now?: () => number };

export function roomName(sessionId: string): string {
  return `goko-${sessionId}`;
}

type Entry = { session: Session; lastSeen: number };

export class SessionManager {
  private readonly opts: SessionManagerOptions;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: SessionManagerOptions) {
    // NaN из опечатки в env молча снял бы лимит (size >= NaN) и TTL (lastSeen < NaN): отказ сразу.
    if (!Number.isInteger(opts.max) || opts.max < 1) throw new Error(`SessionManager: max должен быть целым >= 1, получено ${opts.max}`);
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) throw new Error(`SessionManager: ttlMs должен быть конечным > 0, получено ${opts.ttlMs}`);
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  sweep(): number {
    const cutoff = this.now() - this.opts.ttlMs;
    let removed = 0;
    for (const [id, e] of this.entries) {
      if (e.lastSeen < cutoff) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  // Живая запись или undefined; истёкшие к этому моменту уже выметены.
  private alive(id: string): Entry | undefined {
    this.sweep();
    return this.entries.get(id);
  }

  private require(id: string): Entry {
    const e = this.alive(id);
    if (!e) throw new ApiError('not_found', `сессии ${id} нет`);
    return e;
  }

  create(): Session {
    this.sweep();
    if (this.entries.size >= this.opts.max) throw new ApiError('limit_reached', `уже ${this.opts.max} активных сессий`, { max: this.opts.max });
    const id = newId();
    const now = this.now();
    const session: Session = { id, room: roomName(id), currentGameId: null, createdAt: new Date(now).toISOString() };
    this.entries.set(id, { session, lastSeen: now });
    return session;
  }

  get(id: string): Session {
    return this.require(id).session;
  }

  touch(id: string): void {
    const e = this.alive(id);
    if (e) e.lastSeen = this.now();
  }

  setGame(id: string, gameId: string): Session {
    const e = this.require(id);
    e.session = { ...e.session, currentGameId: gameId };
    e.lastSeen = this.now();
    return e.session;
  }

  // Освобождает место сразу, не дожидаясь TTL (например, если после create не удалось выдать токен).
  // true — живая сессия удалена; false — её нет или она уже истекла.
  remove(id: string): boolean {
    this.sweep();
    return this.entries.delete(id);
  }

  list(): Session[] {
    this.sweep();
    return [...this.entries.values()].map((e) => e.session);
  }
}
