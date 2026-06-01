import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb, countRows } from './test-db';
import {
  upsertDownload,
  getDownload,
  listDownloads,
  updateDownloadStatus,
  deleteDownload,
  searchDownloads,
  serializeTags,
  deserializeTags,
  setDownloadFolderName,
  markDownloadMigrated,
} from '../download';
import type { DBDownload } from '../schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeRow = (overrides: Partial<DBDownload> = {}): DBDownload => ({
  galleryId: 1001,
  title: 'Test Gallery Alpha',
  thumbnail: '/api/img/tn/avifsmalltn/a/bc/hash.avif',
  tags: serializeTags({ artist: ['artist1'], tag: ['action', 'comedy'] }),
  pageCount: 42,
  totalBytes: 1024 * 1024 * 20, // 20 MB
  downloadedAt: new Date('2024-06-01T10:00:00Z').toISOString(),
  status: 'complete',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearAllTables();
});

// ---------------------------------------------------------------------------
// serializeTags / deserializeTags
// ---------------------------------------------------------------------------

describe('serializeTags / deserializeTags', () => {
  it('round-trips a tag map correctly', () => {
    const tags = { artist: ['artist1', 'artist2'], tag: ['action'] };
    const serialized = serializeTags(tags);
    expect(typeof serialized).toBe('string');
    expect(deserializeTags(serialized)).toEqual(tags);
  });

  it('round-trips an empty map', () => {
    expect(deserializeTags(serializeTags({}))).toEqual({});
  });

  it('deserializeTags returns empty map on invalid JSON', () => {
    expect(deserializeTags('not-json')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// upsertDownload / getDownload
// ---------------------------------------------------------------------------

describe('upsertDownload + getDownload', () => {
  it('inserts a row and retrieves it by galleryId', async () => {
    const row = makeRow();
    await upsertDownload(row);
    const retrieved = await getDownload(row.galleryId);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.galleryId).toBe(row.galleryId);
    expect(retrieved!.title).toBe(row.title);
    expect(retrieved!.thumbnail).toBe(row.thumbnail);
    expect(retrieved!.tags).toBe(row.tags);
    expect(retrieved!.pageCount).toBe(row.pageCount);
    expect(retrieved!.totalBytes).toBe(row.totalBytes);
    expect(retrieved!.downloadedAt).toBe(row.downloadedAt);
    expect(retrieved!.status).toBe(row.status);
  });

  it('returns null for a non-existent galleryId', async () => {
    const result = await getDownload(99999);
    expect(result).toBeNull();
  });

  it('overwrites an existing row when upserting with the same galleryId', async () => {
    const original = makeRow({ title: 'Original Title', status: 'downloading' });
    await upsertDownload(original);

    const updated = makeRow({ title: 'Updated Title', status: 'complete' });
    await upsertDownload(updated);

    const retrieved = await getDownload(original.galleryId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('Updated Title');
    expect(retrieved!.status).toBe('complete');

    // Only one row should exist
    const count = await countRows('download');
    expect(count).toBe(1);
  });

  it('stores all three status values correctly', async () => {
    for (const status of ['downloading', 'complete', 'failed'] as const) {
      await upsertDownload(makeRow({ galleryId: 2000, status }));
      const row = await getDownload(2000);
      expect(row!.status).toBe(status);
    }
  });

  it('stores folderName and migratedAt when provided', async () => {
    const row = makeRow({ folderName: 'my-folder', migratedAt: '2024-07-01T00:00:00Z' });
    await upsertDownload(row);
    const retrieved = await getDownload(row.galleryId);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.folderName).toBe('my-folder');
    expect(retrieved!.migratedAt).toBe('2024-07-01T00:00:00Z');
  });

  it('stores NULL for folderName and migratedAt when not provided', async () => {
    const row = makeRow();
    await upsertDownload(row);
    const retrieved = await getDownload(row.galleryId);

    expect(retrieved).not.toBeNull();
    // sql.js returns null for NULL columns
    expect(retrieved!.folderName == null).toBe(true);
    expect(retrieved!.migratedAt == null).toBe(true);
  });

  it('round-trips folderName + migratedAt through upsert + getDownload', async () => {
    const row = makeRow({
      galleryId: 3001,
      folderName: 'Gallery_3001',
      migratedAt: '2025-01-15T12:00:00Z',
    });
    await upsertDownload(row);
    const retrieved = await getDownload(3001);

    expect(retrieved!.folderName).toBe('Gallery_3001');
    expect(retrieved!.migratedAt).toBe('2025-01-15T12:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// updateDownloadStatus
// ---------------------------------------------------------------------------

describe('updateDownloadStatus', () => {
  it('changes status from downloading to complete', async () => {
    await upsertDownload(makeRow({ status: 'downloading' }));
    await updateDownloadStatus(1001, 'complete');
    const row = await getDownload(1001);
    expect(row!.status).toBe('complete');
  });

  it('changes status to failed', async () => {
    await upsertDownload(makeRow({ status: 'downloading' }));
    await updateDownloadStatus(1001, 'failed');
    const row = await getDownload(1001);
    expect(row!.status).toBe('failed');
  });

  it('is a no-op for a non-existent galleryId', async () => {
    await expect(updateDownloadStatus(99999, 'complete')).resolves.not.toThrow();
  });

  it('does not affect other rows', async () => {
    await upsertDownload(makeRow({ galleryId: 1001, status: 'downloading' }));
    await upsertDownload(makeRow({ galleryId: 1002, status: 'downloading' }));
    await updateDownloadStatus(1001, 'complete');

    const other = await getDownload(1002);
    expect(other!.status).toBe('downloading');
  });
});

// ---------------------------------------------------------------------------
// setDownloadFolderName
// ---------------------------------------------------------------------------

describe('setDownloadFolderName', () => {
  it('sets folderName on an existing row', async () => {
    await upsertDownload(makeRow({ galleryId: 4001 }));
    await setDownloadFolderName(4001, 'new-folder');
    const row = await getDownload(4001);
    expect(row!.folderName).toBe('new-folder');
  });

  it('overwrites an existing folderName', async () => {
    await upsertDownload(makeRow({ galleryId: 4002, folderName: 'old-folder' }));
    await setDownloadFolderName(4002, 'updated-folder');
    const row = await getDownload(4002);
    expect(row!.folderName).toBe('updated-folder');
  });

  it('is a no-op for a non-existent galleryId', async () => {
    await expect(setDownloadFolderName(99999, 'some-folder')).resolves.not.toThrow();
  });

  it('does not change other fields', async () => {
    const original = makeRow({ galleryId: 4003, title: 'Keep This Title' });
    await upsertDownload(original);
    await setDownloadFolderName(4003, 'folder-x');
    const row = await getDownload(4003);
    expect(row!.title).toBe('Keep This Title');
    expect(row!.status).toBe(original.status);
  });
});

// ---------------------------------------------------------------------------
// markDownloadMigrated
// ---------------------------------------------------------------------------

describe('markDownloadMigrated', () => {
  it('sets folderName and migratedAt on an existing row', async () => {
    await upsertDownload(makeRow({ galleryId: 5001 }));
    await markDownloadMigrated(5001, 'migrated-folder', '2025-06-01T00:00:00Z');
    const row = await getDownload(5001);
    expect(row!.folderName).toBe('migrated-folder');
    expect(row!.migratedAt).toBe('2025-06-01T00:00:00Z');
  });

  it('overwrites existing folderName and migratedAt', async () => {
    await upsertDownload(makeRow({
      galleryId: 5002,
      folderName: 'old-folder',
      migratedAt: '2024-01-01T00:00:00Z',
    }));
    await markDownloadMigrated(5002, 'new-folder', '2025-06-01T00:00:00Z');
    const row = await getDownload(5002);
    expect(row!.folderName).toBe('new-folder');
    expect(row!.migratedAt).toBe('2025-06-01T00:00:00Z');
  });

  it('is a no-op for a non-existent galleryId', async () => {
    await expect(
      markDownloadMigrated(99999, 'folder', '2025-01-01T00:00:00Z'),
    ).resolves.not.toThrow();
  });

  it('does not change status or other fields', async () => {
    const original = makeRow({ galleryId: 5003, status: 'complete', title: 'Stable Title' });
    await upsertDownload(original);
    await markDownloadMigrated(5003, 'folder-y', '2025-06-01T00:00:00Z');
    const row = await getDownload(5003);
    expect(row!.status).toBe('complete');
    expect(row!.title).toBe('Stable Title');
  });
});

// ---------------------------------------------------------------------------
// deleteDownload
// ---------------------------------------------------------------------------

describe('deleteDownload', () => {
  it('removes a row by galleryId', async () => {
    await upsertDownload(makeRow());
    await deleteDownload(1001);
    const result = await getDownload(1001);
    expect(result).toBeNull();
  });

  it('is a no-op for a non-existent galleryId', async () => {
    await expect(deleteDownload(99999)).resolves.not.toThrow();
  });

  it('only removes the targeted row, leaving others intact', async () => {
    await upsertDownload(makeRow({ galleryId: 1001 }));
    await upsertDownload(makeRow({ galleryId: 1002 }));
    await deleteDownload(1001);

    expect(await getDownload(1001)).toBeNull();
    expect(await getDownload(1002)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listDownloads
// ---------------------------------------------------------------------------

describe('listDownloads', () => {
  it('returns an empty array when no downloads exist', async () => {
    const results = await listDownloads();
    expect(results).toEqual([]);
  });

  it('returns all rows ordered by downloadedAt descending', async () => {
    await upsertDownload(makeRow({ galleryId: 1001, downloadedAt: '2024-01-01T00:00:00Z' }));
    await upsertDownload(makeRow({ galleryId: 1002, downloadedAt: '2024-03-01T00:00:00Z' }));
    await upsertDownload(makeRow({ galleryId: 1003, downloadedAt: '2024-02-01T00:00:00Z' }));

    const results = await listDownloads();
    expect(results).toHaveLength(3);
    expect(results[0].galleryId).toBe(1002); // most recent
    expect(results[1].galleryId).toBe(1003);
    expect(results[2].galleryId).toBe(1001); // oldest
  });

  it('returns all fields in each row', async () => {
    const row = makeRow();
    await upsertDownload(row);
    const results = await listDownloads();
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.galleryId).toBe(row.galleryId);
    expect(r.title).toBe(row.title);
    expect(r.thumbnail).toBe(row.thumbnail);
    expect(r.tags).toBe(row.tags);
    expect(r.pageCount).toBe(row.pageCount);
    expect(r.totalBytes).toBe(row.totalBytes);
    expect(r.downloadedAt).toBe(row.downloadedAt);
    expect(r.status).toBe(row.status);
  });

  it('returns folderName and migratedAt in listed rows', async () => {
    await upsertDownload(makeRow({
      galleryId: 6001,
      folderName: 'list-folder',
      migratedAt: '2025-03-01T00:00:00Z',
    }));
    const results = await listDownloads();
    expect(results).toHaveLength(1);
    expect(results[0].folderName).toBe('list-folder');
    expect(results[0].migratedAt).toBe('2025-03-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// searchDownloads
// ---------------------------------------------------------------------------

describe('searchDownloads', () => {
  beforeEach(async () => {
    await upsertDownload(
      makeRow({
        galleryId: 2001,
        title: 'Dragon Knight Adventure',
        tags: serializeTags({ tag: ['action', 'fantasy'], artist: ['drawmaster'] }),
        downloadedAt: '2024-05-01T00:00:00Z',
      }),
    );
    await upsertDownload(
      makeRow({
        galleryId: 2002,
        title: 'Cooking with Chef Anna',
        tags: serializeTags({ tag: ['slice-of-life', 'comedy'], artist: ['chefpen'] }),
        downloadedAt: '2024-04-01T00:00:00Z',
      }),
    );
    await upsertDownload(
      makeRow({
        galleryId: 2003,
        title: 'Dragon Ball Fan Work',
        tags: serializeTags({ tag: ['action', 'parody'], artist: ['fanartist'] }),
        downloadedAt: '2024-03-01T00:00:00Z',
      }),
    );
  });

  it('returns all rows when no query provided', async () => {
    const results = await searchDownloads({});
    expect(results).toHaveLength(3);
  });

  it('filters by title substring (case-insensitive via LIKE)', async () => {
    const results = await searchDownloads({ query: 'dragon' });
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.galleryId);
    expect(ids).toContain(2001);
    expect(ids).toContain(2003);
  });

  it('returns empty array when title query matches nothing', async () => {
    const results = await searchDownloads({ query: 'zzz_no_match_zzz' });
    expect(results).toEqual([]);
  });

  it('filters by tag substring', async () => {
    const results = await searchDownloads({ tagQuery: 'fantasy' });
    expect(results).toHaveLength(1);
    expect(results[0].galleryId).toBe(2001);
  });

  it('filters by artist name in tags', async () => {
    const results = await searchDownloads({ tagQuery: 'chefpen' });
    expect(results).toHaveLength(1);
    expect(results[0].galleryId).toBe(2002);
  });

  it('combines title and tag query with AND semantics', async () => {
    // "dragon" matches 2001 and 2003; "fantasy" only matches 2001
    const results = await searchDownloads({ query: 'dragon', tagQuery: 'fantasy' });
    expect(results).toHaveLength(1);
    expect(results[0].galleryId).toBe(2001);
  });

  it('returns results ordered by downloadedAt descending', async () => {
    // Both 2001 and 2003 match "dragon"
    const results = await searchDownloads({ query: 'dragon' });
    expect(results[0].galleryId).toBe(2001); // 2024-05-01 > 2024-03-01
    expect(results[1].galleryId).toBe(2003);
  });

  it('handles a query with leading/trailing whitespace', async () => {
    const results = await searchDownloads({ query: '  dragon  ' });
    expect(results).toHaveLength(2);
  });

  it('empty string query returns all rows', async () => {
    const results = await searchDownloads({ query: '', tagQuery: '' });
    expect(results).toHaveLength(3);
  });

  it('returns folderName and migratedAt in search results', async () => {
    // Add a row with folderName set
    await upsertDownload(makeRow({
      galleryId: 7001,
      title: 'Searchable Folder Gallery',
      folderName: 'search-folder',
      migratedAt: '2025-04-01T00:00:00Z',
      downloadedAt: '2024-06-01T00:00:00Z',
    }));
    const results = await searchDownloads({ query: 'Searchable' });
    expect(results).toHaveLength(1);
    expect(results[0].folderName).toBe('search-folder');
    expect(results[0].migratedAt).toBe('2025-04-01T00:00:00Z');
  });
});
