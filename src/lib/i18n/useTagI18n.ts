import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { useDbStatusStore } from '@/lib/store/db-status';
import { batchGetTagI18n } from '@/lib/db/tag';
import type { TagType } from '@/lib/utils/types';

const EMPTY_MAP = new Map<string, string>();

/**
 * Given a tag entries array (from GalleryBlock), returns a Map<"type:name", koreanName>
 * when locale is 'ko' and DB is ready. Otherwise returns empty map.
 */
export function useTagI18n(tagEntries: [TagType, string[]][]) {
  const locale = useSettingsStore((s) => s.locale);
  const dbReady = useDbStatusStore((s) => s.dbReady);
  const [i18nMap, setI18nMap] = useState<Map<string, string>>(EMPTY_MAP);

  // Stabilize tagEntries by serializing to a key string
  const tagKey = useMemo(() => {
    return tagEntries.map(([t, names]) => `${t}:${names.join(',')}`).join('|');
  }, [tagEntries]);

  const prevKeyRef = useRef(tagKey);

  useEffect(() => {
    if (locale !== 'ko' || !dbReady || tagEntries.length === 0) {
      if (i18nMap !== EMPTY_MAP) setI18nMap(EMPTY_MAP);
      return;
    }

    // Only fetch if tagKey actually changed
    prevKeyRef.current = tagKey;

    const tags: Array<{ type: TagType; name: string }> = [];
    for (const [type, names] of tagEntries) {
      for (const name of names) {
        tags.push({ type, name });
      }
    }

    batchGetTagI18n(tags).then(setI18nMap).catch(() => setI18nMap(EMPTY_MAP));
  }, [locale, dbReady, tagKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return i18nMap;
}
