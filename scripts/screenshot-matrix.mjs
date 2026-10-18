// CLI Playwright поверх уже запущенного бесплатного preview; серверы не запускает.
import { chromium, expect } from '@playwright/test';
import { mkdir, access, writeFile } from 'node:fs/promises';
import path from 'node:path';

const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('usage: node scripts/screenshot-matrix.mjs before|after [http://127.0.0.1:4173]');
const baseURL = process.argv[3] ?? 'http://127.0.0.1:4173';
const url = new URL(baseURL);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Нужен локальный бесплатный preview');
const directory = path.resolve('.agent-artifacts/cloud-product', phase);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const manifest = [];
let client = 100;
try {
  for (const [name, viewport] of [['narrow', { width: 360, height: 640 }], ['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ baseURL, viewport, colorScheme, reducedMotion: 'reduce', permissions: ['microphone'] });
      const page = await context.newPage();
      const forwarded = `198.19.${process.pid % 254}.${client++}`;
      await page.route('**/api/**', route => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': forwarded } }));
      // Два человека дают воспроизводимые камни через настоящий HTTP/SSE.
      await page.route('**/api/sessions/*/games', route => route.fallback({ postData: JSON.stringify({ ...route.request().postDataJSON(), black: { controller: 'human' }, white: { controller: 'human' } }) }));
      const capture = async state => {
        const file = `${name}-${colorScheme}-${state}.png`;
        const target = path.join(directory, file);
        if (phase === 'before') {
          const exists = await access(target).then(() => true, () => false);
          if (exists) throw new Error(`Baseline уже существует: ${target}`);
        }
        await page.screenshot({ path: target, fullPage: true });
        manifest.push({ file, viewport, colorScheme, state });
      };
      await page.goto('/');
      await expect(page.getByRole('img', { name: /доска 13×13/ })).toBeVisible();
      await capture('cold');
      await page.getByRole('button', { name: 'Новая партия' }).click();
      const created = page.waitForResponse(response => /\/api\/sessions\/[^/]+\/games$/.test(response.url()));
      await page.getByRole('button', { name: 'Начать' }).click();
      if (!(await created).ok()) {
        const error = (await (await created).json()).error;
        throw new Error(`HTTP newGame отказал: ${(await created).status()} ${error?.code}`);
      }
      await expect(page.getByRole('button', { name: 'Пас' })).toBeEnabled();
      for (const [col, row] of [[3, 3], [9, 9], [4, 4], [9, 3], [8, 2]]) {
        const board = page.getByRole('img', { name: /доска 13×13/ });
        const box = await board.boundingBox();
        const side = Math.min(box.width, box.height), step = side / 14;
        const done = page.waitForResponse(response => response.url().endsWith('/play'));
        await board.click({ position: { x: (box.width - side) / 2 + step * (col + 1), y: (box.height - side) / 2 + step * (13 - row) } });
        if (!(await done).ok()) throw new Error('HTTP play отказал');
        await expect(page.getByRole('button', { name: 'Пас' })).toBeEnabled();
      }
      await expect(page.locator('.mark-on-b')).toHaveCount(1);
      await capture('game');
      await page.getByRole('textbox', { name: 'сообщение Гоко' }).fill('Почему этот ход укрепляет угол?');
      await page.getByRole('textbox', { name: 'сообщение Гоко' }).press('Enter');
      await expect(page.locator('.line-goko')).toContainText('Принято:');
      await page.getByRole('button', { name: /История ходов/ }).click();
      await expect(page.locator('.move-last')).toContainText('J3');
      await capture('history-dialog');
      await page.getByRole('button', { name: /Закрыть: История/ }).click();
      await page.getByRole('button', { name: 'Новая партия' }).click();
      await capture('newgame-dialog');
      await page.getByRole('button', { name: 'Отмена', exact: true }).click();
      await page.route('**/api/games/*/pass', route => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'too_many_games', message: 'fixture', details: { scope: 'client' } } }) }));
      await page.getByRole('button', { name: 'Пас', exact: true }).click();
      await expect(page.locator('.status')).toContainText('у тебя слишком много незаконченных партий');
      await capture('refusal-dialog');
      await page.getByRole('button', { name: 'Говорить с Гоко' }).click();
      await expect(page.getByRole('button', { name: /Слушаю.*Выключить микрофон/ })).toBeVisible();
      await capture('voice-fallback');
      await page.getByRole('button', { name: 'Выйти из голосового разговора' }).click();
      const { state: game } = await (await created).json();
      const finished = await page.request.post(`/api/games/${game.id}/resign`, { headers: { 'x-app-key': 'goko-preview' }, data: { color: 'B', via: 'api' } });
      if (!finished.ok()) throw new Error('Не удалось завершить fixture game');
      await context.close();
    }
  }
  await writeFile(path.join(directory, 'matrix-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[OK] ${manifest.length} screenshots: ${directory}`);
} finally { await browser.close(); }
