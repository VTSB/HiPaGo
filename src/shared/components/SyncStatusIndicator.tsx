'use client';

import { useDbStatusStore } from '@/lib/store/db-status';
import { runTagSync } from '@/lib/db/tag-sync';
import { useT } from '@/lib/i18n/useT';

/**
 * Header indicator for the tag-DB sync lifecycle.
 *
 * - failed   → `syncError` set: shows the failure with a retry button.
 * - syncing  → `isSyncing`: shows progress percent + the current step detail.
 * - ready / idle → renders nothing (the quiet state).
 *
 * A small subscribed component — it only re-renders on the db-status slices it
 * reads, never the whole Header.
 */
export function SyncStatusIndicator() {
  const isSyncing = useDbStatusStore((s) => s.isSyncing);
  const syncProgress = useDbStatusStore((s) => s.syncProgress);
  const syncDetail = useDbStatusStore((s) => s.syncDetail);
  const syncError = useDbStatusStore((s) => s.syncError);
  const t = useT();

  // Failure takes precedence — a stale error must stay visible until a retry.
  if (syncError) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-400"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
        <span>{t('sync.failed')}</span>
        <button
          type="button"
          onClick={() => { void runTagSync(); }}
          className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700 hover:bg-red-200 dark:bg-red-900/60 dark:text-red-300 dark:hover:bg-red-900"
        >
          {t('sync.retry')}
        </button>
      </div>
    );
  }

  if (isSyncing) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
        <span>
          {t('sync.syncing')} {syncProgress}%
        </span>
        {syncDetail && <span className="text-zinc-400 dark:text-zinc-500">{syncDetail}</span>}
      </div>
    );
  }

  // Ready / idle — quiet state.
  return null;
}
