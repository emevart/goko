import { expect, type Page, type TestInfo } from '@playwright/test';

let client = 10;

export async function isolateClient(page: Page, _testInfo: TestInfo) {
  const forwarded = `203.0.113.${client++}`;
  await page.route('**/api/**', async (route) => {
    await route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': forwarded } });
  });
}

export async function startGame(page: Page) {
  await page.getByRole('button', { name: 'Новая партия' }).click();
  await page.getByRole('button', { name: 'Начать' }).click();
  await expect(page.getByRole('button', { name: 'Пас' })).toBeEnabled();
}

export async function playAt(page: Page, col: number, row: number) {
  const board = page.getByRole('img', { name: /доска 13×13/ });
  const box = await board.boundingBox();
  if (!box) throw new Error('доска не получила размер');
  const side = Math.min(box.width, box.height);
  const left = (box.width - side) / 2;
  const top = (box.height - side) / 2;
  const step = side / 14;
  await board.click({ position: { x: left + step * (col + 1), y: top + step * (13 - row) } });
}
