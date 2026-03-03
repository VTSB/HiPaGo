import { ensureDb, withTransaction } from './adapter';
import { useDbStatusStore } from '@/lib/store/db-status';
import { markTagSyncCompleted, markTagSyncLoading, SYNC_KEY_TAGS } from './init';
import { getSyncStatus, setSyncStatus } from './sync-status';
import { TAG_TYPE_TO_BYTE } from '@/lib/utils/types';
import { TagType } from '@/lib/utils/types';
import { createTagFetcher, TagFetcher } from '@/lib/api/tag-fetcher';
import { parseTagsFromHtml, parseNavUrls, TAG_TYPES, ParsedTag } from '@/lib/api/tag-parser';

/**
 * Map JSON type strings to TagType enum values.
 */
const TYPE_STRING_MAP: Record<string, TagType> = {
  artist: TagType.ARTIST,
  series: TagType.SERIES,
  character: TagType.CHARACTER,
  group: TagType.GROUP,
  tag: TagType.TAG,
  female: TagType.FEMALE,
  male: TagType.MALE,
};

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

/** Delay between page fetches to avoid rate limiting */
const PAGE_DELAY_MS = 2000;

/** Yield to the event loop so the UI stays responsive. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a lookup map of existing tags for a given type byte.
 */
async function buildExistingTagMap(typeByte: number): Promise<Map<string, { tagId: number; count: number }>> {
  const db = await ensureDb();
  const existing = await db.query<{ tagId: number; name: string; count: number }>(
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
  const { default: koreanTags } = await import('@/lib/data/korean-tags.json');
  const db = await ensureDb();
  let count = 0;
  const typedKoreanTags = koreanTags as Record<string, Record<string, string>>;

  for (const [field, translations] of Object.entries(typedKoreanTags)) {
    const tagType = KOREAN_FIELD_MAP[field];
    if (tagType === undefined) continue;
    const typeByte = TAG_TYPE_TO_BYTE[tagType];

    const existingTags = await db.query<{ tagId: number; name: string }>(
      'SELECT tagId, name FROM tag WHERE type = ?',
      [typeByte],
    );
    const nameToId = new Map<string, number>();
    for (const tag of existingTags) {
      nameToId.set(tag.name, tag.tagId);
    }

    await withTransaction(async () => {
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
    });

    await yieldToMain();
  }

  return count;
}

/**
 * Upsert tags into DB for a single tag type.
 */
async function upsertTagsForType(
  typeByte: number,
  tags: Array<[string, number]>,
): Promise<number> {
  const db = await ensureDb();
  const existingMap = await buildExistingTagMap(typeByte);

  const toInsert: Array<{ type: number; name: string; count: number }> = [];
  const toUpdate: Array<{ tagId: number; count: number }> = [];

  for (const [name, count] of tags) {
    const existing = existingMap.get(name);
    if (existing) {
      if (existing.count !== count) {
        toUpdate.push({ tagId: existing.tagId, count });
      }
    } else {
      toInsert.push({ type: typeByte, name, count });
      existingMap.set(name, { tagId: -1, count });
    }
  }

  // Insert/update in batches to avoid blocking the UI thread
  const BATCH_SIZE = 500;

  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    await withTransaction(async () => {
      for (const { type, name, count } of batch) {
        await db.execute(
          'INSERT INTO tag (type, name, count) VALUES (?, ?, ?)',
          [type, name, count],
        );
      }
    });
    await yieldToMain();
  }

  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + BATCH_SIZE);
    await withTransaction(async () => {
      for (const { tagId, count } of batch) {
        await db.execute(
          'UPDATE tag SET count = ? WHERE tagId = ?',
          [count, tagId],
        );
      }
    });
    await yieldToMain();
  }

  return tags.length;
}

/**
 * Insert a batch of ParsedTag objects into the DB, grouped by type.
 */
async function insertParsedTags(tags: ParsedTag[]): Promise<void> {
  const grouped = new Map<number, Array<[string, number]>>();
  for (const tag of tags) {
    const tagType = TYPE_STRING_MAP[tag.type];
    if (tagType === undefined) continue;
    const typeByte = TAG_TYPE_TO_BYTE[tagType];
    let list = grouped.get(typeByte);
    if (!list) {
      list = [];
      grouped.set(typeByte, list);
    }
    list.push([tag.name, tag.count]);
  }
  for (const [typeByte, tagList] of grouped) {
    await upsertTagsForType(typeByte, tagList);
  }
}

