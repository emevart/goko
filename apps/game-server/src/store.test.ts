import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newGame } from './game.ts';
import { GameStore } from './store.ts';
import { memoryStore } from './test-helpers.ts';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goko-store-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const T = '2026-09-07T10:00:00.000Z';
const state = () =>
  newGame({ id: 'g1', createdAt: T, settings: { boardSize: 13, rules: 'chinese', komi: 7.5 }, seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } } });

// Тесты записи со шпионом над node:fs/promises — в store-write.test.ts: vi.mock действует на весь
// файл, и здесь чтение и запись идут через настоящий модуль.
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

// Подделка store для тестов сервиса обязана вести себя как диск: хранить снимок на момент записи.
// Иначе правка состояния на месте после коммита была бы видна и «на диске», и тесты «память не
// уходит вперёд диска» её не заметили бы.
describe('memoryStore', () => {
  it('save хранит снимок: правка записанного объекта и прочитанного не меняет хранимое', async () => {
    const store = memoryStore();
    const s = state();
    await store.save(s);
    s.moves.push({ n: 1, color: 'B', coord: 'D4', captured: 0, at: T });
    s.seats.W.rank = '5k';
    expect(store.saved[0]).toEqual(state());
    const loaded = await store.load();
    expect(loaded).toEqual([state()]);
    const first = loaded[0];
    if (!first) throw new Error('expected a loaded game');
    first.moves.push({ n: 1, color: 'B', coord: 'D4', captured: 0, at: T });
    expect(await store.load()).toEqual([state()]);
  });

  it('seed тоже копируется: правка исходного снапшота не видна в load', async () => {
    const seed = state();
    const store = memoryStore([seed]);
    seed.revision = 99;
    expect(await store.load()).toEqual([state()]);
  });
});
