'use client';

/**
 * Settings-page card: shows current version and a manual "Check for
 * updates" button. Inline result rendered below the button.
 *
 * Independent of the top-of-app UpdateBanner — calling Check here does
 * not affect the banner's session-dismissal state.
 */
import { useState } from 'react';
import { UpdateService, CURRENT_VERSION, type CheckResult } from '@/services/UpdateService';
import { useT } from '@/lib/i18n/useT';

type CheckStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'available'; result: CheckResult }
  | { kind: 'installing'; percent: number }
  | { kind: 'failed' };

export function UpdateCheckCard() {
  const t = useT();
  const [status, setStatus] = useState<CheckStatus>({ kind: 'idle' });

  const onCheck = async () => {
    setStatus({ kind: 'checking' });
    try {
      const result = await UpdateService.checkForUpdate();
      if (!result.available) {
        setStatus({ kind: 'upToDate' });
      } else {
        setStatus({ kind: 'available', result });
      }
    } catch {
      setStatus({ kind: 'failed' });
    }
  };

  const onInstall = async () => {
    if (status.kind !== 'available') return;
    const { result } = status;
    if (result.applyFn) {
      setStatus({ kind: 'installing', percent: 0 });
      try {
        await result.applyFn((percent) => {
          setStatus({ kind: 'installing', percent });
        });
      } catch {
        setStatus({ kind: 'failed' });
      }
    } else if (result.releaseUrl) {
      window.open(result.releaseUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="mt-6 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="px-5 py-4">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t('update.about')}</p>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">{t('update.about.desc')}</p>

        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('update.about.currentVersion')}</p>
            <p className="font-mono text-sm font-medium text-zinc-900 dark:text-zinc-100">v{CURRENT_VERSION}</p>
          </div>
          <button
            type="button"
            onClick={onCheck}
            disabled={status.kind === 'checking' || status.kind === 'installing'}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-70 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {status.kind === 'checking' ? t('update.about.checking') : t('update.about.check')}
          </button>
        </div>

        {/* Inline status row */}
        {status.kind === 'upToDate' && (
          <div className="mt-4 flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            {t('update.about.upToDate')}
          </div>
        )}

        {status.kind === 'available' && (
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-3 dark:border-blue-900/60 dark:bg-blue-950/40">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-blue-800 dark:text-blue-200">
                <span className="font-mono font-medium">v{status.result.version}</span>{' '}
                {t('update.about.newAvailable')}
              </p>
              <button
                type="button"
                onClick={onInstall}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
              >
                {status.result.applyFn ? t('update.banner.install') : t('update.banner.viewOnGitHub')}
              </button>
            </div>
            {status.result.notes && (
              <p className="mt-2 text-xs text-blue-700/80 dark:text-blue-300/80">
                {status.result.notes.split('\n').find((l) => l.trim().length > 0)?.trim()}
              </p>
            )}
          </div>
        )}

        {status.kind === 'installing' && (
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-3 dark:border-blue-900/60 dark:bg-blue-950/40">
            <p className="text-sm text-blue-800 dark:text-blue-200">
              {status.percent > 0
                ? `${t('update.banner.downloading')} ${Math.round(status.percent)}%`
                : t('update.banner.installing')}
            </p>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-blue-200 dark:bg-blue-900">
              <div
                className="h-full bg-blue-600 transition-[width] duration-200 ease-out"
                style={{ width: `${Math.max(2, status.percent)}%` }}
              />
            </div>
          </div>
        )}

        {status.kind === 'failed' && (
          <div className="mt-4 flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 shrink-0">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            {t('update.about.checkFailed')}
          </div>
        )}
      </div>
    </div>
  );
}
