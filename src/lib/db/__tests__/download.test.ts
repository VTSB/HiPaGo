import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb, countRows } from './test-db';
import {
  upsertDownload,
  getDownload,
  listDownloads,
  updateDownloadStatus,
  setDownloadError,
  deleteDownload,
  searchDownloads,
  serializeTags,
  deserializeTags,
  setDownloadFolderName,
  markDownloadMigrated,
  restoreDownloadIfUnchanged,
  deleteDownloadIfUnchanged,
  commitDownloadMigrationIfUnchanged,
  completeDownloadIfUnchanged,
  completeNativeDownloadRun,
  prepareNativeDownloadRun,
  adoptDiscoveredNativeRunIfUnchanged,
  rebindNativeRunIfUnchanged,
  clearNativeRunIfUnchanged,
  transitionNativeDownloadRun,
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

  it('round-trips nativeRunId and stores NULL when it is omitted', async () => {
    await upsertDownload(makeRow({ galleryId: 3002, nativeRunId: 'run-aaaaaaaaaaaa' }));
    await upsertDownload(makeRow({ galleryId: 3003 }));

    expect((await getDownload(3002))!.nativeRunId).toBe('run-aaaaaaaaaaaa');
    expect((await getDownload(3003))!.nativeRunId).toBeNull();
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
// lastError column + setDownloadError (AC-004)
// ---------------------------------------------------------------------------

describe('lastError column + setDownloadError', () => {
  it('round-trips lastError through upsert + getDownload', async () => {
    await upsertDownload(
      makeRow({ status: 'failed', lastError: 'download folder unavailable: NO_TREE' }),
    );
    const row = await getDownload(1001);
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toBe('download folder unavailable: NO_TREE');
  });

  it('stores NULL lastError when not provided', async () => {
    await upsertDownload(makeRow({ status: 'complete' }));
    const row = await getDownload(1001);
    expect(row!.lastError == null).toBe(true);
  });

  it('setDownloadError sets status + reason together', async () => {
    await upsertDownload(makeRow({ status: 'downloading' }));
    await setDownloadError(1001, 'failed', 'mkdir failed: HiPaGo');
    const row = await getDownload(1001);
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toBe('mkdir failed: HiPaGo');
  });

  it('setDownloadError can clear the reason on a successful retry', async () => {
    await upsertDownload(makeRow({ status: 'failed', lastError: 'boom' }));
    await setDownloadError(1001, 'downloading', null);
    const row = await getDownload(1001);
    expect(row!.status).toBe('downloading');
    expect(row!.lastError == null).toBe(true);
  });

  it('setDownloadError is a no-op for a non-existent galleryId', async () => {
    await expect(setDownloadError(99999, 'failed', 'x')).resolves.not.toThrow();
  });

  it('listDownloads returns lastError on failed rows', async () => {
    await upsertDownload(makeRow({ galleryId: 1003, status: 'failed', lastError: 'net down' }));
    const rows = await listDownloads();
    const failed = rows.find((r) => r.galleryId === 1003);
    expect(failed!.lastError).toBe('net down');
  });
});

describe('completeDownloadIfUnchanged', () => {
  it('marks the exact existing snapshot complete without inserting a replacement row', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1010,
        status: 'downloading',
        pageCount: 3,
        queuePosition: 7,
        retryCount: 1,
      }),
    );
    const snapshot = await getDownload(1010);

    expect(await completeDownloadIfUnchanged(snapshot!, 3, '2026-08-04T01:00:00.000Z', 4567)).toBe(
      true,
    );
    expect(await getDownload(1010)).toMatchObject({
      status: 'complete',
      pageCount: 3,
      totalBytes: 4567,
      queuePosition: null,
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
      nativeRunId: null,
      migratedAt: '2026-08-04T01:00:00.000Z',
    });
  });

  it('does not resurrect a row deleted after the completion snapshot was read', async () => {
    await upsertDownload(makeRow({ galleryId: 1011, status: 'downloading', pageCount: 2 }));
    const snapshot = await getDownload(1011);
    await deleteDownload(1011);

    expect(await completeDownloadIfUnchanged(snapshot!, 2)).toBe(false);
    expect(await getDownload(1011)).toBeNull();
  });

  it('does not overwrite a newer lifecycle state', async () => {
    await upsertDownload(
      makeRow({ galleryId: 1012, status: 'downloading', pageCount: 2, queuePosition: 3 }),
    );
    const snapshot = await getDownload(1012);
    await setDownloadError(1012, 'paused', null);

    expect(await completeDownloadIfUnchanged(snapshot!, 2)).toBe(false);
    expect(await getDownload(1012)).toMatchObject({ status: 'paused', queuePosition: 3 });
  });

  it('rejects an ABA replacement whose lifecycle fields match but nativeRunId changed', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1013,
        status: 'downloading',
        pageCount: 4,
        queuePosition: 2,
        retryCount: 0,
        nativeRunId: 'run-aaaaaaaaaaaa',
      }),
    );
    const snapshot = await getDownload(1013);
    await upsertDownload({ ...snapshot!, nativeRunId: 'run-bbbbbbbbbbbb' });

    expect(await completeDownloadIfUnchanged(snapshot!, 4)).toBe(false);
    expect(await getDownload(1013)).toMatchObject({
      status: 'downloading',
      nativeRunId: 'run-bbbbbbbbbbbb',
    });
  });
});

