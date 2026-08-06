/**
 * Tests for the auto-retry helpers (Task E / AC-002) over the single `download`
 * table. Uses the real sql.js in-memory adapter so SQL semantics (the
 * status/nextRetryAt/retryCount predicates) are exercised end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb } from './test-db';
import { upsertDownload, getDownload, serializeTags } from '../download';
import { enqueueDownload } from '../download-queue';
import {
  AUTO_RETRY_BACKOFF_MS,
  AUTO_RETRY_MAX,
  scheduleAutoRetry,
  listDueAutoRetries,
  clearAutoRetry,
  earliestNextRetryAt,
  requeueDueAutoRetry,
  requeueInterruptedDownload,
  retryDownloadIfUnchanged,
  retryDownloadIfAbsent,
  redownloadCompleteIfUnchanged,
} from '../download-retry';
import type { DBDownload } from '../schema';

const makeRow = (overrides: Partial<DBDownload> = {}): DBDownload => ({
  galleryId: 1001,
  title: 'Test Gallery',
  thumbnail: '/tn.avif',
  tags: serializeTags({ artist: ['a1'] }),
  pageCount: 0,
  totalBytes: 0,
  downloadedAt: new Date('2024-06-01T10:00:00Z').toISOString(),
  status: 'failed',
  lastError: 'boom',
  ...overrides,
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

describe('constants', () => {
  it('backoff schedule is 30s/5m/30m and length equals AUTO_RETRY_MAX', () => {
    expect(AUTO_RETRY_BACKOFF_MS).toEqual([30_000, 300_000, 1_800_000]);
    expect(AUTO_RETRY_MAX).toBe(3);
    expect(AUTO_RETRY_BACKOFF_MS.length).toBe(AUTO_RETRY_MAX);
  });
});

describe('scheduleAutoRetry', () => {
  it('sets retryCount + nextRetryAt and keeps status failed', async () => {
    await upsertDownload(makeRow({ galleryId: 1, status: 'failed' }));
    const due = '2024-06-01T10:05:00Z';
    const snapshot = (await getDownload(1))!;
    expect(await scheduleAutoRetry(snapshot, 1, due)).toBe(true);
    const row = await getDownload(1);
    expect(row!.status).toBe('failed');
    expect(row!.retryCount).toBe(1);
    expect(row!.nextRetryAt).toBe(due);
  });

  it('is a no-op when the row is not failed (e.g. already requeued)', async () => {
    await upsertDownload(
      makeRow({ galleryId: 2, status: 'queued', queuePosition: 1, lastError: null }),
    );
    const snapshot = (await getDownload(2))!;
    expect(await scheduleAutoRetry(snapshot, 1, '2024-06-01T10:05:00Z')).toBe(false);
    const row = await getDownload(2);
    expect(row!.nextRetryAt == null).toBe(true);
    expect(row!.status).toBe('queued');
  });

  it('does not overwrite a newer failed attempt from a stale failure snapshot', async () => {
    await upsertDownload(makeRow({ galleryId: 3, status: 'failed', retryCount: 0 }));
    const snapshot = (await getDownload(3))!;
    await upsertDownload(
      makeRow({
        galleryId: 3,
        status: 'failed',
        retryCount: 2,
        nextRetryAt: '2024-06-01T10:10:00Z',
      }),
    );

    expect(await scheduleAutoRetry(snapshot, 1, '2024-06-01T10:05:00Z')).toBe(false);
    const row = await getDownload(3);
    expect(row!.retryCount).toBe(2);
    expect(row!.nextRetryAt).toBe('2024-06-01T10:10:00Z');
  });

  it('does not schedule over an ABA replacement with a different native run', async () => {
    await upsertDownload(makeRow({ galleryId: 4, retryCount: 0, nativeRunId: 'run-aaaaaaaaaaaa' }));
    const snapshot = (await getDownload(4))!;
    await upsertDownload({ ...snapshot, nativeRunId: 'run-bbbbbbbbbbbb' });

    expect(await scheduleAutoRetry(snapshot, 1, '2024-06-01T10:05:00Z')).toBe(false);
    expect(await getDownload(4)).toMatchObject({
      retryCount: 0,
      nextRetryAt: null,
      nativeRunId: 'run-bbbbbbbbbbbb',
    });
  });
});

describe('retryDownloadIfUnchanged', () => {
  it('queues the exact tokenless failed snapshot and resets retry state', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 10,
        retryCount: 2,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    const snapshot = (await getDownload(10))!;

    expect(await retryDownloadIfUnchanged(snapshot)).toBe(true);
    expect(await getDownload(10)).toMatchObject({
      status: 'queued',
      retryCount: 0,
      nextRetryAt: null,
      nativeRunId: null,
    });
  });

  it('does not overwrite a newer native claim from a stale failed UI snapshot', async () => {
    await upsertDownload(makeRow({ galleryId: 11 }));
    const snapshot = (await getDownload(11))!;
    await upsertDownload({
      ...snapshot,
      status: 'downloading',
      nativeRunId: 'run-bbbbbbbbbbbb',
    });

    expect(await retryDownloadIfUnchanged(snapshot)).toBe(false);
    expect(await getDownload(11)).toMatchObject({
      status: 'downloading',
      nativeRunId: 'run-bbbbbbbbbbbb',
    });
  });

  it('refuses a failed row while a native run token is still owned', async () => {
    await upsertDownload(makeRow({ galleryId: 12, nativeRunId: 'run-aaaaaaaaaaaa' }));
    const snapshot = (await getDownload(12))!;

    expect(await retryDownloadIfUnchanged(snapshot)).toBe(false);
    expect(await getDownload(12)).toMatchObject({
      status: 'failed',
      nativeRunId: 'run-aaaaaaaaaaaa',
    });
  });

  it('recreates a cancelled missing row without overwriting a replacement', async () => {
    const source = makeRow({ galleryId: 13, nativeRunId: 'run-aaaaaaaaaaaa' });

    expect(await retryDownloadIfAbsent(source)).toBe(true);
    expect(await getDownload(13)).toMatchObject({
      status: 'queued',
      pageCount: 0,
      nativeRunId: null,
    });
    expect(await retryDownloadIfAbsent(source)).toBe(false);
  });
});

describe('redownloadCompleteIfUnchanged', () => {
  it('queues the exact tokenless complete snapshot without losing resume metadata', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 14,
        status: 'complete',
        pageCount: 7,
        totalBytes: 1234,
        lastError: null,
      }),
    );
    const snapshot = (await getDownload(14))!;

    expect(await redownloadCompleteIfUnchanged(snapshot)).toBe(true);
    expect(await getDownload(14)).toMatchObject({
      status: 'queued',
      pageCount: 7,
      totalBytes: 1234,
      nativeRunId: null,
    });
  });

  it('does not recreate a complete row deleted after the UI snapshot', async () => {
    await upsertDownload(makeRow({ galleryId: 15, status: 'complete', lastError: null }));
    const snapshot = (await getDownload(15))!;
    const db = await import('../adapter').then(({ ensureDb }) => ensureDb());
    await db.execute('DELETE FROM download WHERE galleryId = ?', [15]);

    expect(await redownloadCompleteIfUnchanged(snapshot)).toBe(false);
    expect(await getDownload(15)).toBeNull();
  });

  it('does not overwrite a replacement lifecycle created after delete wins the retry race', async () => {
    await upsertDownload(makeRow({ galleryId: 17, status: 'complete', lastError: null }));
    const staleSnapshot = (await getDownload(17))!;
    const db = await import('../adapter').then(({ ensureDb }) => ensureDb());
    await db.execute('DELETE FROM download WHERE galleryId = ?', [17]);
    await upsertDownload(
      makeRow({
        galleryId: 17,
        title: 'Replacement lifecycle',
        status: 'downloading',
        nativeRunId: 'run-replacement-aa',
      }),
    );

    expect(await redownloadCompleteIfUnchanged(staleSnapshot)).toBe(false);
    expect(await getDownload(17)).toMatchObject({
      title: 'Replacement lifecycle',
      status: 'downloading',
      nativeRunId: 'run-replacement-aa',
    });
  });

  it('refuses a complete row while a native cleanup token remains', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 16,
        status: 'complete',
        lastError: null,
        nativeRunId: 'run-aaaaaaaaaaaa',
      }),
    );

    expect(await redownloadCompleteIfUnchanged((await getDownload(16))!)).toBe(false);
    expect(await getDownload(16)).toMatchObject({
      status: 'complete',
      nativeRunId: 'run-aaaaaaaaaaaa',
    });
  });
});

describe('listDueAutoRetries', () => {
  it('returns failed rows past nextRetryAt with retryCount <= MAX', async () => {
    const now = '2024-06-01T12:00:00Z';
    // Due: failed, past due, attempts left.
    await upsertDownload(
      makeRow({
        galleryId: 1,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    // Not due: nextRetryAt in the future.
    await upsertDownload(
      makeRow({
        galleryId: 2,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T13:00:00Z',
      }),
    );
    // Last scheduled attempt is still eligible.
    await upsertDownload(
      makeRow({
        galleryId: 3,
        status: 'failed',
        retryCount: AUTO_RETRY_MAX,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    // Beyond the cap: ignored defensively.
    await upsertDownload(
      makeRow({
        galleryId: 6,
        status: 'failed',
        retryCount: AUTO_RETRY_MAX + 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    // No schedule: nextRetryAt NULL.
    await upsertDownload(
      makeRow({ galleryId: 4, status: 'failed', retryCount: 0, nextRetryAt: null }),
    );
    // Native-owned failures are reconciled/stopped before retrying.  Returning
    // them here could start a second writer while the old worker is alive.
    await upsertDownload(
      makeRow({
        galleryId: 7,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
        nativeRunId: 'run-aaaaaaaaaaaa',
      }),
    );
    // Wrong status: queued.
    await upsertDownload(
      makeRow({
        galleryId: 5,
        status: 'queued',
        queuePosition: 1,
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );

    const due = await listDueAutoRetries(now);
    expect(due.map((r) => r.galleryId)).toEqual([1, 3]);
  });

  it('orders oldest-due first', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:30:00Z',
      }),
    );
    await upsertDownload(
      makeRow({
        galleryId: 2,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    const due = await listDueAutoRetries('2024-06-01T12:00:00Z');
    expect(due.map((r) => r.galleryId)).toEqual([2, 1]);
  });

  it('treats a NULL retryCount as 0 (still eligible)', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1,
        status: 'failed',
        retryCount: null,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    const due = await listDueAutoRetries('2024-06-01T12:00:00Z');
    expect(due.map((r) => r.galleryId)).toEqual([1]);
  });
});

describe('clearAutoRetry', () => {
  it('resets retryCount to 0 and clears nextRetryAt', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1,
        status: 'failed',
        retryCount: 2,
        nextRetryAt: '2024-06-01T11:00:00Z',
        nativeRunId: 'run-aaaaaaaaaaaa',
      }),
    );
    await clearAutoRetry(1);
    const row = await getDownload(1);
    expect(row!.retryCount).toBe(0);
    expect(row!.nextRetryAt == null).toBe(true);
  });
});

describe('conditional retry/reconcile requeue', () => {
  it('requeues the exact due snapshot while preserving its retry count', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 20,
        status: 'failed',
        retryCount: 2,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    const [snapshot] = await listDueAutoRetries('2024-06-01T12:00:00Z');

    expect(await requeueDueAutoRetry(snapshot)).toBe(true);
    const row = await getDownload(20);
    expect(row).toMatchObject({
      status: 'queued',
      retryCount: 2,
      nextRetryAt: null,
      nativeRunId: null,
    });
    expect(row!.queuePosition).not.toBeNull();
  });

  it('cannot resurrect a due row deleted after the due-list snapshot', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 21,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    const [snapshot] = await listDueAutoRetries('2024-06-01T12:00:00Z');
    const db = await import('../adapter').then(({ ensureDb }) => ensureDb());
    await db.execute('DELETE FROM download WHERE galleryId = ?', [21]);

    expect(await requeueDueAutoRetry(snapshot)).toBe(false);
    expect(await getDownload(21)).toBeNull();
  });

  it('does not overwrite a manual retry with an older due snapshot', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 22,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    const [snapshot] = await listDueAutoRetries('2024-06-01T12:00:00Z');
    await enqueueDownload(
      { galleryId: 22, title: 'Manual', thumbnail: '/manual', tags: {} },
      { userInitiated: true },
    );

    expect(await requeueDueAutoRetry(snapshot)).toBe(false);
    const row = await getDownload(22);
    expect(row).toMatchObject({ status: 'queued', retryCount: 0, title: 'Manual' });
  });

  it('does not requeue an ABA replacement with a different nativeRunId', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 24,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    const [snapshot] = await listDueAutoRetries('2024-06-01T12:00:00Z');
    await upsertDownload({ ...snapshot, nativeRunId: 'run-bbbbbbbbbbbb' });

    expect(await requeueDueAutoRetry(snapshot)).toBe(false);
    expect(await getDownload(24)).toMatchObject({
      status: 'failed',
      nativeRunId: 'run-bbbbbbbbbbbb',
    });
  });

  it('refuses a due native-owned failure even when passed directly', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 25,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
        nativeRunId: 'run-aaaaaaaaaaaa',
      }),
    );
    const snapshot = (await getDownload(25))!;

    expect(await requeueDueAutoRetry(snapshot)).toBe(false);
    expect(await getDownload(25)).toMatchObject({
      status: 'failed',
      nativeRunId: 'run-aaaaaaaaaaaa',
      nextRetryAt: '2024-06-01T11:00:00Z',
    });
  });

  it('does not requeue an ABA replacement whose retry fields match but lifecycle changed', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 26,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
        lastError: 'attempt A',
      }),
    );
    const [snapshot] = await listDueAutoRetries('2024-06-01T12:00:00Z');
    await upsertDownload({ ...snapshot, lastError: 'attempt B', totalBytes: 99 });

    expect(await requeueDueAutoRetry(snapshot)).toBe(false);
    expect(await getDownload(26)).toMatchObject({
      status: 'failed',
      retryCount: 1,
      nextRetryAt: '2024-06-01T11:00:00Z',
      lastError: 'attempt B',
      totalBytes: 99,
    });
  });

  it('cannot resurrect an interrupted row deleted after launch scanning', async () => {
    await upsertDownload(makeRow({ galleryId: 23, status: 'downloading', queuePosition: 4 }));
    const snapshot = (await getDownload(23))!;
    const db = await import('../adapter').then(({ ensureDb }) => ensureDb());
    await db.execute('DELETE FROM download WHERE galleryId = ?', [23]);

    expect(await requeueInterruptedDownload(snapshot)).toBe(false);
    expect(await getDownload(23)).toBeNull();
  });

  it('invalidates native ownership when an interrupted row is requeued', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 25,
        status: 'downloading',
        queuePosition: 4,
        nativeRunId: 'run-aaaaaaaaaaaa',
      }),
    );
    const snapshot = (await getDownload(25))!;

    expect(await requeueInterruptedDownload(snapshot)).toBe(true);
    expect(await getDownload(25)).toMatchObject({ status: 'queued', nativeRunId: null });
  });
});

describe('earliestNextRetryAt', () => {
  it('returns the MIN nextRetryAt over eligible failed rows', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T13:00:00Z',
      }),
    );
    await upsertDownload(
      makeRow({
        galleryId: 2,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T11:00:00Z',
      }),
    );
    // Beyond-cap row must be ignored even though it has the earliest time.
    await upsertDownload(
      makeRow({
        galleryId: 3,
        status: 'failed',
        retryCount: AUTO_RETRY_MAX + 1,
        nextRetryAt: '2024-06-01T09:00:00Z',
      }),
    );
    // An overdue schedule that still has a native owner is intentionally held
    // until exact native stop clears its token; it must not arm a 0ms loop.
    await upsertDownload(
      makeRow({
        galleryId: 4,
        status: 'failed',
        retryCount: 1,
        nextRetryAt: '2024-06-01T08:00:00Z',
        nativeRunId: 'run-aaaaaaaaaaaa',
      }),
    );
    const earliest = await earliestNextRetryAt();
    expect(earliest).toBe('2024-06-01T11:00:00Z');
  });

  it('returns null when nothing is awaiting auto-retry', async () => {
    await upsertDownload(makeRow({ galleryId: 1, status: 'complete', lastError: null }));
    expect(await earliestNextRetryAt()).toBeNull();
  });
});

describe('enqueueDownload + retry counters (AC-002 / AC-005 reset)', () => {
  it('manual (default) enqueue RESETS retryCount and clears nextRetryAt', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1,
        status: 'failed',
        retryCount: 2,
        nextRetryAt: '2024-06-01T11:00:00Z',
        pageCount: 4,
      }),
    );
    await enqueueDownload({ galleryId: 1, title: 'G1', thumbnail: '/tn', tags: {} });
    const row = await getDownload(1);
    expect(row!.status).toBe('queued');
    expect(row!.retryCount).toBe(0);
    expect(row!.nextRetryAt == null).toBe(true);
    expect(row!.pageCount).toBe(4); // partial pages preserved for resume
  });

  it('auto requeue (keepRetryState) PRESERVES retryCount, clears nextRetryAt', async () => {
    await upsertDownload(
      makeRow({
        galleryId: 1,
        status: 'failed',
        retryCount: 2,
        nextRetryAt: '2024-06-01T11:00:00Z',
        pageCount: 4,
      }),
    );
    await enqueueDownload(
      { galleryId: 1, title: 'G1', thumbnail: '/tn', tags: {} },
      { keepRetryState: true },
    );
    const row = await getDownload(1);
    expect(row!.status).toBe('queued');
    expect(row!.retryCount).toBe(2);
    expect(row!.nextRetryAt == null).toBe(true);
  });
});
