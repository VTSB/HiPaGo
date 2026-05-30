'use client';

import { useState } from 'react';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useT } from '@/lib/i18n/useT';

/**
 * App-wide local-DB failure surface. The inline {@link DbErrorBanner} renders
 * only on the favorites/history pages, so a SQLite init failure was invisible on
 * every other screen — the user just saw content "disappear". This fixed overlay
 * shows the exact failing init stage + native error message on ANY route, with a
 * one-tap Copy so the cause can be reported from a device with no logcat access.
 * Renders nothing when the DB is healthy. Dismissible for the session.
 */
export function DbErrorOverlay() {
  const dbError = useDbStatusStore((s) => s.dbError);
  const dbInitStage = useDbStatusStore((s) => s.dbInitStage);
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!dbError || dismissed) return null;

  const diagnostic = `${dbInitStage ? `[${dbInitStage}] ` : ''}${dbError}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostic);
    } catch {
      // Webview / insecure context without the async clipboard API: fall back to
      // a manual-copy prompt so the message is still capturable on device.
      window.prompt(t('db.error.copyPrompt'), diagnostic);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-0 z-[100] border-t border-amber-300 bg-amber-50 px-4 py-3 shadow-lg dark:border-amber-900/60 dark:bg-amber-950"
    >
      <div className="mx-auto flex max-w-3xl items-start gap-2">
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
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            {t('db.error.title')}
          </p>
          {/* The exact failing init step + native exception, verbatim. */}
          <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-amber-100/70 px-2 py-1 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200/90">
            {diagnostic}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex min-h-9 items-center rounded-md border border-amber-400 bg-amber-100 px-3 text-xs font-medium text-amber-900 active:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-100"
            >
              {copied ? t('db.error.copied') : t('db.error.copy')}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label={t('db.error.dismiss')}
          className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-amber-600 active:bg-amber-100 dark:text-amber-400 dark:active:bg-amber-900/50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
