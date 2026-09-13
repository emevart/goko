// Снапшоты партий: data/games/<id>.json, запись через временный файл и rename.
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ApiError, GameState } from '@goko/protocol';
import { MAX_ID_LENGTH, isSafeId } from './ids.ts';

// Шов файловой системы для записи и удаления: тест видит порядок шагов и обрывает любой из них.
export type StoreFileHandle = {
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};
export type StoreFs = {
  open(file: string, flags: string): Promise<StoreFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  platform: NodeJS.Platform;
};

const nodeFs: StoreFs = { open: (file, flags) => open(file, flags), rename, unlink, platform: process.platform };

function checkId(id: string): void {
  // Форма id проверяется до файловой системы (isSafeId): ни выхода за каталог, ни имён устройств Windows.
  if (!isSafeId(id)) throw new ApiError('bad_request', `game id must match /^[0-9a-z]+$/, be at most ${MAX_ID_LENGTH} characters and not be a reserved Windows name`, { id });
}

// То, чем сервис пользуется от хранилища: подделка в памяти для тестов реализует только это.
export type SnapshotStore = Pick<GameStore, 'dir' | 'init' | 'load' | 'save' | 'remove'>;

export class GameStore {
  readonly dir: string;
  private readonly fs: StoreFs;

  constructor(dir: string, fs: StoreFs = nodeFs) {
    this.dir = dir;
    this.fs = fs;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async load(): Promise<GameState[]> {
    await this.init();
    const out: GameState[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      try {
        const parsed = GameState.safeParse(JSON.parse(await readFile(file, 'utf8')));
        if (parsed.success) out.push(parsed.data);
        else console.error(`[!] store: ${name} does not match the schema, skipped`);
      } catch {
        console.error(`[!] store: ${name} is not readable, skipped`);
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Долговечная запись: содержимое временного файла сброшено на диск (sync) до rename, а сам rename —
  // fsync каталога. Иначе после отключения питания под именем снапшота мог оказаться пустой файл.
  async save(state: GameState): Promise<void> {
    checkId(state.id);
    const file = path.join(this.dir, `${state.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    const handle = await this.fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(state), 'utf8');
      await handle.sync();
    } catch (e) {
      // Отказ закрытия не должен заслонить исходный отказ записи.
      await handle.close().catch(() => undefined);
      throw e;
    }
    await handle.close();
    await this.fs.rename(tmp, file);
    await this.syncDir();
  }

  // Удаление снапшота (срок хранения завершённых партий, D-0012). Отсутствующий файл — не ошибка.
  async remove(id: string): Promise<void> {
    checkId(id);
    try {
      await this.fs.unlink(path.join(this.dir, `${id}.json`));
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'ENOENT') throw e;
      return;
    }
    await this.syncDir();
  }

  // fsync каталога фиксирует rename и unlink (POSIX). На Windows каталог так не открыть, а NTFS сама
  // журналирует метаданные, поэтому шаг пропускается. Ошибка здесь игнорируется: файл уже целиком
  // лежит под своим именем, а часть файловых систем (сетевые, некоторые тома контейнеров) fsync
  // каталога не поддерживает — отказывать записи из-за этого нельзя.
  private async syncDir(): Promise<void> {
    if (this.fs.platform === 'win32') return;
    try {
      const handle = await this.fs.open(this.dir, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // см. комментарий выше: долговечность rename — best effort
    }
  }
}
