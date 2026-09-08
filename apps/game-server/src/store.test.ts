import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newGame } from './game.ts';
import { GameStore } from './store.ts';

// Шпион над записью: подменяем только writeFile, чтобы увидеть путь временного файла
// и смоделировать падение посреди записи.
const fsHook = vi.hoisted(() => ({ writes: [] as string[], failMidWrite: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    writeFile: async (file: string, data: string, encoding: BufferEncoding) => {
      fsHook.writes.push(String(file));
      if (!fsHook.failMidWrite) return actual.writeFile(file, data, encoding);
      // Половина содержимого на диске, затем обрыв: так выглядит падение при записи.
      await actual.writeFile(file, data.slice(0, Math.floor(data.length / 2)), encoding);
      throw new Error('disk full');
    },
  };
});

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goko-store-'));
  fsHook.writes = [];
  fsHook.failMidWrite = false;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const T = '2026-09-07T10:00:00.000Z';
const state = () =>
  newGame({ id: 'g1', createdAt: T, settings: { boardSize: 13, rules: 'chinese', komi: 7.5 }, seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } } });

describe('GameStore', () => {
  it('save пишет JSON в <dir>/<id>.json, load возвращает партии', async () => {
    const store = new GameStore(path.join(dir, 'games'));
    await store.init();
    await store.save(state());
    const raw = JSON.parse(await readFile(path.join(dir, 'games', 'g1.json'), 'utf8'));
    expect(raw.id).toBe('g1');
    expect(raw.board).toBe('.'.repeat(169));
    const loaded = await new GameStore(path.join(dir, 'games')).load();
    expect(loaded.map((g) => g.id)).toEqual(['g1']);
    expect(loaded[0]).toEqual(state());
  });

  it('load создаёт каталог, если его нет, и возвращает пустой список', async () => {
    const loaded = await new GameStore(path.join(dir, 'fresh')).load();
    expect(loaded).toEqual([]);
    expect(await readdir(path.join(dir, 'fresh'))).toEqual([]);
  });

  it('битый файл пропускается, остальные загружаются', async () => {
    const store = new GameStore(dir);
    await store.init();
    await store.save(state());
    await writeFile(path.join(dir, 'broken.json'), '{not json', 'utf8');
    await writeFile(path.join(dir, 'wrong.json'), JSON.stringify({ id: 'x' }), 'utf8');
    // Обрезанный снапшот: JSON разбирается, но доска не той длины — схема его не пропустит.
    await writeFile(path.join(dir, 'short.json'), JSON.stringify({ ...state(), id: 'short', board: '.'.repeat(80) }), 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loaded = await store.load();
    expect(loaded.map((g) => g.id)).toEqual(['g1']);
    expect(console.error).toHaveBeenCalledTimes(3);
  });

  it('файлы не .json игнорируются', async () => {
    const store = new GameStore(dir);
    await store.init();
    await store.save(state());
    // Годный снапшот с чужим расширением: отбирается именно по .json, а не по разбору.
    await writeFile(path.join(dir, 'notes.txt'), JSON.stringify({ ...state(), id: 'notes' }), 'utf8');
    const loaded = await store.load();
    expect(loaded.map((g) => g.id)).toEqual(['g1']);
  });

  it('load сортирует партии по createdAt', async () => {
    const store = new GameStore(dir);
    await store.init();
    await store.save({ ...state(), id: 'later', createdAt: '2026-09-07T12:00:00.000Z' });
    await store.save({ ...state(), id: 'earlier', createdAt: '2026-09-07T08:00:00.000Z' });
    await store.save(state());
    const loaded = await store.load();
    expect(loaded.map((g) => g.id)).toEqual(['earlier', 'g1', 'later']);
  });

  it('save пишет не в целевой файл, а во временный, и переносит его', async () => {
    const store = new GameStore(dir);
    await store.init();
    await store.save(state());
    const target = path.join(dir, 'g1.json');
    expect(fsHook.writes).toHaveLength(1);
    expect(fsHook.writes[0]).not.toBe(target);
    expect(await readdir(dir)).toEqual(['g1.json']);
  });

  it('падение посреди записи не портит прежний снапшот', async () => {
    const store = new GameStore(dir);
    await store.init();
    await store.save(state());
    fsHook.failMidWrite = true;
    await expect(store.save({ ...state(), revision: 5 })).rejects.toThrow('disk full');
    fsHook.failMidWrite = false;
    // Целевой файл не тронут: прежний снапшот читается схемой целиком.
    const loaded = await store.load();
    expect(loaded.map((g) => g.id)).toEqual(['g1']);
    expect(loaded[0]?.revision).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, 'g1.json'), 'utf8'))).toEqual(state());
  });

  it('save отвергает идентификатор, который выходит за каталог снапшотов', async () => {
    const store = new GameStore(path.join(dir, 'games'));
    await store.init();
    for (const id of ['../escaped', '', 'a/b', 'a\b', '.', 'g1.json']) {
      await expect(store.save({ ...state(), id })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    }
    expect(await readdir(path.join(dir, 'games'))).toEqual([]);
    expect(await readdir(dir)).toEqual(['games']);
    expect(fsHook.writes).toEqual([]);
  });

  it('повторный save перезаписывает атомарно (нет .tmp после записи)', async () => {
    const store = new GameStore(dir);
    await store.init();
    const s = state();
    await store.save(s);
    await store.save({ ...s, revision: 5 });
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.revision).toBe(5);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(await readdir(dir)).toEqual(['g1.json']);
  });
});
