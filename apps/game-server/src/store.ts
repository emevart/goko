// Снапшоты партий: data/games/<id>.json, запись через временный файл и rename.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GameState } from '@goko/protocol';

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
        else console.error(`[!] store: ${name} не по схеме, пропущен`);
      } catch {
        console.error(`[!] store: ${name} не читается, пропущен`);
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async save(state: GameState): Promise<void> {
    const file = path.join(this.dir, `${state.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, file);
  }
}
