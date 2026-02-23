import { getSyncStatus, setSyncStatus } from './sync-status';
import { useDbStatusStore } from '@/lib/store/db-status';

/** Sync status keys */
export const SYNC_KEY_TAGS = 'init:tags';

interface SyncStatusData {
  status: 'loading' | 'completed';
  timestamp: number;
  count?: number;
  checkpoint?: {
    fieldIndex: number;
    tagCount: number;
  };
}

export function parseSyncData(raw: string | null): SyncStatusData | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SyncStatusData;
  } catch {
    return null;
  }
}

/**
 * Check if the tag DB has been initialized and set dbReady accordingly.
 * Called once on app mount.
 */
export async function checkDbReady(): Promise<boolean> {
  const raw = await getSyncStatus(SYNC_KEY_TAGS);
  const data = parseSyncData(raw);
  const ready = data?.status === 'completed';
  useDbStatusStore.getState().setDbReady(ready);
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
