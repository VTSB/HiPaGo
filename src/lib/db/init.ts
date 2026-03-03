import { getSyncStatus, setSyncStatus } from './sync-status';
import { useDbStatusStore } from '@/lib/store/db-status';

/** Sync status keys */
export const SYNC_KEY_TAGS = 'init:tags';

/** Tags older than 7 days are considered stale and will be re-synced in background */
const TAG_SYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
 * Also checks for staleness (> 7 days) and sets tagsStale if needed.
 * Called once on app mount.
 */
export async function checkDbReady(): Promise<boolean> {
  const raw = await getSyncStatus(SYNC_KEY_TAGS);
  const data = parseSyncData(raw);
  const ready = data?.status === 'completed';
  useDbStatusStore.getState().setDbReady(ready);

  // Check if tags are stale (older than 7 days)
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
