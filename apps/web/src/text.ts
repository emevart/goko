// Тексты статуса и ошибок на экране. Позицию не интерпретируем: только поля состояния.
// hasEngine, humanColorOf и retryAfterMs — общие с голосовым агентом, из @goko/protocol (задача 1).
import {
  ApiError,
  type CallOptions,
  ClientTimeoutError,
  type Color,
  type GameState,
  type GokoClient,
  hasEngine,
  humanColorOf,
  humanText,
  retryAfterMs,
  seatColor,
} from '@goko/protocol';

export const NETWORK_TEXT = 'нет связи с сервером';
export const TIMEOUT_NOT_APPLIED_TEXT = 'сервер не отвечает: ход пока не записан';

// Ход или пас тапом (Global Constraints, «Клиент протокола»). ClientTimeoutError не значит, что хода нет: сервер
// мог записать его, а ответ не дошёл. Запрос не повторяется, партия перечитывается. null — ответ пришёл, состояние
// придёт потоком; иначе — перечитанная партия и текст, если ревизия та же, что до тапа. Запрос с expectedRevision
// ещё может записаться позже, поэтому текст говорит «пока». Прочие ошибки и отказ перечитывания — наружу.
export async function sendTapMove(
  client: Pick<GokoClient, 'getGame'>,
  before: GameState,
  send: (o: CallOptions) => Promise<unknown>,
  o: CallOptions = {},
): Promise<{ state: GameState; text: string | null } | null> {
  try {
    await send(o);
    return null;
  } catch (e) {
    if (!(e instanceof ClientTimeoutError)) throw e;
  }
  const state = await client.getGame(before.id, o);
  return { state, text: state.revision === before.revision ? TIMEOUT_NOT_APPLIED_TEXT : null };
}

// Ход тапом, на который ответ уже пришёл: пока состояние партии не новее этой ревизии, следующий ход ушёл бы со старой.
export type SentMove = { gameId: string; revision: number };

// Почему действие над текущей партией не отправляется: фраза для человека, '' — молча, null — запрос можно слать.
// Между session.game новой партии и её первым state.updated gameId уже новый, а state ещё старый: запрос ушёл бы
// в новую партию с ревизией старой, поэтому тоже «партии ещё нет». Проверка «чей ход» — только по полям состояния.
// inFlight — действие над партией ещё в пути; sent — последний записанный ход тапом. Пока одно из них держит, второй
// ход не уходит (иначе 409 revision_conflict): фраза та же, что в черёд Гоко; отмена и сдача ждут молча.
export function actionRefusal(state: GameState | null, gameId: string | null, needTurn: boolean, inFlight: boolean, sent: SentMove | null): string | null {
  if (!gameId || !state || state.id !== gameId) return 'партии ещё нет';
  if (state.status === 'finished') return 'партия окончена';
  const humanTurn = state.status === 'playing' && state.seats[state.toPlay].controller === 'human' && !state.pendingEngineMove;
  const waiting = inFlight || (sent !== null && sent.gameId === state.id && state.revision <= sent.revision);
  if (needTurn && (!humanTurn || waiting)) return hasEngine(state) ? 'сейчас ход Гоко' : 'сейчас не твой ход';
  return waiting ? '' : null;
}

export function describeError(e: unknown): string {
  // Текст для человека — по code и details, message сервера английский (D-0007). details несут reason
  // (bad_request: not_your_seat, sessionless_disabled) и scope (too_many_games) — фразу выбирает humanText.
  if (e instanceof ApiError) return humanText(e.code, e.details);
  // Таймаут клиента — сервер достижим, но молчит; всё прочее (TypeError fetch, HttpError от прокси) — связи нет.
  if (e instanceof ClientTimeoutError) return humanText(e.code);
  return NETWORK_TEXT;
}

// Сколько не слать запросы после rate_limited (D-0012): details.retryAfterSeconds, без него — секунда.
// Для прочих ошибок 0: паузу выбирает вызывающий.
export function retryDelayMs(e: unknown): number {
  if (!(e instanceof ApiError) || e.code !== 'rate_limited') return 0;
  return retryAfterMs(e.details);
}

const colorName = (c: Color) => (c === 'B' ? 'чёрные' : 'белые');
const colorGenitive = (c: Color) => (c === 'B' ? 'чёрных' : 'белых');
const margin = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

export function resultText(g: GameState): string {
  const r = g.result;
  if (!r) return 'Партия окончена';
  const who = !hasEngine(g) ? `Победа ${colorGenitive(r.winner)}` : r.winner === humanColorOf(g) ? 'Победа твоя' : 'Победа Гоко';
  return r.reason === 'resign' ? `${who}: сдача` : `${who}: +${margin(r.margin ?? 0)}`;
}

export function statusText(g: GameState | null, thinking: boolean): string {
  if (!g) return 'Партии нет: нажми «Новая партия» или попроси Гоко';
  if (g.status === 'finished') return resultText(g);
  const n = g.moves.length + 1;
  if (!hasEngine(g)) return `Ход ${n}, ходят ${colorName(g.toPlay)}`;
  const whose = g.toPlay === humanColorOf(g) ? 'твой ход' : thinking ? 'Гоко готовит ход' : 'ход Гоко';
  return `Ход ${n}, ${whose} (${colorName(g.toPlay)})`;
}

export const capturesText = (g: GameState): string => `Пленные: чёрные ${g.captures.B}, белые ${g.captures.W}`;

export function rankText(g: GameState): string {
  const engine = seatColor(g.seats, 'engine');
  if (!engine) return 'Два игрока';
  const rank = g.seats[engine].rank;
  return rank ? `Гоко ${rank}` : 'Гоко';
}
