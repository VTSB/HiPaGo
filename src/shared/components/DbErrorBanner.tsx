'use client';

import { useState } from 'react';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useT } from '@/lib/i18n/useT';

/**
 * Shown on the history/favorites pages when the local SQLite DB failed to
 * initialize. Those features are local-DB-only, so without this the pages would
 * render as a silent empty state and the failure would be invisible. Renders
 * nothing when the DB is healthy.
 */
export function DbErrorBanner() {
  const dbError = useDbStatusStore((s) => s.dbError);
  const dbInitStage = useDbStatusStore((s) => s.dbInitStage);
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (!dbError) return null;

  const diagnostic = `${dbInitStage ? `[${dbInitStage}] ` : ''}${dbError}`;
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostic);
    } catch {
      window.prompt(t('db.error.copyPrompt'), diagnostic);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      role="alert"
      className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/40"
    >
      <div className="flex items-start gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        <div>
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            {t('db.error.title')}
          </p>
          <p className="mt-0.5 text-sm leading-snug text-amber-700 dark:text-amber-300/90">
            {t('db.error.desc')}
          </p>
          {/* Surface the concrete failure so an on-device hang/crash is
              diagnosable without logcat: the actual exception message and the
              init step it died on. */}
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-amber-100/70 px-2 py-1 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200/90">
            {diagnostic}
          </pre>
          <button
            type="button"
            onClick={handleCopy}
            className="mt-2 inline-flex min-h-9 items-center rounded-md border border-amber-400 bg-amber-100 px-3 text-xs font-medium text-amber-900 active:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-100"
          >
            {copied ? t('db.error.copied') : t('db.error.copy')}
          </button>
        </div>
      </div>
    </div>
  );
}
