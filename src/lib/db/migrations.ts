/**
 * Database migration runner for HiPaGo V4.
 * Uses PRAGMA user_version to track applied migrations.
 */
import type { DbAdapter } from './adapter';

export interface Migration {
  version: number;
  description: string;
  up: (adapter: DbAdapter) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Add language and mediaType columns to gallery',
    up: async (adapter) => {
      const cols = await adapter.query<{ name: string }>('PRAGMA table_info(gallery)');
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has('language')) {
        await adapter.exec("ALTER TABLE gallery ADD COLUMN language TEXT NOT NULL DEFAULT ''");
      }
      if (!colNames.has('mediaType')) {
        await adapter.exec("ALTER TABLE gallery ADD COLUMN mediaType TEXT NOT NULL DEFAULT ''");
      }
    },
  },
  {
    version: 2,
    description: 'Drop tag_i18n table and index (Korean localization moved to in-memory store)',
    up: async (adapter) => {
      await adapter.exec('DROP INDEX IF EXISTS idx_tag_i18n_local');
      await adapter.exec('DROP TABLE IF EXISTS tag_i18n');
    },
  },
  {
    version: 3,
    description: 'Add download table for offline library index',
    up: async (adapter) => {
      await adapter.exec(`
        CREATE TABLE IF NOT EXISTS download (
          galleryId INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          thumbnail TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '{}',
          pageCount INTEGER NOT NULL DEFAULT 0,
          totalBytes INTEGER NOT NULL DEFAULT 0,
          downloadedAt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'downloading'
        )
      `);
      await adapter.exec(
        'CREATE INDEX IF NOT EXISTS idx_download_downloadedAt ON download(downloadedAt)',
      );
      await adapter.exec(
        'CREATE INDEX IF NOT EXISTS idx_download_status ON download(status)',
      );
    },
  },
  {
    version: 4,
    description: 'Add folderName + migratedAt to download',
    up: async (adapter) => {
      const cols = await adapter.query<{ name: string }>('PRAGMA table_info(download)');
      // download table is created by migration v3; if it is somehow absent
      // (PRAGMA returns no rows), there is nothing to alter — skip rather than
      // fail with "no such table".
      if (cols.length === 0) return;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has('folderName')) {
        await adapter.exec('ALTER TABLE download ADD COLUMN folderName TEXT');
      }
      if (!colNames.has('migratedAt')) {
        await adapter.exec('ALTER TABLE download ADD COLUMN migratedAt TEXT');
      }
    },
  },
];

// Validate that migrations are sequential at module load time
for (let i = 0; i < MIGRATIONS.length; i++) {
  if (MIGRATIONS[i].version !== i + 1) {
    throw new Error(
      `MIGRATIONS version sequence broken at index ${i}: expected ${i + 1}, got ${MIGRATIONS[i].version}`,
    );
  }
}

/** The latest schema version (highest migration version). */
export const LATEST_VERSION: number =
  MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;

/**
 * Run all pending migrations against the given adapter.
 * Uses PRAGMA user_version to determine the current schema version.
 * Each migration runs inside a transaction; on failure it rolls back and re-throws.
 */
export async function runMigrations(adapter: DbAdapter): Promise<void> {
  const rows = await adapter.query<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = rows[0]?.user_version ?? 0;

  const dynamicLatest = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
  if (currentVersion >= dynamicLatest) return;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
  for (const migration of pending) {
    await adapter.exec('BEGIN');
    try {
      await migration.up(adapter);
      await adapter.exec(`PRAGMA user_version = ${migration.version}`);
      await adapter.exec('COMMIT');
    } catch (e) {
      await adapter.exec('ROLLBACK');
      throw e;
    }
  }
}
