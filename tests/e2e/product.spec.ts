import { expect, test, type Page } from '@playwright/test';
import { finishGames, isolateClient, playAt, startGame } from './helpers.ts';

test.beforeEach(async ({ page }, info) => { await isolateClient(page, info); });
test.afterEach(async ({ page }) => { await finishGames(page); });

async function humans(page: Page) {
  await page.route('**/api/sessions/*/games', route => route.fallback({ postData: JSON.stringify({ ...route.request().postDataJSON(), black: { controller: 'human' }, white: { controller: 'human' } }) }));
  await page.goto('/');
  const created = page.waitForResponse(response => /\/api\/sessions\/[^/]+\/games$/.test(response.url()));
  await startGame(page);
  return (await (await created).json()).state as { id: string };
}

async function withinViewport(page: Page, selector: string) {
  const bounds = await page.locator(selector).boundingBox();
  expect(bounds).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('@layout отказ читается полностью, статус партии и composer доступны при раскрытом диалоге', async ({ page }) => {
  await humans(page);
  await page.getByRole('button', { name: /Диалог/ }).click();
  await page.route('**/api/games/*/pass', route => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'too_many_games', message: 'fixture', details: { scope: 'client' } } }) }));
  await page.getByRole('button', { name: 'Пас', exact: true }).click();
  await expect(page.locator('.status-message')).toHaveText('у тебя слишком много незаконченных партий, новую можно начать позже');
  await expect(page.locator('.status-main')).toContainText('ход');
  expect(await page.locator('.status-message').evaluate(element => {
    const style = getComputedStyle(element);
    return element.scrollHeight <= element.clientHeight && style.webkitLineClamp === 'none';
  })).toBe(true);
  await withinViewport(page, '.chat-input');
  await withinViewport(page, '.game-actions');
  const input = page.getByRole('textbox', { name: 'сообщение Гоко' });
  await input.fill('Можно начать позже?');
  await input.press('Enter');
  await expect(page.locator('.line-goko')).toContainText('Принято: Можно начать позже?');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
});

test('@layout panels, камни и метка последнего хода остаются доступны', async ({ page }) => {
  await humans(page);
  await playAt(page, 3, 3);
  await expect(page.locator('.stone-b')).toHaveCount(1);
  await playAt(page, 9, 9);
  await expect(page.locator('.stone-w')).toHaveCount(1);
  await expect(page.getByRole('img', { name: /последний ход K10/ })).toBeVisible();
  await expect(page.locator('.mark-on-w')).toHaveCount(1);
  await expect(page.locator('.mark-on-b')).toHaveCount(0);
  await page.getByRole('button', { name: /История ходов/ }).click();
  await expect(page.locator('.move-last')).toContainText('Белые · K10');
  await withinViewport(page, '.utility-panel');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /История ходов/ })).toBeFocused();
  await expect(page.locator('.utility-panel')).toHaveCount(0);
  await page.getByRole('button', { name: 'Запись для диагностики' }).click();
  await expect(page.getByRole('button', { name: 'Начать запись' })).toBeVisible();
  await withinViewport(page, '.utility-panel');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Новая партия' }).click();
  await withinViewport(page, '.newgame');
  await expect(page.getByRole('button', { name: 'Начать', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await withinViewport(page, '.chat-input');
  if (page.viewportSize()!.width > 720) {
    const history = (await page.getByRole('button', { name: /История ходов/ }).boundingBox())!;
    const diagnostics = (await page.getByRole('button', { name: 'Запись для диагностики' }).boundingBox())!;
    const newgame = (await page.getByRole('button', { name: 'Новая партия' }).boundingBox())!;
    expect(diagnostics.x - history.x - history.width).toBeLessThanOrEqual(16);
    expect(newgame.x - diagnostics.x - diagnostics.width).toBeLessThanOrEqual(16);
  }
});

test('@layout keyboard focus и touch targets имеют ясное состояние', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /История ходов/ })).toBeFocused();
  expect(await page.locator(':focus-visible').evaluate(element => {
    const style = getComputedStyle(element);
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
  })).toBe(true);
  for (const button of await page.getByRole('button').all()) {
    const box = await button.boundingBox();
    if (box) { expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44); }
  }
  const disabled = page.getByRole('button', { name: 'Пас', exact: true });
  await expect(disabled).toBeDisabled();
  expect(await disabled.evaluate(element => getComputedStyle(element).cursor)).toBe('not-allowed');
  const enabled = page.getByRole('button', { name: 'Новая партия' });
  const original = await enabled.evaluate(element => getComputedStyle(element).backgroundColor);
  await enabled.hover();
  await expect.poll(() => enabled.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(original);
});

