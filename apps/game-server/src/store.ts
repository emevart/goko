// Снапшоты партий: data/games/<id>.json, запись через временный файл и rename.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError, GameState } from '@goko/protocol';
import { MAX_ID_LENGTH, isSafeId } from './ids.ts';

export class GameStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
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

  async save(state: GameState): Promise<void> {
    // Форма id проверяется до файловой системы (isSafeId): ни выхода за каталог, ни имён устройств Windows.
    if (!isSafeId(state.id)) throw new ApiError('bad_request', `game id must match /^[0-9a-z]+$/, be at most ${MAX_ID_LENGTH} characters and not be a reserved Windows name`, { id: state.id });
    const file = path.join(this.dir, `${state.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, file);
  }
}
