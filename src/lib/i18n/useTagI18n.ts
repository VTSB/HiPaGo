import { useMemo } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { getTagI18nLookupKeys, useTagI18nStore } from '@/lib/store/tag-i18n';
import type { TagType } from '@/lib/utils/types';

const EMPTY_MAP = new Map<string, string>();

/**
 * Given a tag entries array (from GalleryBlock), returns a Map<"type:name", localizedName>
 * when matching locale data is loaded. Otherwise returns empty map.
 *
 * Subscribes to the store so components re-render when translations load.
 */
export function useTagI18n(tagEntries: [TagType, string[]][]) {
  const locale = useSettingsStore((s) => s.locale);
  // Subscribe to isLoaded + nameToLocal so we re-render when translations load
  const isLoaded = useTagI18nStore((s) => s.isLoaded);
  const loadedLocale = useTagI18nStore((s) => s.loadedLocale);
  const nameToLocal = useTagI18nStore((s) => s.nameToLocal);

  return useMemo(() => {
    if (!isLoaded || loadedLocale !== locale || tagEntries.length === 0) {
      return EMPTY_MAP;
    }

    const result = new Map<string, string>();
    for (const [type, names] of tagEntries) {
      for (const name of names) {
        for (const key of getTagI18nLookupKeys(type, name)) {
          const local = nameToLocal.get(key);
          if (local !== undefined) {
            result.set(`${type}:${name}`, local);
            break;
          }
        }
      }
    }
    return result;
  }, [locale, isLoaded, loadedLocale, nameToLocal, tagEntries]);
}

export function useTagLocalName(type: string, name: string | undefined) {
  const locale = useSettingsStore((s) => s.locale);
  const isLoaded = useTagI18nStore((s) => s.isLoaded);
  const loadedLocale = useTagI18nStore((s) => s.loadedLocale);
  const nameToLocal = useTagI18nStore((s) => s.nameToLocal);

  return useMemo(() => {
    if (!name || !isLoaded || loadedLocale !== locale) return undefined;
    for (const key of getTagI18nLookupKeys(type, name)) {
      const local = nameToLocal.get(key);
      if (local !== undefined) return local;
    }
    return undefined;
  }, [isLoaded, loadedLocale, locale, name, nameToLocal, type]);
}