describe('restoreDownloadIfUnchanged', () => {
  it('inserts a restored row only while the catalog row is still absent', async () => {
    const restored = makeRow({ galleryId: 1020, title: 'Restored from disk' });

    expect(await restoreDownloadIfUnchanged(null, restored)).toBe(true);
    expect(await getDownload(1020)).toMatchObject({ title: 'Restored from disk' });
  });

  it('does not overwrite a row created after the absent snapshot', async () => {
    const replacement = makeRow({
      galleryId: 1021,
      title: 'Live replacement',
      status: 'downloading',
      nativeRunId: 'run-liveeeeeeeee',
    });
    await upsertDownload(replacement);

    expect(
      await restoreDownloadIfUnchanged(
        null,
        makeRow({ galleryId: 1021, title: 'Stale disk scan', status: 'complete' }),
      ),
    ).toBe(false);
    expect(await getDownload(1021)).toMatchObject({
      title: 'Live replacement',
      status: 'downloading',
      nativeRunId: 'run-liveeeeeeeee',
    });
  });

  it('updates an inactive exact snapshot but rejects a concurrent replacement', async () => {
    await upsertDownload(
      makeRow({ galleryId: 1022, title: 'Old failed row', status: 'failed', lastError: 'old' }),
    );
    const snapshot = (await getDownload(1022))!;
    const restored = makeRow({ galleryId: 1022, title: 'Recovered from disk', status: 'complete' });

    expect(await restoreDownloadIfUnchanged(snapshot, restored)).toBe(true);
    expect(await getDownload(1022)).toMatchObject({ title: 'Recovered from disk' });

    const staleSnapshot = (await getDownload(1022))!;
    await upsertDownload({
      ...staleSnapshot,
      title: 'New active lifecycle',
      status: 'downloading',
      nativeRunId: 'run-newwwwwwwwww',
    });

    expect(
      await restoreDownloadIfUnchanged(staleSnapshot, {
        ...restored,
        title: 'Late stale restore',
      }),
    ).toBe(false);
    expect(await getDownload(1022)).toMatchObject({
      title: 'New active lifecycle',
      status: 'downloading',
      nativeRunId: 'run-newwwwwwwwww',
    });
  });
});

