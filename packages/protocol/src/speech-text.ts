// Служебные метки, которые некоторые STT-модели вставляют в транскрипт. Метка
// может прийти без закрывающей скобки или с пробелом перед ней.
const NOISE_TAG = /\[\s*((?:mouth\s+noises?|clear\s+throat|clears\s+throat|throat\s+clearing|cough(?:ing|s)?|breath(?:ing|s)?|noise|silence|sigh(?:ing|s)?|sniff(?:ing|s)?|inhale(?:s)?|exhale(?:s)?|tongue\s+click|lip\s+smack|background\s+noise|вздох|вдох|кашель|шорох|тишина))\s*\]?/giu;

function noiseMarker(label: string): string {
  const normalized = label.toLowerCase().replace(/\s+/gu, ' ').trim();
  if (/sigh|exhale|вздох/u.test(normalized)) return '*вздох*';
  if (/inhale|breath|вдох/u.test(normalized)) return '*вдох*';
  if (/cough|clear throat|throat clearing|кашель/u.test(normalized)) return '*кашель*';
  if (/silence|тишина/u.test(normalized)) return '*пауза*';
  return '*шорох*';
}

function normalize(text: string): string {
  return text
    // Иногда STT оставляет закрывающую скобку от предыдущей служебной метки.
    .replace(/^\s*\]+\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function parseSpeechTranscript(text: string): { speech: string; formatted: string } {
  let formatted = text.replace(NOISE_TAG, (_match, label: string) => ` ${noiseMarker(label)} `);
  const speech = normalize(text.replace(NOISE_TAG, ' '));
  // Один только шум (иногда с точкой от STT) не должен превращаться в реплику.
  if (!speech || /^[\s.,!?…;:]+$/u.test(speech)) return { speech: '', formatted: '' };
  formatted = normalize(formatted);
  return { speech, formatted };
}

// Чистый текст для intent и команд. Известные служебные пометки удаляются,
// произвольный текст в квадратных скобках сохраняется.
export function cleanSpeechTranscript(text: string): string {
  return parseSpeechTranscript(text).speech;
}

// Текст для ленты и диагностической записи: смешанная фраза сохраняет шум в
// понятном виде (*вздох*, *кашель*), а шумовая реплика целиком скрывается.
export function formatSpeechTranscript(text: string): string {
  return parseSpeechTranscript(text).formatted;
}
