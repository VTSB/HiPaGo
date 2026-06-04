/**
 * Tests for PRAGMA user_version behavior through the sql.js (WebAdapter-style) adapter.
 *
 * These tests verify that PRAGMA user_version read/write works correctly through
 * the adapter's query() and exec() paths — critical for the migration runner.
 *
 * Note: TauriAdapter and CapacitorAdapter split SQL on semicolons in exec() and
 * route through execute(). The SQL semantics verified here apply to all adapters
 * since they all use SQLite under the hood.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { DbAdapter, QueryResult } from '../adapter';
import { runMigrations, LATEST_VERSION } from '../migrations';

// ---------------------------------------------------------------------------
// Minimal in-memory adapter — mirrors test-db.ts TestAdapter but standalone
// so these tests don't depend on schema or other test state.
// ---------------------------------------------------------------------------

class PragmaTestAdapter implements DbAdapter {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.db.run(sql, params);
    const changes = this.db.getRowsModified();
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const lastInsertRowId =
      result.length > 0 ? (result[0].values[0][0] as number) : 0;
    return { changes, lastInsertRowId };
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
  }

  async exec(sql: string): Promise<void> {
    this.db.run(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createAdapter(): Promise<PragmaTestAdapter> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  return new PragmaTestAdapter(db);
}

async function getUserVersion(adapter: PragmaTestAdapter): Promise<number> {
  const rows = await adapter.query<{ user_version: number }>(
    'PRAGMA user_version',
  );
  return rows[0].user_version;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PRAGMA user_version', () => {
  let adapter: PragmaTestAdapter;

  beforeEach(async () => {
    adapter = await createAdapter();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('returns 0 for a fresh database', async () => {
    const version = await getUserVersion(adapter);
    expect(version).toBe(0);
  });

  it('write + read roundtrip', async () => {
    await adapter.exec('PRAGMA user_version = 5');
    const version = await getUserVersion(adapter);
    expect(version).toBe(5);
  });

  it('PRAGMA user_version set inside a committed transaction persists', async () => {
    await adapter.exec('BEGIN');
    await adapter.exec('PRAGMA user_version = 3');
    await adapter.exec('COMMIT');

    const version = await getUserVersion(adapter);
    expect(version).toBe(3);
  });

  it('PRAGMA user_version set inside a rolled-back transaction is reverted', async () => {
    await adapter.exec('BEGIN');
    await adapter.exec('PRAGMA user_version = 3');
    await adapter.exec('ROLLBACK');

    const version = await getUserVersion(adapter);
    expect(version).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Old schema DDL (without language/mediaType) — simulates a pre-migration DB
// ---------------------------------------------------------------------------
const OLD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gallery (
  id INTEGER PRIMARY KEY,
  type INTEGER NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  thumbnail TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_status (
  tag TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
`;

describe('runMigrations: pre-migration DB upgrade', () => {
  let adapter: PragmaTestAdapter;

  beforeEach(async () => {
    adapter = await createAdapter();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('sets user_version to LATEST_VERSION after running migrations on a pre-migration DB', async () => {
    // Simulate pre-migration state: old schema without language/mediaType columns
    await adapter.exec(OLD_SCHEMA_SQL);

    // user_version starts at 0
    expect(await getUserVersion(adapter)).toBe(0);

    await runMigrations(adapter);

    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });

  it('adds language and mediaType columns to gallery after migration', async () => {
    await adapter.exec(OLD_SCHEMA_SQL);
    await runMigrations(adapter);

    const cols = await adapter.query<{ name: string }>('PRAGMA table_info(gallery)');
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('language')).toBe(true);
    expect(colNames.has('mediaType')).toBe(true);
  });

  it('is idempotent: running migrations twice does not change user_version', async () => {
    await adapter.exec(OLD_SCHEMA_SQL);
    await runMigrations(adapter);
    await runMigrations(adapter);

    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });

  it('does not alter user_version when columns already exist (fresh schema)', async () => {
    // Fresh schema already has language and mediaType — simulates new install
    const FRESH_SCHEMA = `
      CREATE TABLE IF NOT EXISTS gallery (
        id INTEGER PRIMARY KEY,
        type INTEGER NOT NULL,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        thumbnail TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        mediaType TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL
      );
    `;
    await adapter.exec(FRESH_SCHEMA);
    // user_version is 0 on a fresh install before runMigrations
    expect(await getUserVersion(adapter)).toBe(0);
    await runMigrations(adapter);
    // After running migrations user_version should be at LATEST_VERSION
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Schema with tag_i18n table — simulates pre-v2 DB that has the table
// ---------------------------------------------------------------------------
const SCHEMA_WITH_TAG_I18N = `
CREATE TABLE IF NOT EXISTS tag_i18n (
  tagId INTEGER PRIMARY KEY,
  local TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tag_i18n_local ON tag_i18n(local);
`;

describe('runMigrations: migration v2 drops tag_i18n', () => {
  let adapter: PragmaTestAdapter;

  beforeEach(async () => {
    adapter = await createAdapter();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('migration v2 executes DROP TABLE IF EXISTS tag_i18n without error', async () => {
    await adapter.exec(SCHEMA_WITH_TAG_I18N);
    // Manually set user_version to 1 (migration v1 already applied)
    await adapter.exec('PRAGMA user_version = 1');

    // Should run migration v2 without throwing
    await expect(runMigrations(adapter)).resolves.toBeUndefined();
  });

  it('migration v2 executes DROP INDEX IF EXISTS idx_tag_i18n_local without error', async () => {
    await adapter.exec(SCHEMA_WITH_TAG_I18N);
    await adapter.exec('PRAGMA user_version = 1');

    await runMigrations(adapter);

    // Index should no longer exist: querying sqlite_master for it returns nothing
    const indexes = await adapter.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tag_i18n_local'",
    );
    expect(indexes).toHaveLength(0);
  });

  it('after migration v2, tag_i18n table no longer exists', async () => {
    await adapter.exec(SCHEMA_WITH_TAG_I18N);
    await adapter.exec('PRAGMA user_version = 1');

    await runMigrations(adapter);

    const tables = await adapter.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tag_i18n'",
    );
    expect(tables).toHaveLength(0);
  });

  it('sets user_version to LATEST_VERSION after running all pending migrations from v1', async () => {
    await adapter.exec(SCHEMA_WITH_TAG_I18N);
    await adapter.exec('PRAGMA user_version = 1');

    await runMigrations(adapter);

    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });

  it('migration v2 is idempotent: no error if tag_i18n does not exist', async () => {
    // user_version=1, no tag_i18n table present
    await adapter.exec('PRAGMA user_version = 1');

    await expect(runMigrations(adapter)).resolves.toBeUndefined();
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Migration v4: adds folderName + migratedAt to download table
// ---------------------------------------------------------------------------

// Simulate a v3 DB: download table exists but without the new columns
const SCHEMA_V3_DOWNLOAD = `
CREATE TABLE IF NOT EXISTS download (
  galleryId INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  thumbnail TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '{}',
  pageCount INTEGER NOT NULL DEFAULT 0,
  totalBytes INTEGER NOT NULL DEFAULT 0,
  downloadedAt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'downloading'
);
`;

describe('runMigrations: migration v4 adds folderName + migratedAt to download', () => {
  let adapter: PragmaTestAdapter;

  beforeEach(async () => {
    adapter = await createAdapter();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('adds folderName and migratedAt columns when upgrading from v3', async () => {
    await adapter.exec(SCHEMA_V3_DOWNLOAD);
    await adapter.exec('PRAGMA user_version = 3');

    await runMigrations(adapter);

    const cols = await adapter.query<{ name: string }>('PRAGMA table_info(download)');
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('folderName')).toBe(true);
    expect(colNames.has('migratedAt')).toBe(true);
  });

  it('sets user_version to LATEST_VERSION after v4 migration', async () => {
    await adapter.exec(SCHEMA_V3_DOWNLOAD);
    await adapter.exec('PRAGMA user_version = 3');

    await runMigrations(adapter);

    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBe(5);
  });

  it('is idempotent: running v4 migration twice leaves columns present exactly once', async () => {
    await adapter.exec(SCHEMA_V3_DOWNLOAD);
    await adapter.exec('PRAGMA user_version = 3');

    // Run migration once
    await runMigrations(adapter);
    // Run again (should be a no-op due to user_version check)
    await runMigrations(adapter);

    const cols = await adapter.query<{ name: string }>('PRAGMA table_info(download)');
    const colNames = cols.map((c) => c.name);
    // Each column should appear exactly once
    expect(colNames.filter((n) => n === 'folderName')).toHaveLength(1);
    expect(colNames.filter((n) => n === 'migratedAt')).toHaveLength(1);
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });

  it('is idempotent at the SQL level: PRAGMA table_info check prevents duplicate ALTER TABLE', async () => {
    // Simulate a DB that already has the columns (e.g. fresh install from new schema-sql)
    // but user_version was somehow stuck at 3 — the up() function must not error
    await adapter.exec(`
      CREATE TABLE IF NOT EXISTS download (
        galleryId INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        thumbnail TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '{}',
        pageCount INTEGER NOT NULL DEFAULT 0,
        totalBytes INTEGER NOT NULL DEFAULT 0,
        downloadedAt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'downloading',
        folderName TEXT,
        migratedAt TEXT
      )
    `);
    await adapter.exec('PRAGMA user_version = 3');

    // Should not throw even though columns already exist
    await expect(runMigrations(adapter)).resolves.toBeUndefined();

    const cols = await adapter.query<{ name: string }>('PRAGMA table_info(download)');
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('folderName')).toBe(true);
    expect(colNames.has('migratedAt')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migration v5: adds lastError to download table
// ---------------------------------------------------------------------------

// Simulate a v4 DB: download table with folderName + migratedAt but no lastError
const SCHEMA_V4_DOWNLOAD = `
CREATE TABLE IF NOT EXISTS download (
  galleryId INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  thumbnail TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '{}',
  pageCount INTEGER NOT NULL DEFAULT 0,
  totalBytes INTEGER NOT NULL DEFAULT 0,
  downloadedAt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'downloading',
  folderName TEXT,
  migratedAt TEXT
);
`;

describe('runMigrations: migration v5 adds lastError to download', () => {
  let adapter: PragmaTestAdapter;

  beforeEach(async () => {
    adapter = await createAdapter();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('adds lastError column when upgrading from v4', async () => {
    await adapter.exec(SCHEMA_V4_DOWNLOAD);
    await adapter.exec('PRAGMA user_version = 4');

    await runMigrations(adapter);

    const cols = await adapter.query<{ name: string }>('PRAGMA table_info(download)');
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('lastError')).toBe(true);
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });

  it('is idempotent: lastError column appears exactly once after running twice', async () => {
    await adapter.exec(SCHEMA_V4_DOWNLOAD);
    await adapter.exec('PRAGMA user_version = 4');

    await runMigrations(adapter);
    await runMigrations(adapter);

    const cols = await adapter.query<{ name: string }>('PRAGMA table_info(download)');
    const colNames = cols.map((c) => c.name);
    expect(colNames.filter((n) => n === 'lastError')).toHaveLength(1);
  });

  it('does not throw when lastError already exists but user_version is stuck at 4', async () => {
    await adapter.exec(`
      CREATE TABLE IF NOT EXISTS download (
        galleryId INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        thumbnail TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '{}',
        pageCount INTEGER NOT NULL DEFAULT 0,
        totalBytes INTEGER NOT NULL DEFAULT 0,
        downloadedAt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'downloading',
        folderName TEXT,
        migratedAt TEXT,
        lastError TEXT
      )
    `);
    await adapter.exec('PRAGMA user_version = 4');

    await expect(runMigrations(adapter)).resolves.toBeUndefined();
    const cols = await adapter.query<{ name: string }>('PRAGMA table_info(download)');
    expect(new Set(cols.map((c) => c.name)).has('lastError')).toBe(true);
  });

  it('full upgrade from v3 lands both v4 and v5 columns', async () => {
    await adapter.exec(SCHEMA_V3_DOWNLOAD);
    await adapter.exec('PRAGMA user_version = 3');

    await runMigrations(adapter);

    const cols = await adapter.query<{ name: string }>('PRAGMA table_info(download)');
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('folderName')).toBe(true);
    expect(colNames.has('migratedAt')).toBe(true);
    expect(colNames.has('lastError')).toBe(true);
  });
});
