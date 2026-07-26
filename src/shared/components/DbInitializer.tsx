'use client';

import { useEffect, useRef } from 'react';
import { initializeDatabase } from '@/lib/db/schema';
import { checkDbReady } from '@/lib/db/init';
import { runTagSync } from '@/lib/db/tag-sync';
import { cleanupStaleCache } from '@/lib/db/gallery';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { isAndroid, isIos } from '@/lib/utils/platform';
import { PublicLibrary } from '@/lib/plugins/publicLibrary';

/**
 * Invisible component that initializes the SQLite database on mount,
 * checks DB readiness, and triggers background tag sync if needed.
 * If no SQLite platform is available (plain browser), falls back to remote API.
 * Also triggers background re-sync when tags are stale (> 7 days old).
 */
export function DbInitializer() {
  const ran = useRef(false);
  const tagsStale = useDbStatusStore((s) => s.tagsStale);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    initializeDatabase()
      .then(async () => {
        // Restore before migration/reconciliation so startup defaults cannot
        // replace a catalog left in the public download tree after reinstall.
        if (isAndroid()) {
          await import('@/lib/storage/public-backup')
            .then(async (backup) => {
              await backup.restorePublicBackup();
            })
            .catch((e) => console.warn('[backup] public backup restore failed:', e));
        }
        // Android-only: run one-time Data→public migration + reconciliation
        // after DB is ready. Best-effort — never propagates errors into boot.
        if (isAndroid()) {
          // The persisted native URI grant survives WebView/localStorage loss.
          // Restore its mirror before migration and queue reconciliation.
          await PublicLibrary.getTree()
            .then((info) => {
              useSettingsStore
                .getState()
                .setDownloadTree(
                  info.valid && info.treeUri ? info.treeUri : null,
                  info.valid ? (info.displayName ?? null) : null,
                );
            })
            .catch((e) => console.warn('[download] tree restore failed:', e));
          await import('@/lib/storage/migrate-downloads')
            .then(async ({ migrateDownloadsToPublic, restoreDownloadsFromPublicFolder }) => {
              await migrateDownloadsToPublic();
              const restored = await restoreDownloadsFromPublicFolder();
              if (restored.imported > 0) {
                const { notifyDownloadLibraryChanged } =
                  await import('@/lib/store/download-progress');
                notifyDownloadLibraryChanged(true);
              }
            })
            .catch((e) => console.warn('[migrate] Data→public migration failed:', e));
        }
        // Download-queue reconciliation: re-enqueue zombie 'downloading' rows
        // and kick the processor when unmetered. Chained AFTER the migration so
        // it never races the library reconcile. Best-effort — never throws.
        await import('@/lib/store/reconcile-queue')
          .then(({ reconcileQueue }) => reconcileQueue())
          .catch((e) => console.warn('[queue] reconcile failed:', e));
        // Enable writes only after every startup restore and migration has
        // completed, preventing an empty fresh install from winning the race.
        if (isAndroid()) {
          await import('@/lib/storage/public-backup')
            .then(({ startPublicBackupSync }) => startPublicBackupSync())
            .catch((e) => console.warn('[backup] public backup sync failed to start:', e));
        }
        return checkDbReady();
      })
      .then((ready) => {
        // Init succeeded — clear any prior error so the history/favorites
        // pages stop showing the failure banner.
        useDbStatusStore.getState().setDbError(null);
        cleanupStaleCache().catch((e) => console.warn('[db] Cache cleanup failed:', e));
        if (!ready) {
          runTagSync();
        }
      })
      .catch((err) => {
        // Surface the failure instead of swallowing it: history/favorites are
        // local-DB-only, so a silent init failure leaves them mysteriously
        // empty. The pages read dbError to show an actionable message.
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[db] Database initialization failed:', message);
        useDbStatusStore.getState().setDbError(message);
      });
  }, []);

  useEffect(() => {
    if (!isAndroid() && !isIos()) return;

    let disposed = false;
    let inFlight = false;

    const reconcileNativeCompletion = async () => {
      if (disposed || inFlight) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        await initializeDatabase();
        await import('@/lib/store/reconcile-queue').then(({ reconcileNativeBackgroundDownloads }) =>
          reconcileNativeBackgroundDownloads(),
        );
      } catch (e) {
        console.warn('[queue] foreground native reconcile failed:', e);
      } finally {
        inFlight = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void reconcileNativeCompletion();
      }
    };
    const onFocus = () => {
      void reconcileNativeCompletion();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Reactively load i18n translations whenever locale changes.
  // This avoids the race between initLocaleOnce (hydration) and the old
  // one-shot read that could see 'en' before hydration finished.
  useEffect(() => {
    let prevLocale: string | null = null;
    const loadForLocale = (locale: string) => {
      if (locale === prevLocale) return;
      prevLocale = locale;
      useTagI18nStore
        .getState()
        .loadLocale(locale)
        .catch((e) => console.warn('[i18n] Failed to load locale:', e));
    };
    // Fire immediately with current value
    loadForLocale(useSettingsStore.getState().locale);
    // Subscribe to future changes
    return useSettingsStore.subscribe((state) => {
      loadForLocale(state.locale);
    });
  }, []);

  // Background re-sync when tags are stale
  useEffect(() => {
    if (tagsStale) {
      runTagSync();
    }
  }, [tagsStale]);

  return null;
}
