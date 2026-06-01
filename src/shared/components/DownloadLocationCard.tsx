'use client';

/**
 * Settings card: Download location (Android only).
 *
 * Shows the current effective base folder (downloadBasePath ?? "Downloads/HiPaGo"),
 * lets the user override it with a text input, and provides a "Reset to default"
 * action that sets downloadBasePath back to null.
 *
 * When the path changes, migrateDownloadsToPublic() is called best-effort so
 * existing gallery files follow the new base.
 *
 * Visibility: rendered only on Android (isAndroid()). The settings page renders
 * it unconditionally; this component returns null on non-Android platforms.
 *
 * AC-008: Settings download-folder card.
 */

import { useState, useEffect } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';
import { isAndroid } from '@/lib/utils/platform';
import { StoragePermission } from '@/lib/plugins/storagePermission';

// migrate-downloads.ts is implemented by AC-007. Import best-effort: if the
// module does not exist yet (parallel AC not landed), the card still renders
// and path changes are persisted — migration just becomes a no-op.
let _migrate: (() => Promise<void>) | null = null;
try {
  // Dynamic require so missing module does not break the card at import time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@/lib/storage/migrate-downloads') as { migrateDownloadsToPublic?: () => Promise<void> };
  _migrate = mod.migrateDownloadsToPublic ?? null;
} catch {
  // AC-007 not yet landed — migration is a no-op.
  _migrate = null;
}

async function runMigration(): Promise<void> {
  if (_migrate) {
    await _migrate();
  }
}

const DEFAULT_DISPLAY = 'Downloads/HiPaGo';

export function DownloadLocationCard() {
  const t = useT();
  const downloadBasePath = useSettingsStore((s) => s.downloadBasePath);
  const setDownloadBasePath = useSettingsStore((s) => s.setDownloadBasePath);

  // Input mirrors the stored path; empty string means "use default".
  const [pathInput, setPathInput] = useState(downloadBasePath ?? '');
  const [moving, setMoving] = useState(false);
  const [permGranted, setPermGranted] = useState<boolean | null>(null);

  // Sync input when store changes externally (e.g. reset from another surface).
  const [prevStored, setPrevStored] = useState(downloadBasePath);
  if (downloadBasePath !== prevStored) {
    setPrevStored(downloadBasePath);
    setPathInput(downloadBasePath ?? '');
  }

  // Check permission on mount (Android only).
  useEffect(() => {
    let alive = true;
    StoragePermission.isGranted()
      .then(({ granted }) => { if (alive) setPermGranted(granted); })
      .catch(() => { if (alive) setPermGranted(false); });
    return () => { alive = false; };
  }, []);

  // Not Android — render nothing.
  if (!isAndroid()) return null;

  const effectiveDisplay = downloadBasePath
    ? `${downloadBasePath}/HiPaGo`
    : DEFAULT_DISPLAY;

  const handleApply = async () => {
    const trimmed = pathInput.trim();
    const newPath = trimmed === '' ? null : trimmed;
    setDownloadBasePath(newPath);
    setMoving(true);
    try {
      await runMigration();
    } catch {
      // Best-effort — ignore errors.
    } finally {
      setMoving(false);
    }
  };

  const handleReset = async () => {
    setPathInput('');
    setDownloadBasePath(null);
    setMoving(true);
    try {
      await runMigration();
    } catch {
      // Best-effort — ignore errors.
    } finally {
      setMoving(false);
    }
  };

  const handleGrantPermission = async () => {
    await StoragePermission.request();
    // Re-check after user returns from the system settings screen.
    try {
      const { granted } = await StoragePermission.isGranted();
      setPermGranted(granted);
    } catch {
      // Ignore.
    }
  };

  return (
    <div className="mt-5 border-y border-zinc-200 bg-white sm:mt-6 sm:rounded-xl sm:border dark:border-zinc-800 dark:bg-zinc-900">
      <div className="px-4 py-5 sm:px-5 sm:py-4">
        <p className="text-base font-semibold text-zinc-900 sm:text-sm sm:font-medium dark:text-zinc-100">
          {t('settings.downloadLocation')}
        </p>
        <p className="mb-4 mt-0.5 text-sm leading-snug text-zinc-500 sm:mb-3 sm:text-xs dark:text-zinc-400">
          {t('settings.downloadLocation.desc')}
        </p>

        {/* Current effective folder display */}
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
          <span className="text-zinc-500 sm:text-xs dark:text-zinc-400">
            {t('settings.downloadLocation.current')}:{' '}
          </span>
          <span className="font-mono font-semibold">{effectiveDisplay}</span>
          {moving && (
            <span className="ml-2 text-xs text-zinc-400 dark:text-zinc-500">
              {t('settings.downloadLocation.moving')}
            </span>
          )}
        </p>

        {/* Path input + action buttons */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <label className="flex-1">
            <span className="mb-1 block text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
              {t('settings.downloadLocation.pathLabel')}
            </span>
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder={t('settings.downloadLocation.pathPlaceholder')}
              className="h-12 w-full rounded-xl border border-zinc-300 bg-white px-4 text-base text-zinc-900 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 sm:h-10 sm:rounded-md sm:px-3 sm:text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </label>

          <button
            type="button"
            onClick={handleApply}
            disabled={moving}
            className="min-h-11 rounded-xl border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-600 transition-colors active:bg-zinc-100 disabled:opacity-40 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:font-medium sm:hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
          >
            Apply
          </button>

          <button
            type="button"
            onClick={handleReset}
            disabled={moving || downloadBasePath === null}
            className="min-h-11 rounded-xl border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-600 transition-colors active:bg-zinc-100 disabled:opacity-40 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:font-medium sm:hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
          >
            {t('settings.downloadLocation.resetDefault')}
          </button>
        </div>

        {/* Storage permission affordance — shown when permission is not granted */}
        {permGranted === false && (
          <div className="mt-4 flex items-center gap-3 sm:mt-3">
            <button
              type="button"
              onClick={handleGrantPermission}
              className="min-h-11 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors active:bg-zinc-700 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:font-medium sm:hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:active:bg-zinc-300 sm:dark:hover:bg-zinc-300"
            >
              {t('settings.downloadLocation.grantPermission')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
