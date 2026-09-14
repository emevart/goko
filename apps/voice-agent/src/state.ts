// Память агента о сессии. Позиции здесь нет (правило 2 CLAUDE.md): только идентификаторы, настройки
// и флаги, по которым события SSE решают, что уже озвучено инструментом, а что надо сказать самому.
import type { Color, Rank, Result } from '@goko/protocol';

export type AgentState = {
  sessionId: string;
  gameId: string | null;
  announceSync: string | null; // session.game сменил партию: sync этой партии озвучить «Продолжаем партию» (задача 3)
  humanColor: Color | null; // null — в партии нет движка, играют два человека (D-0005)
  rank: Rank; // ранг Гоко для следующей партии
  komi: number;
  toolGames: Set<string>; // партии, созданные start_game: их state.updated/new не озвучиваем
  announcedFinish: string | null; // партия, чей результат уже вернул инструмент
  awaitingReply: boolean; // play/pass вернули replyTimedOut: ход движка озвучит событие
  lastTap: { cause: 'play' | 'pass' | 'correct'; coord: string } | null; // ход с экрана, ждём ответ движка
  lastErrorAt: number; // когда в последний раз озвучивали ошибку движка
  retriesExhausted: boolean; // пришёл error retries_exhausted: следующая реплика человека переоткроет поток (D-0006)
  fallbackMove: number | null; // номер последнего хода движка с humanFallback (D-0007)
  startingGame: boolean; // start_game ждёт ответа newGame: событие new приходит раньше ответа HTTP
  awaitingFinish: string | null; // pass ждёт итог этой партии: game.finished кладёт его в finished, не озвучивая
  finished: { gameId: string; result: Result } | null; // итог из потока сессии для ожидающего pass (R2)
  blockedUntil: number; // до этого момента (мс, часы deps.now) запросы к game-server не шлём: rate_limited с Retry-After
};

export const DEFAULT_RANK: Rank = '10k';
export const DEFAULT_KOMI = 7.5;

export function newAgentState(sessionId: string): AgentState {
  return {
    sessionId,
    gameId: null,
    announceSync: null,
    humanColor: 'B',
    rank: DEFAULT_RANK,
    komi: DEFAULT_KOMI,
    toolGames: new Set(),
    announcedFinish: null,
    awaitingReply: false,
    lastTap: null,
    lastErrorAt: 0,
    retriesExhausted: false,
    fallbackMove: null,
    startingGame: false,
    awaitingFinish: null,
    finished: null,
    blockedUntil: 0,
  };
}
