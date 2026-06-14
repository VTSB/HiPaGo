'use client';

import { useEffect, useRef } from 'react';
import { initializeDatabase } from '@/lib/db/schema';
import { checkDbReady } from '@/lib/db/init';
import { runTagSync } from '@/lib/db/tag-sync';
import { cleanupStaleCache } from '@/lib/db/gallery';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { isAndroid } from '@/lib/utils/platform';

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
        // Android-only: run one-time Data→public migration + reconciliation
        // after DB is ready. Best-effort — never propagates errors into boot.
        if (isAndroid()) {
          await import('@/lib/storage/migrate-downloads')
            .then(({ migrateDownloadsToPublic }) => migrateDownloadsToPublic())
            .catch((e) => console.warn('[migrate] Data→public migration failed:', e));
        }
        // Download-queue reconciliation: re-enqueue zombie 'downloading' rows
        // and kick the processor when unmetered. Chained AFTER the migration so
        // it never races the library reconcile. Best-effort — never throws.
        await import('@/lib/store/reconcile-queue')
          .then(({ reconcileQueue }) => reconcileQueue())
          .catch((e) => console.warn('[queue] reconcile failed:', e));
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

  // Reactively load i18n translations whenever locale changes.
  // This avoids the race between initLocaleOnce (hydration) and the old
  // one-shot read that could see 'en' before hydration finished.
  useEffect(() => {
    let prevLocale: string | null = null;
    const loadForLocale = (locale: string) => {
      if (locale === prevLocale) return;
      prevLocale = locale;
      useTagI18nStore.getState().loadLocale(locale).catch((e) =>
        console.warn('[i18n] Failed to load locale:', e)
      );
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
