import { getDb } from './adapter';
import { apiClient } from '@/lib/api/client';
import { resolveTagIndexUrl } from '@/lib/api/url-resolver';
import { useDbStatusStore } from '@/lib/store/db-status';
import { markTagSyncCompleted, markTagSyncLoading, parseSyncData, SYNC_KEY_TAGS } from './init';
import { getSyncStatus, setSyncStatus } from './sync-status';
import { TAG_TYPE_TO_BYTE } from '@/lib/utils/types';
import { TagType } from '@/lib/utils/types';
import koreanTags from '@/lib/data/korean-tags.json';

/**
 * Tag sync fields to download from tagindex.hitomi.la.
 */
const SYNC_FIELDS: Array<{ field: string; tagType: TagType }> = [
  { field: 'female', tagType: TagType.FEMALE },
  { field: 'male', tagType: TagType.MALE },
  { field: 'artist', tagType: TagType.ARTIST },
  { field: 'series', tagType: TagType.SERIES },
  { field: 'group', tagType: TagType.GROUP },
  { field: 'character', tagType: TagType.CHARACTER },
  { field: 'tag', tagType: TagType.TAG },
];

/**
 * Korean localization field mapping.
 */
const KOREAN_FIELD_MAP: Record<string, TagType> = {
  female: TagType.FEMALE,
  male: TagType.MALE,
  series: TagType.SERIES,
  character: TagType.CHARACTER,
  tag: TagType.TAG,
  type: TagType.TYPE,
};

const PREFIXES = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const CONCURRENCY = 3;

/** Yield to the event loop so the UI stays responsive. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Fetch tags from tagindex API for a given field and prefix character.
 */
async function fetchTagsForPrefix(
  field: string,
  prefix: string,
): Promise<Array<[string, number, string]>> {
  try {
    const response = await apiClient.fetchUrl(resolveTagIndexUrl(`${field}/${prefix}.json`));
    return await response.json();
  } catch {
    return [];
  }
}

/**
 * Run tasks with concurrency limit.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Build a lookup map of existing tags for a given type byte.
 * Key: tag name, Value: { tagId, count }
 */
async function buildExistingTagMap(typeByte: number): Promise<Map<string, { tagId: number; count: number }>> {
  const existing = await getDb().query<{ tagId: number; name: string; count: number }>(
    'SELECT tagId, name, count FROM tag WHERE type = ?',
    [typeByte],
  );
  const map = new Map<string, { tagId: number; count: number }>();
  for (const tag of existing) {
    map.set(tag.name, { tagId: tag.tagId, count: tag.count });
  }
  return map;
}

/**
 * Apply Korean localization data to existing tags in DB.
 */
async function applyKoreanLocalization(): Promise<number> {
  const db = getDb();
  let count = 0;
  const typedKoreanTags = koreanTags as Record<string, Record<string, string>>;

  for (const [field, translations] of Object.entries(typedKoreanTags)) {
    const tagType = KOREAN_FIELD_MAP[field];
    if (tagType === undefined) continue;
    const typeByte = TAG_TYPE_TO_BYTE[tagType];

    // Pre-load all tags of this type into a name→tagId map
    const existingTags = await db.query<{ tagId: number; name: string }>(
      'SELECT tagId, name FROM tag WHERE type = ?',
      [typeByte],
    );
    const nameToId = new Map<string, number>();
    for (const tag of existingTags) {
      nameToId.set(tag.name, tag.tagId);
    }

    // Bulk write i18n records
    for (const [englishName, koreanName] of Object.entries(translations)) {
      const tagId = nameToId.get(englishName);
      if (tagId !== undefined) {
        await db.execute(
          'INSERT OR REPLACE INTO tag_i18n (tagId, local) VALUES (?, ?)',
          [tagId, koreanName],
        );
        count++;
      }
    }

    await yieldToMain();
  }

  return count;
}

