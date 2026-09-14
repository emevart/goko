// Снапшоты партий: data/games/<id>.json, запись через временный файл и rename.
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { emptyPosition, formatCoord, opposite, parseCoord, play, resultFromArea } from '@goko/go-core';
import { ApiError, GameState, Move, Result, type GameState as GameStateType, type Move as MoveType, type Result as ResultType } from '@goko/protocol';
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

// Отметка брошенной сменой партии (D-0012): пустой файл рядом со снапшотом. load его не читает (не .json),
// поэтому формат снапшота не меняется, а отметка переживает рестарт.
const ABANDONED_SUFFIX = '.abandoned';

// То, чем сервис пользуется от хранилища: подделка в памяти для тестов реализует только это.
export const RedoPortion = z.object({ moves: z.array(Move), result: Result.optional() });
export type RedoPortion = { moves: MoveType[]; result?: ResultType };
export type GameSnapshot = GameStateType & { redoHistory?: RedoPortion[] };
const SnapshotHistory = z.object({ redoHistory: z.array(RedoPortion).optional() });
export type SnapshotStore = Pick<GameStore, 'dir' | 'init' | 'load' | 'save' | 'remove'>;
// Отметки брошенных партий: отдельный необязательный шов сервиса, подделка в памяти — memoryMarks.
export type AbandonMarks = Pick<GameStore, 'loadAbandoned' | 'markAbandoned' | 'clearAbandoned'>;

function validRedoHistory(state: GameStateType, history: RedoPortion[]): boolean {
  if (history.length === 0) return true;
  if (state.status !== 'playing' || state.result !== undefined) return false;
  let position = emptyPosition(state.settings.boardSize);
  let nextN = 1;
  let nextColor: MoveType['color'] = 'B';
  let consecutivePasses = 0;
  const replayMove = (move: MoveType): boolean => {
    if (move.n !== nextN || move.color !== nextColor) return false;
    try {
      const point = parseCoord(move.coord, state.settings.boardSize);
      const coord = point === 'pass' ? 'pass' : formatCoord(point);
      if (move.coord !== coord) return false;
      const played = play(position, move.color, coord);
      if (move.captured !== played.captured) return false;
      position = played.position;
      consecutivePasses = coord === 'pass' ? consecutivePasses + 1 : 0;
    } catch {
      return false;
    }
    nextN++;
    nextColor = opposite(nextColor);
    return true;
  };
  for (const move of state.moves) if (!replayMove(move)) return false;
  if (state.toPlay !== nextColor || state.consecutivePasses !== consecutivePasses) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    const portion = history[i];
    if (!portion || portion.moves.length === 0) return false;
    for (const move of portion.moves) if (!replayMove(move)) return false;
    if (!portion.result) continue;
    if (i !== 0 || portion.result.reason !== 'score' || consecutivePasses < 2) return false;
    const score = portion.result.score;
    if (!score) return false;
    if (score.ownership.length !== state.settings.boardSize ** 2 || score.komi !== state.settings.komi) return false;
    const expected = resultFromArea(score);
    if (portion.result.winner !== expected.winner || portion.result.margin !== expected.margin) return false;
    try {
      for (const coord of score.dead) if (parseCoord(coord, state.settings.boardSize) === 'pass') return false;
    } catch {
      return false;
    }
  }
  return true;
}

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

  async load(): Promise<GameSnapshot[]> {
    await this.init();
    const out: GameSnapshot[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
        const history = SnapshotHistory.safeParse(raw);
        const parsed = GameState.safeParse({ ...(raw as Record<string, unknown>), canRedo: false });
        if (!parsed.success) {
          console.error(`[!] store: ${name} does not match the schema, skipped`);
          continue;
        }
        const redoHistory = history.success ? (history.data.redoHistory ?? []) : [];
        if (!history.success || !validRedoHistory(parsed.data, redoHistory)) {
          console.error('[!] store: invalid redo history discarded');
          out.push(parsed.data);
          continue;
        }
        out.push({ ...parsed.data, canRedo: redoHistory.length > 0, ...(redoHistory.length > 0 ? { redoHistory } : {}) });
      } catch {
        console.error(`[!] store: ${name} is not readable, skipped`);
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Долговечная запись: содержимое временного файла сброшено на диск (sync) до rename, а сам rename —
  // fsync каталога. Иначе после отключения питания под именем снапшота мог оказаться пустой файл.
  async save(state: GameStateType, redoHistory: RedoPortion[] = []): Promise<void> {
    checkId(state.id);
    const file = path.join(this.dir, `${state.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    const handle = await this.fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify({ ...state, ...(redoHistory.length > 0 ? { redoHistory } : {}) }), 'utf8');
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

  // id партий с отметкой <id>.abandoned; имя не по форме id пропускается, как чужой файл.
  async loadAbandoned(): Promise<string[]> {
    await this.init();
    return (await readdir(this.dir))
      .filter((name) => name.endsWith(ABANDONED_SUFFIX))
      .map((name) => name.slice(0, -ABANDONED_SUFFIX.length))
      .filter(isSafeId)
      .sort();
  }

  // Пустой файл долговечно, как снапшот: sync файла и каталога. Повтор — не ошибка.
  async markAbandoned(id: string): Promise<void> {
    checkId(id);
    const handle = await this.fs.open(path.join(this.dir, `${id}${ABANDONED_SUFFIX}`), 'w');
    try {
      await handle.sync();
    } catch (e) {
      await handle.close().catch(() => undefined);
      throw e;
    }
    await handle.close();
    await this.syncDir();
  }

  // Снятие отметки: к партии вернулись или она уже не идёт. Отсутствующий файл — не ошибка.
  async clearAbandoned(id: string): Promise<void> {
    checkId(id);
    try {
      await this.fs.unlink(path.join(this.dir, `${id}${ABANDONED_SUFFIX}`));
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
