import { ensureDb, withTransaction } from './adapter';
import { useDbStatusStore } from '@/lib/store/db-status';
import { markTagSyncCompleted, markTagSyncLoading, parseSyncData, SYNC_KEY_TAGS } from './init';
import { getSyncStatus, setSyncStatus } from './sync-status';
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
 * Build a lookup map of existing tags for a given type byte.
 */
async function buildExistingTagMap(
  typeByte: number,
): Promise<Map<string, { tagId: number; count: number }>> {
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
 * Upsert tags into DB for a single tag type.
 */
async function upsertTagsForType(typeByte: number, tags: Array<[string, number]>): Promise<number> {
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
    await withTransaction(async (transactionDb) => {
      for (const { type, name, count } of batch) {
        await transactionDb.execute(
          `INSERT INTO tag (type, name, count) VALUES (?, ?, ?)
           ON CONFLICT(type, name) DO UPDATE SET count = excluded.count`,
          [type, name, count],
        );
      }
    });
    await yieldToMain();
  }

  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + BATCH_SIZE);
    await withTransaction(async (transactionDb) => {
      for (const { tagId, count } of batch) {
        await transactionDb.execute('UPDATE tag SET count = ? WHERE tagId = ?', [count, tagId]);
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
async function saveCheckpoint(
  typeIndex: number,
  letterIndex: number,
  tagCount: number,
): Promise<void> {
  await setSyncStatus(
    SYNC_KEY_TAGS,
    JSON.stringify({
      status: 'loading',
      timestamp: Date.now(),
      checkpoint: { typeIndex, letterIndex, tagCount },
    }),
  );
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
    const totalPagesEstimate = TAG_TYPES.length * 26; // rough estimate

    const failedPages: Array<{ url: string; defaultType: string }> = [];

    for (let typeIdx = 0; typeIdx < TAG_TYPES.length; typeIdx++) {
      const { urlType, defaultType } = TAG_TYPES[typeIdx];
      const firstUrl = `all${urlType}-a.html`;

      // Fetch the first page separately because its navigation links define the
      // rest of this type's catalog. A challenge page can be HTTP 200 while
      // parsing to zero tags; retry it once, and never continue with missing
      // navigation metadata.
      store.setSyncDetail(`${urlType} 태그 가져오는 중...`);
      let firstHtml: string | null = null;
      let firstTags: ParsedTag[] = [];
      let firstPageError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const html = await fetcher.fetchPage(firstUrl);
          const tags = parseTagsFromHtml(html, defaultType);
          if (tags.length === 0) {
            throw new Error(`No parseable tags returned for ${firstUrl}`);
          }
          firstHtml = html;
          firstTags = tags;
          break;
        } catch (error) {
          firstPageError = error;
          if (attempt === 0) await sleep(PAGE_DELAY_MS * 2);
        }
      }
      if (firstHtml === null) {
        if (
          firstPageError instanceof Error &&
          !firstPageError.message.startsWith('No parseable tags returned for ')
        ) {
          throw firstPageError;
        }
        throw new Error(
          `Required first tag page ${firstUrl} remained unavailable after retry: ${errorMessage(firstPageError)}`,
        );
      }
      const navUrls = parseNavUrls(firstHtml);

      // Insert first page tags
      await insertParsedTags(firstTags);
      totalTagCount += firstTags.length;
      pagesCompleted++;
      updateProgress(pagesCompleted, totalPagesEstimate);

      // Fetch remaining letter pages back-to-back (sequential, no inter-page
      // throttle — the per-page delay was removed; retries still back off).
      for (let letterIdx = 0; letterIdx < navUrls.length; letterIdx++) {
        try {
          const html = await fetcher.fetchPage(navUrls[letterIdx]);
          const tags = parseTagsFromHtml(html, defaultType);
          if (tags.length === 0) {
            throw new Error(`No parseable tags returned for ${navUrls[letterIdx]}`);
          }
          await insertParsedTags(tags);
          totalTagCount += tags.length;
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
    const unresolvedPages: string[] = [];
    if (failedPages.length > 0) {
      store.setSyncDetail(`실패한 페이지 재시도 (${failedPages.length}개)...`);
      await sleep(5000); // cooldown

      for (const { url, defaultType } of failedPages) {
        try {
          await sleep(PAGE_DELAY_MS * 2);
          const html = await fetcher.fetchPage(url);
          const tags = parseTagsFromHtml(html, defaultType);
          if (tags.length === 0) {
            throw new Error(`No parseable tags returned for ${url}`);
          }
          await insertParsedTags(tags);
          totalTagCount += tags.length;
        } catch {
          console.warn(`[tag-sync] Failed to fetch ${url} after retry`);
          unresolvedPages.push(url);
        }
      }
    }

    // A partial catalog must not be considered fresh for the full 14-day sync
    // window. Already-written pages are idempotent upserts, so keep the status
    // incomplete and let the next launch retry the entire catalog safely.
    if (unresolvedPages.length > 0) {
      throw new Error(
        `Tag sync remained incomplete after retrying ${unresolvedPages.length} page(s): ${unresolvedPages.join(', ')}`,
      );
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

    // Tag localization is bundled UI data, not part of the DB sync itself. A
    // locale reload failure after markTagSyncCompleted must not turn a completed
    // sync into a false failure banner.
    await reloadCurrentLocale().catch((error) => {
      console.warn('[tag-sync] Failed to reload tag localization:', error);
    });
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

  const previousDbReady = store.dbReady;
  const previousTagsStale = store.tagsStale;
  let previousCompletedStatus: string | null = null;

  // Claim the run synchronously. markTagSyncLoading performs an async DB write,
  // so waiting for it before setting this flag allowed two startup triggers to
  // enter together.
  store.setIsSyncing(true);
  store.setSyncError(null);

  try {
    const previousStatus = await getSyncStatus(SYNC_KEY_TAGS);
    if (parseSyncData(previousStatus)?.status === 'completed') {
      previousCompletedStatus = previousStatus;
    }
    await markTagSyncLoading();
    useDbStatusStore.getState().setSyncProgress(5);
    await runRuntimeTagSync();
  } catch (error) {
    console.error('[tag-sync] Sync failed:', error);
    // A stale catalog remains usable while a background refresh is in flight.
    // If that refresh fails, restore its prior completed marker so the next app
    // launch does not mistake the populated DB for an interrupted first sync.
    // The old timestamp remains intact, so it stays stale and will be retried.
    if (previousCompletedStatus !== null) {
      try {
        await setSyncStatus(SYNC_KEY_TAGS, previousCompletedStatus);
        useDbStatusStore.getState().setDbReady(previousDbReady);
        useDbStatusStore.getState().setTagsStale(previousTagsStale);
      } catch (restoreError) {
        console.warn('[tag-sync] Failed to restore the previous completed status:', restoreError);
      }
    }
    const message = errorMessage(error);
    useDbStatusStore.getState().setSyncError(message);
    useDbStatusStore.getState().setIsSyncing(false);
  }
}
