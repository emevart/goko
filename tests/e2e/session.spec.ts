import { expect, test } from '@playwright/test';
import { finishGames, isolateClient } from './helpers.ts';

test.beforeEach(async ({ page }, testInfo) => {
  await isolateClient(page, testInfo);
});
test.afterEach(async ({ page }) => { await finishGames(page); });

test('единый composer запускает чат и показывает mock GPT-Live transcript', async ({ page }) => {
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'сообщение Гоко' });
  await expect(input).toHaveAttribute('placeholder', 'Написать Гоко…');
  await input.fill('давай партию');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.locator('.line-me')).toContainText('давай партию');
  await expect(page.locator('.line-goko')).toContainText('Принято: давай партию');
  await expect(input).toHaveValue('');
});

test('при отказе отправки composer сохраняет черновик', async ({ page }) => {
  await page.goto('/?mockSend=fail');
  const input = page.getByRole('textbox', { name: 'сообщение Гоко' });
  await input.fill('не теряй меня');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(input).toHaveValue('не теряй меня');
  await expect(page.locator('.line-me')).toHaveCount(0);
});

test('голос запускается только явной кнопкой, показывает 3D-орб и освобождает медиа перед чатом', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const state = { calls: 0, tracks: [] as MediaStreamTrack[] };
    (window as any).__gokoMedia = state;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      state.calls++;
      const stream = await nativeGetUserMedia(constraints);
      state.tracks.push(...stream.getTracks());
      return stream;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Новая партия' }).click();
  await page.getByRole('button', { name: 'Начать' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__gokoMedia.calls)).toBe(0);

  await page.getByRole('button', { name: 'Говорить с Гоко' }).click();
  await expect(page.getByRole('button', { name: /Слушаю.*Выключить микрофон/ })).toBeVisible();
  await expect(page.locator('.voice-orb-canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__gokoMedia.calls)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__gokoLiveKit?.microphone)).toBe(true);

  await page.getByRole('button', { name: /Слушаю.*Выключить микрофон/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__gokoLiveKit?.localTrackStates)).toEqual(['ended']);
  await page.getByRole('button', { name: /Включить микрофон/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__gokoMedia.calls)).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as any).__gokoMedia.tracks.map((track: MediaStreamTrack) => track.readyState))).toEqual(['ended', 'live']);
  await expect.poll(() => page.evaluate(() => (window as any).__gokoLiveKit?.localTrackStates)).toEqual(['ended', 'live']);

  await page.getByRole('button', { name: 'Выйти из голосового разговора' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__gokoLiveKit?.microphone)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).__gokoMedia.tracks.map((track: MediaStreamTrack) => track.readyState))).toEqual(['ended', 'ended']);
  await expect.poll(() => page.evaluate(() => (window as any).__gokoLiveKit?.localTrackStates)).toEqual(['ended', 'ended']);
  const input = page.getByRole('textbox', { name: 'сообщение Гоко' });
  await input.fill('теперь чат');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.locator('.line-me')).toContainText('теперь чат');
  await expect.poll(() => page.evaluate(() => (window as any).__gokoLiveKit?.audioSubscribed ?? false)).toBe(false);
});

test('диагностическая запись доступна только локально и отдаёт три файла', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Говорить с Гоко' }).click();
  await expect(page.getByRole('button', { name: /Слушаю.*Выключить микрофон/ })).toBeVisible();
  await page.getByRole('button', { name: 'Запись для диагностики' }).click();
  await page.getByRole('button', { name: 'Начать запись' }).click();
  await expect(page.getByRole('status')).toContainText('Запись');
  await page.getByRole('button', { name: 'Остановить' }).click();
  await expect(page.getByRole('link', { name: 'Микрофон' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Гоко' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Журнал' })).toBeVisible();
});

test('Гоко не пришёл: сообщение остаётся в composer', async ({ page }) => {
  await page.addInitScript(() => {
    const real = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
      real(handler, ms === 8_000 || ms === 30_000 ? 30 : ms, ...args)) as typeof window.setTimeout;
  });
  await page.goto('/?mockAgent=absent');
  const input = page.getByRole('textbox', { name: 'сообщение Гоко' });
  await input.fill('ты здесь?');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(input).toHaveValue('ты здесь?');
  await expect(page.locator('.status-notice')).toContainText('не успел подключиться');
  await expect(page.getByText(/Гоко не пришёл:/)).toBeVisible();
});

test('Гоко вышел после успешного подключения', async ({ page }) => {
  await page.clock.install();
  await page.goto('/?mockAgent=gone');
  const input = page.getByRole('textbox', { name: 'сообщение Гоко' });
  await input.fill('привет');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.locator('.line-me')).toContainText('привет');
  await page.clock.fastForward(1_000);
  await expect(input).toHaveAttribute('placeholder', 'Гоко подключается…');
  await page.clock.fastForward(15_100);
  await expect(page.getByText(/Гоко вышел из комнаты:/)).toBeVisible();
});
