import { describe, expect, it, vi } from 'vitest';
import { IntentLedger, intentMatches } from './intent.ts';

describe('intentMatches', () => {
  it('не принимает гипотетический ход, но принимает голую координату и явную команду', () => {
    expect(intentMatches('play_move', 'а если E9?')).toBe(false);
    expect(intentMatches('play_move', 'стоит ли пойти на E9')).toBe(false);
    expect(intentMatches('play_move', 'E9')).toBe(true);
    expect(intentMatches('play_move', 'поставь на E9')).toBe(true);
    expect(intentMatches('play_move', 'D четыре.', { coord: 'D4' })).toBe(true);
    expect(intentMatches('play_move', 'дэ четыре', { coord: 'D4' })).toBe(true);
    expect(intentMatches('play_move', 'ка десять', { coord: 'K10' })).toBe(true);
    expect(intentMatches('play_move', 'Е9', { coord: 'E9' })).toBe(true);
    expect(intentMatches('play_move', 'сыграй дэ четыре', { coord: 'D4' })).toBe(true);
    expect(intentMatches('play_move', 'Поставь E9', { coord: 'D4' })).toBe(false);
    expect(intentMatches('play_move', 'не ставь E9', { coord: 'E9' })).toBe(false);
    expect(intentMatches('play_move', 'как поставить E9?', { coord: 'E9' })).toBe(false);
    expect(intentMatches('play_move', 'ты сказал поставить E9', { coord: 'E9' })).toBe(false);
    expect(intentMatches('play_move', 'если я сыграю D4, что будет?', { coord: 'D4' })).toBe(false);
    expect(intentMatches('play_move', 'я сыграл D4', { coord: 'D4' })).toBe(false);
  });

  it('принимает только утвердительные команды для остальных мутаций', () => {
    expect(intentMatches('resign', 'я не сдаюсь')).toBe(false);
    expect(intentMatches('start_game', 'не начинай новую партию')).toBe(false);
    expect(intentMatches('undo', 'не возвращай ход назад')).toBe(false);
    expect(intentMatches('correct_last_move', 'нет, не исправляй на D5', { coord: 'D5' })).toBe(false);
    expect(intentMatches('correct_last_move', 'нет, всё правильно, оставь D5', { coord: 'D5' })).toBe(false);
    expect(intentMatches('set_rank', 'уровень менять не надо, 5 кю', { rank: '5 кю' })).toBe(false);
    expect(intentMatches('redo', 'не надо вперёд')).toBe(false);
    expect(intentMatches('pass', 'пас?')).toBe(false);
    expect(intentMatches('undo', 'отмени')).toBe(true);
    expect(intentMatches('resign', 'я сдаюсь')).toBe(true);
    expect(intentMatches('correct_last_move', 'исправь на D5', { coord: 'D5' })).toBe(true);
    expect(intentMatches('correct_last_move', 'нет, D5', { coord: 'D5' })).toBe(true);
  });

  it('разрешает документированный чёрный цвет по умолчанию, но сверяет явно названный цвет', () => {
    expect(intentMatches('start_game', 'давай партию', { my_color: 'black' })).toBe(true);
    expect(intentMatches('start_game', 'давай партию белыми', { my_color: 'white' })).toBe(true);
    expect(intentMatches('start_game', 'давай партию белыми', { my_color: 'black' })).toBe(false);
    expect(intentMatches('start_game', 'давай партию', { my_color: 'white' })).toBe(false);
    expect(intentMatches('start_game', 'давай партию, коми 17,5', { komi: 7.5 })).toBe(false);
    expect(intentMatches('start_game', 'давай партию, коми 7,5', { komi: 7.5 })).toBe(true);
    expect(intentMatches('start_game', 'давай партию', { komi: 7.5 })).toBe(true);
    expect(intentMatches('start_game', 'давай партию, играй как 15 кю', { rank: '5 кю' })).toBe(false);
    expect(intentMatches('set_rank', 'играй как 15 кю', { rank: '5 кю' })).toBe(false);
  });
});

describe('IntentLedger', () => {
  it('потребляет один trusted final turn ровно один раз и требует полный текст', async () => {
    const ledger = new IntentLedger();
    ledger.add('Поставь на E9');
    await expect(ledger.consume('play_move', 'Поставь на E9')).resolves.toMatchObject({ ok: true, turnId: 1 });
    await expect(ledger.consume('play_move', 'Поставь на E9', {}, 0)).resolves.toMatchObject({ ok: false });
    ledger.add('Поставь на E9');
    await expect(ledger.consume('play_move', 'E9', {}, 0)).resolves.toMatchObject({ ok: false });
  });

  it('bounded ждёт final, а timeout и server commentary fail closed', async () => {
    vi.useFakeTimers();
    const ledger = new IntentLedger();
    const pending = ledger.consume('undo', 'отмени', {}, 500);
    ledger.add('отмени');
    await expect(pending).resolves.toMatchObject({ ok: true });
    const missing = ledger.consume('redo', 'верни отменённое', {}, 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(missing).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/подтверд/) });
    vi.useRealTimers();
  });

  it('новая реплика отменяет старую неиспользованную команду, а event id дедуплицирует одно событие', async () => {
    const ledger = new IntentLedger();
    ledger.add('отмени', 'item-1');
    expect(ledger.add('отмени', 'item-1')).toBeNull();
    ledger.add('нет, ничего не отменяй', 'item-2');
    await expect(ledger.consume('undo', 'отмени', {}, 0)).resolves.toMatchObject({ ok: false });
  });

  it('abort до ожидания и во время ожидания закрывает intent fail closed', async () => {
    const before = new AbortController();
    before.abort();
    await expect(new IntentLedger().consume('undo', 'отмени', {}, 500, before.signal)).resolves.toMatchObject({ ok: false, reason: 'разговор уже завершён' });
    const during = new AbortController();
    const pending = new IntentLedger().consume('undo', 'отмени', {}, 500, during.signal);
    during.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'разговор уже завершён' });
  });
});
