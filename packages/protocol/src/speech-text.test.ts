import { expect, it } from 'vitest';
import { cleanSpeechTranscript } from './speech-text.ts';

it.each([
  ['[mouth noise', ''],
  ['] [clear throat', ''],
  ['] Да, поехали', 'Да, поехали'],
  ['[cough] А мой первый ход черными К4', 'А мой первый ход черными К4'],
  ['Не ставь [clear throat] D4', 'Не ставь D4'],
  ['[не ставь D4]', '[не ставь D4]'],
])('очищает только служебную разметку речи: %s', (input, output) => {
  expect(cleanSpeechTranscript(input)).toBe(output);
});
