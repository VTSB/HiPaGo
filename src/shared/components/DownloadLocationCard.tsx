'use client';

/**
 * Settings card: Download location (Android only).
 *
 * Lets the user pick the download folder via the system Storage Access
 * Framework picker (ACTION_OPEN_DOCUMENT_TREE). The app creates a HiPaGo
 * subfolder (+ .nomedia) inside the chosen tree. No all-files permission.
 *
 * Shows the currently chosen folder name (or "not selected"), a button to
 * pick / change it, and a clear action. When nothing is chosen the first
 * download prompts the picker automatically (download-zip → ensureReady).
 *
 * Visibility: rendered only on Android (isAndroid()); returns null elsewhere.
 */

import { useState, useEffect } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';
import { isAndroid } from '@/lib/utils/platform';
import { PublicLibrary } from '@/lib/plugins/publicLibrary';

export function DownloadLocationCard() {
  const t = useT();
  const treeName = useSettingsStore((s) => s.downloadTreeName);
  const treeUri = useSettingsStore((s) => s.downloadTreeUri);
  const setDownloadTree = useSettingsStore((s) => s.setDownloadTree);
  const [busy, setBusy] = useState(false);

  // Reconcile the settings mirror with the native persisted tree on mount —
  // the grant can be lost (folder deleted, app data cleared) outside the app.
  useEffect(() => {
    let alive = true;
    PublicLibrary.getTree()
      .then((info) => {
        if (!alive) return;
        if (info.valid && info.treeUri) {
          setDownloadTree(info.treeUri, info.displayName ?? null);
        } else {
          setDownloadTree(null, null);
        }
      })
      .catch(() => {
        /* non-Android / plugin missing — ignore */
      });
    return () => {
      alive = false;
    };
  }, [setDownloadTree]);

  if (!isAndroid()) return null;

  const selected = !!treeUri;
  const folderLabel = treeName || t('settings.downloadLocation.notSelected');

  const handlePick = async () => {
    setBusy(true);
    try {
      const { treeUri: uri, displayName } = await PublicLibrary.openDocumentTree();
      setDownloadTree(uri, displayName);
    } catch {
      // User cancelled the picker — leave the current selection untouched.
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      await PublicLibrary.clearTree();
    } catch {
      // Ignore — clear the mirror regardless.
    } finally {
      setDownloadTree(null, null);
      setBusy(false);
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

        {/* Current chosen folder */}
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
          <span className="text-zinc-500 sm:text-xs dark:text-zinc-400">
            {t('settings.downloadLocation.current')}:{' '}
          </span>
          <span className="font-mono font-semibold">{folderLabel}</span>
        </p>

        {/* Pick / change + clear */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handlePick}
            disabled={busy}
            className="min-h-11 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-colors active:bg-zinc-700 disabled:opacity-40 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:font-medium sm:hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:active:bg-zinc-300 sm:dark:hover:bg-zinc-300"
          >
            {selected
              ? t('settings.downloadLocation.change')
              : t('settings.downloadLocation.select')}
          </button>

          {selected && (
            <button
              type="button"
              onClick={handleClear}
              disabled={busy}
              className="min-h-11 rounded-xl border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-600 transition-colors active:bg-zinc-100 disabled:opacity-40 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:font-medium sm:hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
            >
              {t('settings.downloadLocation.clear')}
            </button>
          )}
        </div>

        {!selected && (
          <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-500">
            {t('settings.downloadLocation.hint')}
          </p>
        )}
      </div>
    </div>
  );
}
