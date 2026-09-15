import { describe, expect, it, vi } from 'vitest';
import { IntentLedger, mutationArgumentsMatch } from './intent.ts';

describe('mutationArgumentsMatch', () => {
  it.each(['А мой первый ход черными К4', 'Я решил занять К4', 'Пусть это будет К4', 'Не D4, а К4, так и играю'])('принимает решение модели для %s', text => {
    expect(mutationArgumentsMatch('play_move', text, { coord: 'K4' })).toBe(true);
    expect(mutationArgumentsMatch('play_move', text, { coord: 'E5' })).toBe(false);
  });
  it('не выдаёт сверку аргументов за классификацию намерения', () => {
    // Вызывать ли инструмент для вопросов/отрицаний, проверяется модельным eval.
    expect(mutationArgumentsMatch('play_move', 'а если D4?', { coord: 'D4' })).toBe(true);
    expect(mutationArgumentsMatch('undo', 'не отменяй')).toBe(true);
    expect(mutationArgumentsMatch('play_move', '[mouth noise', { coord: 'D4' })).toBe(false);
  });
  it.each(['Давай Д четыре', 'Ну, Д четыре', 'Д4', 'Д 4', 'ну давай дэ четыре'])('сверяет координату: %s', text => {
    expect(mutationArgumentsMatch('play_move', text, { coord: 'D4' })).toBe(true);
    expect(mutationArgumentsMatch('play_move', text, { coord: 'E4' })).toBe(false);
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

it('шум между реальной репликой и действием не вытесняет её и сам не разрешает действие', async () => {
  const ledger = new IntentLedger();
  ledger.add('А мой первый ход черными К4');
  expect(ledger.add('[mouth noise')).toBeNull();
  expect(ledger.add('] [clear throat')).toBeNull();
  await expect(ledger.consume('play_move', 'А мой первый ход черными К4', {coord:'K4'}, 0)).resolves.toMatchObject({ok:true});
  const empty = new IntentLedger();
  empty.add('[clear throat]');
  await expect(empty.consume('undo', '[clear throat]', {}, 0)).resolves.toMatchObject({ok:false});
});
