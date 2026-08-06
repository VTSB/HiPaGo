/**
 * Regression test for the DB BOOT path (initializeDatabase order):
 *   1. adapter.exec(SCHEMA_SQL)   ("creating tables")
 *   2. runMigrations(adapter)     ("running migrations")
 *
 * The other migration tests exercise runMigrations() in isolation against
 * hand-written DDL, so they never ran the REAL exported SCHEMA_SQL ahead of the
 * migrations. That gap let a bug ship: SCHEMA_SQL contained
 *   CREATE INDEX idx_download_queue ON download(status, queuePosition)
 * but `queuePosition` is added by migration v6. On an UPGRADE (existing
 * `download` table predating queuePosition), `CREATE TABLE IF NOT EXISTS` is a
 * no-op so the column is absent, and SCHEMA_SQL aborts with
 *   "no such column: queuePosition"
 * BEFORE migrations get a chance to add it — breaking DB init (and the whole
 * app) after an update.
 *
 * These tests import the REAL SCHEMA_SQL and reproduce the boot order against a
 * pre-queuePosition `download` table. They fail against the buggy SCHEMA_SQL and
 * pass once the migration-added index is removed from SCHEMA_SQL (it is created
 * idempotently by migration v6 for both fresh installs and upgrades).
 */
import { describe, it, expect, afterEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { DbAdapter, QueryResult } from '../adapter';
import { SCHEMA_SQL } from '../schema-sql';
import { runMigrations, LATEST_VERSION } from '../migrations';

class InMemoryAdapter implements DbAdapter {
  readonly sqlDb: SqlJsDatabase;
  constructor(db: SqlJsDatabase) {
    this.sqlDb = db;
  }
  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.sqlDb.run(sql, params);
    return { changes: this.sqlDb.getRowsModified(), lastInsertRowId: 0 };
  }
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.sqlDb.prepare(sql);
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    stmt.free();
    return rows;
  }
  async exec(sql: string): Promise<void> {
    this.sqlDb.run(sql);
  }
  async close(): Promise<void> {
    this.sqlDb.close();
  }
}

/**
 * A `download` table as it existed at migration v5 (lastError present, but NO
 * queuePosition / retryCount / nextRetryAt). Mirrors what an upgrading user's
 * on-device DB actually contains.
 */
const LEGACY_DOWNLOAD_TABLE = `
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
);
CREATE INDEX IF NOT EXISTS idx_download_downloadedAt ON download(downloadedAt);
CREATE INDEX IF NOT EXISTS idx_download_status ON download(status);
`;

async function newDb(): Promise<InMemoryAdapter> {
  const SQL = await initSqlJs();
  return new InMemoryAdapter(new SQL.Database());
}

async function columns(adapter: InMemoryAdapter, table: string): Promise<string[]> {
  const cols = await adapter.query<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.map((c) => c.name);
}

async function indexNames(adapter: InMemoryAdapter, table: string): Promise<string[]> {
  const idx = await adapter.query<{ name: string }>(`PRAGMA index_list(${table})`);
  return idx.map((i) => i.name);
}

describe('DB boot path: upgrade from pre-queuePosition download table', () => {
  let adapter: InMemoryAdapter;
  afterEach(async () => {
    await adapter?.close();
  });

  it('SCHEMA_SQL does not reference queuePosition before migrations add it', () => {
    // The boot order runs SCHEMA_SQL before runMigrations, so SCHEMA_SQL must
    // not build any index on a migration-added column.
    const ddlBeforeMigrations = SCHEMA_SQL;
    const referencesQueuePositionInIndex = /CREATE INDEX[^;]*queuePosition/i.test(
      ddlBeforeMigrations,
    );
    expect(referencesQueuePositionInIndex).toBe(false);
  });

  it('boot path (SCHEMA_SQL then runMigrations) succeeds on a legacy download table', async () => {
    adapter = await newDb();
    // Simulate an existing on-device DB at the v5 schema.
    await adapter.exec(LEGACY_DOWNLOAD_TABLE);
    await adapter.exec('PRAGMA user_version = 5');
    // Seed a row to prove data survives the upgrade.
    await adapter.exec(
      `INSERT INTO download (galleryId, title, thumbnail, downloadedAt, status)
       VALUES (7, 'Legacy DL', '/t.avif', '2024-01-01', 'complete')`,
    );

    // This is the exact initializeDatabase() order. It must not throw.
    await expect(
      (async () => {
        await adapter.exec(SCHEMA_SQL);
        await runMigrations(adapter);
      })(),
    ).resolves.not.toThrow();

    // queuePosition column + queue index are present after the upgrade.
    expect(await columns(adapter, 'download')).toContain('queuePosition');
    expect(await columns(adapter, 'download')).toContain('nativeRunId');
    expect(await indexNames(adapter, 'download')).toContain('idx_download_queue');
    expect(
      (await adapter.query<{ user_version: number }>('PRAGMA user_version'))[0].user_version,
    ).toBe(LATEST_VERSION);

    // Pre-existing data preserved.
    const rows = await adapter.query<{ galleryId: number; title: string }>(
      'SELECT galleryId, title FROM download WHERE galleryId = 7',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Legacy DL');
  });

  it('boot path is correct on a fresh install too (no existing tables)', async () => {
    adapter = await newDb();
    await expect(
      (async () => {
        await adapter.exec(SCHEMA_SQL);
        await runMigrations(adapter);
      })(),
    ).resolves.not.toThrow();

    expect(await columns(adapter, 'download')).toContain('queuePosition');
    expect(await columns(adapter, 'download')).toContain('nativeRunId');
    expect(await indexNames(adapter, 'download')).toContain('idx_download_queue');
    expect(
      (await adapter.query<{ user_version: number }>('PRAGMA user_version'))[0].user_version,
    ).toBe(LATEST_VERSION);
  });
});