/**
 * Update sync progress in the store.
 * Reserves 5% for fetch start and 5% for localization; 90% for page processing.
 */
function updateProgress(completed: number, total: number): void {
  const progress = 5 + Math.round((completed / Math.max(total, 1)) * 90);
  useDbStatusStore.getState().setSyncProgress(Math.min(progress, 95));
}

/** Persist sync checkpoint so interrupted syncs can resume. */
async function saveCheckpoint(typeIndex: number, letterIndex: number, tagCount: number): Promise<void> {
  await setSyncStatus(SYNC_KEY_TAGS, JSON.stringify({
    status: 'loading',
    timestamp: Date.now(),
    checkpoint: { typeIndex, letterIndex, tagCount },
  }));
}

/**
 * Runtime tag sync: fetches hitomi.la tag pages directly, page by page.
 * Falls back to bundled JSON if this fails.
 */
async function runRuntimeTagSync(): Promise<void> {
  const store = useDbStatusStore.getState();
  const fetcher = createTagFetcher();

  try {
    let totalTagCount = 0;
    let pagesCompleted = 0;
    let totalPagesEstimate = TAG_TYPES.length * 26; // rough estimate, refined as we go

    const failedPages: Array<{ url: string; defaultType: string }> = [];

    for (let typeIdx = 0; typeIdx < TAG_TYPES.length; typeIdx++) {
      const { urlType, defaultType } = TAG_TYPES[typeIdx];
      const firstUrl = `all${urlType}-a.html`;

      // Fetch first page
      store.setSyncDetail(`${urlType} 태그 가져오는 중...`);
      const firstHtml = await fetcher.fetchPage(firstUrl);
      const firstTags = parseTagsFromHtml(firstHtml, defaultType);
      const navUrls = parseNavUrls(firstHtml);

      // Insert first page tags
      if (firstTags.length > 0) {
        await insertParsedTags(firstTags);
        totalTagCount += firstTags.length;
      }
      pagesCompleted++;
      updateProgress(pagesCompleted, totalPagesEstimate);

      // Fetch remaining letter pages
      for (let letterIdx = 0; letterIdx < navUrls.length; letterIdx++) {
        await sleep(PAGE_DELAY_MS);

        try {
          const html = await fetcher.fetchPage(navUrls[letterIdx]);
          const tags = parseTagsFromHtml(html, defaultType);
          if (tags.length > 0) {
            await insertParsedTags(tags);
            totalTagCount += tags.length;
          }
        } catch {
          failedPages.push({ url: navUrls[letterIdx], defaultType });
        }

        pagesCompleted++;
        updateProgress(pagesCompleted, totalPagesEstimate);
        store.setSyncDetail(`${urlType} (${letterIdx + 2}/${navUrls.length + 1})`);

        await saveCheckpoint(typeIdx, letterIdx, totalTagCount);
        await yieldToMain();
      }
    }

    // Pass 2: retry failed pages
    if (failedPages.length > 0) {
      store.setSyncDetail(`실패한 페이지 재시도 (${failedPages.length}개)...`);
      await sleep(5000); // cooldown

      for (const { url, defaultType } of failedPages) {
        try {
          await sleep(PAGE_DELAY_MS * 2);
          const html = await fetcher.fetchPage(url);
          const tags = parseTagsFromHtml(html, defaultType);
          if (tags.length > 0) {
            await insertParsedTags(tags);
            totalTagCount += tags.length;
          }
        } catch {
          console.warn(`[tag-sync] Failed to fetch ${url} after retry`);
        }
      }
    }

    // Apply Korean localization
    store.setSyncDetail('한국어 태그 적용 중...');
    await applyKoreanLocalization();

    await markTagSyncCompleted(totalTagCount);
  } finally {
    await fetcher.dispose();
  }
}

/**
 * Main tag sync entry point.
 * Fetches tag pages from hitomi.la directly, page by page.
 */
export async function runTagSync(): Promise<void> {
  const store = useDbStatusStore.getState();
  if (store.isSyncing) return;

  await markTagSyncLoading();
  useDbStatusStore.getState().setIsSyncing(true);

  try {
    useDbStatusStore.getState().setSyncProgress(5);
    await runRuntimeTagSync();
  } catch (error) {
    console.error('[tag-sync] Sync failed:', error);
    useDbStatusStore.getState().setIsSyncing(false);
  }
}
