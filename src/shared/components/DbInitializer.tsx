'use client';

import { useEffect, useRef } from 'react';
import { initializeDatabase } from '@/lib/db/schema';
import { checkDbReady } from '@/lib/db/init';
import { runTagSync } from '@/lib/db/tag-sync';
import { cleanupStaleCache } from '@/lib/db/gallery';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useTagI18nStore } from '@/lib/store/tag-i18n';
import { useSettingsStore } from '@/lib/store/settings';

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
      .then(() => checkDbReady())
      .then((ready) => {
        cleanupStaleCache().catch((e) => console.warn('[db] Cache cleanup failed:', e));
        // Always load i18n translations (even if DB is already ready)
        const locale = useSettingsStore.getState().locale;
        useTagI18nStore.getState().loadLocale(locale).catch((e) =>
          console.warn('[i18n] Failed to load locale:', e)
        );
        if (!ready) {
          runTagSync();
        }
      })
      .catch((err) => {
        console.warn('[db] Database initialization skipped:', err.message);
        // dbReady stays false — app uses remote API
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
