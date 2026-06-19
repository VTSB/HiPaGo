'use client';

import { useState } from 'react';
import { useDbStatusStore } from '@/lib/store/db-status';
import { runTagSync } from '@/lib/db/tag-sync';
import { useT } from '@/lib/i18n/useT';

/**
 * Surfaces a tag-DB sync failure on mobile with the concrete reason + a retry.
 *
 * The desktop header has SyncStatusIndicator, but it lives in the md-only nav,
 * so on mobile (especially portrait) a sync failure was invisible — and even on
 * desktop it never showed WHY it failed. This mirrors DbErrorBanner (which shows
 * the SQL/DB-init error): it renders the actual `syncError` message in a copyable
 * block so an on-device failure is diagnosable without logcat. Renders nothing
 * when there is no sync error.
 */
export function SyncErrorBanner() {
  const syncError = useDbStatusStore((s) => s.syncError);
  const isSyncing = useDbStatusStore((s) => s.isSyncing);
  const t = useT();
  const [copied, setCopied] = useState(false);

  // While a (re)sync is running there is nothing to show — the error is stale.
  if (!syncError || isSyncing) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(syncError);
    } catch {
      window.prompt(t('db.error.copyPrompt'), syncError);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      role="alert"
      className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 dark:border-red-900/60 dark:bg-red-950/40"
    >
      <div className="flex items-start gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-red-800 dark:text-red-200">
            {t('sync.failed')}
          </p>
          <p className="mt-0.5 text-sm leading-snug text-red-700 dark:text-red-300/90">
            {t('sync.failed.desc')}
          </p>
          {/* The concrete failure string (network/TLS error, or the empty-sync
              guard message) so an on-device sync failure is diagnosable without
              logcat — same rationale as DbErrorBanner. */}
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-red-100/70 px-2 py-1 text-xs text-red-900 dark:bg-red-900/40 dark:text-red-200/90">
            {syncError}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void runTagSync(); }}
              className="inline-flex min-h-9 items-center rounded-md border border-red-400 bg-red-100 px-3 text-xs font-medium text-red-900 active:bg-red-200 dark:border-red-700 dark:bg-red-900/50 dark:text-red-100"
            >
              {t('sync.retry')}
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex min-h-9 items-center rounded-md border border-red-400 bg-red-100 px-3 text-xs font-medium text-red-900 active:bg-red-200 dark:border-red-700 dark:bg-red-900/50 dark:text-red-100"
            >
              {copied ? t('db.error.copied') : t('db.error.copy')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
