// @vitest-environment node
/**
 * AC-005 (sequential QueueProcessor) + AC-007 (reconcileQueue) tests.
 *
 * The processor drives a sequence of dequeueNextQueued() reads, calling the
 * (mocked) downloadGalleryToLibrary once per item. We assert:
 *   - synchronous single-flight: a re-entrant processQueue() does not run a
 *     second download concurrently,
 *   - sequential order: items processed lowest-position first,
 *   - advance-on-complete: removeFromQueue + markDownloaded, then next item,
 *   - pause branch: DownloadPausedError leaves the item in the queue,
 *   - cancel branch (queued item): cancel() removes it, no abort.
 *   - reconcileQueue: zombie 'downloading' rows re-enqueued; idempotent; kicks
 *     processor only when unmetered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DownloadPausedError, hasCompleteDownloadedGallery } from '@/lib/utils/download-zip';
import { DownloadCancelledError } from '@/lib/storage/download-store';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const dl = vi.fn();
// galleryId → manifest page list (for the Android reconcile-from-manifest test).
const manifestPages = new Map<number, { index: number; ext: string }[]>();
vi.mock('@/lib/utils/download-zip', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils/download-zip')>(
    '@/lib/utils/download-zip',
  );
  return {
    ...actual,
    downloadGalleryToLibrary: (...a: unknown[]) => dl(...a),
    getDownloadedGalleryPages: vi.fn(async (id: number) => manifestPages.get(id) ?? []),
    hasCompleteDownloadedGallery: vi.fn(async (id: number, expectedPageCount: number) => {
      const pages = manifestPages.get(id) ?? [];
      return pages.length > 0 && (expectedPageCount <= 0 || pages.length === expectedPageCount);
    }),
  };
});

const ensureDownloadStoreReady = vi.fn(async () => {});
vi.mock('@/lib/storage/download-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/storage/download-store')>(
    '@/lib/storage/download-store',
  );
  return {
    ...actual,
    createDownloadStore: vi.fn(async () => ({ ensureReady: ensureDownloadStoreReady })),
  };
});

const queue: { id: number; pageCount: number; paused?: boolean; pos?: number }[] = [];
const removed: number[] = [];
const enqueued: { meta: unknown; opts: unknown }[] = [];

vi.mock('@/lib/db/download-queue', () => ({
  dequeueNextQueued: vi.fn(async () => {
    // Mirror the SQL `WHERE status = 'queued' ORDER BY queuePosition`: paused
    // items are NOT dequeued; lowest position runs next.
    const item = queue
      .slice()
      .sort((a, b) => (a.pos ?? a.id) - (b.pos ?? b.id))
      .find((q) => !q.paused);
    if (!item) return null;
    return {
      galleryId: item.id,
      title: `G${item.id}`,
      thumbnail: '/tn',
      tags: '{}',
      pageCount: item.pageCount,
      status: 'queued',
    };
  }),
  removeFromQueue: vi.fn(async (id: number) => {
    removed.push(id);
    const idx = queue.findIndex((q) => q.id === id);
    if (idx >= 0) queue.splice(idx, 1);
  }),
  enqueueDownload: vi.fn(async (meta: unknown, opts: unknown) => {
    enqueued.push({ meta, opts });
    const m = meta as { galleryId: number };
    const options = (opts ?? {}) as { userInitiated?: boolean; queuePosition?: number };
    const existing = queue.find((q) => q.id === m.galleryId);
    const pos =
      options.queuePosition ??
      (options.userInitiated
        ? Math.min(1, ...queue.map((q) => q.pos ?? q.id)) - 1
        : Math.max(0, ...queue.map((q) => q.pos ?? q.id)) + 1);
    if (existing) {
      existing.pos = pos;
      existing.paused = false;
    } else {
      queue.push({ id: m.galleryId, pageCount: 0, pos });
    }
    return pos;
  }),
  // Queue surface consumed by the store actions (AC-001). listQueue() returns
  // queued + paused rows in position order, mirroring the production SQL.
  listQueue: vi.fn(async () =>
    queue
      .slice()
      .sort((a, b) => (a.pos ?? a.id) - (b.pos ?? b.id))
      .map((q) => ({
        galleryId: q.id,
        title: `G${q.id}`,
        thumbnail: '/tn',
        tags: '{}',
        pageCount: q.pageCount,
        status: q.paused ? 'paused' : 'queued',
        queuePosition: q.pos ?? q.id,
      })),
  ),
  pauseQueued: vi.fn(async (id: number) => {
    const item = queue.find((q) => q.id === id);
    if (item) item.paused = true;
  }),
  resumeQueued: vi.fn(async (id: number) => {
    const item = queue.find((q) => q.id === id);
    if (item) item.paused = false;
  }),
  reorderQueue: vi.fn(async (id: number, newPos: number) => {
    const item = queue.find((q) => q.id === id);
    if (item) item.pos = newPos;
  }),
}));

// getDownload returns a row whose retryCount we can steer per-test (the genuine-
// failure branch reads it to decide whether to schedule another auto-retry).
// Per-test steering for getDownload. Only retryCount was needed by the failure
// tests; status/pageCount were added for the finalize-on-complete tests (the
// Android in-app completion bridge). Unset fields fall back to the old defaults
// (status:'failed', pageCount:0) so existing tests are unaffected.
const downloadRows = new Map<
  number,
  { retryCount?: number; status?: string; pageCount?: number }
>();
const upsertedRows: unknown[] = [];
const errorRows: { galleryId: number; status: string; lastError: string | null }[] = [];
vi.mock('@/lib/db/download', () => ({
  getDownload: vi.fn(async (id: number) => {
    // Explicit per-test override wins; otherwise reflect the same row the
    // reconcile db.query mock returns (adapterRows) so getDownload and the
    // reconcile query are one consistent source for a table; else old defaults.
    const o = downloadRows.get(id);
    const fromAdapter = adapterRows.find((r) => (r as { galleryId: number }).galleryId === id) as
      | { pageCount?: number; status?: string }
      | undefined;
    return {
      galleryId: id,
      title: `G${id}`,
      thumbnail: '/tn',
      tags: '{}',
      pageCount: o?.pageCount ?? fromAdapter?.pageCount ?? 0,
      totalBytes: 0,
      downloadedAt: '',
      status: o?.status ?? fromAdapter?.status ?? 'failed',
      retryCount: o?.retryCount ?? 0,
    };
  }),
  deserializeTags: vi.fn(() => ({})),
  serializeTags: vi.fn(() => '{}'),
  upsertDownload: vi.fn(async (row: unknown) => {
    upsertedRows.push(row);
    // Mirror production: an upsert to a non-'queued' status (e.g. the Android
    // handoff's 'downloading') drops the row out of dequeueNextQueued()/listQueue
    // (which only surface 'queued'/'paused'). Without this the in-memory test
    // queue would keep re-dequeuing the same id forever.
    const r = row as { galleryId: number; status?: string };
    if (r.status && r.status !== 'queued' && r.status !== 'paused') {
      const idx = queueRef().findIndex((q) => q.id === r.galleryId);
      if (idx >= 0) queueRef().splice(idx, 1);
    }
  }),
  setDownloadError: vi.fn(async (galleryId: number, status: string, lastError: string | null) => {
    errorRows.push({ galleryId, status, lastError });
    const prev = downloadRows.get(galleryId) ?? {};
    downloadRows.set(galleryId, { ...prev, status });
  }),
}));

// Forward-reference to the shared in-memory queue (declared below) so the
// upsertDownload mock can drop handed-off rows. Defined as a getter because the
// `queue` const is initialized after this mock factory is hoisted.
function queueRef(): { id: number; pageCount: number; paused?: boolean; pos?: number }[] {
  return queue;
}

// ── Android worker handoff seam (Task C) ──────────────────────────────────────
// isAndroid() is steered per-test; the DownloadWorker plugin is fully mocked so
// no native call happens. buildWorkOrder/galleryFolderName run for real (pure).
let androidFlag = false;
let iosFlag = false;
vi.mock('@/lib/utils/platform', () => ({
  isAndroid: () => androidFlag,
  // iOS (Task D): keeps the in-process downloader AND schedules a BG backstop.
  isIos: () => iosFlag,
  // url-resolver (pulled in by buildWorkOrder → getNativeHeaders) imports
  // isNativePlatform; keep it false so headers default to {} in the test.
  isNativePlatform: () => false,
  isTauri: () => false,
  isCapacitor: () => false,
}));

const workOrderWrites: { galleryId: string; json: string }[] = [];
const workerEnqueues: string[] = [];
const workerCancels: string[] = [];
// Steerable: when true, writeWorkOrder rejects so the iOS backstop scheduling
// failure path can be exercised (it must NOT fail the foreground download).
const workerWriteThrows = { value: false };
// Steers DownloadWorker.getProgress for the poller tests (in-app progress bridge).
// Default: no progress file yet ({current:null}) so handoff tests' polls are inert.
const workerProgress: {
  value: { current: number; total: number } | { current: null; error?: string };
} = {
  value: { current: null },
};
vi.mock('@/lib/plugins/downloadWorker', () => ({
  DownloadWorker: {
    writeWorkOrder: vi.fn(async (o: { galleryId: string; json: string }) => {
      if (workerWriteThrows.value) throw new Error('writeWorkOrder failed');
      workOrderWrites.push(o);
    }),
    enqueue: vi.fn(async (o: { galleryId: string }) => {
      workerEnqueues.push(o.galleryId);
    }),
    cancel: vi.fn(async (o: { galleryId: string }) => {
      workerCancels.push(o.galleryId);
      return { remaining: 0 };
    }),
    // Steerable per-test (in-app progress bridge). Default: no progress file yet
    // ({current:null}) so the handoff tests' poll ticks are inert no-ops.
    getProgress: vi.fn(async () => workerProgress.value),
  },
}));

// Auto-retry helpers (Task E). scheduleAutoRetry records calls; the due-list +
// earliest are steered per-test.
const scheduled: { id: number; attempt: number; dueAt: string }[] = [];
let scheduleThrows = false;
let dueRows: { galleryId: number; title: string; thumbnail: string; tags: string }[] = [];
let earliest: string | null = null;
vi.mock('@/lib/db/download-retry', () => ({
  AUTO_RETRY_BACKOFF_MS: [30_000, 300_000, 1_800_000],
  AUTO_RETRY_MAX: 3,
  scheduleAutoRetry: vi.fn(async (id: number, attempt: number, dueAt: string) => {
    if (scheduleThrows) throw new Error('schedule failed');
    scheduled.push({ id, attempt, dueAt });
  }),
  listDueAutoRetries: vi.fn(async () => dueRows),
  earliestNextRetryAt: vi.fn(async () => earliest),
  clearAutoRetry: vi.fn(async () => {}),
}));

vi.mock('@/lib/api/client', () => ({
  getGgConfig: vi.fn(async () => ({
    pathCode: 'x',
    mDefault: 0,
    mCases: new Set(),
    mCaseValue: 1,
  })),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, msg: string) {
      super(msg);
      this.status = status;
    }
  },
}));

vi.mock('@/features/gallery-detail/hooks/useGalleryDetail', () => ({
  resolveGalleryDetail: vi.fn(async (id: number) => ({
    files: [
      {
        name: `${id}.webp`,
        hash: 'h',
        width: 1,
        height: 1,
        haswebp: 1,
        hasavif: 0,
        hasavifsmalltn: 0,
      },
    ],
  })),
}));

// reconcile-queue deps
const adapterRows: unknown[] = [];
vi.mock('@/lib/db/adapter', () => ({
  ensureDb: vi.fn(async () => ({ query: vi.fn(async () => adapterRows) })),
}));

const unmetered = vi.fn(async () => true);
vi.mock('@/lib/utils/network', () => ({
  isUnmeteredNetwork: () => unmetered(),
}));

import {
  processQueue,
  useDownloadProgressStore,
  startAndroidProgressPoll,
  stopAndroidProgressPoll,
  finalizeDownloadIfComplete,
} from '../download-progress';
import { DownloadWorker } from '@/lib/plugins/downloadWorker';
import * as queueOps from '@/lib/db/download-queue';
import { resolveGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';

beforeEach(async () => {
  queue.length = 0;
  removed.length = 0;
  enqueued.length = 0;
  adapterRows.length = 0;
  scheduled.length = 0;
  scheduleThrows = false;
  dueRows = [];
  earliest = null;
  downloadRows.clear();
  manifestPages.clear();
  upsertedRows.length = 0;
  errorRows.length = 0;
  workOrderWrites.length = 0;
  workerEnqueues.length = 0;
  workerCancels.length = 0;
  workerWriteThrows.value = false;
  workerProgress.value = { current: null };
  ensureDownloadStoreReady.mockReset();
  ensureDownloadStoreReady.mockResolvedValue(undefined);
  vi.mocked(DownloadWorker.getProgress).mockClear();
  stopAndroidProgressPoll();
  androidFlag = false;
  iosFlag = false;
  dl.mockReset();
  vi.mocked(resolveGalleryDetail).mockClear();
  unmetered.mockReset();
  unmetered.mockResolvedValue(true);
  useDownloadProgressStore.setState({
    entries: {},
    downloaded: {},
    queue: [],
    globalPaused: false,
  });
  // Clear the module-level globalPaused flag (queue is already empty, so this is
  // a pure reset — it kicks an empty processQueue which is a no-op).
  await useDownloadProgressStore.getState().resumeAll();
});

describe('processQueue (AC-005)', () => {
  it('processes queued items sequentially in order and advances on complete', async () => {
    queue.push({ id: 1, pageCount: 0 }, { id: 2, pageCount: 0 }, { id: 3, pageCount: 0 });
    const order: number[] = [];
    dl.mockImplementation(async (id: number) => {
      order.push(id);
    });

    await processQueue();

    expect(order).toEqual([1, 2, 3]);
    // each completed item is removed + marked downloaded
    expect(removed).toEqual([1, 2, 3]);
    expect(useDownloadProgressStore.getState().downloaded[1]).toBe(true);
    expect(useDownloadProgressStore.getState().downloaded[3]).toBe(true);
  });

  it('single-flight: a concurrent processQueue() does not double-run an item', async () => {
    queue.push({ id: 1, pageCount: 0 });
    let active = 0;
    let maxActive = 0;
    dl.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });

    // Fire two loops "at once".
    const p1 = processQueue();
    const p2 = processQueue();
    await Promise.all([p1, p2]);

    expect(maxActive).toBe(1);
    expect(dl).toHaveBeenCalledTimes(1);
  });

  it('passes resume:true when the item has prior pages', async () => {
    queue.push({ id: 5, pageCount: 4 });
    dl.mockResolvedValue(undefined);
    await processQueue();
    const opts = dl.mock.calls[0][8] as { resume: boolean };
    expect(opts.resume).toBe(true);
  });

  it('pause branch: DownloadPausedError leaves the item in the queue (not removed)', async () => {
    queue.push({ id: 9, pageCount: 2 });
    // download-zip would write status 'paused'; mirror that here so the item is
    // no longer dequeued (otherwise the processor loops on it forever — which is
    // exactly the production behavior the SQL status filter prevents).
    dl.mockImplementation(async (id: number) => {
      const item = queue.find((q) => q.id === id);
      if (item) item.paused = true;
      throw new DownloadPausedError();
    });
    await processQueue();
    // Not removed from the queue (still present, just paused).
    expect(removed).not.toContain(9);
    expect(queue.find((q) => q.id === 9)).toBeTruthy();
  });

  it('genuine failure: removes from queue, surfaces error entry, advances', async () => {
    queue.push({ id: 1, pageCount: 0 }, { id: 2, pageCount: 0 });
    dl.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    dl.mockImplementationOnce(async () => {});
    await processQueue();
    expect(removed).toContain(1);
    expect(removed).toContain(2);
    expect(useDownloadProgressStore.getState().entries[1]?.error).toBe('boom');
  });

  it('detail resolution failure schedules the same automatic retry path as download failures', async () => {
    queue.push({ id: 44, pageCount: 2 });
    downloadRows.set(44, { retryCount: 1, status: 'failed', pageCount: 2 });
    vi.mocked(resolveGalleryDetail).mockRejectedValueOnce(new Error('detail unavailable'));

    await processQueue();

    expect(errorRows).toContainEqual({
      galleryId: 44,
      status: 'failed',
      lastError: 'Failed to resolve gallery',
    });
    expect(removed).toContain(44);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ id: 44, attempt: 2 });
    expect(useDownloadProgressStore.getState().entries[44]?.retryAt).toBe(scheduled[0].dueAt);
  });
});

describe('Android worker handoff (Task C, AC-005)', () => {
  it('hands off to the native worker instead of the in-process downloader', async () => {
    androidFlag = true;
    queue.push({ id: 100, pageCount: 0 });
    dl.mockResolvedValue(undefined);

    await processQueue();

    // The in-process downloader is NEVER called on Android.
    expect(dl).not.toHaveBeenCalled();
    // The work-order was written + the worker enqueued for this gallery.
    expect(workOrderWrites.map((w) => w.galleryId)).toContain('100');
    expect(workerEnqueues).toContain('100');
    // A 'downloading' (background) row was upserted (not removed) so reconcile
    // can finalize it; the store surfaces a background entry.
    const upserted = upsertedRows.find((r) => (r as { galleryId: number }).galleryId === 100) as
      | { status: string; pageCount: number }
      | undefined;
    expect(upserted?.status).toBe('downloading');
    expect(upserted?.pageCount).toBe(1); // resolveGalleryDetail returns 1 file
    expect(useDownloadProgressStore.getState().entries[100]?.progress?.total).toBe(1);
  });

  it('the work-order JSON carries pages with index/url/ext/relPath/headers', async () => {
    androidFlag = true;
    queue.push({ id: 200, pageCount: 0 });
    await processQueue();

    const write = workOrderWrites.find((w) => w.galleryId === '200');
    expect(write).toBeTruthy();
    const order = JSON.parse(write!.json);
    expect(order.galleryId).toBe(200);
    expect(order.pages).toHaveLength(1);
    const page = order.pages[0];
    expect(page).toHaveProperty('index', 0);
    expect(page).toHaveProperty('url');
    expect(page).toHaveProperty('ext');
    expect(page.relPath).toMatch(/^HiPaGo\/200.*\/0001\./);
    expect(page).toHaveProperty('headers');
  });

  it('drains the whole queue, handing every gallery to the worker', async () => {
    androidFlag = true;
    queue.push({ id: 1, pageCount: 0 }, { id: 2, pageCount: 0 }, { id: 3, pageCount: 0 });
    await processQueue();
    expect(workerEnqueues.sort()).toEqual(['1', '2', '3']);
    expect(dl).not.toHaveBeenCalled();
  });

  it('surfaces every handed-off Android download in the manager queue', async () => {
    androidFlag = true;
    queue.push({ id: 1, pageCount: 0 }, { id: 2, pageCount: 0 }, { id: 3, pageCount: 0 });

    await processQueue();
    await useDownloadProgressStore.getState().refreshQueue();

    const managerRows = useDownloadProgressStore.getState().queue;
    expect(managerRows.map((q) => q.id).sort()).toEqual([1, 2, 3]);
    expect(managerRows.every((q) => q.status === 'downloading')).toBe(true);
    expect(managerRows.every((q) => q.progress?.total === 1)).toBe(true);
  });

  it('marks Android handoff failures as failed rows before removing them from the queue', async () => {
    androidFlag = true;
    workerWriteThrows.value = true;
    queue.push({ id: 250, pageCount: 0 });
    downloadRows.set(250, { retryCount: 0, status: 'failed', pageCount: 0 });

    await processQueue();

    expect(dl).not.toHaveBeenCalled();
    expect(workerEnqueues).not.toContain('250');
    expect(errorRows).toContainEqual({
      galleryId: 250,
      status: 'failed',
      lastError: 'writeWorkOrder failed',
    });
    expect(removed).toContain(250);
    expect(useDownloadProgressStore.getState().entries[250]?.error).toBe('writeWorkOrder failed');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ id: 250, attempt: 1 });
    expect(useDownloadProgressStore.getState().entries[250]?.retryAt).toBe(scheduled[0].dueAt);
  });

  it('fails Android handoff before writing work-order when download storage is not ready', async () => {
    androidFlag = true;
    ensureDownloadStoreReady.mockRejectedValueOnce(new Error('Select a download folder'));
    queue.push({ id: 251, pageCount: 0 });
    downloadRows.set(251, { retryCount: 0, status: 'failed', pageCount: 0 });

    await processQueue();

    expect(workOrderWrites).toEqual([]);
    expect(workerEnqueues).not.toContain('251');
    expect(errorRows).toContainEqual({
      galleryId: 251,
      status: 'failed',
      lastError: 'Select a download folder',
    });
    expect(removed).toContain(251);
  });

  it('drops Android queue item without failure when storage setup is cancelled', async () => {
    androidFlag = true;
    ensureDownloadStoreReady.mockRejectedValueOnce(new DownloadCancelledError('cancelled'));
    queue.push({ id: 252, pageCount: 0 });

    await processQueue();

    expect(workOrderWrites).toEqual([]);
    expect(workerEnqueues).not.toContain('252');
    expect(errorRows).toEqual([]);
    expect(scheduled).toEqual([]);
    expect(removed).toContain(252);
    expect(useDownloadProgressStore.getState().entries[252]).toBeUndefined();
  });

  it('non-Android still runs the in-process downloader (no worker call)', async () => {
    androidFlag = false;
    queue.push({ id: 300, pageCount: 0 });
    const order: number[] = [];
    dl.mockImplementation(async (id: number) => {
      order.push(id);
    });

    await processQueue();

    expect(order).toEqual([300]);
    expect(workOrderWrites).toEqual([]);
    expect(workerEnqueues).toEqual([]);
  });

  it('cancel on Android drops the work-order via the worker plugin', async () => {
    androidFlag = true;
    // No active controller / queue entry — simulate an item already handed off.
    useDownloadProgressStore.getState().cancel(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(workerCancels).toContain('100');
  });

  it('cancel on Android marks a handed-off row failed so it does not stay downloading', async () => {
    androidFlag = true;
    downloadRows.set(101, { status: 'downloading', pageCount: 5 });
    useDownloadProgressStore.setState({
      entries: { 101: { progress: { current: 2, total: 5 }, error: null } },
    });

    useDownloadProgressStore.getState().cancel(101);
    await Promise.resolve();
    await Promise.resolve();

    expect(errorRows).toContainEqual({
      galleryId: 101,
      status: 'failed',
      lastError: 'Cancelled',
    });
    expect(useDownloadProgressStore.getState().entries[101]).toBeUndefined();
  });
});

// ── Android in-app live-progress poller (in-app progress bridge, AC-003) ──────
describe('Android live-progress poller (AC-003)', () => {
  it('updates entries[id].progress over poll ticks from getProgress', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = true;
      // Seed an active downloading entry (as the handoff branch would).
      useDownloadProgressStore.setState({
        entries: { 500: { progress: { current: 0, total: 10 }, error: null } },
      });

      workerProgress.value = { current: 3, total: 10 };
      startAndroidProgressPoll(500);
      // Immediate first read + let its await settle.
      await vi.advanceTimersByTimeAsync(0);
      expect(useDownloadProgressStore.getState().entries[500]?.progress).toEqual({
        current: 3,
        total: 10,
      });

      // Next tick advances further.
      workerProgress.value = { current: 7, total: 10 };
      await vi.advanceTimersByTimeAsync(1000);
      expect(useDownloadProgressStore.getState().entries[500]?.progress).toEqual({
        current: 7,
        total: 10,
      });
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });

  it('keeps the placeholder progress when getProgress returns {current:null} before worker start', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = true;
      useDownloadProgressStore.setState({
        entries: { 501: { progress: { current: 0, total: 8 }, error: null } },
      });
      workerProgress.value = { current: 0, total: 8 };
      startAndroidProgressPoll(501);
      await vi.advanceTimersByTimeAsync(0);

      // Worker has not published a file yet → null this tick; placeholder sticks.
      workerProgress.value = { current: null };
      await vi.advanceTimersByTimeAsync(1000);
      expect(useDownloadProgressStore.getState().entries[501]?.progress).toEqual({
        current: 0,
        total: 8,
      });
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });

  it('marks Android handoff failed when progress disappears after work began and manifest is incomplete', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = true;
      downloadRows.set(503, { status: 'downloading', pageCount: 8, retryCount: 0 });
      useDownloadProgressStore.setState({
        entries: { 503: { progress: { current: 4, total: 8 }, error: null } },
      });
      workerProgress.value = { current: 4, total: 8 };
      startAndroidProgressPoll(503);
      await vi.advanceTimersByTimeAsync(0);

      workerProgress.value = { current: null };
      await vi.advanceTimersByTimeAsync(1000);

      expect(errorRows).toContainEqual({
        galleryId: 503,
        status: 'failed',
        lastError: 'Background download stopped before completion',
      });
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({ id: 503, attempt: 1 });
      expect(useDownloadProgressStore.getState().entries[503]?.error).toBe(
        'Background download stopped before completion',
      );
      expect(useDownloadProgressStore.getState().entries[503]?.retryAt).toBe(scheduled[0].dueAt);
      const callsAfterFailure = vi.mocked(DownloadWorker.getProgress).mock.calls.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(vi.mocked(DownloadWorker.getProgress).mock.calls.length).toBe(callsAfterFailure);
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });

  it('marks Android handoff failed when the native worker reports a terminal error before progress advances', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = true;
      downloadRows.set(504, { status: 'downloading', pageCount: 8, retryCount: 0 });
      useDownloadProgressStore.setState({
        entries: { 504: { progress: { current: 0, total: 8 }, error: null } },
      });

      workerProgress.value = { current: null, error: 'Background download failed' };
      startAndroidProgressPoll(504);
      await vi.advanceTimersByTimeAsync(0);

      expect(errorRows).toContainEqual({
        galleryId: 504,
        status: 'failed',
        lastError: 'Background download failed',
      });
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({ id: 504, attempt: 1 });
      expect(useDownloadProgressStore.getState().entries[504]?.error).toBe(
        'Background download failed',
      );
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });

  it('stops polling once the entry clears (completion/removal)', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = true;
      useDownloadProgressStore.setState({
        entries: { 502: { progress: { current: 1, total: 5 }, error: null } },
      });
      workerProgress.value = { current: 1, total: 5 };
      startAndroidProgressPoll(502);
      await vi.advanceTimersByTimeAsync(0);

      // Completion clears the entry (reconcile/cancel does this in production).
      useDownloadProgressStore.setState({ entries: {} });
      const callsBefore = vi.mocked(DownloadWorker.getProgress).mock.calls.length;
      // The next tick sees no entry → self-stops; further ticks make no calls.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(5000);
      const callsAfter = vi.mocked(DownloadWorker.getProgress).mock.calls.length;
      // At most one more call (the tick that detected the cleared entry); then quiet.
      expect(callsAfter - callsBefore).toBeLessThanOrEqual(1);
      const settled = vi.mocked(DownloadWorker.getProgress).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.mocked(DownloadWorker.getProgress).mock.calls.length).toBe(settled);
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });

  it('uses a SINGLE timer while polling every active Android handoff', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = true;
      useDownloadProgressStore.setState({
        entries: {
          600: { progress: { current: 0, total: 3 }, error: null },
          601: { progress: { current: 0, total: 4 }, error: null },
        },
      });
      startAndroidProgressPoll(600);
      await vi.advanceTimersByTimeAsync(0);
      // A second handoff joins the same poller instead of replacing the first.
      startAndroidProgressPoll(601);
      await vi.advanceTimersByTimeAsync(0);

      // Both active rows are polled going forward, so the current WorkManager
      // gallery can advance even when it was not the last id handed off.
      vi.mocked(DownloadWorker.getProgress).mockClear();
      await vi.advanceTimersByTimeAsync(1000);
      const polledIds = vi
        .mocked(DownloadWorker.getProgress)
        .mock.calls.map((c) => (c[0] as { galleryId: string }).galleryId);
      expect(polledIds).toContain('600');
      expect(polledIds).toContain('601');
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });

  it('does not poll on non-Android platforms', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = false;
      useDownloadProgressStore.setState({
        entries: { 700: { progress: { current: 0, total: 2 }, error: null } },
      });
      startAndroidProgressPoll(700);
      await vi.advanceTimersByTimeAsync(2000);
      expect(vi.mocked(DownloadWorker.getProgress)).not.toHaveBeenCalled();
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });

  it('the Android handoff starts the poller for the handed-off gallery', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = true;
      queue.push({ id: 800, pageCount: 0 });
      workerProgress.value = { current: 1, total: 1 };

      await processQueue();
      // The handoff set a placeholder entry and started polling; a tick reads it.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.mocked(DownloadWorker.getProgress)).toHaveBeenCalledWith({ galleryId: '800' });
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });

  it('refreshDownloaded restores an Android background row after navigation back', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = true;
      downloadRows.set(801, { status: 'downloading', pageCount: 9 });

      await useDownloadProgressStore.getState().refreshDownloaded(801);
      await vi.advanceTimersByTimeAsync(0);

      expect(useDownloadProgressStore.getState().downloaded[801]).toBe(false);
      expect(useDownloadProgressStore.getState().entries[801]?.progress).toEqual({
        current: 0,
        total: 9,
      });
      expect(vi.mocked(DownloadWorker.getProgress)).toHaveBeenCalledWith({ galleryId: '801' });
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });

  it('refreshDownloaded verifies files before trusting a complete DB row', async () => {
    downloadRows.set(802, { status: 'complete', pageCount: 2 });
    manifestPages.set(802, [
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);

    await useDownloadProgressStore.getState().refreshDownloaded(802);

    expect(useDownloadProgressStore.getState().downloaded[802]).toBe(true);
  });

  it('refreshDownloaded does not mark complete when the DB row is complete but files are missing', async () => {
    downloadRows.set(803, { status: 'complete', pageCount: 2 });

    await useDownloadProgressStore.getState().refreshDownloaded(803);

    expect(useDownloadProgressStore.getState().downloaded[803]).toBe(false);
    expect(useDownloadProgressStore.getState().entries[803]).toBeUndefined();
  });
});

// ── Android in-app completion bridge (finalize without relaunch) ──────────────
// Regression: after the worker finished every page the row stayed 'downloading'
// (shown as "진행중") until the next app launch reconciled it, because the poller
// only updated progress and never finalized. The poller now confirms completion
// from the on-disk manifest and flips the row to 'complete' in-app.
describe('finalizeDownloadIfComplete (shared completion rule)', () => {
  it('marks a downloading row complete when the manifest covers all pages', async () => {
    downloadRows.set(900, { status: 'downloading', pageCount: 3 });
    manifestPages.set(900, [
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
      { index: 2, ext: 'webp' },
    ]);
    const done = await finalizeDownloadIfComplete(900);
    expect(done).toBe(true);
    const upsert = upsertedRows.at(-1) as { galleryId: number; status: string; pageCount: number };
    expect(upsert).toMatchObject({ galleryId: 900, status: 'complete', pageCount: 3 });
  });

  it('does NOT finalize when the manifest is short of pageCount', async () => {
    downloadRows.set(901, { status: 'downloading', pageCount: 5 });
    manifestPages.set(901, [
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    const done = await finalizeDownloadIfComplete(901);
    expect(done).toBe(false);
    expect(upsertedRows).toHaveLength(0);
  });

  it('does NOT finalize when the manifest has stale extra pages beyond pageCount', async () => {
    downloadRows.set(905, { status: 'downloading', pageCount: 3 });
    manifestPages.set(905, [
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
      { index: 2, ext: 'webp' },
      { index: 3, ext: 'webp' },
    ]);
    const done = await finalizeDownloadIfComplete(905);
    expect(done).toBe(false);
    expect(upsertedRows).toHaveLength(0);
  });

  it('does NOT finalize a not-yet-started row with an empty manifest', async () => {
    downloadRows.set(902, { status: 'downloading', pageCount: 4 });
    // manifestPages has no entry for 902 → []
    const done = await finalizeDownloadIfComplete(902);
    expect(done).toBe(false);
    expect(upsertedRows).toHaveLength(0);
  });

  it('does NOT finalize when manifest length covers pageCount but a page is missing on disk', async () => {
    downloadRows.set(904, { status: 'downloading', pageCount: 2 });
    manifestPages.set(904, [
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    vi.mocked(hasCompleteDownloadedGallery).mockResolvedValueOnce(false);
    const done = await finalizeDownloadIfComplete(904);
    expect(done).toBe(false);
    expect(upsertedRows).toHaveLength(0);
  });

  it('reports already-complete rows as complete without re-upserting', async () => {
    downloadRows.set(903, { status: 'complete', pageCount: 2 });
    const done = await finalizeDownloadIfComplete(903);
    expect(done).toBe(true);
    expect(upsertedRows).toHaveLength(0);
  });
});

describe('Android poller finalizes completion in-app (AC-003)', () => {
  it('flips the row to complete + clears the entry when progress reaches total', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = true;
      downloadRows.set(910, { status: 'downloading', pageCount: 2 });
      manifestPages.set(910, [
        { index: 0, ext: 'webp' },
        { index: 1, ext: 'webp' },
      ]);
      useDownloadProgressStore.setState({
        entries: { 910: { progress: { current: 1, total: 2 }, error: null } },
      });
      workerProgress.value = { current: 2, total: 2 };
      startAndroidProgressPoll(910);
      await vi.advanceTimersByTimeAsync(0);

      expect(useDownloadProgressStore.getState().entries[910]).toBeUndefined();
      expect(useDownloadProgressStore.getState().downloaded[910]).toBe(true);
      const upsert = upsertedRows.at(-1) as { galleryId: number; status: string };
      expect(upsert).toMatchObject({ galleryId: 910, status: 'complete' });
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });

  it('finalizes when getProgress returns {current:null} but the manifest is complete', async () => {
    // The worker deletes its progress file on completion, so the LAST signal the
    // poller often sees is {current:null}. This is the exact bug scenario.
    vi.useFakeTimers();
    try {
      androidFlag = true;
      downloadRows.set(911, { status: 'downloading', pageCount: 1 });
      manifestPages.set(911, [{ index: 0, ext: 'webp' }]);
      useDownloadProgressStore.setState({
        entries: { 911: { progress: { current: 1, total: 1 }, error: null } },
      });
      workerProgress.value = { current: null };
      startAndroidProgressPoll(911);
      await vi.advanceTimersByTimeAsync(0);

      expect(useDownloadProgressStore.getState().entries[911]).toBeUndefined();
      expect(useDownloadProgressStore.getState().downloaded[911]).toBe(true);
      const upsert = upsertedRows.at(-1) as { galleryId: number; status: string };
      expect(upsert).toMatchObject({ galleryId: 911, status: 'complete' });
    } finally {
      stopAndroidProgressPoll();
      vi.useRealTimers();
    }
  });
});

// ── iOS best-effort background backstop (Task D, AC-004/AC-005) ────────────────
describe('iOS background backstop (Task D)', () => {
  it('runs the in-process downloader AND schedules the BG backstop', async () => {
    iosFlag = true;
    queue.push({ id: 400, pageCount: 0 });
    const order: number[] = [];
    dl.mockImplementation(async (id: number) => {
      order.push(id);
    });

    await processQueue();

    // The in-process foreground downloader IS still invoked on iOS.
    expect(order).toEqual([400]);
    // AND the work-order was written + the BG task enqueued as a backstop.
    expect(workOrderWrites.map((w) => w.galleryId)).toContain('400');
    expect(workerEnqueues).toContain('400');
  });

  it('iOS work-order JSON uses the numeric downloads/<id>/ layout (not HiPaGo/<id title>)', async () => {
    iosFlag = true;
    queue.push({ id: 401, pageCount: 0 });
    dl.mockResolvedValue(undefined);

    await processQueue();

    const write = workOrderWrites.find((w) => w.galleryId === '401');
    expect(write).toBeTruthy();
    const orderJson = JSON.parse(write!.json);
    expect(orderJson.galleryId).toBe(401);
    expect(orderJson.folderName).toBe('401'); // numeric-only, no title
    expect(orderJson.pages).toHaveLength(1);
    const page = orderJson.pages[0];
    expect(page).toHaveProperty('index', 0);
    expect(page).toHaveProperty('url');
    expect(page).toHaveProperty('ext');
    expect(page).toHaveProperty('headers');
    // iOS layout: downloads/<id>/NNNN.ext — NOT the Android HiPaGo/<id title>/.
    expect(page.relPath).toMatch(/^downloads\/401\/0001\./);
    expect(page.relPath).not.toMatch(/^HiPaGo\//);
  });

  it('on successful in-process download, drops the iOS backstop work-order', async () => {
    iosFlag = true;
    queue.push({ id: 402, pageCount: 0 });
    dl.mockResolvedValue(undefined);

    await processQueue();

    // Completion clears the backstop (DownloadWorker.cancel) so the BG task does
    // not re-download an already-complete gallery.
    expect(workerCancels).toContain('402');
    expect(useDownloadProgressStore.getState().downloaded[402]).toBe(true);
  });

  it('a backstop scheduling failure does NOT fail the foreground download', async () => {
    iosFlag = true;
    queue.push({ id: 403, pageCount: 0 });
    // The plugin throws on writeWorkOrder; the foreground download must still run
    // and complete (the backstop is best-effort).
    workerWriteThrows.value = true;
    const order: number[] = [];
    dl.mockImplementation(async (id: number) => {
      order.push(id);
    });

    await processQueue();

    expect(order).toEqual([403]);
    expect(removed).toContain(403);
    expect(useDownloadProgressStore.getState().downloaded[403]).toBe(true);
  });

  it('non-iOS (web/Tauri) does NOT schedule a backstop', async () => {
    iosFlag = false;
    androidFlag = false;
    queue.push({ id: 404, pageCount: 0 });
    dl.mockResolvedValue(undefined);

    await processQueue();

    expect(workOrderWrites).toEqual([]);
    expect(workerEnqueues).toEqual([]);
  });

  it('cancel of an active iOS download drops the backstop work-order', async () => {
    iosFlag = true;
    queue.push({ id: 405, pageCount: 2 });
    // Hold the download open so a controller exists when we cancel: the mock
    // resolves only after the cancel side-effect has been asserted.
    const deferred: { resolve: () => void } = { resolve: () => {} };
    dl.mockImplementation(
      () =>
        new Promise<void>((res) => {
          deferred.resolve = res;
        }),
    );

    const run = processQueue();
    await new Promise((r) => setTimeout(r, 1));
    useDownloadProgressStore.getState().cancel(405);
    await Promise.resolve();
    // The active-controller cancel branch drops the iOS backstop work-order.
    expect(workerCancels).toContain('405');
    // Let the (aborted) download settle so processQueue can finish.
    deferred.resolve();
    await run;
  });

  it('pause of an active iOS download drops the backstop work-order', async () => {
    iosFlag = true;
    queue.push({ id: 406, pageCount: 2 });
    dl.mockImplementation(
      async (...a: unknown[]) =>
        new Promise<void>((_res, rej) => {
          const opts = a[8] as { isPauseSignal: () => boolean };
          setTimeout(() => {
            rej(opts.isPauseSignal() ? new DownloadPausedError() : new Error('not paused'));
          }, 5);
        }),
    );

    const run = processQueue();
    await new Promise((r) => setTimeout(r, 1));
    await useDownloadProgressStore.getState().pause(406);

    expect(workerCancels).toContain('406');
    await run;
  });
});

describe('cancel (AC-005)', () => {
  it('cancel of a queued-but-not-started item removes it without aborting', async () => {
    queue.push({ id: 42, pageCount: 0 });
    // No active controller for 42 → cancel goes through removeFromQueue.
    useDownloadProgressStore.getState().cancel(42);
    // removeFromQueue is fire-and-forget; flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(removed).toContain(42);
  });

  it('Android cancel of a queued-but-not-started item removes it without marking failure', async () => {
    androidFlag = true;
    queue.push({ id: 43, pageCount: 0 });
    useDownloadProgressStore.setState({
      entries: { 43: { progress: null, error: null, queued: true, position: 1 } },
    });

    useDownloadProgressStore.getState().cancel(43);
    await Promise.resolve();
    await Promise.resolve();

    expect(workerCancels).toContain('43');
    expect(removed).toContain(43);
    expect(errorRows).not.toContainEqual({
      galleryId: 43,
      status: 'failed',
      lastError: 'Cancelled',
    });
    expect(useDownloadProgressStore.getState().entries[43]).toBeUndefined();
  });
});

// ── Auto-restart of failed downloads (Task E) ───────────────────────────────

describe('auto-retry scheduling on genuine failure (AC-003)', () => {
  it('schedules the next auto-retry on a genuine failure when attempts remain', async () => {
    queue.push({ id: 1, pageCount: 0 });
    downloadRows.set(1, { retryCount: 0 }); // fresh: 0 attempts used
    dl.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    await processQueue();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].id).toBe(1);
    expect(scheduled[0].attempt).toBe(1); // retryCount + 1
    // Store entry surfaces the pending retry (retryAt + attempt).
    const entry = useDownloadProgressStore.getState().entries[1];
    expect(entry?.error).toBe('boom');
    expect(entry?.retryAt).toBe(scheduled[0].dueAt);
    expect(entry?.attempt).toBe(1);
  });

  it('escalates the attempt number from the existing retryCount', async () => {
    queue.push({ id: 1, pageCount: 2 });
    downloadRows.set(1, { retryCount: 1 }); // already used 1 auto-attempt
    dl.mockImplementationOnce(async () => {
      throw new Error('boom2');
    });

    await processQueue();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].attempt).toBe(2);
  });

  it('does NOT schedule once the attempt cap (AUTO_RETRY_MAX) is reached', async () => {
    queue.push({ id: 1, pageCount: 2 });
    downloadRows.set(1, { retryCount: 3 }); // === AUTO_RETRY_MAX → exhausted
    dl.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    await processQueue();

    expect(scheduled).toHaveLength(0);
    // Plain failed entry, no retryAt.
    const entry = useDownloadProgressStore.getState().entries[1];
    expect(entry?.error).toBe('boom');
    expect(entry?.retryAt == null).toBe(true);
  });

  it('shows a plain failed entry when persisting the auto-retry schedule fails', async () => {
    queue.push({ id: 1, pageCount: 2 });
    downloadRows.set(1, { retryCount: 0 });
    scheduleThrows = true;
    dl.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    await processQueue();

    expect(scheduled).toHaveLength(0);
    const entry = useDownloadProgressStore.getState().entries[1];
    expect(entry?.error).toBe('boom');
    expect(entry?.retryAt == null).toBe(true);
  });

  it('does NOT schedule on a user cancel (AbortError)', async () => {
    queue.push({ id: 1, pageCount: 2 });
    downloadRows.set(1, { retryCount: 0 });
    dl.mockImplementationOnce(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });

    await processQueue();

    expect(scheduled).toHaveLength(0);
  });
});

describe('auto-retry scheduler timer (AC-004)', () => {
  it('fires due rows and re-enqueues them (keepRetryState) when unmetered', async () => {
    vi.useFakeTimers();
    try {
      const { armAutoRetryTimer } = await import('../download-progress');
      unmetered.mockResolvedValue(true);
      // One row due ~30s out; the timer should fire it.
      earliest = new Date(Date.now() + 30_000).toISOString();
      dueRows = [{ galleryId: 77, title: 'G77', thumbnail: '/tn', tags: '{}' }];
      dl.mockResolvedValue(undefined);

      armAutoRetryTimer();
      // Let the async earliestNextRetryAt() resolve so the timer is set.
      await vi.advanceTimersByTimeAsync(0);
      // Advance past the due time → handler fires.
      await vi.advanceTimersByTimeAsync(31_000);
      // Flush the fire handler's awaits.
      await vi.advanceTimersByTimeAsync(0);

      const autoRequeue = enqueued.find((e) => (e.meta as { galleryId: number }).galleryId === 77);
      expect(autoRequeue).toBeTruthy();
      expect((autoRequeue!.opts as { keepRetryState?: boolean }).keepRetryState).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an older async re-arm result after a newer arm call supersedes it', async () => {
    vi.useFakeTimers();
    try {
      const retry = await import('@/lib/db/download-retry');
      const { armAutoRetryTimer } = await import('../download-progress');
      unmetered.mockResolvedValue(true);
      dueRows = [{ galleryId: 90, title: 'G90', thumbnail: '/tn', tags: '{}' }];

      let releaseFirst: (() => void) | undefined;
      vi.mocked(retry.earliestNextRetryAt)
        .mockImplementationOnce(
          () =>
            new Promise<string | null>((resolve) => {
              releaseFirst = () => resolve(new Date(Date.now() + 10).toISOString());
            }),
        )
        .mockResolvedValueOnce(null);

      armAutoRetryTimer();
      armAutoRetryTimer();
      await vi.advanceTimersByTimeAsync(0);
      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);

      const staleRequeue = enqueued.find((e) => (e.meta as { galleryId: number }).galleryId === 90);
      expect(staleRequeue).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds (does NOT re-enqueue) due rows when metered', async () => {
    vi.useFakeTimers();
    try {
      const { armAutoRetryTimer } = await import('../download-progress');
      unmetered.mockResolvedValue(false);
      earliest = new Date(Date.now() + 30_000).toISOString();
      dueRows = [{ galleryId: 88, title: 'G88', thumbnail: '/tn', tags: '{}' }];

      armAutoRetryTimer();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.advanceTimersByTimeAsync(0);

      const autoRequeue = enqueued.find((e) => (e.meta as { galleryId: number }).galleryId === 88);
      expect(autoRequeue).toBeFalsy();
      const checksAfterFirstDue = unmetered.mock.calls.length;

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(unmetered.mock.calls.length).toBe(checksAfterFirstDue);

      await vi.advanceTimersByTimeAsync(59_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(unmetered.mock.calls.length).toBeGreaterThan(checksAfterFirstDue);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Android: re-enqueues due rows on a metered network because native worker is CONNECTED-gated', async () => {
    vi.useFakeTimers();
    try {
      androidFlag = true;
      const { armAutoRetryTimer } = await import('../download-progress');
      unmetered.mockResolvedValue(false);
      earliest = new Date(Date.now() + 30_000).toISOString();
      dueRows = [{ galleryId: 89, title: 'G89', thumbnail: '/tn', tags: '{}' }];

      armAutoRetryTimer();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.advanceTimersByTimeAsync(0);

      const autoRequeue = enqueued.find((e) => (e.meta as { galleryId: number }).galleryId === 89);
      expect(autoRequeue).toBeTruthy();
      expect((autoRequeue!.opts as { keepRetryState?: boolean }).keepRetryState).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('queue actions (AC-001 / Task B)', () => {
  it('manual start processes only the tapped gallery and leaves stale queued work parked', async () => {
    queue.push({ id: 80, pageCount: 0, pos: 5 });
    const order: number[] = [];
    dl.mockImplementation(async (id: number) => {
      order.push(id);
    });

    await useDownloadProgressStore.getState().start({
      id: 81,
      title: 'Manual',
      thumbnail: '/tn',
      files: [
        {
          name: 'manual.webp',
          hash: 'h',
          width: 1,
          height: 1,
          haswebp: 1,
          hasavif: 0,
          hasavifsmalltn: 0,
        },
      ],
      tags: {},
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(order).toEqual([81]);
    expect(removed).toContain(81);
    expect(removed).not.toContain(80);
    expect(queue.find((q) => q.id === 80)).toBeTruthy();
  });

  it('start ignores a shorter offline-detail file list when an existing complete row expects more pages', async () => {
    downloadRows.set(71, { status: 'complete', pageCount: 3 });
    vi.mocked(resolveGalleryDetail).mockResolvedValueOnce({
      files: [
        {
          name: 'resolved-1.webp',
          hash: 'h1',
          width: 1,
          height: 1,
          haswebp: 1,
          hasavif: 0,
          hasavifsmalltn: 0,
        },
        {
          name: 'resolved-2.webp',
          hash: 'h2',
          width: 1,
          height: 1,
          haswebp: 1,
          hasavif: 0,
          hasavifsmalltn: 0,
        },
      ],
    } as Awaited<ReturnType<typeof resolveGalleryDetail>>);
    dl.mockResolvedValue(undefined);

    await useDownloadProgressStore.getState().start({
      id: 71,
      title: 'Partial fallback',
      thumbnail: '/tn',
      files: [
        {
          name: 'partial.webp',
          hash: 'h',
          width: 1,
          height: 1,
          haswebp: 1,
          hasavif: 0,
          hasavifsmalltn: 0,
        },
      ],
      tags: {},
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(vi.mocked(resolveGalleryDetail)).toHaveBeenCalledWith(71);
    expect(dl.mock.calls[0][3]).toHaveLength(2);
  });

  it('pause(active) marks the row paused (not failed) and retains its pages', async () => {
    queue.push({ id: 7, pageCount: 3 });
    let paused = false;
    // download-zip: when the abort is a PAUSE signal, it throws DownloadPausedError
    // (mirroring the live seam: opts.isPauseSignal() true → status 'paused').
    dl.mockImplementation(async (...a: unknown[]) => {
      const opts = a[8] as { isPauseSignal: () => boolean };
      // Simulate the in-flight download: pause is requested mid-run.
      await new Promise((r) => setTimeout(r, 5));
      if (opts.isPauseSignal()) {
        const item = queue.find((q) => q.id === 7);
        if (item) item.paused = true; // row stays in queue at its position
        paused = true;
        throw new DownloadPausedError();
      }
    });

    const run = processQueue();
    // Let the processor start the active run, then pause it.
    await new Promise((r) => setTimeout(r, 1));
    await useDownloadProgressStore.getState().pause(7);
    await run;

    expect(paused).toBe(true);
    // Paused → NOT removed from the queue (pages retained for resume).
    expect(removed).not.toContain(7);
    expect(queue.find((q) => q.id === 7)?.paused).toBe(true);
    expect(queue.find((q) => q.id === 7)?.pageCount).toBe(3);
  });

  it('pause(queued) holds a not-yet-started item via pauseQueued', async () => {
    queue.push({ id: 8, pageCount: 0 });
    await useDownloadProgressStore.getState().pause(8);
    expect(vi.mocked(queueOps.pauseQueued)).toHaveBeenCalledWith(8);
    expect(queue.find((q) => q.id === 8)?.paused).toBe(true);
  });

  it('pause(Android handed-off active) cancels native work and persists paused', async () => {
    androidFlag = true;
    downloadRows.set(88, { status: 'downloading', pageCount: 3 });
    useDownloadProgressStore.setState({
      entries: { 88: { progress: { current: 1, total: 3 }, error: null } },
    });

    await useDownloadProgressStore.getState().pause(88);

    expect(workerCancels).toContain('88');
    expect(errorRows).toContainEqual({ galleryId: 88, status: 'paused', lastError: null });
    expect(useDownloadProgressStore.getState().entries[88]).toBeUndefined();
  });

  it('resume re-drives the processor and continues a paused item', async () => {
    queue.push({ id: 9, pageCount: 2, paused: true });
    const order: number[] = [];
    dl.mockImplementation(async (id: number) => {
      order.push(id);
    });

    await useDownloadProgressStore.getState().resume(9);
    // resume() kicks processQueue async; let it drain.
    await new Promise((r) => setTimeout(r, 5));

    expect(vi.mocked(queueOps.resumeQueued)).toHaveBeenCalledWith(9);
    expect(order).toContain(9);
  });

  it('reorder calls reorderQueue for a pending item', async () => {
    queue.push({ id: 10, pageCount: 0, pos: 1 }, { id: 11, pageCount: 0, pos: 2 });
    await useDownloadProgressStore.getState().reorder(11, 0);
    expect(vi.mocked(queueOps.reorderQueue)).toHaveBeenCalledWith(11, 0);
    expect(queue.find((q) => q.id === 11)?.pos).toBe(0);
  });

  it('pauseAll stops auto-advance: a queued item does NOT start under global pause', async () => {
    queue.push({ id: 20, pageCount: 0 }, { id: 21, pageCount: 0 });
    const order: number[] = [];
    dl.mockImplementation(async (id: number) => {
      order.push(id);
    });

    await useDownloadProgressStore.getState().pauseAll();
    expect(useDownloadProgressStore.getState().globalPaused).toBe(true);
    expect(queue.every((q) => q.paused)).toBe(true);

    // Kicking the processor while globally paused must not dequeue anything.
    await processQueue();
    expect(order).toEqual([]);
    expect(removed).toEqual([]);

    // resumeAll clears the gate and drives the queue again.
    await useDownloadProgressStore.getState().resumeAll();
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([20, 21]);
  });

  it('nav-badge selector is true iff the queue is non-empty', async () => {
    const { selectQueueActive } = await import('../download-progress');
    useDownloadProgressStore.setState({ queue: [] });
    expect(selectQueueActive(useDownloadProgressStore.getState())).toBe(false);

    queue.push({ id: 30, pageCount: 0 });
    await useDownloadProgressStore.getState().refreshQueue();
    expect(selectQueueActive(useDownloadProgressStore.getState())).toBe(true);
    expect(useDownloadProgressStore.getState().queue.map((q) => q.id)).toContain(30);
  });
});

describe('reconcileQueue (AC-007)', () => {
  it('re-enqueues zombie downloading rows then kicks the processor when unmetered', async () => {
    adapterRows.push({
      galleryId: 11,
      title: 'Z',
      thumbnail: '/tn',
      tags: '{}',
      pageCount: 3,
      status: 'downloading',
    });
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();
    dl.mockResolvedValue(undefined);

    await reconcileQueue();
    await new Promise((r) => setTimeout(r, 5));

    expect(vi.mocked(queueOps.enqueueDownload)).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 11 }),
      { keepRetryState: true, queuePosition: undefined },
    );
  });

  it('re-enqueues zombie rows with their persisted queue position and retry state', async () => {
    adapterRows.push({
      galleryId: 16,
      title: 'Z',
      thumbnail: '/tn',
      tags: '{}',
      pageCount: 3,
      status: 'downloading',
      queuePosition: 4,
      retryCount: 1,
    });
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();
    dl.mockResolvedValue(undefined);

    await reconcileQueue();
    await new Promise((r) => setTimeout(r, 5));

    expect(vi.mocked(queueOps.enqueueDownload)).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 16 }),
      { keepRetryState: true, queuePosition: 4 },
    );
  });

  it('is idempotent: a second call does nothing (started guard)', async () => {
    adapterRows.push({
      galleryId: 12,
      title: 'Z',
      thumbnail: '/tn',
      tags: '{}',
      pageCount: 3,
      status: 'downloading',
    });
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();
    dl.mockResolvedValue(undefined);

    await reconcileQueue();
    const callsAfterFirst = vi.mocked(queueOps.enqueueDownload).mock.calls.length;
    await reconcileQueue(); // guarded → no-op
    expect(vi.mocked(queueOps.enqueueDownload).mock.calls.length).toBe(callsAfterFirst);
  });

  it('Android: marks a gallery complete when its manifest covers all pages', async () => {
    androidFlag = true;
    // A 'downloading' row targeting 3 pages; the worker finished while away.
    adapterRows.push({
      galleryId: 55,
      title: 'W',
      thumbnail: '/tn',
      tags: '{}',
      pageCount: 3,
      status: 'downloading',
    });
    manifestPages.set(55, [
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
      { index: 2, ext: 'webp' },
    ]);
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();

    await reconcileQueue();
    await new Promise((r) => setTimeout(r, 5));

    const completed = upsertedRows.find((r) => (r as { galleryId: number }).galleryId === 55) as
      | { status: string }
      | undefined;
    expect(completed?.status).toBe('complete');
  });

  it('iOS: does NOT infer completion from manifest length because pageCount is progressive', async () => {
    iosFlag = true;
    // iOS foreground rows store pageCount as current progress, not target total.
    // A background task may have written more pages than that without finishing
    // the full gallery, so launch reconcile must resume instead of completing.
    adapterRows.push({
      galleryId: 57,
      title: 'I',
      thumbnail: '/tn',
      tags: '{}',
      pageCount: 2,
      status: 'downloading',
    });
    manifestPages.set(57, [
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();

    await reconcileQueue();
    await new Promise((r) => setTimeout(r, 5));

    const completed = upsertedRows.find(
      (r) =>
        (r as { galleryId: number }).galleryId === 57 &&
        (r as { status: string }).status === 'complete',
    );
    expect(completed).toBeFalsy();
    expect(vi.mocked(queueOps.enqueueDownload)).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 57 }),
      { keepRetryState: true, queuePosition: undefined },
    );
  });

  it('Android: does NOT mark complete when the manifest is short of the target', async () => {
    androidFlag = true;
    adapterRows.push({
      galleryId: 56,
      title: 'W',
      thumbnail: '/tn',
      tags: '{}',
      pageCount: 5,
      status: 'downloading',
    });
    manifestPages.set(56, [
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]); // 2 of 5
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();

    await reconcileQueue();
    await new Promise((r) => setTimeout(r, 5));

    const completed = upsertedRows.find(
      (r) =>
        (r as { galleryId: number }).galleryId === 56 &&
        (r as { status: string }).status === 'complete',
    );
    expect(completed).toBeFalsy();
  });

  it('non-Android: does NOT kick the processor on a metered network', async () => {
    adapterRows.push({
      galleryId: 13,
      title: 'Z',
      thumbnail: '/tn',
      tags: '{}',
      pageCount: 3,
      status: 'downloading',
    });
    unmetered.mockResolvedValue(false);
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();

    await reconcileQueue();
    await new Promise((r) => setTimeout(r, 5));

    // Zombie was requeued, but download was not driven (processor not kicked).
    expect(vi.mocked(queueOps.enqueueDownload)).toHaveBeenCalled();
    expect(dl).not.toHaveBeenCalled();
  });

  it('Android: kicks the processor on a metered network so CONNECTED WorkManager can run', async () => {
    androidFlag = true;
    adapterRows.push({
      galleryId: 14,
      title: 'Cellular',
      thumbnail: '/tn',
      tags: '{}',
      pageCount: 3,
      status: 'downloading',
    });
    unmetered.mockResolvedValue(false);
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();

    await reconcileQueue();
    await new Promise((r) => setTimeout(r, 5));

    expect(vi.mocked(queueOps.enqueueDownload)).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 14 }),
      { keepRetryState: true, queuePosition: undefined },
    );
    expect(workOrderWrites.map((w) => w.galleryId)).toContain('14');
    expect(workerEnqueues).toContain('14');
    expect(dl).not.toHaveBeenCalled();
  });

  it('Android: re-enqueues due auto-retries on a metered network for CONNECTED WorkManager', async () => {
    androidFlag = true;
    unmetered.mockResolvedValue(false);
    dueRows = [{ galleryId: 15, title: 'Retry', thumbnail: '/tn', tags: '{}' }];
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();

    await reconcileQueue();
    await new Promise((r) => setTimeout(r, 5));

    expect(vi.mocked(queueOps.enqueueDownload)).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 15 }),
      { keepRetryState: true },
    );
    expect(workOrderWrites.map((w) => w.galleryId)).toContain('15');
    expect(workerEnqueues).toContain('15');
  });
});
