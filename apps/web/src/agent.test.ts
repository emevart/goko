import { describe, expect, it } from 'vitest';
import { AGENT_ABSENT_MS, AGENT_GONE_MS, AGENT_HINT_TEXT, agentHintTimer, chatPlaceholder } from './agent.ts';

describe('подсказки об агенте', () => {
  it('комната не подключена или агент в комнате — подсказки не ждём', () => {
    expect(agentHintTimer(false, false, false)).toBeNull();
    expect(agentHintTimer(false, false, true)).toBeNull();
    expect(agentHintTimer(true, true, false)).toBeNull();
    expect(agentHintTimer(true, true, true)).toBeNull();
  });

  it('агента в сессии ещё не было — «Гоко не пришёл» через 30 с после подключения', () => {
    expect(AGENT_ABSENT_MS).toBe(30_000);
    expect(agentHintTimer(true, false, false)).toEqual({ hint: 'absent', ms: AGENT_ABSENT_MS });
  });

  it('агент был и ушёл — «Гоко вышел» через 15 с', () => {
    expect(AGENT_GONE_MS).toBe(15_000);
    expect(agentHintTimer(true, false, true)).toEqual({ hint: 'gone', ms: AGENT_GONE_MS });
  });

  it('тексты подсказок в ленте', () => {
    expect(AGENT_HINT_TEXT.absent).toBe('Гоко не пришёл: доска работает тапами. Повтори запуск разговора.');
    expect(AGENT_HINT_TEXT.gone).toBe('Гоко вышел из комнаты: доска работает тапами. Повтори запуск разговора.');
  });

  it('надпись поля «Чата»: готовность агента важнее подсказки', () => {
    expect(chatPlaceholder(false, null, false)).toBe('Написать Гоко…');
    expect(chatPlaceholder(false, null)).toBe('Гоко подключается…');
    expect(chatPlaceholder(false, 'absent')).toBe('Гоко не пришёл');
    expect(chatPlaceholder(false, 'gone')).toBe('Гоко вышел из комнаты');
    // Агент пришёл позже: подсказка ещё не снята эффектом, а поле уже приглашает писать.
    expect(chatPlaceholder(true, 'absent')).toBe('Напиши Гоко');
    expect(chatPlaceholder(true, null)).toBe('Напиши Гоко');
  });
});
