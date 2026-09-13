// Запись снапшота через шов fs: порядок open/write/sync/close/rename, fsync каталога на POSIX, обрывы
// на каждом шаге. Файлы настоящие, во временном каталоге; каталог открывается подделкой: настоящий
// каталог на Windows так не открыть, а тест обязан проходить на любой платформе.
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newGame } from './game.ts';
import { GameStore, type StoreFs } from './store.ts';

let dir = '';
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(tmpdir(), 'goko-store-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const T = '2026-09-07T10:00:00.000Z';
const state = () =>
  newGame({ id: 'g1', createdAt: T, settings: { boardSize: 13, rules: 'chinese', komi: 7.5 }, seats: { B: { controller: 'human' }, W: { controller: 'engine', rank: '10k' } } });
const TMP = `g1.json.${process.pid}.tmp`;

type FailPoint = 'write' | 'sync' | 'rename' | 'openDir' | 'syncDir' | 'unlink';

// fs, записывающий шаги: имена относительно каталога снапшотов, сам каталог — <dir>.
function recordingFs(opts: { platform?: NodeJS.Platform; fail?: Partial<Record<FailPoint, Error>> } = {}) {
  const steps: string[] = [];
  const name = (file: string) => path.relative(dir, file) || '<dir>';
  const failAt = (point: FailPoint) => {
    const e = opts.fail?.[point];
    if (e) throw e;
  };
  const fs: StoreFs = {
    platform: opts.platform ?? 'linux',
    open: async (file, flags) => {
      steps.push(`open ${name(file)} ${flags}`);
      if (file === dir) {
        failAt('openDir');
        return {
          writeFile: async () => {
            throw new Error('a directory is not writable');
          },
          sync: async () => {
            steps.push('sync <dir>');
            failAt('syncDir');
          },
          close: async () => {
            steps.push('close <dir>');
          },
        };
      }
      const handle = await fsp.open(file, flags);
      return {
        writeFile: async (data, encoding) => {
          steps.push(`write ${name(file)}`);
          const e = opts.fail?.write;
          if (!e) return handle.writeFile(data, encoding);
          // Половина содержимого на диске, затем обрыв: так выглядит падение при записи.
          await handle.writeFile(data.slice(0, Math.floor(data.length / 2)), encoding);
          throw e;
        },
        sync: async () => {
          steps.push(`sync ${name(file)}`);
          failAt('sync');
          await handle.sync();
        },
        close: async () => {
          steps.push(`close ${name(file)}`);
          await handle.close();
        },
      };
    },
    rename: async (from, to) => {
      steps.push(`rename ${name(from)} ${name(to)}`);
      failAt('rename');
      await fsp.rename(from, to);
    },
    unlink: async (file) => {
      steps.push(`unlink ${name(file)}`);
      failAt('unlink');
      await fsp.unlink(file);
    },
  };
  return { fs, steps };
}

const WRITE_STEPS = [`open ${TMP} w`, `write ${TMP}`, `sync ${TMP}`, `close ${TMP}`, `rename ${TMP} g1.json`];
const DIR_SYNC_STEPS = ['open <dir> r', 'sync <dir>', 'close <dir>'];

describe('GameStore: запись через шов fs', () => {
  it('save: временный файл открыт, записан, sync, закрыт, перенесён; затем fsync каталога', async () => {
    const { fs, steps } = recordingFs();
    const store = new GameStore(dir, fs);
    await store.init();
    await store.save(state());
    expect(steps).toEqual([...WRITE_STEPS, ...DIR_SYNC_STEPS]);
    expect(await fsp.readdir(dir)).toEqual(['g1.json']);
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'g1.json'), 'utf8'))).toEqual(state());
  });

  it('win32: fsync каталога пропускается, файл всё равно проходит sync', async () => {
    const { fs, steps } = recordingFs({ platform: 'win32' });
    const store = new GameStore(dir, fs);
    await store.save(state());
    expect(steps).toEqual(WRITE_STEPS);
  });

  it.each([
    ['открытия каталога', 'openDir' as const, [...WRITE_STEPS, 'open <dir> r']],
    ['fsync каталога', 'syncDir' as const, [...WRITE_STEPS, ...DIR_SYNC_STEPS]],
  ])('отказ %s игнорируется: снапшот записан, дескриптор каталога закрыт', async (_label, point, expected) => {
    const { fs, steps } = recordingFs({ fail: { [point]: Object.assign(new Error('EINVAL'), { code: 'EINVAL' }) } });
    const store = new GameStore(dir, fs);
    await store.save(state());
    expect(steps).toEqual(expected);
    expect((await store.load()).map((g) => g.revision)).toEqual([0]);
  });

  it('обрыв записи: дескриптор закрыт, переноса нет, прежний снапшот цел', async () => {
    await new GameStore(dir, recordingFs().fs).save(state());
    const { fs, steps } = recordingFs({ fail: { write: new Error('disk full') } });
    const store = new GameStore(dir, fs);
    await expect(store.save({ ...state(), revision: 5 })).rejects.toThrow('disk full');
    expect(steps).toEqual([`open ${TMP} w`, `write ${TMP}`, `close ${TMP}`]);
    const loaded = await store.load();
    expect(loaded.map((g) => g.revision)).toEqual([0]);
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'g1.json'), 'utf8'))).toEqual(state());
  });

  it('отказ sync файла: дескриптор закрыт, переноса нет', async () => {
    const { fs, steps } = recordingFs({ fail: { sync: new Error('EIO') } });
    const store = new GameStore(dir, fs);
    await expect(store.save(state())).rejects.toThrow('EIO');
    expect(steps).toEqual([`open ${TMP} w`, `write ${TMP}`, `sync ${TMP}`, `close ${TMP}`]);
    expect(await fsp.readdir(dir)).not.toContain('g1.json');
  });

  it('отказ переноса: отказ записи, fsync каталога не идёт', async () => {
    const { fs, steps } = recordingFs({ fail: { rename: new Error('EXDEV') } });
    await expect(new GameStore(dir, fs).save(state())).rejects.toThrow('EXDEV');
    expect(steps).toEqual(WRITE_STEPS);
  });

  it('save отвергает идентификатор, который выходит за каталог снапшотов, зарезервирован в Windows или длиннее предела', async () => {
    const { fs, steps } = recordingFs();
    const store = new GameStore(path.join(dir, 'games'), fs);
    await store.init();
    for (const id of ['../escaped', '', 'a/b', 'a\\b', '.', 'g1.json', 'con', 'nul', 'com1', 'lpt9', 'a'.repeat(65)]) {
      await expect(store.save({ ...state(), id })).rejects.toMatchObject({
        code: 'bad_request',
        status: 400,
        message: 'game id must match /^[0-9a-z]+$/, be at most 64 characters and not be a reserved Windows name',
        details: { id },
      });
    }
    expect(await fsp.readdir(path.join(dir, 'games'))).toEqual([]);
    expect(await fsp.readdir(dir)).toEqual(['games']);
    expect(steps).toEqual([]);
  });
});

describe('GameStore.remove через шов fs', () => {
  it('удаляет снапшот и синхронизирует каталог', async () => {
    await new GameStore(dir, recordingFs().fs).save(state());
    const { fs, steps } = recordingFs();
    const store = new GameStore(dir, fs);
    await store.remove('g1');
    expect(steps).toEqual(['unlink g1.json', ...DIR_SYNC_STEPS]);
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('отсутствующий снапшот — без ошибки; другой отказ удаления уходит вызывающему', async () => {
    await expect(new GameStore(dir, recordingFs().fs).remove('g1')).resolves.toBeUndefined();
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const { fs, steps } = recordingFs({ fail: { unlink: eperm } });
    await expect(new GameStore(dir, fs).remove('g1')).rejects.toBe(eperm);
    expect(steps).toEqual(['unlink g1.json']);
  });

  it('небезопасный id — bad_request до файловой системы', async () => {
    const { fs, steps } = recordingFs();
    await expect(new GameStore(dir, fs).remove('../escaped')).rejects.toMatchObject({ code: 'bad_request', details: { id: '../escaped' } });
    expect(steps).toEqual([]);
  });
});