describe('completeNativeDownloadRun', () => {
  it('commits the Android public-storage watermark with the owned native run', async () => {
    const nativeRunId = 'run-publicpublic1';
    await upsertDownload(
      makeRow({ galleryId: 1015, status: 'downloading', nativeRunId, migratedAt: null }),
    );

    expect(
      await completeNativeDownloadRun(
        makeRow({
          galleryId: 1015,
          status: 'complete',
          nativeRunId,
          migratedAt: '2026-08-04T02:00:00.000Z',
        }),
        nativeRunId,
      ),
    ).toBe(true);
    expect(await getDownload(1015)).toMatchObject({
      status: 'complete',
      migratedAt: '2026-08-04T02:00:00.000Z',
      nativeRunId,
    });
  });

  it('does not mark a native run public before its manifest-backed completion', async () => {
    const nativeRunId = 'run-preparepublic';
    await upsertDownload(
      makeRow({ galleryId: 1016, status: 'downloading', nativeRunId, migratedAt: null }),
    );

    expect(
      await prepareNativeDownloadRun(1016, nativeRunId, {
        pageCount: 4,
        totalBytes: 0,
        folderName: '1016 Public',
      }),
    ).toBe(true);
    expect(await getDownload(1016)).toMatchObject({
      status: 'downloading',
      folderName: '1016 Public',
      migratedAt: null,
      nativeRunId,
    });
  });

  it.each(['paused', 'failed'] as const)(
    'does not complete a same-token row after its lifecycle changed to %s',
    async (status) => {
      const nativeRunId = 'run-cccccccccccc';
      await upsertDownload(
        makeRow({
          galleryId: 1014,
          status,
          pageCount: 2,
          queuePosition: 4,
          lastError: status === 'failed' ? 'stopped' : null,
          nativeRunId,
        }),
      );
      const current = await getDownload(1014);

      expect(
        await completeNativeDownloadRun(
          {
            ...current!,
            status: 'complete',
            pageCount: 3,
            totalBytes: 4096,
          },
          nativeRunId,
        ),
      ).toBe(false);
      expect(await getDownload(1014)).toMatchObject({
        status,
        pageCount: 2,
        queuePosition: 4,
        nativeRunId,
      });
    },
  );
});

