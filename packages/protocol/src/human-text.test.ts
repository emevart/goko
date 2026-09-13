import { describe, expect, it } from 'vitest';
import * as protocol from './index.ts';
import { ClientTimeoutError, ERROR_CODES } from './errors.ts';
import { CLIENT_ERROR_TEXT, ERROR_TEXT, ILLEGAL_REASON_TEXT, humanText } from './human-text.ts';

describe('текст ошибки для человека', () => {
  it('у каждого кода есть русский текст, лишних кодов в таблице нет', () => {
    expect(Object.keys(ERROR_TEXT).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(ERROR_TEXT[code], code).toMatch(/[а-яё]/i);
      expect(humanText(code), code).toBe(ERROR_TEXT[code]);
    }
  });

  it('illegal_move объясняется по reason: занято, ко, самоубийство', () => {
    expect(ILLEGAL_REASON_TEXT).toEqual({
      occupied: 'точка занята',
      ko: 'ко: сразу забрать нельзя',
      suicide: 'самоубийство: у камня не будет дыханий',
    });
    expect(humanText('illegal_move', { reason: 'occupied', coord: 'E5' })).toBe('точка занята');
    expect(humanText('illegal_move', { reason: 'ko' })).toBe('ко: сразу забрать нельзя');
    expect(humanText('illegal_move', { reason: 'suicide' })).toBe('самоубийство: у камня не будет дыханий');
    // Без reason или с незнакомым reason — общий текст кода, а не undefined.
    expect(humanText('illegal_move')).toBe(ERROR_TEXT.illegal_move);
    expect(humanText('illegal_move', { reason: 'toString' })).toBe(ERROR_TEXT.illegal_move);
    expect(humanText('illegal_move', { reason: 42 })).toBe(ERROR_TEXT.illegal_move);
    // reason объясняет только illegal_move: у другого кода со знакомым reason — текст самого кода.
    expect(humanText('not_your_turn', { reason: 'ko' })).toBe(ERROR_TEXT.not_your_turn);
  });

  it('исчерпанная серия повторов: нейтральный текст, не про движок и не про диск', () => {
    expect(humanText('retries_exhausted')).toBe('Гоко не может продолжить партию; скажи что-нибудь, и он попробует снова');
    expect(humanText('engine_gave_up')).toBe(ERROR_TEXT.internal);
  });

  it('лимиты: частые запросы и слишком много партий', () => {
    expect(humanText('rate_limited')).toBe('слишком много запросов, подожди немного');
    expect(humanText('too_many_games')).toBe('сейчас идёт слишком много партий, попробуй позже');
  });

  it('таймаут клиента — не код сервера, но текст у него есть', () => {
    expect(ERROR_CODES).not.toContain('client_timeout');
    expect(Object.keys(CLIENT_ERROR_TEXT)).toEqual(['client_timeout']);
    expect(humanText('client_timeout')).toBe('сервер не отвечает');
    expect(humanText(new ClientTimeoutError('play', 15_000).code)).toBe('сервер не отвечает');
  });

  it('код события error — строка: незнакомый код даёт текст internal', () => {
    expect(humanText('something_new')).toBe(ERROR_TEXT.internal);
    expect(humanText('constructor')).toBe(ERROR_TEXT.internal);
  });

  it('таблица и функция доступны из пакета', () => {
    expect(protocol.humanText).toBe(humanText);
    expect(protocol.ERROR_TEXT).toBe(ERROR_TEXT);
    expect(protocol.CLIENT_ERROR_TEXT).toBe(CLIENT_ERROR_TEXT);
    expect(protocol.ClientTimeoutError).toBe(ClientTimeoutError);
  });
});
