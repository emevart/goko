// Текст ошибки для человека: одна таблица на голосового агента и веб.
// Правило языка: `message` ошибки (в ответе HTTP, в событии error, в исключении) — английский текст
// для разработчика, его не озвучивают и не показывают. Смысл несут `code` и `details`, а русскую
// фразу клиент собирает здесь, чтобы агент и веб говорили одинаково.
import type { ErrorCode } from './errors.ts';

export type IllegalReasonCode = 'occupied' | 'ko' | 'suicide';

export const ILLEGAL_REASON_TEXT: Record<IllegalReasonCode, string> = {
  occupied: 'точка занята',
  ko: 'ко: сразу забрать нельзя',
  suicide: 'самоубийство: у камня не будет дыханий',
};

export const ERROR_TEXT: Record<ErrorCode, string> = {
  invalid_coord: 'не понял координату',
  illegal_move: 'так ходить нельзя',
  not_your_turn: 'сейчас не твой ход',
  game_finished: 'партия уже закончена',
  nothing_to_undo: 'отменять нечего',
  revision_conflict: 'партия уже изменилась, повтори ещё раз',
  engine_busy: 'Гоко думает дольше обычного',
  engine_unavailable: 'Гоко сейчас недоступен',
  engine_gave_up: 'Гоко так и не смог ответить; скажи что-нибудь, и он попробует снова',
  unsupported_controller: 'такое место в партии пока не поддерживается',
  not_found: 'такой партии или сессии нет',
  bad_request: 'запрос не по форме',
  limit_reached: 'сейчас слишком много активных сессий',
  unauthorized: 'нет доступа',
  internal: 'на сервере что-то сломалось',
};

// Своё свойство, а не цепочка прототипов: код события — произвольная строка ('constructor').
const own = <T extends object>(table: T, key: unknown): key is keyof T => typeof key === 'string' && Object.hasOwn(table, key);

// code — строка, потому что код события error в схеме не перечисление: незнакомый код даёт текст internal.
export function humanText(code: string, details?: Record<string, unknown>): string {
  if (code === 'illegal_move' && own(ILLEGAL_REASON_TEXT, details?.reason)) return ILLEGAL_REASON_TEXT[details.reason];
  return own(ERROR_TEXT, code) ? ERROR_TEXT[code] : ERROR_TEXT.internal;
}
