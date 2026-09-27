import { ensureDb, withTransaction } from './adapter';
import { useDbStatusStore } from '@/lib/store/db-status';
import { markTagSyncCompleted, markTagSyncLoading, SYNC_KEY_TAGS } from './init';
import { setSyncStatus } from './sync-status';
import { TAG_TYPE_TO_BYTE } from '@/lib/utils/types';
import { TagType } from '@/lib/utils/types';
import { createTagFetcher } from '@/lib/api/tag-fetcher';
import { parseTagsFromHtml, parseNavUrls, TAG_TYPES, ParsedTag } from '@/lib/api/tag-parser';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
import { useSettingsStore } from '@/lib/store/settings';

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

/** Delay between page fetches to avoid rate limiting */
const PAGE_DELAY_MS = 2000;

/** Yield to the event loop so the UI stays responsive. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reloadCurrentLocale(): Promise<void> {
  const currentLocale = useSettingsStore.getState().locale;
  await useTagI18nStore.getState().loadLocale(currentLocale);
}

/**
 * Upsert tags into DB for a single tag type.
 */
async function upsertTagsForType(
  typeByte: number,
  tags: Array<[string, number]>,
): Promise<number> {
  const db = await ensureDb();

  // Keep each bridge call below SQLite's older 999-variable limit. Resolving
  // conflicts in SQL preserves tag IDs even when gallery saves add tags while
  // sync is fetching, without rescanning the whole type for every page.
  const BATCH_SIZE = 300;
  for (let i = 0; i < tags.length; i += BATCH_SIZE) {
    const batch = tags.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '(?, ?, ?)').join(', ');
    const params = batch.flatMap(([name, count]) => [typeByte, name, count]);
    await withTransaction(async () => {
      await db.execute(
        `INSERT INTO tag (type, name, count) VALUES ${placeholders}
         ON CONFLICT(type, name) DO UPDATE SET count = excluded.count`,
        params,
      );
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
 */
async function runRuntimeTagSync(): Promise<void> {
  const store = useDbStatusStore.getState();
  const fetcher = createTagFetcher();

  try {
    let totalTagCount = 0;
    let pagesCompleted = 0;
    const totalPagesEstimate = TAG_TYPES.length * 26; // rough estimate

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

      // Fetch remaining letter pages back-to-back (sequential, no inter-page
      // throttle — the per-page delay was removed; retries still back off).
      for (let letterIdx = 0; letterIdx < navUrls.length; letterIdx++) {
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

    // Never mark an empty sync as completed. A blocked/challenge response is an
    // HTTP 200 page that parses to 0 tags (no throw), so without this guard every
    // page "succeeds" with 0 tags and the sync is marked completed with an empty
    // tag table — which poisons dbReady (see checkDbReady) and stops any re-sync.
    // Throw instead so runTagSync records the error and the status stays
    // not-completed, so it retries on the next launch.
    if (totalTagCount === 0) {
      throw new Error(
        'Tag sync produced 0 tags — every page returned no parseable tags (likely a blocked/challenge response). Not marking completed.',
      );
    }

    await markTagSyncCompleted(totalTagCount);

    // Reload locale translations into the store (respects current user locale)
    await reloadCurrentLocale();
  } finally {
    await fetcher.dispose();
  }
}

let syncInFlight = false;

/**
 * Main tag sync entry point.
 * Fetches tag pages from hitomi.la directly, page by page.
 */
export async function runTagSync(): Promise<void> {
  const store = useDbStatusStore.getState();
  if (syncInFlight || store.isSyncing) return;

  syncInFlight = true;
  useDbStatusStore.getState().setIsSyncing(true);
  useDbStatusStore.getState().setSyncError(null);

  try {
    await markTagSyncLoading();
    useDbStatusStore.getState().setSyncProgress(5);
    await runRuntimeTagSync();
  } catch (error) {
    console.error('[tag-sync] Sync failed:', error);
    const message = errorMessage(error);
    useDbStatusStore.getState().setSyncError(message);
  } finally {
    syncInFlight = false;
    useDbStatusStore.getState().setIsSyncing(false);
  }
}
