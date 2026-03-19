import { useMemo } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
import type { TagType } from '@/lib/utils/types';

const EMPTY_MAP = new Map<string, string>();

/**
 * Given a tag entries array (from GalleryBlock), returns a Map<"type:name", koreanName>
 * when locale is 'ko' and i18n store is loaded. Otherwise returns empty map.
 *
 * Subscribes to the store so components re-render when translations load.
 */
export function useTagI18n(tagEntries: [TagType, string[]][]) {
  const locale = useSettingsStore((s) => s.locale);
  // Subscribe to isLoaded + nameToLocal so we re-render when translations load
  const isLoaded = useTagI18nStore((s) => s.isLoaded);
  const nameToLocal = useTagI18nStore((s) => s.nameToLocal);

  return useMemo(() => {
    if (locale !== 'ko' || !isLoaded || tagEntries.length === 0) {
      return EMPTY_MAP;
    }

    const result = new Map<string, string>();
    for (const [type, names] of tagEntries) {
      for (const name of names) {
        const local = nameToLocal.get(`${type}:${name}`);
        if (local !== undefined) {
          result.set(`${type}:${name}`, local);
        }
      }
    }
    return result;
  }, [locale, isLoaded, nameToLocal, tagEntries]);
}
