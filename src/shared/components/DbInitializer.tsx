'use client';

import { useEffect, useRef } from 'react';
import { initializeDatabase } from '@/lib/db/schema';
import { checkDbReady } from '@/lib/db/init';
import { runTagSync } from '@/lib/db/tag-sync';

/**
 * Invisible component that initializes the SQLite database on mount,
 * checks DB readiness, and triggers background tag sync if needed.
 * If no SQLite platform is available (plain browser), falls back to remote API.
 */
export function DbInitializer() {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    initializeDatabase()
      .then(() => checkDbReady())
      .then((ready) => {
        if (!ready) {
          runTagSync();
        }
      })
      .catch((err) => {
        console.warn('[db] Database initialization skipped:', err.message);
        // dbReady stays false — app uses remote API
      });
  }, []);

  return null;
}
