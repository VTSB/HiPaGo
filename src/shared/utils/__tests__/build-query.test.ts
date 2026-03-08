import { describe, it, expect } from 'vitest';
import { buildQueryString } from '../build-query';

describe('buildQueryString', () => {
  it('returns empty string for no chips and no input', () => {
    expect(buildQueryString([], '', 0)).toBe('');
  });

  it('joins chips in order when no active input', () => {
    expect(buildQueryString(['female:loli', 'tag:stockings'], '', 2))
      .toBe('female:loli tag:stockings');
  });

  it('places active input at inputPosition', () => {
    expect(buildQueryString(['female:loli', 'tag:stockings'], 'search', 1))
      .toBe('female:loli search tag:stockings');
  });

  it('trims active input whitespace', () => {
    expect(buildQueryString(['a'], '  hello  ', 1)).toBe('a hello');
  });

  it('skips empty trimmed input', () => {
    expect(buildQueryString(['a', 'b'], '   ', 1)).toBe('a b');
  });

  it('handles inputPosition at start', () => {
    expect(buildQueryString(['a', 'b'], 'text', 0)).toBe('text a b');
  });

  it('handles inputPosition at end', () => {
    expect(buildQueryString(['a', 'b'], 'text', 2)).toBe('a b text');
  });

  it('handles only active input with no chips', () => {
    expect(buildQueryString([], 'hello world', 0)).toBe('hello world');
  });

  it('handles only chips with no active input', () => {
    expect(buildQueryString(['a', 'b', 'c'], '', 3)).toBe('a b c');
  });
});

describe('buildQueryString with gapTexts', () => {
  it('places gapTexts at non-active positions', () => {
    // chips=[a, b, c], input at pos 1 = "mid", gapTexts={0: "before", 3: "after"}
    expect(buildQueryString(['a', 'b', 'c'], 'mid', 1, { 0: 'before', 3: 'after' }))
      .toBe('before a mid b c after');
  });

  it('ignores gapTexts at activeInput position', () => {
    // gapTexts[1] should be ignored since inputPosition=1
    expect(buildQueryString(['a', 'b'], 'active', 1, { 1: 'ignored' }))
      .toBe('a active b');
  });

  it('handles gapTexts with empty string values', () => {
    expect(buildQueryString(['a', 'b'], 'text', 2, { 0: '', 1: '' }))
      .toBe('a b text');
  });

  it('trims gapTexts whitespace', () => {
    expect(buildQueryString(['a'], '', 1, { 0: '  padded  ' }))
      .toBe('padded a');
  });

  it('handles gapTexts only (no active input)', () => {
    expect(buildQueryString(['a', 'b'], '', 2, { 0: 'x', 1: 'y' }))
      .toBe('x a y b');
  });

  it('handles multiple gap positions with chips between', () => {
    expect(buildQueryString(['a', 'b', 'c'], '', 3, { 0: 'g0', 1: 'g1', 2: 'g2' }))
      .toBe('g0 a g1 b g2 c');
  });

  it('undefined gapTexts works like before (backwards compatible)', () => {
    expect(buildQueryString(['a', 'b'], 'text', 1, undefined))
      .toBe('a text b');
  });
});
