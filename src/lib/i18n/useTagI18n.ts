import { useSettingsStore } from '@/lib/store/settings';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
import type { TagType } from '@/lib/utils/types';

const EMPTY_MAP = new Map<string, string>();

/**
 * Given a tag entries array (from GalleryBlock), returns a Map<"type:name", koreanName>
 * when locale is 'ko' and i18n store is loaded. Otherwise returns empty map.
 */
export function useTagI18n(tagEntries: [TagType, string[]][]) {
  const locale = useSettingsStore((s) => s.locale);

  if (locale !== 'ko' || tagEntries.length === 0) {
    return EMPTY_MAP;
  }

  const { isLoaded, getLocal } = useTagI18nStore.getState();

  if (!isLoaded) {
    return EMPTY_MAP;
  }

  const result = new Map<string, string>();
  for (const [type, names] of tagEntries) {
    for (const name of names) {
      const local = getLocal(type as string, name);
      if (local !== undefined) {
        result.set(`${type}:${name}`, local);
      }
    }
  }
  return result;
}