describe('native reconciliation snapshot CAS', () => {
  it('atomically gives a stopped native run a tail queue position when pausing it', async () => {
    await upsertDownload(
      makeRow({ galleryId: 1090, status: 'queued', queuePosition: 4, nativeRunId: null }),
    );
    await upsertDownload(
      makeRow({
        galleryId: 1091,
        status: 'downloading',
        queuePosition: null,
        nativeRunId: 'run-pausepause12',
      }),
    );

    expect(
      await transitionNativeDownloadRun(1091, 'run-pausepause12', 'paused', null, {
        clearQueuePosition: false,
        ensureQueuePosition: true,
      }),
    ).toBe(true);
    expect(await getDownload(1091)).toMatchObject({
      status: 'paused',
      queuePosition: 5,
      nativeRunId: null,
    });
  });

  it('adopts the discovered native writer only from the exact queued snapshot', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1015,
        status: 'queued',
        queuePosition: 4,
        lastError: 'stale',
        nextRetryAt: '2026-07-31T00:00:00.000Z',
        nativeRunId: 'run-oldoldoldold',
      }),
    );
    const snapshot = await getDownload(1015);

    expect(await adoptDiscoveredNativeRunIfUnchanged(snapshot!, 'run-newnewnewnew')).toBe(true);
    expect(await getDownload(1015)).toMatchObject({
      status: 'downloading',
      queuePosition: null,
      lastError: null,
      nextRetryAt: null,
      nativeRunId: 'run-newnewnewnew',
    });
  });

  it('cannot adopt over a concurrent lifecycle replacement', async () => {
    await upsertDownload(
      makeRow({ galleryId: 1016, status: 'queued', nativeRunId: 'run-oldoldoldold' }),
    );
    const snapshot = await getDownload(1016);
    await upsertDownload({ ...snapshot!, status: 'paused' });

    expect(await adoptDiscoveredNativeRunIfUnchanged(snapshot!, 'run-newnewnewnew')).toBe(false);
    expect(await getDownload(1016)).toMatchObject({
      status: 'paused',
      nativeRunId: 'run-oldoldoldold',
    });
  });

  it('clears a stopped native token only while the full snapshot is unchanged', async () => {
    await upsertDownload(
      makeRow({ galleryId: 1017, status: 'failed', nativeRunId: 'run-stopstopstop' }),
    );
    const snapshot = await getDownload(1017);

    expect(await clearNativeRunIfUnchanged(snapshot!)).toBe(true);
    expect((await getDownload(1017))?.nativeRunId).toBeNull();
  });

  it('rebinds a failed row to the discovered native identity without reviving it', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1019,
        status: 'failed',
        lastError: 'Cancelled',
        nativeRunId: 'run-oldoldoldold',
      }),
    );
    const snapshot = await getDownload(1019);

    expect(await rebindNativeRunIfUnchanged(snapshot!, 'run-realrealreal')).toBe(true);
    expect(await getDownload(1019)).toMatchObject({
      status: 'failed',
      lastError: 'Cancelled',
      nativeRunId: 'run-realrealreal',
    });
  });

  it('cannot clear a token after the same run was paused concurrently', async () => {
    await upsertDownload(
      makeRow({ galleryId: 1018, status: 'failed', nativeRunId: 'run-stopstopstop' }),
    );
    const snapshot = await getDownload(1018);
    await upsertDownload({ ...snapshot!, status: 'paused' });

    expect(await clearNativeRunIfUnchanged(snapshot!)).toBe(false);
    expect(await getDownload(1018)).toMatchObject({
      status: 'paused',
      nativeRunId: 'run-stopstopstop',
    });
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
    await upsertDownload(
      makeRow({
        galleryId: 5002,
        folderName: 'old-folder',
        migratedAt: '2024-01-01T00:00:00Z',
      }),
    );
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

describe('commitDownloadMigrationIfUnchanged', () => {
  it('commits the watermark only after storage succeeds for the exact snapshot', async () => {
    await upsertDownload(makeRow({ galleryId: 5010, migratedAt: null }));
    const snapshot = (await getDownload(5010))!;
    let storageCommitted = false;

    expect(
      await commitDownloadMigrationIfUnchanged(
        snapshot,
        '5010 Migrated',
        '2026-08-04T00:00:00.000Z',
        async () => {
          storageCommitted = true;
          return true;
        },
      ),
    ).toBe(true);
    expect(storageCommitted).toBe(true);
    expect(await getDownload(5010)).toMatchObject({
      folderName: '5010 Migrated',
      migratedAt: '2026-08-04T00:00:00.000Z',
    });
  });

  it('does not enter storage when the catalog snapshot was replaced', async () => {
    await upsertDownload(makeRow({ galleryId: 5011, status: 'complete', migratedAt: null }));
    const snapshot = (await getDownload(5011))!;
    await upsertDownload({
      ...snapshot,
      status: 'downloading',
      nativeRunId: 'run-replacement-5011',
    });
    let storageCalled = false;

    expect(
      await commitDownloadMigrationIfUnchanged(
        snapshot,
        '5011 Stale',
        '2026-08-04T00:00:00.000Z',
        async () => {
          storageCalled = true;
          return true;
        },
      ),
    ).toBe(false);
    expect(storageCalled).toBe(false);
    expect(await getDownload(5011)).toMatchObject({
      status: 'downloading',
      nativeRunId: 'run-replacement-5011',
      migratedAt: null,
    });
  });

  it('rolls the watermark back when storage cannot finish', async () => {
    await upsertDownload(makeRow({ galleryId: 5012, folderName: null, migratedAt: null }));
    const snapshot = (await getDownload(5012))!;

    expect(
      await commitDownloadMigrationIfUnchanged(
        snapshot,
        '5012 Not Committed',
        '2026-08-04T00:00:00.000Z',
        async () => false,
      ),
    ).toBe(false);
    expect(await getDownload(5012)).toMatchObject({ folderName: null, migratedAt: null });
  });

  it('keeps a new lifecycle behind the storage lease until migration commits', async () => {
    await upsertDownload(makeRow({ galleryId: 5013, migratedAt: null }));
    const snapshot = (await getDownload(5013))!;
    let signalStorageStarted!: () => void;
    let releaseStorage!: () => void;
    const storageStarted = new Promise<void>((resolve) => {
      signalStorageStarted = resolve;
    });
    const storageGate = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });

    const migration = commitDownloadMigrationIfUnchanged(
      snapshot,
      '5013 Migrated',
      '2026-08-04T00:00:00.000Z',
      async () => {
        signalStorageStarted();
        await storageGate;
        return true;
      },
    );
    await storageStarted;

    let replacementSettled = false;
    const replacement = upsertDownload({
      ...snapshot,
      title: 'New lifecycle',
      status: 'downloading',
      nativeRunId: 'run-new-lifecycle-5013',
    }).then(() => {
      replacementSettled = true;
    });
    await Promise.resolve();
    expect(replacementSettled).toBe(false);

    releaseStorage();
    await expect(migration).resolves.toBe(true);
    await replacement;
    expect(await getDownload(5013)).toMatchObject({
      title: 'New lifecycle',
      status: 'downloading',
      nativeRunId: 'run-new-lifecycle-5013',
      migratedAt: null,
    });
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

describe('deleteDownloadIfUnchanged', () => {
  it('deletes a row while its complete persisted snapshot is unchanged', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1003,
        folderName: '1003 Snapshot',
        migratedAt: '2026-01-01T00:00:00.000Z',
        lastError: 'missing manifest',
        retryCount: 2,
      }),
    );
    const snapshot = (await getDownload(1003))!;

    expect(await deleteDownloadIfUnchanged(snapshot)).toBe(true);
    expect(await getDownload(1003)).toBeNull();
  });

  it('does not delete a replacement lifecycle that starts after the snapshot', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1004,
        migratedAt: '2026-01-01T00:00:00.000Z',
        status: 'failed',
        lastError: 'old failure',
      }),
    );
    const snapshot = (await getDownload(1004))!;
    await upsertDownload({
      ...snapshot,
      title: 'Replacement lifecycle',
      status: 'downloading',
      lastError: null,
      retryCount: 0,
      nativeRunId: 'run-replacement-1004',
    });

    expect(await deleteDownloadIfUnchanged(snapshot)).toBe(false);
    expect(await getDownload(1004)).toMatchObject({
      title: 'Replacement lifecycle',
      status: 'downloading',
      nativeRunId: 'run-replacement-1004',
    });
  });

  it('rejects every independently changed persisted field in the snapshot', async () => {
    const changes: Partial<DBDownload>[] = [
      { title: 'Changed title' },
      { thumbnail: '/changed-thumbnail' },
      { tags: '{"tag":["changed"]}' },
      { pageCount: 43 },
      { totalBytes: 123456 },
      { downloadedAt: '2026-08-04T03:00:00.000Z' },
      { status: 'failed' },
      { folderName: 'Changed folder' },
      { migratedAt: '2026-08-04T03:01:00.000Z' },
      { lastError: 'Changed error' },
      { queuePosition: 9 },
      { retryCount: 3 },
      { nextRetryAt: '2026-08-04T03:02:00.000Z' },
      { nativeRunId: 'run-changed-snapshot' },
    ];

    for (const [index, change] of changes.entries()) {
      const galleryId = 1100 + index;
      await upsertDownload(makeRow({ galleryId }));
      const snapshot = (await getDownload(galleryId))!;
      await upsertDownload({ ...snapshot, ...change });

      expect(await deleteDownloadIfUnchanged(snapshot)).toBe(false);
      expect(await getDownload(galleryId)).toMatchObject(change);
    }
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
    await upsertDownload(
      makeRow({
        galleryId: 6001,
        folderName: 'list-folder',
        migratedAt: '2025-03-01T00:00:00Z',
      }),
    );
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
    await upsertDownload(
      makeRow({
        galleryId: 7001,
        title: 'Searchable Folder Gallery',
        folderName: 'search-folder',
        migratedAt: '2025-04-01T00:00:00Z',
        downloadedAt: '2024-06-01T00:00:00Z',
      }),
    );
    const results = await searchDownloads({ query: 'Searchable' });
    expect(results).toHaveLength(1);
    expect(results[0].folderName).toBe('search-folder');
    expect(results[0].migratedAt).toBe('2025-04-01T00:00:00Z');
  });
});
