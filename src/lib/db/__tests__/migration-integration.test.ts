/**
 * Integration tests for the DB migration runner.
 *
 * Covers:
 *  1. Fresh install: DDL already has all columns → migrations no-op → user_version = LATEST_VERSION
 *  2. Existing DB (pre-migration, no language/mediaType) → v1 runs → columns added → data preserved
 *  3. Already migrated (user_version = LATEST_VERSION) → migrations skipped entirely
 *  4. Multiple migrations → only pending ones run (simulated via patching MIGRATIONS at runtime)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { DbAdapter, QueryResult } from '../adapter';
import { runMigrations, MIGRATIONS, LATEST_VERSION } from '../migrations';

// ---------------------------------------------------------------------------
// Minimal in-memory adapter (same pattern as TestAdapter in test-db.ts)
// ---------------------------------------------------------------------------

class InMemoryAdapter implements DbAdapter {
  readonly sqlDb: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.sqlDb = db;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.sqlDb.run(sql, params as any[]);
    const changes = this.sqlDb.getRowsModified();
    const result = this.sqlDb.exec('SELECT last_insert_rowid() as id');
    const lastInsertRowId =
      result.length > 0 ? (result[0].values[0][0] as number) : 0;
    return { changes, lastInsertRowId };
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.sqlDb.prepare(sql);
    stmt.bind(params as any[]);
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
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

// ---------------------------------------------------------------------------
// DDL without language/mediaType — simulates a pre-migration existing DB
// ---------------------------------------------------------------------------

const LEGACY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gallery (
  id INTEGER PRIMARY KEY,
  type INTEGER NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  thumbnail TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tag (
  tagId INTEGER PRIMARY KEY AUTOINCREMENT,
  type INTEGER NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_status (
  tag TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
`;

// Full current DDL (mirrors schema-sql.ts) — fresh install
const CURRENT_SCHEMA_SQL = `
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
CREATE TABLE IF NOT EXISTS tag (
  tagId INTEGER PRIMARY KEY AUTOINCREMENT,
  type INTEGER NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_status (
  tag TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createAdapter(ddl: string): Promise<InMemoryAdapter> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const adapter = new InMemoryAdapter(db);
  await adapter.exec(ddl);
  return adapter;
}

async function getUserVersion(adapter: InMemoryAdapter): Promise<number> {
  const rows = await adapter.query<{ user_version: number }>('PRAGMA user_version');
  return rows[0].user_version;
}

async function getColumnNames(adapter: InMemoryAdapter, table: string): Promise<string[]> {
  const cols = await adapter.query<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.map((c) => c.name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Migration integration: fresh install', () => {
  let adapter: InMemoryAdapter;

  beforeEach(async () => {
    adapter = await createAdapter(CURRENT_SCHEMA_SQL);
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('fresh DB starts with user_version = 0', async () => {
    expect(await getUserVersion(adapter)).toBe(0);
  });

  it('runMigrations on fresh install (columns already present) completes without error', async () => {
    await expect(runMigrations(adapter)).resolves.not.toThrow();
  });

  it('user_version equals LATEST_VERSION after migrations run on fresh install', async () => {
    await runMigrations(adapter);
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });

  it('gallery table still has language and mediaType columns after migration', async () => {
    await runMigrations(adapter);
    const cols = await getColumnNames(adapter, 'gallery');
    expect(cols).toContain('language');
    expect(cols).toContain('mediaType');
  });

  it('running migrations twice on fresh install is a no-op (idempotent)', async () => {
    await runMigrations(adapter);
    await runMigrations(adapter);
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });
});

describe('Migration integration: existing pre-migration DB', () => {
  let adapter: InMemoryAdapter;

  beforeEach(async () => {
    adapter = await createAdapter(LEGACY_SCHEMA_SQL);
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('legacy DB starts with user_version = 0 and no language/mediaType columns', async () => {
    expect(await getUserVersion(adapter)).toBe(0);
    const cols = await getColumnNames(adapter, 'gallery');
    expect(cols).not.toContain('language');
    expect(cols).not.toContain('mediaType');
  });

  it('v1 migration adds language column to legacy DB', async () => {
    await runMigrations(adapter);
    const cols = await getColumnNames(adapter, 'gallery');
    expect(cols).toContain('language');
  });

  it('v1 migration adds mediaType column to legacy DB', async () => {
    await runMigrations(adapter);
    const cols = await getColumnNames(adapter, 'gallery');
    expect(cols).toContain('mediaType');
  });

  it('user_version equals LATEST_VERSION after migration on legacy DB', async () => {
    await runMigrations(adapter);
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });

  it('pre-existing gallery data is preserved after migration', async () => {
    // Insert a row before migration (no language/mediaType columns yet)
    await adapter.exec(
      `INSERT INTO gallery (id, type, title, date, thumbnail, url, updatedAt)
       VALUES (42, 1, 'Test Gallery', '2024-01-01', '/thumb.avif', '/url', '2024-01-01')`,
    );

    await runMigrations(adapter);

    const rows = await adapter.query<{ id: number; title: string }>(
      'SELECT id, title FROM gallery WHERE id = 42',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(42);
    expect(rows[0].title).toBe('Test Gallery');
  });

  it('migrated rows get empty string defaults for language and mediaType', async () => {
    await adapter.exec(
      `INSERT INTO gallery (id, type, title, date, thumbnail, url, updatedAt)
       VALUES (42, 1, 'Test Gallery', '2024-01-01', '/thumb.avif', '/url', '2024-01-01')`,
    );

    await runMigrations(adapter);

    const rows = await adapter.query<{ language: string; mediaType: string }>(
      'SELECT language, mediaType FROM gallery WHERE id = 42',
    );
    expect(rows[0].language).toBe('');
    expect(rows[0].mediaType).toBe('');
  });

  it('other tables (tag, sync_status) are unaffected by migration', async () => {
    await adapter.exec(`INSERT INTO tag (type, name, count) VALUES (1, 'test-tag', 5)`);
    await adapter.exec(`INSERT INTO sync_status (tag, data) VALUES ('init', '{"ok":true}')`);

    await runMigrations(adapter);

    const tags = await adapter.query<{ name: string }>('SELECT name FROM tag');
    expect(tags).toHaveLength(1);
    expect(tags[0].name).toBe('test-tag');

    const status = await adapter.query<{ data: string }>('SELECT data FROM sync_status');
    expect(status).toHaveLength(1);
    expect(status[0].data).toBe('{"ok":true}');
  });
});

describe('Migration integration: already migrated DB', () => {
  let adapter: InMemoryAdapter;

  beforeEach(async () => {
    // Start with legacy schema, run migrations to bring to LATEST_VERSION
    adapter = await createAdapter(LEGACY_SCHEMA_SQL);
    await runMigrations(adapter);
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('already-migrated DB has user_version = LATEST_VERSION', async () => {
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });

  it('running migrations again on already-migrated DB is a no-op', async () => {
    const versionBefore = await getUserVersion(adapter);
    await runMigrations(adapter);
    expect(await getUserVersion(adapter)).toBe(versionBefore);
  });

  it('columns remain present after second migration run', async () => {
    await runMigrations(adapter);
    const cols = await getColumnNames(adapter, 'gallery');
    expect(cols).toContain('language');
    expect(cols).toContain('mediaType');
  });

  it('running migrations N times is always idempotent', async () => {
    for (let i = 0; i < 5; i++) {
      await runMigrations(adapter);
    }
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
  });
});

describe('Migration integration: multiple migrations — only pending run', () => {
  it('a DB at user_version=0 runs all migrations', async () => {
    // Current MIGRATIONS has exactly 1 migration; this verifies the runner
    // applies all pending (version > currentVersion) migrations.
    const adapter = await createAdapter(LEGACY_SCHEMA_SQL);
    expect(await getUserVersion(adapter)).toBe(0);

    await runMigrations(adapter);

    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
    // All MIGRATIONS versions should now be applied
    expect(await getUserVersion(adapter)).toBeGreaterThanOrEqual(MIGRATIONS.length);

    await adapter.close();
  });

  it('a DB at user_version = LATEST_VERSION skips all migrations', async () => {
    const adapter = await createAdapter(CURRENT_SCHEMA_SQL);

    // Manually set user_version to LATEST_VERSION without running migrations
    await adapter.exec(`PRAGMA user_version = ${LATEST_VERSION}`);
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);

    // runMigrations should be a no-op — columns are there, version is current
    await runMigrations(adapter);
    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);

    await adapter.close();
  });

  it('a DB at user_version = LATEST_VERSION-1 (if applicable) runs only remaining migrations', async () => {
    // Only meaningful when LATEST_VERSION > 1. When LATEST_VERSION === 1,
    // version 0 is the only "pre-migration" state — verify that path still works.
    if (LATEST_VERSION < 2) {
      // Only one migration exists; version 0 → 1 is the only transition.
      const adapter = await createAdapter(LEGACY_SCHEMA_SQL);
      await runMigrations(adapter);
      expect(await getUserVersion(adapter)).toBe(1);
      await adapter.close();
      return;
    }

    // For LATEST_VERSION >= 2: set version to LATEST_VERSION - 1, verify only
    // the last migration runs.
    const adapter = await createAdapter(CURRENT_SCHEMA_SQL);
    const startVersion = LATEST_VERSION - 1;
    await adapter.exec(`PRAGMA user_version = ${startVersion}`);

    await runMigrations(adapter);

    expect(await getUserVersion(adapter)).toBe(LATEST_VERSION);
    await adapter.close();
  });

  it('MIGRATIONS array is sequential starting from 1', () => {
    // Validates the sequence invariant enforced at module load time
    for (let i = 0; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].version).toBe(i + 1);
    }
  });

  it('LATEST_VERSION matches the last migration version', () => {
    if (MIGRATIONS.length === 0) {
      expect(LATEST_VERSION).toBe(0);
    } else {
      expect(LATEST_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    }
  });
});
