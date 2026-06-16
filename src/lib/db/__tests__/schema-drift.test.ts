/**
 * SCHEMA_SQL ⇄ MIGRATIONS drift detector.
 *
 * The DB uses a TWO-TRACK schema strategy:
 *   - Fresh install: empty DB → exec(SCHEMA_SQL) → runMigrations  (SCHEMA_SQL is
 *     the latest full snapshot; migrations are then no-ops that just bump
 *     user_version).
 *   - Upgrade: an OLD on-device DB → exec(SCHEMA_SQL) → runMigrations  (SCHEMA_SQL
 *     runs on every boot but is mostly IF NOT EXISTS no-ops on an existing DB;
 *     the migrations apply the real structural deltas).
 *
 * Both tracks MUST converge to the SAME final schema. Nothing in the code
 * enforces that — SCHEMA_SQL and the cumulative migrations are hand-maintained
 * separately, so they can silently drift. SQLite makes this worse: it is
 * dynamically typed (type affinity), so a type/column divergence usually does
 * NOT throw — it just produces two different on-device schemas for
 * fresh-install vs upgraded users. This test is the guard:
 *
 *   For every historical install baseline, the REAL boot order
 *   (baseline → SCHEMA_SQL → runMigrations) must (a) not throw and
 *   (b) produce a schema semantically identical to a fresh install.
 *
 * The comparison is SEMANTIC (column set + per-column type/notnull/default/pk,
 * and the index set + per-index columns/uniqueness), sorted by name — so
 * harmless differences like column ORDER (ALTER appends; SCHEMA_SQL may inline
 * elsewhere) do not trip it, but a missing/extra column, a type change, a
 * NOT NULL/default change, or a missing/extra index does.
 *
 * NOTE: this test reproduces the queuePosition boot-crash too — the v5 baseline
 * has a `download` table without queuePosition, so a SCHEMA_SQL that indexes
 * queuePosition before migrations add it throws here (regression coverage on top
 * of schema-bootstrap-upgrade.test.ts).
 */
import { describe, it, expect } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { DbAdapter, QueryResult } from '../adapter';
import { SCHEMA_SQL } from '../schema-sql';
import { runMigrations } from '../migrations';

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

// Oldest historical DB shape — before migration v1 existed. gallery lacks
// language/mediaType; download/queue columns do not exist yet; tag_i18n is
// present (migration v2 drops it). user_version = 0.
const GENESIS_SCHEMA = `
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
CREATE TABLE IF NOT EXISTS tag_i18n (
  tagId INTEGER PRIMARY KEY,
  local TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tag_i18n_local ON tag_i18n(local);
`;

// A mid-history DB shape — download table at migration v5 (lastError present,
// but no queuePosition/retryCount/nextRetryAt). Represents a user who installed
// after download landed (v3) but before the queue work (v6/v7). user_version=5.
const V5_DOWNLOAD = `
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

interface ColInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
interface IdxListRow {
  name: string;
  unique: number;
}
interface IdxInfoRow {
  name: string;
}

/**
 * Semantic schema descriptor: for each table, its columns (sorted by name with
 * type/notnull/default/pk) and indexes (sorted by name with columns + unique).
 * Order-insensitive for columns so harmless declaration-order differences do
 * not produce false positives.
 */
async function dumpSchema(a: InMemoryAdapter): Promise<string> {
  const tables = await a.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const out: Record<string, unknown> = {};
  for (const { name } of tables) {
    const cols = await a.query<ColInfo>(`PRAGMA table_info(${name})`);
    const idxList = await a.query<IdxListRow>(`PRAGMA index_list(${name})`);
    const indexes = [];
    for (const idx of [...idxList].sort((x, y) => x.name.localeCompare(y.name))) {
      const info = await a.query<IdxInfoRow>(`PRAGMA index_info(${idx.name})`);
      indexes.push({ name: idx.name, unique: idx.unique, columns: info.map((i) => i.name) });
    }
    out[name] = {
      columns: [...cols]
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((c) => ({
          name: c.name,
          type: c.type,
          notnull: c.notnull,
          dflt: c.dflt_value,
          pk: c.pk,
        })),
      indexes,
    };
  }
  return JSON.stringify(out);
}

async function newDb(): Promise<InMemoryAdapter> {
  const SQL = await initSqlJs();
  return new InMemoryAdapter(new SQL.Database());
}

/** Run the REAL boot order on top of an optional pre-existing baseline. */
async function bootSchema(baselineDdl: string | null, userVersion: number): Promise<string> {
  const a = await newDb();
  try {
    if (baselineDdl) {
      await a.exec(baselineDdl);
      await a.exec(`PRAGMA user_version = ${userVersion}`);
    }
    await a.exec(SCHEMA_SQL);
    await runMigrations(a);
    return await dumpSchema(a);
  } finally {
    await a.close();
  }
}

describe('schema drift: fresh install and upgrades converge', () => {
  it('fresh install produces a non-trivial schema with the queue column + index', async () => {
    const a = await newDb();
    try {
      await a.exec(SCHEMA_SQL);
      await runMigrations(a);
      const dump = await dumpSchema(a);
      // Sanity: the descriptor really captured the evolving download table.
      expect(dump).toContain('"name":"queuePosition"');
      expect(dump).toContain('"name":"idx_download_queue"');
      expect(dump).toContain('"name":"retryCount"');
    } finally {
      await a.close();
    }
  });

  it('upgrade from genesis (pre-v1) converges to the fresh-install schema', async () => {
    const fresh = await bootSchema(null, 0);
    const upgraded = await bootSchema(GENESIS_SCHEMA, 0);
    expect(upgraded).toBe(fresh);
  });

  it('upgrade from a v5 download table converges to the fresh-install schema', async () => {
    // A user at user_version=5 already had migrations v1..v5 applied, so the
    // baseline is just the v5-shape download table; SCHEMA_SQL (which runs every
    // boot) recreates every other table identically via IF NOT EXISTS. Do NOT
    // seed genesis/tag_i18n here — at v5 it was already dropped (by v2), and v2
    // will not re-run at user_version=5.
    //
    // This also exercises the boot order against a download table missing
    // queuePosition — a SCHEMA_SQL that indexes a migration-added column before
    // migrations run would throw here.
    const fresh = await bootSchema(null, 0);
    const upgraded = await bootSchema(V5_DOWNLOAD, 5);
    expect(upgraded).toBe(fresh);
  });
});
