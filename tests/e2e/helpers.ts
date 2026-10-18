import { expect, type Page, type TestInfo } from '@playwright/test';

let client = 10;
const games = new WeakMap<Page, { pending: Promise<void>[]; ids: Map<string, 'B' | 'W'> }>();

export async function isolateClient(page: Page, _testInfo: TestInfo) {
  // Зарезервированная тестовая сеть; новый worker не переиспользует лимиты прежнего.
  const forwarded = `198.18.${process.pid % 254}.${client++}`;
  const owned = { pending: [] as Promise<void>[], ids: new Map<string, 'B' | 'W'>() };
  games.set(page, owned);
  page.on('response', response => {
    if (response.request().method() !== 'POST' || !/\/api\/sessions\/[^/]+\/games$/.test(response.url()) || !response.ok()) return;
    owned.pending.push(response.json().then(({ state }) => {
      owned.ids.set(state.id, state.seats.B.controller === 'human' ? 'B' : 'W');
    }));
  });
  await page.route('**/api/**', async (route) => {
    await route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': forwarded } });
  });
}

export async function finishGames(page: Page) {
  const owned = games.get(page);
  if (!owned) return;
  await Promise.all(owned.pending);
  for (const [id, color] of owned.ids) {
    const response = await page.request.post(`/api/games/${id}/resign`, { headers: { 'x-app-key': 'goko-preview' }, data: { color, via: 'api' } });
    if (!response.ok()) expect((await response.json()).error.code).toBe('game_finished');
  }
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
