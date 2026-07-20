import { describe, expect, it } from 'vitest';

import { TagType } from '@/lib/utils/types';
import type { Suggestion } from '@/lib/utils/types';
import { prioritizeFavorites, prioritizeSuggestions, toFavoriteTagKey } from '../tag-favorites';

describe('toFavoriteTagKey', () => {
  it('builds a type-qualified search-form key', () => {
    expect(toFavoriteTagKey(TagType.ARTIST, 'sample artist')).toBe('artist:sample_artist');
  });

  it('keeps different metadata types distinct', () => {
    expect(toFavoriteTagKey(TagType.ARTIST, 'same name')).not.toBe(
      toFavoriteTagKey(TagType.SERIES, 'same name'),
    );
  });

  it('normalizes surrounding whitespace and case', () => {
    expect(toFavoriteTagKey(TagType.ARTIST, '  Sample Artist  ')).toBe(
      toFavoriteTagKey(TagType.ARTIST, 'sample artist'),
    );
    expect(toFavoriteTagKey(TagType.SERIES, 'MIXED Case')).toBe('series:mixed_case');
  });

  it('normalizes legacy generic male and female suffixes to their canonical types', () => {
    expect(toFavoriteTagKey(TagType.TAG, '  Legacy Male ♂  ')).toBe(
      toFavoriteTagKey(TagType.MALE, 'legacy male'),
    );
    expect(toFavoriteTagKey(TagType.TAG, 'LEGACY FEMALE ♀')).toBe(
      toFavoriteTagKey(TagType.FEMALE, 'legacy female'),
    );
  });

  it('only normalizes an exact trailing space plus gender suffix', () => {
    expect(toFavoriteTagKey(TagType.TAG, 'not-spaced♂')).toBe('tag:not-spaced♂');
    expect(toFavoriteTagKey(TagType.TAG, 'female ♀ extra')).toBe('tag:female_♀_extra');
  });
});

describe('prioritizeFavorites', () => {
  it('performs a stable, non-mutating favorite-first partition', () => {
    const items = [
      { id: 'a', key: 'tag:a' },
      { id: 'b', key: 'tag:b' },
      { id: 'c', key: 'tag:c' },
      { id: 'd', key: 'tag:d' },
    ] as const;
    const original = [...items];

    const result = prioritizeFavorites(items, ['tag:c', 'tag:a'], (item) => item.key);

    expect(result.map((item) => item.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(items).toEqual(original);
    expect(result).not.toBe(items);
  });

  it('returns a copy when there are no favorites', () => {
    const items = [1, 2, 3] as const;
    const result = prioritizeFavorites(items, [], String);

    expect(result).toEqual([1, 2, 3]);
    expect(result).not.toBe(items);
  });
});

describe('prioritizeSuggestions', () => {
  it('prioritizes canonical favorite keys and preserves source order within groups', () => {
    const suggestions: readonly Suggestion[] = [
      { tag: 'first tag', tagType: TagType.TAG, amount: 30 },
      { tag: 'sample artist', tagType: TagType.ARTIST, amount: 20 },
      { tag: 'sample series', tagType: TagType.SERIES, amount: 10 },
    ];

    const result = prioritizeSuggestions(suggestions, [
      'artist:sample_artist',
      'series:sample_series',
    ]);

    expect(result.map((suggestion) => suggestion.tag)).toEqual([
      'sample artist',
      'sample series',
      'first tag',
    ]);
    expect(suggestions.map((suggestion) => suggestion.tag)).toEqual([
      'first tag',
      'sample artist',
      'sample series',
    ]);
  });
});
