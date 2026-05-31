'use client';

/**
 * Top-of-app banner that surfaces new releases.
 *
 * - Calls UpdateService.checkForUpdate() once on mount.
 * - Renders nothing when no update is available, the platform has no
 *   auto-update path (plain web), or the user dismissed this version
 *   for the current session.
 * - When the platform supports in-place install (Tauri / Android), the
 *   primary action triggers `applyFn` with a progress callback (both Tauri
 *   and Android report download %) so the banner can render a thin progress
 *   bar while the bundle downloads.
 * - When the platform can only deep-link (iOS), the primary action
 *   opens the GitHub Release page in the system browser.
 */
import { useEffect, useState } from 'react';
import { UpdateService, type CheckResult } from '@/services/UpdateService';
import { useT } from '@/lib/i18n/useT';

const DISMISS_KEY = 'hipago-update-banner-dismissed-version';
type ApplyNotice = 'permissionRequired' | 'installerStarted' | 'failed' | null;

function firstMeaningfulLine(notes?: string): string | undefined {
  const line = notes?.split('\n').find((entry) => {
    const value = entry.trim().toLowerCase();
    return value.length > 0 && value !== 'null';
  });
  return line?.trim();
}

export function UpdateBanner() {
  const t = useT();
  const [result, setResult] = useState<CheckResult | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [notice, setNotice] = useState<ApplyNotice>(null);

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
      setNotice(null);
      try {
        const applyResult = await result.applyFn((percent) => setProgress(percent));
        if (applyResult.status === 'permission_required') {
          setNotice('permissionRequired');
        } else if (applyResult.status === 'installer_started') {
          setNotice('installerStarted');
        }
      } catch (err) {
        console.warn('[UpdateBanner] apply failed', err);
        setNotice('failed');
      } finally {
        setInstalling(false);
        setProgress(null);
      }
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

  const noticeLine =
    notice === 'permissionRequired'
      ? t('update.banner.permissionRequired')
      : notice === 'installerStarted'
        ? t('update.banner.installerStarted')
        : notice === 'failed'
          ? t('update.banner.installFailed')
          : undefined;
  const noteLine = noticeLine ?? firstMeaningfulLine(result.notes);

  return (
    <div
      role="region"
      aria-label={t('update.banner.title')}
      className="sticky top-0 z-[60] border-b border-zinc-200 bg-white/95 text-zinc-900 shadow-sm backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/95 dark:text-zinc-100"
    >
      <div className="mx-auto flex min-h-14 max-w-7xl items-center gap-3 px-4 py-2">
        {/* Download / update icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400"
          aria-hidden="true"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {t('update.banner.title')}
            {result.version ? (
              <span className="ml-1.5 font-mono text-zinc-500 dark:text-zinc-400">
                v{result.version}
              </span>
            ) : null}
          </p>
          {noteLine && (
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{noteLine}</p>
          )}
        </div>

        <button
          type="button"
          onClick={onApply}
          disabled={installing}
          className="min-h-10 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors active:bg-zinc-800 disabled:cursor-wait disabled:opacity-70 md:min-h-0 md:rounded-md md:px-3 md:py-1.5 md:font-medium md:hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:active:bg-zinc-200 md:dark:hover:bg-zinc-200"
        >
          {primaryLabel}
        </button>

        <button
          type="button"
          onClick={onDismiss}
          disabled={installing}
          className="min-h-10 rounded-xl border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-600 transition-colors active:bg-zinc-100 disabled:opacity-40 md:min-h-0 md:rounded-md md:px-3 md:py-1.5 md:font-medium md:hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:active:bg-zinc-800 md:dark:hover:bg-zinc-800"
        >
          {t('update.banner.later')}
        </button>
      </div>

      {/* Thin progress bar (Tauri and Android both report download %) */}
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
