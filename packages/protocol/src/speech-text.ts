// Только известные служебные пометки STT, в том числе разрыв перед закрывающей
// скобкой. Произвольный текст в скобках сохраняем: в нём может быть отрицание.
export function cleanSpeechTranscript(text: string): string {
  return text
    .replace(/\[(?:mouth noises?|clear throat|clears throat|throat clearing|cough(?:ing)?|breath(?:ing)?|noise|silence)(?:\]|$)/giu, ' ')
    .replace(/^\s*\]+\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
