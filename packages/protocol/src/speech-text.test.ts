import { expect, it } from 'vitest';
import { cleanSpeechTranscript, formatSpeechTranscript } from './speech-text.ts';

it.each([
  ['[mouth noise', ''],
  ['] [clear throat', ''],
  ['] Да, поехали', 'Да, поехали'],
  ['[cough] А мой первый ход черными К4', 'А мой первый ход черными К4'],
  ['[sigh ]L6', 'L6'],
  ['[кашель] Давай дальше', 'Давай дальше'],
  ['[coughs]', ''],
  ['[sniff] Окей, давай. М восемь', 'Окей, давай. М восемь'],
  ['. [tongue click', ''],
  ['[inhale]', ''],
  ['Не ставь [clear throat] D4', 'Не ставь D4'],
  ['[не ставь D4]', '[не ставь D4]'],
])('очищает только служебную разметку речи: %s', (input, output) => {
  expect(cleanSpeechTranscript(input)).toBe(output);
});

it.each([
  ['[sigh ]L6', '*вздох* L6'],
  ['[кашель] Давай дальше', '*кашель* Давай дальше'],
  ['[sniff] Окей, давай. М восемь', '*шорох* Окей, давай. М восемь'],
  ['Не ставь [clear throat] D4', 'Не ставь *кашель* D4'],
  ['[mouth noise', ''],
  ['. [tongue click', ''],
])('форматирует шум для ленты, но скрывает шумовую реплику: %s', (input, output) => {
  expect(formatSpeechTranscript(input)).toBe(output);
});