/**
 * Main tag sync function.
 * Downloads all tags from tagindex.hitomi.la, populates the local DB,
 * and applies Korean localization.
 */
export async function runTagSync(): Promise<void> {
  const store = useDbStatusStore.getState();
  if (store.isSyncing) return;

  // Check for resume checkpoint from interrupted sync
  const raw = await getSyncStatus(SYNC_KEY_TAGS);
  const syncData = parseSyncData(raw);
  let resumeFieldIndex = 0;
  let totalTagCount = 0;

  if (syncData?.status === 'loading' && syncData.checkpoint) {
    resumeFieldIndex = syncData.checkpoint.fieldIndex + 1;
    totalTagCount = syncData.checkpoint.tagCount;
  } else {
    await markTagSyncLoading();
  }

  useDbStatusStore.getState().setIsSyncing(true);

  const totalSteps = SYNC_FIELDS.length * PREFIXES.length;
  let completedSteps = resumeFieldIndex * PREFIXES.length;

  try {
    const db = getDb();

    for (let fi = resumeFieldIndex; fi < SYNC_FIELDS.length; fi++) {
      const { field, tagType } = SYNC_FIELDS[fi];
      const typeByte = TAG_TYPE_TO_BYTE[tagType];

      // Pre-load existing tags for this type into memory
      let existingMap = await buildExistingTagMap(typeByte);

      // Collect all tags from all prefixes for this field
      const allNewTags: Array<[string, number]> = [];

      const tasks = PREFIXES.map((prefix) => async () => {
        const tags = await fetchTagsForPrefix(field, prefix);
        completedSteps++;
        useDbStatusStore.getState().setSyncProgress(
          Math.round((completedSteps / totalSteps) * 95),
        );
        return tags;
      });

      const results = await runWithConcurrency(tasks, CONCURRENCY);

      // Flatten all prefix results
      for (const tags of results) {
        for (const [tagName, count] of tags) {
          if (tagName) {
            allNewTags.push([tagName, count]);
          }
        }
      }

      if (allNewTags.length === 0) {
        await saveCheckpoint(fi, totalTagCount);
        await yieldToMain();
        continue;
      }

      // Diff against existing map and prepare operations
      const toInsert: Array<{ type: number; name: string; count: number }> = [];
      const toUpdate: Array<{ tagId: number; count: number }> = [];

      for (const [tagName, count] of allNewTags) {
        const existing = existingMap.get(tagName);
        if (existing) {
          if (existing.count !== count) {
            toUpdate.push({ tagId: existing.tagId, count });
          }
        } else {
          toInsert.push({ type: typeByte, name: tagName, count });
          existingMap.set(tagName, { tagId: -1, count });
        }
      }

      // Bulk insert new tags
      for (const { type, name, count } of toInsert) {
        await db.execute(
          'INSERT INTO tag (type, name, count) VALUES (?, ?, ?)',
          [type, name, count],
        );
      }

      // Bulk update changed counts
      for (const { tagId, count } of toUpdate) {
        await db.execute(
          'UPDATE tag SET count = ? WHERE tagId = ?',
          [count, tagId],
        );
      }

      totalTagCount += allNewTags.length;
      await saveCheckpoint(fi, totalTagCount);
      await yieldToMain();
    }

    // Apply Korean localization after all tags are synced
    await applyKoreanLocalization();

    await markTagSyncCompleted(totalTagCount);
  } catch (error) {
    console.error('[tag-sync] Sync failed:', error);
    useDbStatusStore.getState().setIsSyncing(false);
  }
}

/** Persist sync checkpoint so interrupted syncs can resume. */
async function saveCheckpoint(fieldIndex: number, tagCount: number): Promise<void> {
  await setSyncStatus(SYNC_KEY_TAGS, JSON.stringify({
    status: 'loading',
    timestamp: Date.now(),
    checkpoint: { fieldIndex, tagCount },
  }));
}
