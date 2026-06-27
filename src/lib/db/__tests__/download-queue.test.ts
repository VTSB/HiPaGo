/**
 * Tests for the download-queue ops (AC-002) over the single `download` table,
 * plus the listLibraryDownloads status filter. Uses the real sql.js in-memory
 * adapter (same as download.test.ts) so SQL semantics are exercised end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb } from './test-db';
import { upsertDownload, getDownload, listLibraryDownloads, serializeTags } from '../download';
import {
  enqueueDownload,
  listQueue,
  dequeueNextQueued,
  pauseQueued,
  resumeQueued,
  removeFromQueue,
  reorderQueue,
} from '../download-queue';
import type { DBDownload } from '../schema';

const makeRow = (overrides: Partial<DBDownload> = {}): DBDownload => ({
  galleryId: 1001,
  title: 'Test Gallery',
  thumbnail: '/tn.avif',
  tags: serializeTags({ artist: ['a1'] }),
  pageCount: 0,
  totalBytes: 0,
  downloadedAt: new Date('2024-06-01T10:00:00Z').toISOString(),
  status: 'complete',
  ...overrides,
});

const meta = (galleryId: number) => ({
  galleryId,
  title: `G${galleryId}`,
  thumbnail: '/tn.avif',
  tags: { artist: ['x'] },
});

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
// upsertDownload carries queuePosition (the INSERT OR REPLACE wipe guard)
// ---------------------------------------------------------------------------

describe('upsertDownload + queuePosition', () => {
  it('round-trips queuePosition through upsert + getDownload', async () => {
    await upsertDownload(makeRow({ status: 'queued', queuePosition: 7 }));
    const row = await getDownload(1001);
    expect(row!.queuePosition).toBe(7);
  });

  it('stores NULL queuePosition when not provided', async () => {
    await upsertDownload(makeRow());
    const row = await getDownload(1001);
    expect(row!.queuePosition == null).toBe(true);
  });

  it('a later upsert that omits queuePosition clears it (null passed through)', async () => {
    await upsertDownload(makeRow({ status: 'queued', queuePosition: 3 }));
    await upsertDownload(makeRow({ status: 'downloading' })); // no queuePosition
    const row = await getDownload(1001);
    expect(row!.queuePosition == null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enqueueDownload
// ---------------------------------------------------------------------------

describe('enqueueDownload', () => {
  it('assigns ascending positions when appending to the back', async () => {
    const p1 = await enqueueDownload(meta(1));
    const p2 = await enqueueDownload(meta(2));
    const p3 = await enqueueDownload(meta(3));
    expect(p1).toBe(1);
    expect(p2).toBe(2);
    expect(p3).toBe(3);
  });

  it('userInitiated jumps to the front (min - 1)', async () => {
    await enqueueDownload(meta(1)); // pos 1
    await enqueueDownload(meta(2)); // pos 2
    const front = await enqueueDownload(meta(3), { userInitiated: true });
    expect(front).toBe(0); // min(1) - 1
  });

  it('sets status to queued and clears stale lastError', async () => {
    await upsertDownload(
      makeRow({ galleryId: 5, status: 'failed', lastError: 'boom', pageCount: 4 }),
    );
    await enqueueDownload(meta(5));
    const row = await getDownload(5);
    expect(row!.status).toBe('queued');
    expect(row!.lastError == null).toBe(true);
    // preserves partial pages so the processor resumes
    expect(row!.pageCount).toBe(4);
  });

  it('can restore an explicit queue position when reconciling an interrupted active row', async () => {
    await upsertDownload(
      makeRow({ galleryId: 6, status: 'downloading', queuePosition: 4, retryCount: 2 }),
    );

    const position = await enqueueDownload(meta(6), {
      keepRetryState: true,
      queuePosition: 4,
    });

    const row = await getDownload(6);
    expect(position).toBe(4);
    expect(row!.status).toBe('queued');
    expect(row!.queuePosition).toBe(4);
    expect(row!.retryCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// listQueue / dequeueNextQueued
// ---------------------------------------------------------------------------

describe('listQueue + dequeueNextQueued', () => {
  it('listQueue returns queued + paused ordered by position', async () => {
    await enqueueDownload(meta(1)); // pos 1
    await enqueueDownload(meta(2)); // pos 2
    await enqueueDownload(meta(3)); // pos 3
    await pauseQueued(2);
    const q = await listQueue();
    expect(q.map((r) => r.galleryId)).toEqual([1, 2, 3]);
  });

  it('dequeueNextQueued returns the lowest-position queued item (skips paused)', async () => {
    await enqueueDownload(meta(1)); // pos 1
    await enqueueDownload(meta(2)); // pos 2
    await pauseQueued(1); // pos 1 now paused → skipped
    const next = await dequeueNextQueued();
    expect(next!.galleryId).toBe(2);
    expect(next!.status).toBe('downloading');
    expect((await getDownload(2))!.status).toBe('downloading');
  });

  it('excludes queued rows whose queuePosition was cleared', async () => {
    await upsertDownload(makeRow({ galleryId: 1, status: 'queued', queuePosition: null }));
    await upsertDownload(makeRow({ galleryId: 2, status: 'queued', queuePosition: 3 }));
    await upsertDownload(makeRow({ galleryId: 3, status: 'paused', queuePosition: 2 }));

    const q = await listQueue();
    expect(q.map((r) => r.galleryId)).toEqual([3, 2]);
    expect((await dequeueNextQueued())!.galleryId).toBe(2);
  });

  it('atomically claims a queued row before returning it', async () => {
    await enqueueDownload(meta(1));

    const claimed = await dequeueNextQueued();
    const stored = await getDownload(1);

    expect(claimed).toMatchObject({ galleryId: 1, status: 'downloading' });
    expect(stored).toMatchObject({ galleryId: 1, status: 'downloading' });
  });

  it('can claim a specific queued row without claiming earlier queued work', async () => {
    await enqueueDownload(meta(1)); // pos 1
    await enqueueDownload(meta(2)); // pos 2

    const claimed = await dequeueNextQueued(2);

    expect(claimed).toMatchObject({ galleryId: 2, status: 'downloading' });
    expect((await getDownload(1))!.status).toBe('queued');
    expect((await getDownload(2))!.status).toBe('downloading');
  });

  it('allows only one concurrent dequeue caller to claim a single queued row', async () => {
    await enqueueDownload(meta(1));

    const results = await Promise.all([dequeueNextQueued(), dequeueNextQueued()]);
    const claimed = results.filter((row): row is DBDownload => row !== null);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ galleryId: 1, status: 'downloading' });
    expect(results.filter((row) => row === null)).toHaveLength(1);
    expect((await getDownload(1))!.status).toBe('downloading');
  });

  it('dequeueNextQueued returns null when nothing is queued', async () => {
    await enqueueDownload(meta(1));
    await pauseQueued(1);
    expect(await dequeueNextQueued()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

describe('pauseQueued / resumeQueued', () => {
  it('pause flips queued → paused, resume flips back', async () => {
    await enqueueDownload(meta(1));
    await pauseQueued(1);
    expect((await getDownload(1))!.status).toBe('paused');
    await resumeQueued(1);
    expect((await getDownload(1))!.status).toBe('queued');
  });

  it('pause is a no-op on a non-queued row', async () => {
    await upsertDownload(makeRow({ galleryId: 9, status: 'complete' }));
    await pauseQueued(9);
    expect((await getDownload(9))!.status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// removeFromQueue
// ---------------------------------------------------------------------------

describe('removeFromQueue', () => {
  it('turns a partial queued cancel into a visible failed library row', async () => {
    await upsertDownload(
      makeRow({ galleryId: 1, status: 'queued', queuePosition: 1, pageCount: 5 }),
    );
    await removeFromQueue(1);
    const row = await getDownload(1);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('failed');
    expect(row!.queuePosition == null).toBe(true);
    expect((await listQueue()).map((r) => r.galleryId)).not.toContain(1);
    expect((await listLibraryDownloads()).map((r) => r.galleryId)).toContain(1);
    expect(await dequeueNextQueued()).toBeNull();
  });

  it('turns a partial paused cancel into a visible failed library row', async () => {
    await upsertDownload(
      makeRow({ galleryId: 2, status: 'paused', queuePosition: 1, pageCount: 3 }),
    );
    await removeFromQueue(2);

    const row = await getDownload(2);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('failed');
    expect(row!.queuePosition == null).toBe(true);
    expect((await listQueue()).map((r) => r.galleryId)).not.toContain(2);
    expect((await listLibraryDownloads()).map((r) => r.galleryId)).toContain(2);
  });

  it('deletes the row when it has no pages', async () => {
    await enqueueDownload(meta(1)); // pageCount 0
    await removeFromQueue(1);
    expect(await getDownload(1)).toBeNull();
  });

  it('keeps a failed row with no pages so first-page failures can be retried', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1,
        status: 'failed',
        queuePosition: 1,
        pageCount: 0,
        lastError: 'network failed before first page',
      }),
    );
    await removeFromQueue(1);
    const row = await getDownload(1);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('failed');
    expect(row!.queuePosition == null).toBe(true);
    expect(row!.lastError).toBe('network failed before first page');
  });

  it('is a no-op for a non-existent row', async () => {
    await expect(removeFromQueue(99999)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// reorderQueue
// ---------------------------------------------------------------------------

describe('reorderQueue', () => {
  it('changes a queued item position so list order updates', async () => {
    await enqueueDownload(meta(1)); // pos 1
    await enqueueDownload(meta(2)); // pos 2
    await reorderQueue(2, -5); // move 2 to the front
    const q = await listQueue();
    expect(q.map((r) => r.galleryId)).toEqual([2, 1]);
  });

  it('is a no-op on a non-queued row', async () => {
    await upsertDownload(makeRow({ galleryId: 9, status: 'complete' }));
    await reorderQueue(9, 3);
    expect((await getDownload(9))!.queuePosition == null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listLibraryDownloads filter (the library-leak guard)
// ---------------------------------------------------------------------------

describe('listLibraryDownloads', () => {
  it('includes complete/downloading/failed and EXCLUDES queued/paused', async () => {
    await upsertDownload(makeRow({ galleryId: 1, status: 'complete' }));
    await upsertDownload(makeRow({ galleryId: 2, status: 'downloading' }));
    await upsertDownload(makeRow({ galleryId: 3, status: 'failed', lastError: 'x' }));
    await upsertDownload(makeRow({ galleryId: 4, status: 'queued', queuePosition: 1 }));
    await upsertDownload(makeRow({ galleryId: 5, status: 'paused', queuePosition: 2 }));

    const rows = await listLibraryDownloads();
    const ids = rows.map((r) => r.galleryId).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('orders by downloadedAt descending', async () => {
    await upsertDownload(
      makeRow({ galleryId: 1, status: 'complete', downloadedAt: '2024-01-01T00:00:00Z' }),
    );
    await upsertDownload(
      makeRow({ galleryId: 2, status: 'complete', downloadedAt: '2024-03-01T00:00:00Z' }),
    );
    const rows = await listLibraryDownloads();
    expect(rows[0].galleryId).toBe(2);
  });
});
