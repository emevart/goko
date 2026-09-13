import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Точка входа действительно запускает сервер при любом способе вызова: стража прямого запуска нет,
// поэтому отказ без переменных окружения виден как код 2 и строки [X], а не молчаливый выход 0.

// Окружение подпроцесса — белый список без переменных Гоко: ключи с машины разработчика
// не должны поднять настоящий сервер.
const PASS_THROUGH = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'HOME'];

describe('точка входа game-server', () => {
  it('без переменных окружения выходит с кодом 2 и видимыми строками [X]', () => {
    const env: Record<string, string> = {};
    for (const name of PASS_THROUGH) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'main.ts')], {
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('[X] game-server: нужна переменная APP_KEY');
    expect(run.stdout).not.toContain('[OK]');
  });
});
