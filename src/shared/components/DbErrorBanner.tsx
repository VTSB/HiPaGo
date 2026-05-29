'use client';

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
  const t = useT();
  if (!dbError) return null;

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
        </div>
      </div>
    </div>
  );
}
