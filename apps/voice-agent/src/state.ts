// Память агента о сессии. Позиции здесь нет (правило 2 CLAUDE.md): только идентификаторы, настройки
// и флаги, по которым события SSE решают, что уже озвучено инструментом, а что надо сказать самому.
import type { Color, Rank, Result } from '@goko/protocol';

export type AgentState = {
  sessionId: string;
  gameId: string | null;
  gameGeneration: number; // растёт при session.game другой партии; защищает AgentState от поздних tool-ответов
  observedRevision: { gameId: string; revision: number } | null; // самая новая ревизия этой партии из SSE
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
  // Ревизия партии, на которой её итог (finished, announcedFinish) стал известен: событие state.updated законченной
  // партии или ответ инструмента. По ней forgetFinishIfReopened отличает возобновлённую партию от устаревшего события.
  finishRevision: { gameId: string; revision: number } | null;
  // Номер последнего хода партии из последнего обработанного state.updated (0 — доска пуста). По нему sync после
  // переподключения отличает ход, сделанный в разрыве, от уже показанного потоком. Запись другой партии не в счёт.
  seenMove: { gameId: string; n: number } | null;
  blockedUntil: number; // до этого момента (мс, часы deps.now) запросы к game-server не шлём: rate_limited с Retry-After
};

export const DEFAULT_RANK: Rank = '10k';
export const DEFAULT_KOMI = 7.5;

export function newAgentState(sessionId: string): AgentState {
  return {
    sessionId,
    gameId: null,
    gameGeneration: 0,
    observedRevision: null,
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
    finishRevision: null,
    seenMove: null,
    blockedUntil: 0,
  };
}

// Итог партии gameId известен на ревизии revision. Для той же партии запись не уменьшается: ответ инструмента
// может нести ревизию старше события потока, которое уже пришло.
export function noteFinishRevision(state: AgentState, gameId: string, revision: number): void {
  const known = state.finishRevision;
  state.finishRevision = { gameId, revision: known?.gameId === gameId ? Math.max(known.revision, revision) : revision };
}

// Партия gameId снова идёт на ревизии revision (отмена, переподключение, пас человека): итог этой партии,
// известный на ревизии не новее, устарел. Иначе game.finished промолчал бы о новом итоге (announcedFinish), а
// ожидающий pass взял бы старый (finished). Событие с ревизией не новее итога — устаревшее (стояло в очереди,
// пока инструмент записал итог), итог не трогает. revision = null — ревизия неизвестна, но партия точно идёт.
// Итог другой партии не трогает.
export function forgetFinishIfReopened(state: AgentState, gameId: string, revision: number | null): void {
  const known = state.finishRevision?.gameId === gameId ? state.finishRevision : null;
  if (known && revision !== null && revision <= known.revision) return;
  if (state.finished?.gameId === gameId) state.finished = null;
  if (state.announcedFinish === gameId) state.announcedFinish = null;
  if (known) state.finishRevision = null;
}
