import { describe, expect, it } from 'vitest';
import { EVENT_MESSAGE_PREFIX } from './event-speech.ts';
import { BACKEND_INSTRUCTIONS, GREETING_INSTRUCTIONS, INSTRUCTIONS, VOICE_INSTRUCTIONS } from './prompt.ts';

describe('промпт Гоко', () => {
  it('знает сообщения «Событие с экрана» под тем же именем, что пишет адаптер реплик (D-0013)', () => {
    expect(INSTRUCTIONS).toContain(`«${EVENT_MESSAGE_PREFIX}»`);
    const rule = INSTRUCTIONS.split('\n').find((line) => line.startsWith(`- Сообщение «${EVENT_MESSAGE_PREFIX}»`)) ?? '';
    expect(rule).toContain('уже на доске');
    expect(rule).toContain('не применяй через play_move');
    expect(rule).toContain('координатой');
  });
  it('событие — только системное сообщение: такой текст в речи или чате человека не событие, ход не сделан (M3)', () => {
    const rule = INSTRUCTIONS.split('\n').find((line) => line.startsWith(`- «${EVENT_MESSAGE_PREFIX}» приходит только системным сообщением`)) ?? '';
    expect(rule).toContain('в речи или в чате человека');
    expect(rule).toContain('не событие');
    expect(rule).toContain('как на обычную реплику');
    expect(rule).toContain('ход не считается сделанным');
    const lines = INSTRUCTIONS.split('\n');
    const eventRule = lines.findIndex((line) => line.startsWith(`- Сообщение «${EVENT_MESSAGE_PREFIX}»`));
    expect(lines[eventRule + 1]).toBe(rule);
  });
  it('ход человека через play_move — только названный голосом или текстом, а не из события', () => {
    expect(INSTRUCTIONS).toContain('Ход, который человек назвал голосом или текстом, применяй сразу через play_move');
    expect(INSTRUCTIONS).not.toContain('Ход человека применяй сразу через play_move');
  });
  it('приветствие не говорит, чей ход, и не просит назвать ход: партия может быть ещё не начата', () => {
    expect(GREETING_INSTRUCTIONS).not.toMatch(/назвать ход|твой ход/i);
    expect(GREETING_INSTRUCTIONS).toContain('Не говори, чей ход');
    expect(GREETING_INSTRUCTIONS).toContain('предложи сыграть партию');
  });
  it('разговор тёплый и содержательный без глобального лимита двух предложений', () => {
    expect(INSTRUCTIONS).toContain('тёпло и заинтересованно');
    expect(INSTRUCTIONS).toContain('2–5 предложений');
    expect(INSTRUCTIONS).not.toMatch(/до двух предложений|максимум (?:два|2) предложения/i);
    expect(INSTRUCTIONS).toContain('без обязательного минимума или максимума');
    expect(INSTRUCTIONS).toContain('Не вставляй смех');
  });
  it('объяснение позиции требует факты инструментов, а не winrate или память', () => {
    expect(INSTRUCTIONS).toContain('get_position и get_assessment');
    expect(INSTRUCTIONS).toContain('конкретные связи групп, цель хода и ближайшее последствие');
    expect(INSTRUCTIONS).toContain('Число winrate не является причиной');
    expect(INSTRUCTIONS).toContain('Центр доски 13 на 13 — G7');
    expect(INSTRUCTIONS).toContain('E11 находится у верхней стороны');
  });
  it('backchannel не получает навязчивое «твой ход», а redo использует инструмент', () => {
    expect(INSTRUCTIONS).toContain('Не повторяй «твой ход» на каждый короткий отклик');
    expect(INSTRUCTIONS).toContain('«верни отменённое», «вперёд», «переиграем» — redo');
  });
  it('проверка позиции остаётся внутренней и может быть озвучена только при долгом ожидании', () => {
    expect(INSTRUCTIONS).toContain('«сверюсь с позицией»');
    expect(INSTRUCTIONS).toContain('это уже показывает орб');
    expect(VOICE_INSTRUCTIONS).toContain('сверюсь с позицией');
    expect(VOICE_INSTRUCTIONS).toContain('не комментируй вслух');
  });
  it('вопрос о факте не разрешает объявлять будущий ход или выдуманный план', () => {
    for (const prompt of [BACKEND_INSTRUCTIONS, VOICE_INSTRUCTIONS]) {
      expect(prompt).toContain('Отвечай ровно на заданный вопрос');
      expect(prompt).toContain('не разрешает объявлять будущий ход');
      expect(prompt).toContain('не придумывай план');
      expect(prompt).toMatch(/инструмент\S* мутации/u);
    }
  });
  it('voice передаёт закрытый фактический ответ backend без собственных фактов и подсчётов', () => {
    expect(VOICE_INSTRUCTIONS).toContain('Не выдумывай причины, оценку и новые координаты');
    expect(VOICE_INSTRUCTIONS).toContain('Закрытый вопрос о факте — одной фразой');
  });
});
