import { describe, expect, it } from 'vitest';
import { EVENT_MESSAGE_PREFIX } from './event-speech.ts';
import { GREETING_INSTRUCTIONS, INSTRUCTIONS } from './prompt.ts';

describe('промпт Гоко', () => {
  it('знает сообщения «Событие с экрана» под тем же именем, что пишет адаптер реплик (D-0013)', () => {
    expect(INSTRUCTIONS).toContain(`«${EVENT_MESSAGE_PREFIX}»`);
    const rule = INSTRUCTIONS.split('\n').find((line) => line.startsWith(`- Сообщение «${EVENT_MESSAGE_PREFIX}»`)) ?? '';
    expect(rule).toContain('уже на доске');
    expect(rule).toContain('не применяй через play_move');
    expect(rule).toContain('координатой');
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
});
