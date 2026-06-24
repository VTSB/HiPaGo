import { getSyncStatus, setSyncStatus } from './sync-status';
import { ensureDb } from './adapter';
import { useDbStatusStore } from '@/lib/store/db-status';

/** Sync status keys */
export const SYNC_KEY_TAGS = 'init:tags';

/** Tags older than 14 days are considered stale and will be re-synced in background */
const TAG_SYNC_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

interface SyncStatusData {
  status: 'loading' | 'completed';
  timestamp: number;
  count?: number;
  checkpoint?: {
    fieldIndex?: number;
    tagCount: number;
    typeIndex?: number;
    letterIndex?: number;
  };
}

export function parseSyncData(raw: string | null): SyncStatusData | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncStatusData;
  } catch {
    // Recoverable: corrupted localStorage entry — treat as no prior sync status
    return null;
  }
}

/**
 * Check if the tag DB has been initialized and set dbReady accordingly.
 * Also checks for staleness (> 14 days) and sets tagsStale if needed.
 * Called once on app mount.
 */
export async function checkDbReady(): Promise<boolean> {
  const raw = await getSyncStatus(SYNC_KEY_TAGS);
  const data = parseSyncData(raw);
  let ready = data?.status === 'completed';

  // Defense in depth: a prior sync may have marked 'completed' with an empty tag
  // table (e.g. blocked fetches that parsed to 0 tags before the empty-guard in
  // runRuntimeTagSync existed). Trust the flag only if the tag table actually has
  // rows — otherwise a stuck device would never re-sync, since DbInitializer only
  // syncs when !ready. The probe is best-effort: if it fails, keep the flag value
  // so a transient query error never blocks boot.
  if (ready) {
    try {
      const db = await ensureDb();
      const rows = await db.query<{ c: number }>('SELECT COUNT(*) as c FROM tag');
      if (!rows[0] || rows[0].c === 0) ready = false;
    } catch {
      // Probe failed — fall back to the sync-status flag value.
    }
  }

  useDbStatusStore.getState().setDbReady(ready);

  // Check if tags are stale (older than 14 days)
  if (ready && data?.timestamp && Date.now() - data.timestamp > TAG_SYNC_MAX_AGE_MS) {
    useDbStatusStore.getState().setTagsStale(true);
  }

  return ready;
}

/**
 * Mark tag sync as completed in sync_status and set dbReady.
 */
export async function markTagSyncCompleted(count: number): Promise<void> {
  const data: SyncStatusData = {
    status: 'completed',
    timestamp: Date.now(),
    count,
  };
  await setSyncStatus(SYNC_KEY_TAGS, JSON.stringify(data));
  useDbStatusStore.getState().setDbReady(true);
  useDbStatusStore.getState().setIsSyncing(false);
  useDbStatusStore.getState().setSyncProgress(100);
  useDbStatusStore.getState().setTagsStale(false);
  useDbStatusStore.getState().setSyncError(null);
}

/**
 * Mark tag sync as in-progress.
 */
export async function markTagSyncLoading(): Promise<void> {
  const data: SyncStatusData = {
    status: 'loading',
    timestamp: Date.now(),
  };
  await setSyncStatus(SYNC_KEY_TAGS, JSON.stringify(data));
  useDbStatusStore.getState().setIsSyncing(true);
}
