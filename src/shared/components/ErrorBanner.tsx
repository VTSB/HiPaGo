'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n/useT';

export interface ErrorBannerAction {
  label: string;
  onClick: () => void;
}

interface ErrorBannerProps {
  /** Bold heading line. */
  title: string;
  /** Supporting sentence under the title. */
  description: string;
  /** The concrete diagnostic string, shown in a copyable <pre> and copied verbatim. */
  detail: string;
  /** Severity tone. amber = recoverable/info-ish, red = failure. Defaults to red. */
  tone?: 'amber' | 'red';
  /** Optional primary action (e.g. Retry). Rendered before the Copy button when present. */
  action?: ErrorBannerAction;
}

// Full class strings per tone so Tailwind's JIT keeps them (no dynamic concat).
const TONES = {
  amber: {
    wrap: 'border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40',
    icon: 'text-amber-600 dark:text-amber-400',
    title: 'text-amber-800 dark:text-amber-200',
    desc: 'text-amber-700 dark:text-amber-300/90',
    pre: 'bg-amber-100/70 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200/90',
    btn: 'border-amber-400 bg-amber-100 text-amber-900 active:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-100',
  },
  red: {
    wrap: 'border-red-300 bg-red-50 dark:border-red-900/60 dark:bg-red-950/40',
    icon: 'text-red-600 dark:text-red-400',
    title: 'text-red-800 dark:text-red-200',
    desc: 'text-red-700 dark:text-red-300/90',
    pre: 'bg-red-100/70 text-red-900 dark:bg-red-900/40 dark:text-red-200/90',
    btn: 'border-red-400 bg-red-100 text-red-900 active:bg-red-200 dark:border-red-700 dark:bg-red-900/50 dark:text-red-100',
  },
} as const;

/**
 * Shared error-alert surface for on-device failures whose concrete reason must
 * stay visible (no logcat). Used by DbErrorBanner (SQL/DB-init failure) and
 * SyncErrorBanner (tag-DB sync failure). Presentational only — callers read the
 * relevant store slice and pass the strings + optional retry action.
 */
export function ErrorBanner({ title, description, detail, tone = 'red', action }: ErrorBannerProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const c = TONES[tone];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(detail);
    } catch {
      window.prompt(t('db.error.copyPrompt'), detail);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div role="alert" className={`mb-4 rounded-xl border px-4 py-3 ${c.wrap}`}>
      <div className="flex items-start gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`mt-0.5 h-5 w-5 shrink-0 ${c.icon}`}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${c.title}`}>{title}</p>
          <p className={`mt-0.5 text-sm leading-snug ${c.desc}`}>{description}</p>
          <pre className={`mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md px-2 py-1 text-xs ${c.pre}`}>
            {detail}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            {action && (
              <button
                type="button"
                onClick={action.onClick}
                className={`inline-flex min-h-9 items-center rounded-md border px-3 text-xs font-medium ${c.btn}`}
              >
                {action.label}
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className={`inline-flex min-h-9 items-center rounded-md border px-3 text-xs font-medium ${c.btn}`}
            >
              {copied ? t('db.error.copied') : t('db.error.copy')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
