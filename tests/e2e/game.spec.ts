import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { finishGames, isolateClient, playAt, startGame } from './helpers.ts';

test.beforeEach(async ({ page }, testInfo) => {
  await isolateClient(page, testInfo);
});
test.afterEach(async ({ page }) => { await finishGames(page); });

test('@layout актуальный интерфейс доступен без запуска разговора', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Гоко' })).toBeVisible();
  await expect(page.getByRole('img', { name: /доска 13×13/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'сообщение Гоко' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Говорить с Гоко' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('новая партия, D4, края доски и блокировка двойного тапа', async ({ page }) => {
  await page.goto('/');
  await startGame(page);
  const requests: string[] = [];
  await page.route('**/api/games/*/play', async (route) => {
    requests.push((route.request().postDataJSON() as { coord: string }).coord);
    await route.continue();
  });

  await playAt(page, 3, 3); // D4
  await expect.poll(() => requests).toEqual(['D4']);
  await expect(page.getByRole('button', { name: 'Пас' })).toBeEnabled();

  const board = page.getByRole('img', { name: /доска 13×13/ });
  const box = await board.boundingBox();
  if (!box) throw new Error('доска не получила размер');
  const side = Math.min(box.width, box.height);
  const step = side / 14;
  await board.dblclick({ position: { x: (box.width - side) / 2 + step, y: (box.height - side) / 2 + step * 13 } }); // A1
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.getByRole('button', { name: 'Пас' })).toBeEnabled();

  await page.getByRole('button', { name: 'Новая партия' }).click();
  await page.getByRole('button', { name: 'Начать' }).click();
  await expect(page.getByRole('button', { name: 'Пас' })).toBeEnabled();
  await playAt(page, 12, 12); // N13: 13-я колонка в интерфейсе
  await expect.poll(() => requests.at(-1)).toBe('N13');
});

test('назад, вперёд и пас проходят через реальный HTTP/SSE', async ({ page }) => {
  await page.goto('/');
  await startGame(page);
  await playAt(page, 3, 3);
  await expect(page.getByRole('button', { name: 'назад, отменить ход' })).toBeEnabled();

  const undo = page.waitForResponse((response) => response.url().endsWith('/undo'));
  await page.getByRole('button', { name: 'назад, отменить ход' }).click();
  expect((await undo).ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'вперёд, вернуть ход' })).toBeEnabled();

  const redo = page.waitForResponse((response) => response.url().endsWith('/redo'));
  await page.getByRole('button', { name: 'вперёд, вернуть ход' }).click();
  expect((await redo).ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'Пас' })).toBeEnabled();

  const pass = page.waitForResponse((response) => response.url().endsWith('/pass'));
  await page.getByRole('button', { name: 'Пас' }).click();
  const state = await (await pass).json() as { state: { moves: Array<{ coord: string }> } };
  expect(state.state.moves.some((move) => move.coord === 'pass')).toBe(true);
});

test('перезагрузка сохраняет текущую партию и настройки новой игры', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая партия' }).click();
  await page.getByRole('button', { name: 'сильнее' }).click();
  await page.getByRole('button', { name: 'Начать' }).click();
  await expect(page.getByRole('button', { name: 'Пас' })).toBeEnabled();
  await playAt(page, 3, 3);
  await expect(page.getByRole('button', { name: 'Пас' })).toBeEnabled();
  await page.reload();
  await expect(page.locator('.stone-b')).toHaveCount(1);
  await page.getByRole('button', { name: 'Новая партия' }).click();
  await expect(page.locator('.rank-value')).toHaveText('9k');
});

test('отказ создания сессии восстанавливается повторным явным действием', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/sessions', async (route) => {
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'mock' } }) });
    else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая партия' }).click();
  await page.getByRole('button', { name: 'Начать' }).click();
  await expect(page.locator('.status-notice')).toBeVisible();
  await page.getByRole('button', { name: 'Новая партия' }).click();
  await page.getByRole('button', { name: 'Начать' }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByRole('button', { name: 'Пас' })).toBeEnabled();
});

test('@visual скриншот текущего интерфейса', async ({ page }, testInfo) => {
  await page.goto('/');
  await startGame(page);
  await page.getByRole('button', { name: /Диалог/ }).click();
  const directory = path.resolve('.agent-artifacts/playwright/screenshots');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${testInfo.project.name}.png`), fullPage: true });
});
