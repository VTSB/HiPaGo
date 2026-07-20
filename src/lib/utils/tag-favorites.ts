import { tagFromDisplay, toSearchString } from './hitomi-tag';
import { TagType, type Suggestion } from './types';

/** Build the canonical persisted identity for any user-facing metadata tag. */
export function toFavoriteTagKey(type: TagType, tag: string): string {
  const normalizedTag = tag.trim().toLowerCase();

  // Legacy gallery blocks may cache gendered tags in the generic `tag` bucket
  // with Hitomi's visible suffix. Treat those as the same identity as modern
  // male/female buckets so an existing favorite still matches old cache data.
  if (type === TagType.TAG) {
    if (normalizedTag.endsWith(' ♂')) {
      return toSearchString(tagFromDisplay(normalizedTag.slice(0, -2), TagType.MALE));
    }
    if (normalizedTag.endsWith(' ♀')) {
      return toSearchString(tagFromDisplay(normalizedTag.slice(0, -2), TagType.FEMALE));
    }
  }

  return toSearchString(tagFromDisplay(normalizedTag, type));
}

/**
 * Move favorite items to the front without mutating the input or disturbing
 * the relative order within the favorite and non-favorite groups.
 */
export function prioritizeFavorites<T>(
  items: readonly T[],
  favoriteTags: readonly string[],
  getKey: (item: T) => string,
): T[] {
  if (items.length === 0) return [];

  const favoriteKeys = new Set(favoriteTags);
  const favorites: T[] = [];
  const others: T[] = [];

  for (const item of items) {
    (favoriteKeys.has(getKey(item)) ? favorites : others).push(item);
  }

  return [...favorites, ...others];
}

/** Prioritize favorite tag suggestions while preserving their source ranking. */
export function prioritizeSuggestions(
  items: readonly Suggestion[],
  favoriteTags: readonly string[],
): Suggestion[] {
  return prioritizeFavorites(items, favoriteTags, (suggestion) =>
    toFavoriteTagKey(suggestion.tagType, suggestion.tag),
  );
}
