/**
 * Simple overload: joins chips and inputText into a query string.
 */
export function buildQueryStringSimple(chips: string[], inputText: string): string {
  return [...chips, inputText.trim()].filter(Boolean).join(' ');
}

/**
 * Build a query string from chips + active input + gap texts, preserving order.
 * Iterates all gap positions (0..chips.length), placing text from activeInput
 * at inputPosition and from gapTexts at all other positions.
 */
export function buildQueryString(
  chips: string[],
  activeInput: string,
  inputPosition: number,
  gapTexts?: Record<number, string>,
): string {
  const parts: string[] = [];
  for (let i = 0; i <= chips.length; i++) {
    const text = i === inputPosition
      ? activeInput.trim()
      : (gapTexts?.[i] || '').trim();
    if (text) parts.push(text);
    if (i < chips.length) parts.push(chips[i]);
  }
  return parts.join(' ');
}
