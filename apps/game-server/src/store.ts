// Снапшоты партий: data/games/<id>.json, запись через временный файл и rename.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError, GameState } from '@goko/protocol';

// Форма идентификатора партии: только цифры и строчные латинские буквы, как у newId().
// Проверяется до обращения к файловой системе, иначе id вида '../escaped' написал бы
// файл за пределами каталога снапшотов.
// [!] Образец не ограничивает длину и пропускает зарезервированные в Windows имена
// ('con', 'nul', 'aux', 'prn'). Из newId() такие значения недостижимы; задаче 12,
// где id приходит снаружи, оба пробела закрывать осознанно.
const ID_PATTERN = /^[0-9a-z]+$/;

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
    if (!ID_PATTERN.test(state.id)) throw new ApiError('bad_request', 'game id must match /^[0-9a-z]+$/', { id: state.id });
    const file = path.join(this.dir, `${state.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, file);
  }
}
