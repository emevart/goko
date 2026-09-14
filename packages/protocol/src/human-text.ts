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

export type BadRequestReasonCode = 'not_your_seat' | 'sessionless_disabled';

// Причины bad_request, у которых есть своя фраза: сдача за цвет, которым человек не управляет, и партия
// без сессии там, где такие выключены (D-0012).
export const BAD_REQUEST_REASON_TEXT: Record<BadRequestReasonCode, string> = {
  not_your_seat: 'это не твой цвет',
  sessionless_disabled: 'партии создаются только внутри сессии',
};

export type TooManyGamesScope = 'client';

// too_many_games без scope — общий лимит сервера; scope client — лимит незавершённых партий на адрес (D-0012).
// Старые партии с телефона не открыть, поэтому текст не зовёт их доигрывать.
export const TOO_MANY_GAMES_SCOPE_TEXT: Record<TooManyGamesScope, string> = {
  client: 'у тебя слишком много незаконченных партий, новую можно начать позже',
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
  // Без слова «ход»: серия повторов бывает и у автосчёта после двух пасов.
  retries_exhausted: 'движок не отвечает, нужно повторить',
  unsupported_controller: 'такое место в партии пока не поддерживается',
  not_found: 'такой партии или сессии нет',
  bad_request: 'запрос не по форме',
  limit_reached: 'сейчас слишком много активных сессий',
  rate_limited: 'слишком много запросов, подожди немного',
  too_many_games: 'сейчас идёт слишком много партий, попробуй позже',
  unauthorized: 'нет доступа',
  internal: 'на сервере что-то сломалось',
};

// Коды, которые рождает клиент, а не сервер: в ERROR_CODES их нет.
export const CLIENT_ERROR_TEXT = {
  client_timeout: 'сервер не отвечает',
} as const;

// Своё свойство, а не цепочка прототипов: код события — произвольная строка ('constructor').
const own = <T extends object>(table: T, key: unknown): key is keyof T => typeof key === 'string' && Object.hasOwn(table, key);

// code — строка, потому что код события error в схеме не перечисление: незнакомый код даёт текст internal.
export function humanText(code: string, details?: Record<string, unknown>): string {
  if (code === 'illegal_move' && own(ILLEGAL_REASON_TEXT, details?.reason)) return ILLEGAL_REASON_TEXT[details.reason];
  if (code === 'bad_request' && own(BAD_REQUEST_REASON_TEXT, details?.reason)) return BAD_REQUEST_REASON_TEXT[details.reason];
  if (code === 'too_many_games' && own(TOO_MANY_GAMES_SCOPE_TEXT, details?.scope)) return TOO_MANY_GAMES_SCOPE_TEXT[details.scope];
  if (own(CLIENT_ERROR_TEXT, code)) return CLIENT_ERROR_TEXT[code];
  return own(ERROR_TEXT, code) ? ERROR_TEXT[code] : ERROR_TEXT.internal;
}
