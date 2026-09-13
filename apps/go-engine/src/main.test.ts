import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Точка входа действительно запускает сервис при любом способе вызова. Раньше страж прямого
// запуска сравнивал пути и через symlink/junction молча выходил с кодом 0; теперь стража нет,
// и отказ без переменных окружения виден как код 2 и строка [X].

// Окружение подпроцесса — белый список без переменных Гоко: KATAGO_BIN и ENGINE_KEY с машины
// разработчика не должны поднять настоящий движок.
const PASS_THROUGH = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'HOME'];

describe('точка входа go-engine', () => {
  it('без KATAGO_BIN и ENGINE_KEY выходит с кодом 2 и видимой строкой, а не молча', () => {
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
    expect(run.stderr).toContain('[X] go-engine: нужна переменная KATAGO_BIN');
    expect(run.stderr).toContain('[X] go-engine: нужна переменная ENGINE_KEY');
  });
});
