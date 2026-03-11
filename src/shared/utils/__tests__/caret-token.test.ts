import { describe, expect, it } from 'vitest';

import { getTokenAtOffset, normalizeGapText, normalizeTextWithCaret } from '../caret-token';

describe('normalizeGapText', () => {
  it('collapses repeated whitespace to match caret-token normalization', () => {
    expect(normalizeGapText(' left  \n female:lo   right  ')).toBe('left female:lo right');
  });
});

describe('normalizeTextWithCaret', () => {
  it('remaps caret offsets across collapsed spaces and newlines', () => {
    expect(normalizeTextWithCaret('hello \n world', 10)).toEqual({
      text: 'hello world',
      offset: 8,
    });
  });

  it('collapses repeated spaces and CRLF runs into one normalized gap', () => {
    expect(normalizeTextWithCaret('alpha  \r\n\t  beta', 9)).toEqual({
      text: 'alpha beta',
      offset: 5,
    });

    expect(normalizeTextWithCaret('alpha  \r\n\t  beta', 12)).toEqual({
      text: 'alpha beta',
      offset: 6,
    });

    expect(normalizeTextWithCaret('hello\r\n\r\n  female:lo', 12)).toEqual({
      text: 'hello female:lo',
      offset: 7,
    });
  });

  it('trims leading and trailing whitespace while clamping the caret', () => {
    expect(normalizeTextWithCaret('   hello  ', 1)).toEqual({
      text: 'hello',
      offset: 0,
    });

    expect(normalizeTextWithCaret('   hello  ', 99)).toEqual({
      text: 'hello',
      offset: 5,
    });
  });

  it('returns empty text and a zero offset for empty or whitespace-only input', () => {
    expect(normalizeTextWithCaret('', 4)).toEqual({ text: '', offset: 0 });
    expect(normalizeTextWithCaret('  \n\t  ', 3)).toEqual({ text: '', offset: 0 });
  });

  it('maps caret to the normalized start of a token after leading and inline whitespace', () => {
    expect(normalizeTextWithCaret('  red    blue', 9)).toEqual({
      text: 'red blue',
      offset: 4,
    });
  });

  it('maps the middle-gap offset to the previous token boundary with multiple spaces', () => {
    expect(normalizeTextWithCaret('hello  world   again', 12)).toEqual({
      text: 'hello world again',
      offset: 11,
    });
  });

  it('collapses trailing whitespace after the last token to the end boundary', () => {
    expect(normalizeTextWithCaret('tag1  tag2   ', 12)).toEqual({
      text: 'tag1 tag2',
      offset: 9,
    });
  });
});

describe('getTokenAtOffset', () => {
  it('returns a single token when the caret is inside the token', () => {
    expect(getTokenAtOffset('female:lo', 6)).toEqual({
      token: 'female:lo',
      start: 0,
      end: 9,
    });
  });

  it('returns a single token when the caret is at the token end', () => {
    expect(getTokenAtOffset('female:lo', 9)).toEqual({
      token: 'female:lo',
      start: 0,
      end: 9,
    });
  });

  it('returns the current token from multi-word text', () => {
    expect(getTokenAtOffset('hello world', 7)).toEqual({
      token: 'world',
      start: 6,
      end: 11,
    });
  });

  it('keeps the previous token active at an internal token boundary', () => {
    expect(getTokenAtOffset('hello world', 5)).toEqual({
      token: 'hello',
      start: 0,
      end: 5,
    });
  });

  it('returns an empty token when the caret is on whitespace', () => {
    const result = getTokenAtOffset('hello  world', 6);

    expect(result).toEqual({
      token: '',
      start: 6,
      end: 6,
    });
    expect(result.start).toBe(result.end);
  });

  it('keeps colons inside typed tag tokens', () => {
    expect(getTokenAtOffset('hello female:lo world', 10)).toEqual({
      token: 'female:lo',
      start: 6,
      end: 15,
    });
  });

  it('keeps underscores inside the current token', () => {
    expect(getTokenAtOffset('female:long_hair test', 12)).toEqual({
      token: 'female:long_hair',
      start: 0,
      end: 16,
    });
  });

  it('returns an empty token for empty normalized text', () => {
    expect(getTokenAtOffset('', 2)).toEqual({
      token: '',
      start: 0,
      end: 0,
    });
  });

  it('treats punctuation-like suffix fragments as part of the token', () => {
    const result = getTokenAtOffset('female:lo:', 9);

    expect({ token: result.token, tokenStart: result.start, tokenEnd: result.end }).toEqual({
      token: 'female:lo:',
      tokenStart: 0,
      tokenEnd: 10,
    });
  });

  it('keeps adjacent-token boundaries stable at token starts after whitespace', () => {
    const result = getTokenAtOffset('first   second', 9);

    expect({ token: result.token, tokenStart: result.start, tokenEnd: result.end }).toEqual({
      token: 'second',
      tokenStart: 8,
      tokenEnd: 14,
    });
  });

  it('returns an empty token for trailing middle-gap and trailing-space fragments', () => {
    const gapResult = getTokenAtOffset('one   two  ', 4);
    const trailingResult = getTokenAtOffset('one   two  ', 10);

    expect({ token: gapResult.token, tokenStart: gapResult.start, tokenEnd: gapResult.end }).toEqual({
      token: '',
      tokenStart: 4,
      tokenEnd: 4,
    });

    expect({ token: trailingResult.token, tokenStart: trailingResult.start, tokenEnd: trailingResult.end }).toEqual({
      token: '',
      tokenStart: 10,
      tokenEnd: 10,
    });
  });
});