test('@layout hold-drag ставит один камень; cancel и выход за доску не создают ход', async ({ page }) => {
  const game = await humans(page);
  const requests: string[] = [];
  await page.route('**/api/games/*/play', route => { requests.push(route.request().postDataJSON().coord); return route.continue(); });
  const board = page.getByRole('img', { name: /доска 13×13/ });
  const box = (await board.boundingBox())!;
  const side = Math.min(box.width, box.height), step = side / 14;
  const point = (col: number, row: number) => ({ x: box.x + (box.width - side) / 2 + step * (col + 1), y: box.y + (box.height - side) / 2 + step * (13 - row) });
  const d4 = point(3, 3), e5 = point(4, 4);
  await page.mouse.move(d4.x, d4.y); await page.mouse.down();
  await expect(page.locator('.board-preview-label')).toContainText('D4');
  expect(requests).toEqual([]);
  await page.mouse.move(e5.x, e5.y);
  await expect(page.locator('.board-preview-label')).toContainText('E5');
  await page.mouse.up();
  await expect.poll(() => requests).toEqual(['E5']);
  await expect(page.locator('.stone-b')).toHaveCount(1);
  await page.mouse.move(d4.x, d4.y); await page.mouse.down();
  await expect(page.locator('.board-preview-label')).toBeVisible();
  await board.dispatchEvent('pointercancel', { pointerId: 1, isPrimary: true });
  await page.mouse.up();
  await expect(page.locator('.board-preview-label')).toHaveCount(0);
  expect(requests).toEqual(['E5']);
  await page.mouse.move(d4.x, d4.y); await page.mouse.down();
  await page.mouse.move(box.x + box.width + 10, box.y);
  await page.mouse.up();
  await expect(page.locator('.board-preview-label')).toHaveCount(0);
  expect(requests).toEqual(['E5']);
  // Чужое действие HTTP/SSE меняет revision, пока палец ещё удерживает доску.
  await page.mouse.move(d4.x, d4.y); await page.mouse.down();
  await expect(page.locator('.board-preview-label')).toBeVisible();
  const changed = await page.request.post(`/api/games/${game.id}/play`, { headers: { 'x-app-key': 'goko-preview' }, data: { coord: 'K10', expectedRevision: 1, via: 'api' } });
  expect(changed.ok()).toBe(true);
  await expect(page.locator('.stone-w')).toHaveCount(1);
  await expect(page.locator('.board-preview-label')).toHaveCount(0);
  await page.mouse.up();
  expect(requests).toEqual(['E5']);
});

for (const fallback of ['reduced-motion', 'no-webgl', 'context-lost'] as const) {
  test(`@visual orb ${fallback}: CSS fallback сохраняет подпись, mute и повторный вход`, async ({ page }) => {
    if (fallback === 'reduced-motion') await page.emulateMedia({ reducedMotion: 'reduce' });
    if (fallback === 'no-webgl') await page.addInitScript(() => {
      const native = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind: string, ...args: unknown[]) {
        if (kind.startsWith('webgl')) return null;
        return (native as Function).call(this, kind, ...args);
      } as typeof native;
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Говорить с Гоко' }).click();
    const orb = page.getByRole('button', { name: /Слушаю.*Выключить микрофон/ });
    await expect(orb).toBeVisible();
    if (fallback === 'context-lost') {
      await expect(page.locator('.voice-orb-canvas')).toBeVisible();
      await expect.poll(() => page.locator('.voice-orb-canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width)).not.toBe(300);
      await page.locator('.voice-orb-canvas').evaluate(canvas => {
        const context = (canvas as HTMLCanvasElement).getContext('webgl2');
        const extension = context?.getExtension('WEBGL_lose_context');
        if (!extension) throw new Error('WEBGL_lose_context недоступен');
        extension.loseContext();
      });
    }
    await expect(page.locator('.voice-orb-fallback-visible')).toBeVisible();
    await expect(page.locator('.voice-orb-canvas')).toHaveCount(0);
    if (fallback === 'reduced-motion') expect(await page.locator('.voice-orb-visual').evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none');
    await orb.click();
    await expect(page.getByRole('button', { name: /Микрофон выключен.*Включить микрофон/ })).toBeVisible();
    await page.getByRole('button', { name: 'Выйти из голосового разговора' }).click();
    await expect(page.locator('.voice-orb')).toHaveCount(0);
    await page.getByRole('button', { name: 'Говорить с Гоко' }).click();
    await expect(page.getByRole('button', { name: /Слушаю.*Выключить микрофон/ })).toBeVisible();
    if (fallback === 'context-lost') await expect(page.locator('.voice-orb-canvas')).toBeVisible();
    else await expect(page.locator('.voice-orb-fallback-visible')).toBeVisible();
  });
}
