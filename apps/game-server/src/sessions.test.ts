import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, roomName } from './sessions.ts';
import { errorOf } from './test-helpers.ts';

describe('SessionManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('создаёт сессию с комнатой goko-<id>, лимит -> limit_reached', () => {
    const m = new SessionManager({ max: 2, ttlMs: 1000 });
    const a = m.create();
    expect(a.room).toBe(roomName(a.id));
    expect(a.currentGameId).toBeNull();
    m.create();
    expect(errorOf(() => m.create())).toMatchObject({ code: 'limit_reached', status: 429 });
    expect(m.list()).toHaveLength(2);
  });

  it('roomName — префикс goko- к идентификатору сессии', () => {
    expect(roomName('s1')).toBe('goko-s1');
  });

  it('limit_reached называет лимит в details, сессии с разными id', () => {
    const m = new SessionManager({ max: 2, ttlMs: 1000 });
    const a = m.create();
    const b = m.create();
    expect(a.id).not.toBe(b.id);
    expect(errorOf(() => m.create())).toMatchObject({ code: 'limit_reached', details: { max: 2 } });
    expect(m.list().map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('setGame переключает партию, get неизвестной -> not_found', () => {
    const m = new SessionManager({ max: 2, ttlMs: 1000 });
    const a = m.create();
    expect(m.setGame(a.id, 'g1').currentGameId).toBe('g1');
    expect(m.get(a.id).currentGameId).toBe('g1');
    expect(errorOf(() => m.get('nope'))).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('setGame неизвестной -> not_found, touch неизвестной — без ошибки', () => {
    const m = new SessionManager({ max: 2, ttlMs: 1000 });
    expect(errorOf(() => m.setGame('nope', 'g1'))).toMatchObject({ code: 'not_found', status: 404 });
    expect(() => m.touch('nope')).not.toThrow();
    expect(m.list()).toEqual([]);
  });

  it('TTL: сессия без событий истекает, touch продлевает, место освобождается', () => {
    let t = 0;
    const m = new SessionManager({ max: 1, ttlMs: 100, now: () => t });
    const a = m.create();
    t = 90;
    m.touch(a.id);
    t = 150;
    expect(m.get(a.id).id).toBe(a.id); // прожила: touch на 90 + 100 = 190
    t = 200;
    expect(errorOf(() => m.get(a.id))).toMatchObject({ code: 'not_found' });
    expect(m.create().id).not.toBe(a.id);
  });

  it('граница TTL: ровно ttlMs без событий — жива, ttlMs + 1 — истекла', () => {
    let t = 0;
    const m = new SessionManager({ max: 1, ttlMs: 100, now: () => t });
    const a = m.create();
    t = 100;
    expect(m.list().map((s) => s.id)).toEqual([a.id]);
    expect(errorOf(() => m.create())).toMatchObject({ code: 'limit_reached' });
    t = 101;
    expect(m.list()).toEqual([]);
    expect(errorOf(() => m.get(a.id))).toMatchObject({ code: 'not_found' });
  });

  it('create сам выметает истёкшие: место свободно без предварительного get или list', () => {
    let t = 0;
    const m = new SessionManager({ max: 1, ttlMs: 100, now: () => t });
    const a = m.create();
    t = 101;
    const b = m.create();
    expect(b.id).not.toBe(a.id);
    expect(m.list().map((s) => s.id)).toEqual([b.id]);
  });

  it('touch истёкшей, но не выметенной сессии её не воскрешает', () => {
    let t = 0;
    const m = new SessionManager({ max: 1, ttlMs: 100, now: () => t });
    const a = m.create();
    t = 150;
    m.touch(a.id);
    expect(errorOf(() => m.get(a.id))).toMatchObject({ code: 'not_found' });
  });

  it('setGame истёкшей, но не выметенной сессии -> not_found и не воскрешает', () => {
    let t = 0;
    const m = new SessionManager({ max: 1, ttlMs: 100, now: () => t });
    const a = m.create();
    t = 150;
    expect(errorOf(() => m.setGame(a.id, 'g1'))).toMatchObject({ code: 'not_found', status: 404 });
    expect(m.list()).toEqual([]);
    expect(m.create().id).not.toBe(a.id);
  });

  it('setGame — событие и продлевает срок; get и list — чтение и не продлевают', () => {
    let t = 0;
    const m = new SessionManager({ max: 2, ttlMs: 100, now: () => t });
    const a = m.create();
    const b = m.create();
    t = 90;
    m.get(a.id);
    m.list();
    m.setGame(b.id, 'g1');
    t = 101;
    expect(m.list().map((s) => s.id)).toEqual([b.id]);
    t = 190;
    expect(m.get(b.id).currentGameId).toBe('g1');
    t = 191;
    expect(m.list()).toEqual([]);
  });

  it('setGame не меняет ранее выданный объект сессии', () => {
    const m = new SessionManager({ max: 1, ttlMs: 100 });
    const a = m.create();
    m.setGame(a.id, 'g1');
    expect(a.currentGameId).toBeNull();
  });

  it('sweep возвращает число выметенных и оставляет живые', () => {
    let t = 0;
    const m = new SessionManager({ max: 3, ttlMs: 100, now: () => t });
    const a = m.create();
    const b = m.create();
    t = 50;
    const c = m.create();
    expect(m.sweep()).toBe(0);
    t = 120;
    expect(m.sweep()).toBe(2);
    expect(m.sweep()).toBe(0);
    expect(m.list().map((s) => s.id)).toEqual([c.id]);
    expect(errorOf(() => m.get(a.id))).toMatchObject({ code: 'not_found' });
    expect(errorOf(() => m.get(b.id))).toMatchObject({ code: 'not_found' });
  });

  it('createdAt — ISO от инжектируемых часов', () => {
    const m = new SessionManager({ max: 1, ttlMs: 100, now: () => Date.parse('2026-09-07T10:00:00.000Z') });
    expect(m.create().createdAt).toBe('2026-09-07T10:00:00.000Z');
  });

  it('без now — системные часы и для createdAt, и для срока', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T10:00:00.000Z'));
    const m = new SessionManager({ max: 1, ttlMs: 100 });
    const a = m.create();
    expect(a.createdAt).toBe('2026-09-07T10:00:00.000Z');
    vi.setSystemTime(new Date('2026-09-07T10:00:00.100Z'));
    expect(m.get(a.id).id).toBe(a.id);
    vi.setSystemTime(new Date('2026-09-07T10:00:00.201Z'));
    expect(errorOf(() => m.get(a.id))).toMatchObject({ code: 'not_found' });
  });
});
