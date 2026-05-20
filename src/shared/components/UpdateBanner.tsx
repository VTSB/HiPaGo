'use client';

/**
 * Top-of-app banner that surfaces new releases.
 *
 * - Calls UpdateService.checkForUpdate() once on mount.
 * - Renders nothing when no update is available, the platform has no
 *   auto-update path (plain web), or the user dismissed this version
 *   for the current session.
 * - When the platform supports in-place install (Tauri / Android), the
 *   primary action triggers `applyFn` with a progress callback (Tauri
 *   side) so the banner can render a thin progress bar while the
 *   bundle downloads.
 * - When the platform can only deep-link (iOS), the primary action
 *   opens the GitHub Release page in the system browser.
 */
import { useEffect, useState } from 'react';
import { UpdateService, type CheckResult } from '@/services/UpdateService';
import { useT } from '@/lib/i18n/useT';

const DISMISS_KEY = 'hipago-update-banner-dismissed-version';

export function UpdateBanner() {
  const t = useT();
  const [result, setResult] = useState<CheckResult | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    UpdateService.checkForUpdate().then((r) => {
      if (cancelled) return;
      if (r.available && r.version) {
        const last = sessionStorage.getItem(DISMISS_KEY);
        if (last === r.version) setDismissed(true);
      }
      setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!result || !result.available || dismissed) return null;

  const onApply = async () => {
    if (result.applyFn) {
      setInstalling(true);
      setProgress(0);
      try {
        await result.applyFn((percent) => setProgress(percent));
      } catch (err) {
        console.warn('[UpdateBanner] apply failed', err);
        setInstalling(false);
        setProgress(null);
      }
      // On Tauri/Android success the app is replaced/restarted by the OS;
      // we don't clear installing because the page is about to go away.
    } else if (result.releaseUrl) {
      window.open(result.releaseUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const onDismiss = () => {
    if (result.version) sessionStorage.setItem(DISMISS_KEY, result.version);
    setDismissed(true);
  };

  const canInstall = Boolean(result.applyFn);
  const primaryLabel = installing
    ? progress !== null && progress > 0
      ? `${t('update.banner.downloading')} ${Math.round(progress)}%`
      : t('update.banner.installing')
    : canInstall
      ? t('update.banner.install')
      : t('update.banner.viewOnGitHub');

  const noteLine = result.notes?.split('\n').find((line) => line.trim().length > 0)?.trim();

  return (
    <div
      role="region"
      aria-label={t('update.banner.title')}
      className="sticky top-0 z-[60] border-b border-zinc-800 bg-zinc-900/95 text-zinc-100 shadow-sm backdrop-blur-sm dark:border-zinc-200 dark:bg-zinc-100/95 dark:text-zinc-900"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
        {/* Download / update icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5 shrink-0 text-blue-400 dark:text-blue-600"
          aria-hidden="true"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {t('update.banner.title')}
            {result.version ? <span className="ml-1.5 font-mono text-zinc-300 dark:text-zinc-600">v{result.version}</span> : null}
          </p>
          {noteLine && (
            <p className="truncate text-xs text-zinc-400 dark:text-zinc-500">{noteLine}</p>
          )}
        </div>

        <button
          type="button"
          onClick={onApply}
          disabled={installing}
          className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 shadow-sm transition-colors hover:bg-white disabled:cursor-wait disabled:opacity-70 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-black"
        >
          {primaryLabel}
        </button>

        <button
          type="button"
          onClick={onDismiss}
          disabled={installing}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40 dark:border-zinc-300 dark:text-zinc-600 dark:hover:bg-zinc-200"
        >
          {t('update.banner.later')}
        </button>
      </div>

      {/* Thin progress bar (Tauri provides %; Android stays at 0) */}
      {installing && (
        <div className="h-0.5 w-full bg-zinc-800 dark:bg-zinc-200">
          <div
            className="h-full bg-blue-500 transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(2, progress ?? 0)}%` }}
          />
        </div>
      )}
    </div>
  );
}
