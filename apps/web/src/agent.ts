// Подсказки об агенте в подключённой комнате. В эту сессию агента повторно не позвать: новая вкладка — новая сессия
// (sessionStorage) и новая комната, куда LiveKit отправит воркер заново.
// «Гоко вышел»: агент в сессии уже был и ушёл (ждал возврата телефона 15 минут); 15 с без него — уход, а не переподключение.
// «Гоко не пришёл»: агента в сессии ещё не было, а комната подключена 30 с (воркер не получил задание или не запущен).

export const AGENT_GONE_MS = 15_000;
export const AGENT_ABSENT_MS = 30_000;

export type AgentHint = 'gone' | 'absent';

export const AGENT_HINT_TEXT: Record<AgentHint, string> = {
  gone: 'Гоко вышел из комнаты: доска работает тапами. Повтори запуск разговора.',
  absent: 'Гоко не пришёл: доска работает тапами. Повтори запуск разговора.',
};

// Какую подсказку ждать и сколько: null — никакой (комната не подключена или агент в ней).
// seen — агент уже появлялся в этой сессии. Отсчёт идёт с момента, когда условие стало верным: для «не пришёл» — с подключения.
export function agentHintTimer(connected: boolean, agent: boolean, seen: boolean): { hint: AgentHint; ms: number } | null {
  if (!connected || agent) return null;
  return seen ? { hint: 'gone', ms: AGENT_GONE_MS } : { hint: 'absent', ms: AGENT_ABSENT_MS };
}

// Надпись поля «Чата». Готовность агента важнее подсказки: пришёл позже — поле сразу снова приглашает писать.
export function chatPlaceholder(ready: boolean, hint: AgentHint | null, active = true): string {
  if (!active) return 'Написать Гоко…';
  if (ready) return 'Напиши Гоко';
  if (hint === 'gone') return 'Гоко вышел из комнаты';
  if (hint === 'absent') return 'Гоко не пришёл';
  return 'Гоко подключается…';
}
