// Запись снапшота под шпионом над node:fs/promises. vi.mock действует на весь файл, поэтому здесь
// только тесты, которым нужен шпион (путь временного файла, обрыв записи, отказ до записи).
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

describe('GameStore: запись под шпионом fs', () => {
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


  it('save отвергает идентификатор, который выходит за каталог снапшотов, зарезервирован в Windows или длиннее предела', async () => {
    const store = new GameStore(path.join(dir, 'games'));
    await store.init();
    for (const id of ['../escaped', '', 'a/b', 'a\\b', '.', 'g1.json', 'con', 'nul', 'com1', 'lpt9', 'a'.repeat(65)]) {
      await expect(store.save({ ...state(), id })).rejects.toMatchObject({
        code: 'bad_request',
        status: 400,
        message: 'game id must match /^[0-9a-z]+$/, be at most 64 characters and not be a reserved Windows name',
        details: { id },
      });
    }
    expect(await readdir(path.join(dir, 'games'))).toEqual([]);
    expect(await readdir(dir)).toEqual(['games']);
    expect(fsHook.writes).toEqual([]);
  });
});
