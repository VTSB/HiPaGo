/**
 * Tests for the migration runner (runMigrations) and MIGRATIONS array.
 * Uses sql.js in-memory adapter — no schema dependency, simulates pre-migration DB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { DbAdapter, QueryResult } from '../adapter';

// ---------------------------------------------------------------------------
// Minimal in-memory adapter (standalone, no dependency on test-db.ts)
// ---------------------------------------------------------------------------

class MigrationTestAdapter implements DbAdapter {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.db.run(sql, params as any[]);
    const changes = this.db.getRowsModified();
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const lastInsertRowId =
      result.length > 0 ? (result[0].values[0][0] as number) : 0;
    return { changes, lastInsertRowId };
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as any[]);
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

/** Schema without language/mediaType to simulate a pre-migration DB */
const SCHEMA_WITHOUT_NEW_COLS = `
CREATE TABLE IF NOT EXISTS gallery (
  id INTEGER PRIMARY KEY,
  type INTEGER NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  thumbnail TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL
);
`;

async function createAdapter(withSchema = false, withNewCols = false): Promise<MigrationTestAdapter> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const adapter = new MigrationTestAdapter(db);
  if (withSchema) {
    if (withNewCols) {
      // Full schema with new columns already present
      db.run(`
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
      `);
    } else {
      db.run(SCHEMA_WITHOUT_NEW_COLS);
    }
  }
  return adapter;
}

async function getUserVersion(adapter: DbAdapter): Promise<number> {
  const rows = await adapter.query<{ user_version: number }>('PRAGMA user_version');
  return rows[0].user_version;
}

async function getColumnNames(adapter: DbAdapter, table: string): Promise<string[]> {
  const cols = await adapter.query<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.map(c => c.name);
}

// ---------------------------------------------------------------------------
// Import the module under test (after helpers, since file doesn't exist yet)
// ---------------------------------------------------------------------------

import { runMigrations, MIGRATIONS, LATEST_VERSION } from '../migrations';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MIGRATIONS array', () => {
  it('has sequential version numbers starting at 1', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    MIGRATIONS.forEach((m, i) => {
      expect(m.version).toBe(i + 1);
    });
  });

  it('LATEST_VERSION equals the last migration version', () => {
    const lastVersion = MIGRATIONS[MIGRATIONS.length - 1].version;
    expect(LATEST_VERSION).toBe(lastVersion);
  });
});

describe('runMigrations', () => {
  let adapter: MigrationTestAdapter;

  afterEach(async () => {
    await adapter.close();
  });

  describe('version tracking', () => {
    it('increments user_version after each migration', async () => {
      adapter = await createAdapter(true, false);
      const versionBefore = await getUserVersion(adapter);
      expect(versionBefore).toBe(0);

      await runMigrations(adapter);

      const versionAfter = await getUserVersion(adapter);
      expect(versionAfter).toBe(LATEST_VERSION);
    });

    it('skips migrations when user_version is already at latest', async () => {
      adapter = await createAdapter(true, true);
      // Manually set user_version to LATEST_VERSION
      await adapter.exec(`PRAGMA user_version = ${LATEST_VERSION}`);

      // Track calls by wrapping exec
      const execCalls: string[] = [];
      const origExec = adapter.exec.bind(adapter);
      adapter.exec = async (sql: string) => {
        execCalls.push(sql);
        return origExec(sql);
      };

      await runMigrations(adapter);

      // Should not have called BEGIN (no migrations ran)
      const beginCalls = execCalls.filter(s => s.trim().toUpperCase() === 'BEGIN');
      expect(beginCalls).toHaveLength(0);
      // user_version unchanged
      const version = await getUserVersion(adapter);
      expect(version).toBe(LATEST_VERSION);
    });

    it('only runs pending migrations (skips already-applied)', async () => {
      // Create adapter with v1 already applied but schema with new cols
      adapter = await createAdapter(true, true);
      await adapter.exec(`PRAGMA user_version = 1`);

      const versionBefore = await getUserVersion(adapter);
      expect(versionBefore).toBe(1);

      await runMigrations(adapter);

      // Version should remain 1 since that's already the latest
      const versionAfter = await getUserVersion(adapter);
      expect(versionAfter).toBe(1);
    });
  });

  describe('rollback on failure', () => {
    it('user_version stays at previous value when a migration throws', async () => {
      // Use full schema with new cols so all real migrations pass first
      adapter = await createAdapter(true, true);

      // Apply all real migrations so we start at LATEST_VERSION
      await runMigrations(adapter);
      const versionAfterReal = await getUserVersion(adapter);
      expect(versionAfterReal).toBe(LATEST_VERSION);

      // Now add a failing migration at LATEST_VERSION + 1
      const failingVersion = LATEST_VERSION + 1;
      const failingMigration = {
        version: failingVersion,
        description: 'Failing migration for test',
        up: async (_a: DbAdapter) => {
          throw new Error('intentional failure');
        },
      };

      const originalMigrations = [...MIGRATIONS];
      MIGRATIONS.push(failingMigration);

      try {
        await expect(runMigrations(adapter)).rejects.toThrow('intentional failure');
      } finally {
        MIGRATIONS.splice(0, MIGRATIONS.length, ...originalMigrations);
      }

      // user_version should still be LATEST_VERSION (rollback worked)
      const version = await getUserVersion(adapter);
      expect(version).toBe(LATEST_VERSION);
    });
  });

  describe('migration v1: language and mediaType columns', () => {
    it('adds language and mediaType columns if missing', async () => {
      adapter = await createAdapter(true, false); // schema without new cols

      const colsBefore = await getColumnNames(adapter, 'gallery');
      expect(colsBefore).not.toContain('language');
      expect(colsBefore).not.toContain('mediaType');

      await runMigrations(adapter);

      const colsAfter = await getColumnNames(adapter, 'gallery');
      expect(colsAfter).toContain('language');
      expect(colsAfter).toContain('mediaType');
    });

    it('is idempotent — no error if columns already exist', async () => {
      adapter = await createAdapter(true, true); // schema WITH new cols

      const colsBefore = await getColumnNames(adapter, 'gallery');
      expect(colsBefore).toContain('language');
      expect(colsBefore).toContain('mediaType');

      // Running v1 migration directly should not throw
      const v1 = MIGRATIONS.find(m => m.version === 1);
      expect(v1).toBeDefined();
      await expect(v1!.up(adapter)).resolves.not.toThrow();
    });

    it('sets user_version to 1 after v1 migration', async () => {
      adapter = await createAdapter(true, false);

      await runMigrations(adapter);

      const version = await getUserVersion(adapter);
      expect(version).toBeGreaterThanOrEqual(1);
    });
  });
});
