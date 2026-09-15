import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMove, newGame } from './game.ts';
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

  it('история redo сохраняется отдельно, а старый снапшот без неё загружается с canRedo=false', async () => {
    const store = new GameStore(dir);
    const move = { n: 1, color: 'B' as const, coord: 'D4', captured: 0, at: T };
    await store.save({ ...state(), canRedo: true }, [{ moves: [move] }]);
    const raw = JSON.parse(await readFile(path.join(dir, 'g1.json'), 'utf8'));
    expect(raw.redoHistory).toEqual([{ moves: [move] }]);
    expect((await store.load())[0]).toMatchObject({ canRedo: true, redoHistory: [{ moves: [move] }] });

    const old = { ...state(), id: 'old' } as Record<string, unknown>;
    delete old.canRedo;
    await writeFile(path.join(dir, 'old.json'), JSON.stringify(old), 'utf8');
    expect((await store.load()).find((g) => g.id === 'old')).toMatchObject({ canRedo: false });
  });

  it.each([
    ['пустая порция', [{ moves: [] }]],
    ['нарушен порядок ходов', [{ moves: [{ n: 2, color: 'B', coord: 'D4', captured: 0, at: T }] }]],
    ['нелегальная координата', [{ moves: [{ n: 1, color: 'B', coord: 'D20', captured: 0, at: T }] }]],
    ['неверно число взятых камней', [{ moves: [{ n: 1, color: 'B', coord: 'D4', captured: 1, at: T }] }]],
  ])('load сохраняет валидную партию, но отбрасывает повреждённую redo-историю: %s', async (_case, redoHistory) => {
    const file = path.join(dir, 'g1.json');
    const before = JSON.stringify({ ...state(), canRedo: true, redoHistory });
    await writeFile(file, before, 'utf8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await new GameStore(dir).load()).toEqual([state()]);
    expect(error).toHaveBeenCalledWith('[!] store: invalid redo history discarded');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('load принимает полную цепочку redo и итог score только после двух пасов', async () => {
    const base = state();
    const first = applyMove(base, 'B', 'D4', T).state.moves[0]!;
    const afterFirst = applyMove(base, 'B', 'D4', T).state;
    const second = applyMove(afterFirst, 'W', 'E5', T).state.moves[1]!;
    const afterSecond = applyMove(afterFirst, 'W', 'E5', T).state;
    const passB = applyMove(afterSecond, 'B', 'pass', T).state.moves[2]!;
    const afterPassB = applyMove(afterSecond, 'B', 'pass', T).state;
    const passW = applyMove(afterPassB, 'W', 'pass', T).state.moves[3]!;
    const result = {
      winner: 'W' as const,
      margin: 7.5,
      reason: 'score' as const,
      score: { areaB: 1, areaW: 1, komi: 7.5, dead: [], ownership: new Array(169).fill(0) },
    };
    const redoHistory = [{ moves: [passB, passW], result }, { moves: [first, second] }];
    await writeFile(path.join(dir, 'g1.json'), JSON.stringify({ ...base, canRedo: true, redoHistory }), 'utf8');

    expect((await new GameStore(dir).load())[0]).toMatchObject({ canRedo: true, redoHistory });
  });

  it.each([
    ['сдача вместо счёта', { winner: 'W' as const, reason: 'resign' as const }],
    ['счёт до двух пасов', { winner: 'W' as const, margin: 7.5, reason: 'score' as const, score: { areaB: 1, areaW: 1, komi: 7.5, dead: [], ownership: new Array(169).fill(0) } }],
    ['ownership не размера доски', { winner: 'W' as const, margin: 7.5, reason: 'score' as const, score: { areaB: 1, areaW: 1, komi: 7.5, dead: [], ownership: [] } }],
  ])('load отбрасывает несогласованный результат redo: %s', async (kind, result) => {
    const base = state();
    const firstPass = applyMove(base, 'B', 'pass', T).state.moves[0]!;
    const afterFirst = applyMove(base, 'B', 'pass', T).state;
    const secondPass = applyMove(afterFirst, 'W', 'pass', T).state.moves[1]!;
    const moves = kind === 'счёт до двух пасов' ? [firstPass] : [firstPass, secondPass];
    await writeFile(path.join(dir, 'g1.json'), JSON.stringify({ ...base, redoHistory: [{ moves, result }] }), 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await new GameStore(dir).load()).toEqual([base]);
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

  it('отметки брошенных партий: пустой <id>.abandoned рядом со снапшотом; load их не читает; повтор и снятие отсутствующей — не ошибка; id проверяется', async () => {
    const store = new GameStore(dir);
    await store.init();
    await store.save(state());
    await store.markAbandoned('g1');
    await store.markAbandoned('g1');
    expect((await readdir(dir)).sort()).toEqual(['g1.abandoned', 'g1.json']);
    expect(await readFile(path.join(dir, 'g1.abandoned'), 'utf8')).toBe('');
    // Имя не по форме id — не отметка.
    await writeFile(path.join(dir, 'NOT-SAFE.abandoned'), '', 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await store.load()).map((g) => g.id)).toEqual(['g1']);
    expect(console.error).not.toHaveBeenCalled();
    expect(await new GameStore(dir).loadAbandoned()).toEqual(['g1']);
    await store.clearAbandoned('g1');
    await store.clearAbandoned('g1');
    expect(await store.loadAbandoned()).toEqual([]);
    await expect(store.markAbandoned('../x')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(store.clearAbandoned('../x')).rejects.toMatchObject({ code: 'bad_request' });
    expect(await new GameStore(path.join(dir, 'fresh')).loadAbandoned()).toEqual([]);
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

  it('remove на настоящем fs: снапшот исчезает из load, повторный remove без ошибки', async () => {
    const store = new GameStore(dir);
    await store.save(state());
    await store.save({ ...state(), id: 'g2' });
    await store.remove('g1');
    expect((await store.load()).map((g) => g.id)).toEqual(['g2']);
    await store.remove('g1');
    expect(await readdir(dir)).toEqual(['g2.json']);
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

  it('remove убирает снапшот из load и записывает id в removed', async () => {
    const store = memoryStore([state(), { ...state(), id: 'g2' }]);
    await store.remove('g1');
    expect((await store.load()).map((g) => g.id)).toEqual(['g2']);
    expect(store.removed).toEqual(['g1']);
  });
});
