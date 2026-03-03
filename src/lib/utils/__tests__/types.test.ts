// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { getTagColor, TAG_TYPE_COLOR, TagType } from '../types';

describe('getTagColor', () => {
  it('returns specific color for female type', () => {
    expect(getTagColor(TagType.FEMALE)).toBe(TAG_TYPE_COLOR[TagType.FEMALE]);
  });
  it('returns specific color for male type', () => {
    expect(getTagColor(TagType.MALE)).toBe(TAG_TYPE_COLOR[TagType.MALE]);
  });
  it('returns default color for unknown type', () => {
    const defaultColor = 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700';
    expect(getTagColor('unknown')).toBe(defaultColor);
    expect(getTagColor(TagType.ARTIST)).toBe(defaultColor);
  });
});
