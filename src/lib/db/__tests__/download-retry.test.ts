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
    await scheduleAutoRetry(1, 1, due);
    const row = await getDownload(1);
    expect(row!.status).toBe('failed');
    expect(row!.retryCount).toBe(1);
    expect(row!.nextRetryAt).toBe(due);
  });

  it('is a no-op when the row is not failed (e.g. already requeued)', async () => {
    await upsertDownload(
      makeRow({ galleryId: 2, status: 'queued', queuePosition: 1, lastError: null }),
    );
    await scheduleAutoRetry(2, 1, '2024-06-01T10:05:00Z');
    const row = await getDownload(2);
    expect(row!.nextRetryAt == null).toBe(true);
    expect(row!.status).toBe('queued');
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
      }),
    );
    await clearAutoRetry(1);
    const row = await getDownload(1);
    expect(row!.retryCount).toBe(0);
    expect(row!.nextRetryAt == null).toBe(true);
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
