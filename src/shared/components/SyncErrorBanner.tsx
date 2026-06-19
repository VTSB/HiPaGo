'use client';

import { useDbStatusStore } from '@/lib/store/db-status';
import { runTagSync } from '@/lib/db/tag-sync';
import { useT } from '@/lib/i18n/useT';
import { ErrorBanner } from '@/shared/components/ErrorBanner';

/**
 * Surfaces a tag-DB sync failure on mobile with the concrete reason + a retry.
 *
 * The desktop header has SyncStatusIndicator, but it lives in the md-only nav,
 * so on mobile (especially portrait) a sync failure was invisible — and even on
 * desktop it never showed WHY it failed. Renders the shared ErrorBanner with the
 * actual `syncError` message so an on-device failure is diagnosable without
 * logcat. Renders nothing when there is no error (or while a (re)sync runs).
 */
export function SyncErrorBanner() {
  const syncError = useDbStatusStore((s) => s.syncError);
  const isSyncing = useDbStatusStore((s) => s.isSyncing);
  const t = useT();

  // While a (re)sync is running there is nothing to show — the error is stale.
  if (!syncError || isSyncing) return null;

  return (
    <ErrorBanner
      tone="red"
      title={t('sync.failed')}
      description={t('sync.failed.desc')}
      detail={syncError}
      action={{ label: t('sync.retry'), onClick: () => { void runTagSync(); } }}
    />
  );
}
