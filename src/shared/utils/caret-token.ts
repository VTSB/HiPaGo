const WHITESPACE_RE = /\s/;

interface TokenSpan {
  rawStart: number;
  rawEnd: number;
  normalizedStart: number;
  normalizedEnd: number;
}

function buildNormalizedText(rawText: string, spans: TokenSpan[]): string {
  return spans.map((span) => rawText.slice(span.rawStart, span.rawEnd)).join(' ');
}

function clampOffset(offset: number, max: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(Math.trunc(offset), 0), max);
}

function isWhitespace(char: string | undefined): boolean {
  return Boolean(char && WHITESPACE_RE.test(char));
}

function getTokenSpans(rawText: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const matches = rawText.matchAll(/\S+/g);
  let normalizedStart = 0;

  for (const match of matches) {
    const token = match[0];
    const rawStart = match.index ?? 0;
    const rawEnd = rawStart + token.length;
    const normalizedEnd = normalizedStart + token.length;

    spans.push({
      rawStart,
      rawEnd,
      normalizedStart,
      normalizedEnd,
    });

    normalizedStart = normalizedEnd + 1;
  }

  return spans;
}

function mapRawOffsetToNormalized(spans: TokenSpan[], rawOffset: number, normalizedTextLength: number): number {
  if (spans.length === 0) return 0;
  if (rawOffset <= spans[0].rawStart) return 0;

  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];

    if (rawOffset < span.rawStart) {
      return spans[index - 1].normalizedEnd;
    }

    if (rawOffset <= span.rawEnd) {
      return Math.min(
        span.normalizedStart + (rawOffset - span.rawStart),
        span.normalizedEnd,
      );
    }
  }

  return normalizedTextLength;
}

function getTokenBoundsAtIndex(text: string, index: number): { start: number; end: number } {
  let start = index;
  let end = index;

  while (start > 0 && !isWhitespace(text[start - 1])) {
    start -= 1;
  }

  while (end < text.length && !isWhitespace(text[end])) {
    end += 1;
  }

  return { start, end };
}

export function normalizeGapText(rawText: string): string {
  const spans = getTokenSpans(rawText);
  return buildNormalizedText(rawText, spans);
}

export function normalizeTextWithCaret(rawText: string, rawOffset: number): { text: string; offset: number } {
  const clampedRawOffset = clampOffset(rawOffset, rawText.length);
  const spans = getTokenSpans(rawText);
  const text = buildNormalizedText(rawText, spans);

  if (!text) {
    return { text: '', offset: 0 };
  }

  return {
    text,
    offset: mapRawOffsetToNormalized(spans, clampedRawOffset, text.length),
  };
}

export function getTokenAtOffset(text: string, offset: number): { token: string; start: number; end: number } {
  const clampedOffset = clampOffset(offset, text.length);

  if (!text) {
    return { token: '', start: clampedOffset, end: clampedOffset };
  }

  if (clampedOffset > 0 && !isWhitespace(text[clampedOffset - 1])) {
    if (clampedOffset === text.length || isWhitespace(text[clampedOffset])) {
      const { start, end } = getTokenBoundsAtIndex(text, clampedOffset - 1);
      return { token: text.slice(start, end), start, end };
    }
  }

  if (clampedOffset === text.length) {
    return { token: '', start: clampedOffset, end: clampedOffset };
  }

  if (isWhitespace(text[clampedOffset])) {
    return { token: '', start: clampedOffset, end: clampedOffset };
  }

  const { start, end } = getTokenBoundsAtIndex(text, clampedOffset);
  return { token: text.slice(start, end), start, end };
}
