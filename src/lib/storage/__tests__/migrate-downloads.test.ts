/**
 * Unit tests for migrate-downloads.ts
 *
 * Both stores are in-memory mocks. DB helpers (listDownloads,
 * commitDownloadMigrationIfUnchanged, deleteDownloadIfUnchanged) are vi.fn()
 * stubs. isAndroid is stubbed
 * to true for most suites and false for the non-Android no-op suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DBDownload } from '@/lib/db/schema';
import type { DownloadStore } from '@/lib/storage/download-store';

// ── In-memory DownloadStore ──────────────────────────────────────────────────

/**
 * Minimal in-memory DownloadStore for testing migration.
 * Keyed by "<galleryId>/<filename>".
 */
class MemStore {
  private files = new Map<string, Uint8Array>();
  private galleries = new Set<number>();
  private folderNames = new Map<number, { folderName: string; title: string }>();

  key(galleryId: number, index: number, ext: string): string {
    const idx = index + 1;
    const name = String(idx).padStart(4, '0') + '.' + ext;
    return `${galleryId}/${name}`;
  }

  async putImage(galleryId: number, index: number, bytes: Uint8Array, ext: string): Promise<void> {
    this.files.set(this.key(galleryId, index, ext), bytes);
    this.galleries.add(galleryId);
  }

  async getImage(galleryId: number, index: number, ext: string): Promise<Uint8Array | null> {
    return this.files.get(this.key(galleryId, index, ext)) ?? null;
  }

  async listGalleries(): Promise<number[]> {
    return [...this.galleries];
  }

  setGalleryFolder(galleryId: number, folderName: string, title: string): void {
    this.galleries.add(galleryId);
    this.folderNames.set(galleryId, { folderName, title });
  }

  async listGalleryFolders(): Promise<{ galleryId: number; folderName: string; title: string }[]> {
    return [...this.galleries].map((galleryId) => ({
      galleryId,
      folderName: this.folderNames.get(galleryId)?.folderName ?? String(galleryId),
      title: this.folderNames.get(galleryId)?.title ?? `Gallery ${galleryId}`,
    }));
  }

  async deleteGallery(galleryId: number): Promise<void> {
    const prefix = `${galleryId}/`;
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(prefix)) this.files.delete(k);
    }
    this.galleries.delete(galleryId);
  }

  async ensureGallery(): Promise<void> {
    // No-op for tests — folder concept is implicit.
  }

  async gallerySize(): Promise<number> {
    return 0;
  }
  async usage(): Promise<number> {
    return 0;
  }
}

// ── Mock helpers ─────────────────────────────────────────────────────────────

let mockIsAndroid = true;
let mockOldStore: MemStore;
let mockNewStore: MemStore;

// Rows returned by listDownloads
let mockRows: DBDownload[];
// Track calls for spy assertions
const markMigratedCalls: Array<[number, string, string]> = [];
const setFolderCalls: Array<[number, string]> = [];
const deletedRows: number[] = [];
const upsertedRows: DBDownload[] = [];
let getDownloadError: Error | null = null;
let beforeRestoreCommit: (() => void) | null = null;

function persistedDownloadSnapshot(row: DBDownload | null): unknown[] | null {
  if (!row) return null;
  return [
    row.galleryId,
    row.title,
    row.thumbnail,
    row.tags,
    row.pageCount,
    row.totalBytes,
    row.downloadedAt,
    row.status,
    row.folderName ?? null,
    row.migratedAt ?? null,
    row.lastError ?? null,
    row.queuePosition ?? null,
    row.retryCount ?? null,
    row.nextRetryAt ?? null,
    row.nativeRunId ?? null,
  ];
}

vi.mock('@/lib/utils/platform', () => ({
  isAndroid: () => mockIsAndroid,
}));

vi.mock('@/lib/db/download', () => ({
  listDownloads: vi.fn(async () => mockRows),
  commitDownloadMigrationIfUnchanged: vi.fn(
    async (
      expected: DBDownload,
      folder: string,
      ts: string,
      commitStorage: () => Promise<boolean>,
    ) => {
      const live = mockRows.find((row) => row.galleryId === expected.galleryId) ?? null;
      if (
        JSON.stringify(persistedDownloadSnapshot(live)) !==
        JSON.stringify(persistedDownloadSnapshot(expected))
      ) {
        return false;
      }
      if (!(await commitStorage())) return false;
      markMigratedCalls.push([expected.galleryId, folder, ts]);
      const row = mockRows.find((candidate) => candidate.galleryId === expected.galleryId);
      if (row) {
        row.folderName = folder;
        row.migratedAt = ts;
      }
      return true;
    },
  ),
  setDownloadFolderName: vi.fn(async (id: number, folder: string) => {
    setFolderCalls.push([id, folder]);
  }),
  deleteDownloadIfUnchanged: vi.fn(async (expected: DBDownload) => {
    const live = mockRows.find((row) => row.galleryId === expected.galleryId) ?? null;
    if (
      JSON.stringify(persistedDownloadSnapshot(live)) !==
      JSON.stringify(persistedDownloadSnapshot(expected))
    )
      return false;
    deletedRows.push(expected.galleryId);
    mockRows = mockRows.filter((row) => row.galleryId !== expected.galleryId);
    return true;
  }),
  getDownload: vi.fn(async (id: number) => {
    if (getDownloadError) throw getDownloadError;
    return mockRows.find((row) => row.galleryId === id) ?? null;
  }),
  restoreDownloadIfUnchanged: vi.fn(async (expected: DBDownload | null, row: DBDownload) => {
    const hook = beforeRestoreCommit;
    beforeRestoreCommit = null;
    hook?.();
    const live = mockRows.find((existing) => existing.galleryId === row.galleryId) ?? null;
    const unchanged =
      expected === null ? live === null : JSON.stringify(live) === JSON.stringify(expected);
    if (!unchanged) return false;
    upsertedRows.push(row);
    mockRows = [...mockRows.filter((existing) => existing.galleryId !== row.galleryId), row];
    return true;
  }),
}));

vi.mock('@/lib/storage/adapters/capacitor', () => ({
  CapacitorDownloadStore: {
    create: vi.fn(async () => mockOldStore),
  },
}));

vi.mock('@/lib/storage/adapters/android-public', () => ({
  AndroidPublicDownloadStore: {
    create: vi.fn(() => mockNewStore),
  },
}));

// base-path-resolver galleryFolderName: "<id> <title>"
vi.mock('@/lib/storage/base-path-resolver', () => ({
  galleryFolderName: vi.fn((id: number, title: string) => {
    const safe = title.trim();
    return safe ? `${id} ${safe}` : String(id);
  }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  migrateDownloadsToPublic,
  reconcileLibrary,
  restoreDownloadsFromPublicFolder,
} from '../migrate-downloads';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeManifest(exts: string[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(exts));
}

function makeBytes(size: number, fill = 0xab): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

function makeRow(overrides: Partial<DBDownload> = {}): DBDownload {
  return {
    galleryId: 12345,
    title: 'Test Gallery',
    thumbnail: '',
    tags: '{}',
    pageCount: 1,
    totalBytes: 100,
    downloadedAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    folderName: null,
    migratedAt: null,
    ...overrides,
  };
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('migrateDownloadsToPublic — basic migration', () => {
  beforeEach(() => {
    mockIsAndroid = true;
    mockOldStore = new MemStore();
    mockNewStore = new MemStore();
    mockRows = [];
    markMigratedCalls.length = 0;
    setFolderCalls.length = 0;
    deletedRows.length = 0;
    vi.clearAllMocks();
  });

  it('migrates an old "<id>" gallery into "<id> <title>" with all pages + manifest', async () => {
    const row = makeRow({ galleryId: 100, title: 'My Gallery', pageCount: 2 });
    mockRows = [row];

    // Populate old store: manifest + 2 pages
    const manifest = makeManifest(['webp', 'jpg']);
    await mockOldStore.putImage(100, -1, manifest, 'json'); // 0000.json
    await mockOldStore.putImage(100, 0, makeBytes(10, 0x01), 'webp'); // 0001.webp
    await mockOldStore.putImage(100, 1, makeBytes(10, 0x02), 'jpg'); // 0002.jpg

    const result = await migrateDownloadsToPublic();

    // Migration count
    expect(result.migrated).toBe(1);

    // New store has manifest + pages
    const newManifest = await mockNewStore.getImage(100, -1, 'json');
    expect(newManifest).not.toBeNull();
    expect(new TextDecoder().decode(newManifest!)).toBe(JSON.stringify(['webp', 'jpg']));

    const page0 = await mockNewStore.getImage(100, 0, 'webp');
    expect(page0).toEqual(makeBytes(10, 0x01));

    const page1 = await mockNewStore.getImage(100, 1, 'jpg');
    expect(page1).toEqual(makeBytes(10, 0x02));

    // DB was updated
    expect(markMigratedCalls).toHaveLength(1);
    expect(markMigratedCalls[0][0]).toBe(100);
    expect(markMigratedCalls[0][1]).toBe('100 My Gallery');
    expect(setFolderCalls).toHaveLength(0);

    // Old folder was deleted
    const oldIds = await mockOldStore.listGalleries();
    expect(oldIds).not.toContain(100);
  });

  it.each([
    ['downloading status', { status: 'downloading' as const }],
    ['queued status', { status: 'queued' as const, queuePosition: 1 }],
    ['paused status', { status: 'paused' as const, queuePosition: 2 }],
    ['native ownership', { nativeRunId: 'run-active-migration' }],
  ])('does not touch legacy or public files for an active %s row', async (_, active) => {
    mockRows = [makeRow({ galleryId: 101, migratedAt: null, ...active })];
    await mockOldStore.putImage(101, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(101, 0, makeBytes(8), 'webp');
    const oldGetImage = vi.spyOn(mockOldStore, 'getImage');
    const oldDelete = vi.spyOn(mockOldStore, 'deleteGallery');
    const newPutImage = vi.spyOn(mockNewStore, 'putImage');

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(0);
    expect(oldGetImage).not.toHaveBeenCalled();
    expect(oldDelete).not.toHaveBeenCalled();
    expect(newPutImage).not.toHaveBeenCalled();
    expect(markMigratedCalls).toHaveLength(0);
    expect(await mockOldStore.listGalleries()).toContain(101);
  });

  it('does not acquire storage ownership from a stale row after delayed startup IO', async () => {
    const snapshot = makeRow({ galleryId: 102, title: 'Old row', migratedAt: null });
    mockRows = [snapshot];
    await mockOldStore.putImage(102, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(102, 0, makeBytes(8), 'webp');
    const originalListGalleries = mockOldStore.listGalleries.bind(mockOldStore);
    let signalListStarted!: () => void;
    let releaseList!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      signalListStarted = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let listCalls = 0;
    mockOldStore.listGalleries = vi.fn(async () => {
      if (listCalls++ === 0) {
        signalListStarted();
        await listGate;
      }
      return originalListGalleries();
    });

    const migration = migrateDownloadsToPublic();
    await listStarted;
    const replacement = {
      ...snapshot,
      title: 'New native lifecycle',
      status: 'downloading' as const,
      nativeRunId: 'run-new-migration-102',
    };
    mockRows = [replacement];
    releaseList();

    expect(await migration).toMatchObject({ migrated: 0 });
    expect(markMigratedCalls).toHaveLength(0);
    expect(mockRows).toEqual([replacement]);
    expect(await mockOldStore.listGalleries()).toContain(102);
    expect(await mockNewStore.getImage(102, -1, 'json')).toBeNull();
  });

  it('is a no-op on non-Android', async () => {
    mockIsAndroid = false;
    const row = makeRow({ galleryId: 200 });
    mockRows = [row];
    await mockOldStore.putImage(200, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(200, 0, makeBytes(8), 'webp');

    const result = await migrateDownloadsToPublic();

    expect(result).toEqual({ migrated: 0, reconciled: 0 });
    expect(markMigratedCalls).toHaveLength(0);
  });
});

describe('migrateDownloadsToPublic — idempotency', () => {
  beforeEach(() => {
    mockIsAndroid = true;
    mockOldStore = new MemStore();
    mockNewStore = new MemStore();
    mockRows = [];
    markMigratedCalls.length = 0;
    setFolderCalls.length = 0;
    deletedRows.length = 0;
    vi.clearAllMocks();
  });

  it('re-run is a no-op when migratedAt is already set', async () => {
    const row = makeRow({ galleryId: 300, migratedAt: '2026-01-01T00:00:00.000Z' });
    mockRows = [row];

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(0);
    expect(markMigratedCalls).toHaveLength(0);
  });

  it('repairs missing target pages before accepting an existing manifest', async () => {
    const row = makeRow({ galleryId: 400, title: 'Idempotent Gallery', migratedAt: null });
    mockRows = [row];

    // Simulate old folder present + new folder already has manifest
    await mockOldStore.putImage(400, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(400, 0, makeBytes(8), 'webp');
    // A prior interrupted run published the manifest but never copied the page.
    await mockNewStore.putImage(400, -1, makeManifest(['webp']), 'json');

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(1);
    expect(markMigratedCalls).toHaveLength(1);
    expect(markMigratedCalls[0][0]).toBe(400);
    expect(await mockNewStore.getImage(400, 0, 'webp')).toEqual(makeBytes(8));
    expect(await mockOldStore.listGalleries()).not.toContain(400);
  });
});

describe('migrateDownloadsToPublic — crash-resumable', () => {
  beforeEach(() => {
    mockIsAndroid = true;
    mockOldStore = new MemStore();
    mockNewStore = new MemStore();
    mockRows = [];
    markMigratedCalls.length = 0;
    setFolderCalls.length = 0;
    deletedRows.length = 0;
    vi.clearAllMocks();
  });

  it('crash mid-way leaves earlier rows migrated and resumes on re-run', async () => {
    // Two rows: gallery 500 and 600.
    // Simulate a crash during gallery 600 by making its putImage throw.
    const row500 = makeRow({ galleryId: 500, title: 'Gallery 500', migratedAt: null });
    const row600 = makeRow({ galleryId: 600, title: 'Gallery 600', migratedAt: null });
    mockRows = [row500, row600];

    // Populate old stores
    await mockOldStore.putImage(500, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(500, 0, makeBytes(8, 0x55), 'webp');

    await mockOldStore.putImage(600, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(600, 0, makeBytes(8, 0x66), 'webp');

    // Intercept newStore.putImage for gallery 600 to throw (simulating crash)
    const origPut = mockNewStore.putImage.bind(mockNewStore);
    let callCount = 0;
    mockNewStore.putImage = async (id, index, bytes, ext) => {
      if (id === 600 && callCount++ === 0) {
        // Throw on the manifest write for gallery 600 (first putImage call for 600)
        throw new Error('simulated crash during 600');
      }
      return origPut(id, index, bytes, ext);
    };

    const result1 = await migrateDownloadsToPublic();

    // Gallery 500 should have migrated; 600 failed silently
    expect(result1.migrated).toBe(1);
    expect(markMigratedCalls.map((c) => c[0])).toContain(500);
    expect(markMigratedCalls.map((c) => c[0])).not.toContain(600);

    // Now simulate second run — 500 has migratedAt set (done above by mock),
    // 600 still has null migratedAt. Reset the throw.
    mockNewStore.putImage = origPut;
    markMigratedCalls.length = 0;
    setFolderCalls.length = 0;

    const result2 = await migrateDownloadsToPublic();

    // 600 should now migrate
    expect(result2.migrated).toBeGreaterThanOrEqual(1);
    expect(markMigratedCalls.map((c) => c[0])).toContain(600);
  });
});

describe('migrateDownloadsToPublic — validation before delete', () => {
  beforeEach(() => {
    mockIsAndroid = true;
    mockOldStore = new MemStore();
    mockNewStore = new MemStore();
    mockRows = [];
    markMigratedCalls.length = 0;
    setFolderCalls.length = 0;
    deletedRows.length = 0;
    vi.clearAllMocks();
  });

  it('old folder is NOT deleted if new manifest validation fails', async () => {
    const row = makeRow({ galleryId: 700, title: 'Validate Me', migratedAt: null });
    mockRows = [row];

    await mockOldStore.putImage(700, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(700, 0, makeBytes(8), 'webp');

    // Make newStore.getImage always return null for the validation check
    // (after putImage writes, getImage still returns null — simulates a broken store)
    const origGet = mockNewStore.getImage.bind(mockNewStore);
    mockNewStore.getImage = async () => null;

    const result = await migrateDownloadsToPublic();

    // Should NOT have migrated (validation failed)
    expect(result.migrated).toBe(0);
    expect(markMigratedCalls).toHaveLength(0);

    // Old folder should still exist
    const oldIds = await mockOldStore.listGalleries();
    expect(oldIds).toContain(700);

    // Restore
    mockNewStore.getImage = origGet;
  });

  it('old folder is deleted only after new manifest validates', async () => {
    const row = makeRow({ galleryId: 800, title: 'Safe Delete', migratedAt: null });
    mockRows = [row];

    await mockOldStore.putImage(800, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(800, 0, makeBytes(8, 0x88), 'webp');

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(1);

    // Old folder deleted
    const oldIds = await mockOldStore.listGalleries();
    expect(oldIds).not.toContain(800);

    // New store has manifest
    const newManifest = await mockNewStore.getImage(800, -1, 'json');
    expect(newManifest).not.toBeNull();
  });

  it('preserves the source when a valid manifest omits DB-expected pages', async () => {
    const row = makeRow({
      galleryId: 806,
      title: 'Truncated Manifest',
      pageCount: 2,
      migratedAt: null,
    });
    mockRows = [row];
    await mockOldStore.putImage(806, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(806, 0, makeBytes(8, 0x80), 'webp');
    // This page is physically present but omitted from the torn manifest.
    await mockOldStore.putImage(806, 1, makeBytes(8, 0x81), 'jpg');

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(0);
    expect(markMigratedCalls).toHaveLength(0);
    expect(await mockOldStore.listGalleries()).toContain(806);
    expect(await mockOldStore.getImage(806, 1, 'jpg')).toEqual(makeBytes(8, 0x81));
    expect(await mockNewStore.getImage(806, -1, 'json')).toBeNull();
  });

  it('does not commit the migration watermark when source deletion fails', async () => {
    const row = makeRow({
      galleryId: 803,
      title: 'Delete Retry',
      pageCount: 1,
      migratedAt: null,
    });
    mockRows = [row];
    await mockOldStore.putImage(803, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(803, 0, makeBytes(8), 'webp');
    mockOldStore.deleteGallery = vi.fn(async () => {
      throw new Error('provider busy');
    });

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(0);
    expect(markMigratedCalls).toHaveLength(0);
    expect(await mockOldStore.listGalleries()).toContain(803);
    expect(await mockNewStore.getImage(803, -1, 'json')).not.toBeNull();
  });

  it('recovers a crash after source deletion but before the DB watermark', async () => {
    const row = makeRow({
      galleryId: 804,
      title: 'Crash Recovery',
      pageCount: 1,
      migratedAt: null,
    });
    mockRows = [row];
    await mockNewStore.putImage(804, 0, makeBytes(8), 'webp');
    await mockNewStore.putImage(804, -1, makeManifest(['webp']), 'json');

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(1);
    expect(markMigratedCalls).toHaveLength(1);
    expect(markMigratedCalls[0][0]).toBe(804);
    expect(markMigratedCalls[0][1]).toBe('804 Crash Recovery');
  });

  it('does not publish completion or delete the source when any source page is missing', async () => {
    const row = makeRow({
      galleryId: 801,
      title: 'Incomplete Source',
      pageCount: 2,
      migratedAt: null,
    });
    mockRows = [row];

    await mockOldStore.putImage(801, -1, makeManifest(['webp', 'jpg']), 'json');
    await mockOldStore.putImage(801, 0, makeBytes(8), 'webp');
    // Page 2 is absent. A manifest-only target must never become the commit marker.

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(0);
    expect(markMigratedCalls).toHaveLength(0);
    expect(await mockOldStore.listGalleries()).toContain(801);
    expect(await mockNewStore.getImage(801, -1, 'json')).toBeNull();
  });

  it('repairs a zero-byte target page before deleting the source', async () => {
    const row = makeRow({ galleryId: 802, title: 'Torn Target', migratedAt: null });
    mockRows = [row];

    await mockOldStore.putImage(802, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(802, 0, makeBytes(12, 0x82), 'webp');
    await mockNewStore.putImage(802, -1, makeManifest(['webp']), 'json');
    await mockNewStore.putImage(802, 0, new Uint8Array(), 'webp');

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(1);
    expect(await mockNewStore.getImage(802, 0, 'webp')).toEqual(makeBytes(12, 0x82));
    expect(await mockOldStore.listGalleries()).not.toContain(802);
  });

  it('repairs same-sized corrupt target bytes before deleting the source', async () => {
    const row = makeRow({
      galleryId: 805,
      title: 'Corrupt Target',
      pageCount: 1,
      migratedAt: null,
    });
    mockRows = [row];
    const sourcePage = makeBytes(12, 0x85);
    await mockOldStore.putImage(805, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(805, 0, sourcePage, 'webp');
    await mockNewStore.putImage(805, -1, makeManifest(['webp']), 'json');
    await mockNewStore.putImage(805, 0, makeBytes(12, 0x11), 'webp');

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(1);
    expect(await mockNewStore.getImage(805, 0, 'webp')).toEqual(sourcePage);
    expect(await mockOldStore.listGalleries()).not.toContain(805);
  });
});

describe('reconcileLibrary', () => {
  beforeEach(() => {
    mockIsAndroid = true;
    mockOldStore = new MemStore();
    mockNewStore = new MemStore();
    mockRows = [];
    markMigratedCalls.length = 0;
    setFolderCalls.length = 0;
    deletedRows.length = 0;
    vi.clearAllMocks();
  });

  it('prunes a newly completed Android public row whose folder was deleted', async () => {
    const row = makeRow({
      galleryId: 900,
      title: 'Dead Row',
      status: 'complete',
      folderName: '900 Dead Row',
      migratedAt: '2026-01-01T00:00:00.000Z',
    });
    mockRows = [row];
    // New store has no files for gallery 900

    const pruned = await reconcileLibrary(mockNewStore);

    expect(pruned).toBe(1);
    expect(deletedRows).toContain(900);
  });

  it('retains an inactive failed native handoff that never published a public manifest', async () => {
    const row = makeRow({
      galleryId: 899,
      title: 'Retryable handoff failure',
      status: 'failed',
      folderName: '899 Retryable handoff failure',
      migratedAt: null,
      lastError: 'Native enqueue failed',
      nativeRunId: null,
      nextRetryAt: null,
    });
    mockRows = [row];
    const getImage = vi.spyOn(mockNewStore, 'getImage');

    const pruned = await reconcileLibrary(mockNewStore);

    expect(pruned).toBe(0);
    expect(getImage).not.toHaveBeenCalled();
    expect(deletedRows).not.toContain(899);
    expect(mockRows).toEqual([row]);
  });

  it.each([
    ['downloading status', { status: 'downloading' as const }],
    ['queued status', { status: 'queued' as const, queuePosition: 1 }],
    ['paused status', { status: 'paused' as const, queuePosition: 2 }],
    ['native run ownership', { nativeRunId: 'run-active-900' }],
    ['queue membership', { queuePosition: 3 }],
    ['scheduled retry', { status: 'failed' as const, nextRetryAt: '2026-01-02T00:00:00.000Z' }],
  ])('skips a migrated row with active %s before reading its manifest', async (_, active) => {
    mockRows = [
      makeRow({
        galleryId: 905,
        migratedAt: '2026-01-01T00:00:00.000Z',
        ...active,
      }),
    ];
    const getImage = vi.spyOn(mockNewStore, 'getImage');

    const pruned = await reconcileLibrary(mockNewStore);

    expect(pruned).toBe(0);
    expect(getImage).not.toHaveBeenCalled();
    expect(deletedRows).not.toContain(905);
  });

  it.each([
    [
      'replacement native run',
      {
        title: 'Replacement worker',
        status: 'downloading' as const,
        nativeRunId: 'run-new-906',
      },
    ],
    [
      'queued retry',
      {
        title: 'Queued retry',
        status: 'queued' as const,
        queuePosition: 1,
        retryCount: 1,
      },
    ],
    [
      'scheduled retry',
      {
        title: 'Scheduled retry',
        status: 'failed' as const,
        retryCount: 1,
        nextRetryAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    ['metadata replacement', { title: 'New catalog title' }],
  ])('does not prune a %s that wins while the manifest read is pending', async (_, replacement) => {
    const snapshot = makeRow({
      galleryId: 906,
      title: 'Old inactive row',
      status: 'failed',
      migratedAt: '2026-01-01T00:00:00.000Z',
      lastError: 'old failure',
    });
    mockRows = [snapshot];

    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    mockNewStore.getImage = vi.fn(async () => {
      signalReadStarted();
      await readGate;
      return null;
    });

    const reconcile = reconcileLibrary(mockNewStore);
    await readStarted;
    const liveReplacement = { ...snapshot, ...replacement };
    mockRows = [liveReplacement];
    releaseRead();

    expect(await reconcile).toBe(0);
    expect(deletedRows).not.toContain(906);
    expect(mockRows).toEqual([liveReplacement]);
  });

  it('keeps a valid DB row whose new folder has the manifest', async () => {
    const row = makeRow({
      galleryId: 901,
      title: 'Live Row',
      migratedAt: '2026-01-01T00:00:00.000Z',
    });
    mockRows = [row];
    // New store has the manifest
    await mockNewStore.putImage(901, -1, makeManifest(['webp']), 'json');

    const pruned = await reconcileLibrary(mockNewStore);

    expect(pruned).toBe(0);
    expect(deletedRows).not.toContain(901);
  });

  it('prunes dead rows and keeps valid rows when both exist', async () => {
    const rowDead = makeRow({
      galleryId: 902,
      title: 'Dead',
      migratedAt: '2026-01-01T00:00:00.000Z',
    });
    const rowLive = makeRow({
      galleryId: 903,
      title: 'Live',
      migratedAt: '2026-01-01T00:00:00.000Z',
    });
    mockRows = [rowDead, rowLive];

    // Only 903 has a manifest
    await mockNewStore.putImage(903, -1, makeManifest(['webp']), 'json');

    const pruned = await reconcileLibrary(mockNewStore);

    expect(pruned).toBe(1);
    expect(deletedRows).toContain(902);
    expect(deletedRows).not.toContain(903);
  });

  it('does not prune a row when manifest I/O throws', async () => {
    mockRows = [
      makeRow({
        galleryId: 904,
        folderName: '904 Keep Me',
        migratedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    mockNewStore.getImage = vi.fn(async () => {
      throw new Error('temporary storage failure');
    });

    const pruned = await reconcileLibrary(mockNewStore);

    expect(pruned).toBe(0);
    expect(deletedRows).not.toContain(904);
  });

  it('returns 0 on non-Android (standalone call)', async () => {
    mockIsAndroid = false;
    const row = makeRow({ galleryId: 950 });
    mockRows = [row];

    const pruned = await reconcileLibrary();

    expect(pruned).toBe(0);
    expect(deletedRows).toHaveLength(0);
  });
});

describe('restoreDownloadsFromPublicFolder', () => {
  beforeEach(() => {
    mockIsAndroid = true;
    mockOldStore = new MemStore();
    mockNewStore = new MemStore();
    mockRows = [];
    getDownloadError = null;
    beforeRestoreCommit = null;
    upsertedRows.length = 0;
    vi.clearAllMocks();
  });

  it('rebuilds a complete DB row from a titled folder, manifest, and page files', async () => {
    mockNewStore.setGalleryFolder(1200, '1200 Saved title', 'Saved title');
    await mockNewStore.putImage(1200, -1, makeManifest(['webp', 'jpg']), 'json');
    await mockNewStore.putImage(1200, 0, makeBytes(11), 'webp');
    await mockNewStore.putImage(1200, 1, makeBytes(13), 'jpg');

    const result = await restoreDownloadsFromPublicFolder(mockNewStore);

    expect(result).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(upsertedRows).toHaveLength(1);
    expect(upsertedRows[0]).toMatchObject({
      galleryId: 1200,
      title: 'Saved title',
      pageCount: 2,
      totalBytes: 24,
      status: 'complete',
      folderName: '1200 Saved title',
    });
  });

  it('fails closed when the existing catalog row cannot be read', async () => {
    mockNewStore.setGalleryFolder(1250, '1250 Existing', 'Existing');
    await mockNewStore.putImage(1250, -1, makeManifest(['webp']), 'json');
    await mockNewStore.putImage(1250, 0, makeBytes(11), 'webp');
    mockRows = [
      makeRow({
        galleryId: 1250,
        status: 'downloading',
        pageCount: 3,
        nativeRunId: '1250:live-run',
      }),
    ];
    getDownloadError = new Error('database temporarily unavailable');

    await expect(restoreDownloadsFromPublicFolder(mockNewStore)).rejects.toThrow(
      'failed to scan public download 1250: database temporarily unavailable',
    );
    expect(upsertedRows).toHaveLength(0);
    expect(mockRows[0]).toMatchObject({
      galleryId: 1250,
      status: 'downloading',
      pageCount: 3,
      nativeRunId: '1250:live-run',
    });
  });

  it('skips an existing active lifecycle even when the disk manifest is long enough', async () => {
    mockNewStore.setGalleryFolder(1260, '1260 Active', 'Active');
    await mockNewStore.putImage(1260, -1, makeManifest(['webp', 'jpg']), 'json');
    await mockNewStore.putImage(1260, 0, makeBytes(11), 'webp');
    await mockNewStore.putImage(1260, 1, makeBytes(13), 'jpg');
    mockRows = [
      makeRow({
        galleryId: 1260,
        status: 'downloading',
        pageCount: 1,
        nativeRunId: 'run-activeeeeeee',
      }),
    ];

    const result = await restoreDownloadsFromPublicFolder(mockNewStore);

    expect(result).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(upsertedRows).toHaveLength(0);
    expect(mockRows[0]).toMatchObject({
      status: 'downloading',
      pageCount: 1,
      nativeRunId: 'run-activeeeeeee',
    });
  });

  it('does not overwrite a lifecycle replaced after the filesystem scan began', async () => {
    mockNewStore.setGalleryFolder(1270, '1270 Restore', 'Restore');
    await mockNewStore.putImage(1270, -1, makeManifest(['webp']), 'json');
    await mockNewStore.putImage(1270, 0, makeBytes(11), 'webp');
    mockRows = [
      makeRow({
        galleryId: 1270,
        title: 'Old failed row',
        status: 'failed',
        pageCount: 1,
        lastError: 'old failure',
      }),
    ];
    beforeRestoreCommit = () => {
      mockRows = [
        makeRow({
          galleryId: 1270,
          title: 'Concurrent replacement',
          status: 'downloading',
          pageCount: 4,
          nativeRunId: 'run-replacement',
        }),
      ];
    };

    const result = await restoreDownloadsFromPublicFolder(mockNewStore);

    expect(result).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(upsertedRows).toHaveLength(0);
    expect(mockRows[0]).toMatchObject({
      title: 'Concurrent replacement',
      status: 'downloading',
      pageCount: 4,
      nativeRunId: 'run-replacement',
    });
  });

  it('restores a folder with a missing page as a resumable failed download', async () => {
    mockNewStore.setGalleryFolder(1300, '1300 Partial', 'Partial');
    await mockNewStore.putImage(1300, -1, makeManifest(['webp', 'jpg']), 'json');
    await mockNewStore.putImage(1300, 0, makeBytes(10), 'webp');

    const result = await restoreDownloadsFromPublicFolder(mockNewStore);

    expect(result).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(upsertedRows).toHaveLength(1);
    expect(upsertedRows[0]).toMatchObject({
      galleryId: 1300,
      title: 'Partial',
      pageCount: 2,
      totalBytes: 10,
      status: 'failed',
      folderName: '1300 Partial',
      lastError: 'Recovered partial download',
      queuePosition: null,
      retryCount: 0,
      nextRetryAt: null,
    });
  });

  it('does not shrink a catalog-restored partial target into a false completion', async () => {
    mockNewStore.setGalleryFolder(1400, '1400 Partial', 'Partial');
    await mockNewStore.putImage(1400, -1, makeManifest(['webp']), 'json');
    await mockNewStore.putImage(1400, 0, makeBytes(9), 'webp');
    mockRows = [
      makeRow({
        galleryId: 1400,
        title: 'Partial',
        status: 'failed',
        pageCount: 3,
        folderName: '1400 Partial',
        migratedAt: '2026-07-11T00:00:00.000Z',
      }),
    ];

    const result = await restoreDownloadsFromPublicFolder(mockNewStore);

    expect(result).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(upsertedRows).toHaveLength(0);
    expect(mockRows[0]).toMatchObject({ status: 'failed', pageCount: 3 });
  });

  it('preserves an already-complete DB row when the on-disk folder is momentarily incomplete', async () => {
    // The DB says the gallery is complete and points at this folder, but the
    // scan sees a missing page (e.g. a transient SAF stat failure on boot).
    // The complete row must not be downgraded to failed by the boot-time scan.
    mockRows = [
      makeRow({
        galleryId: 1450,
        title: 'Complete On Disk Once',
        pageCount: 2,
        status: 'complete',
        folderName: '1450 Complete On Disk Once',
        migratedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    mockNewStore.setGalleryFolder(1450, '1450 Complete On Disk Once', 'Complete On Disk Once');
    await mockNewStore.putImage(1450, -1, makeManifest(['webp', 'jpg']), 'json');
    await mockNewStore.putImage(1450, 0, makeBytes(10), 'webp');
    // page 1 (jpg) is missing on disk → complete would be false.

    const result = await restoreDownloadsFromPublicFolder(mockNewStore);

    expect(result).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(upsertedRows).toHaveLength(0);
  });

  it.each([
    ['exact first', ['1600 Exact', '1600 Stale']],
    ['stale first', ['1600 Stale', '1600 Exact']],
  ])('keeps the exact complete alias regardless of provider order (%s)', async (_label, order) => {
    mockRows = [
      makeRow({
        galleryId: 1600,
        title: 'Exact',
        pageCount: 2,
        status: 'complete',
        folderName: '1600 Exact',
        migratedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    const manifest = makeManifest(['webp', 'jpg']);
    const aliasStore = {
      listGalleryFolders: vi.fn(async () =>
        order.map((folderName) => ({
          galleryId: 1600,
          folderName,
          title: folderName.endsWith('Exact') ? 'Exact' : 'Stale',
        })),
      ),
      listGalleries: vi.fn(async () => [1600]),
      getImage: vi.fn(
        async (
          _galleryId: number,
          index: number,
          _ext: string,
          options?: { folderName?: string | null },
        ) => {
          if (index === -1) return manifest;
          if (options?.folderName === '1600 Exact') return makeBytes(index === 0 ? 11 : 13);
          return index === 0 ? makeBytes(7) : null;
        },
      ),
      putImage: vi.fn(async () => {}),
      deleteGallery: vi.fn(async () => {}),
      gallerySize: vi.fn(async () => 0),
      usage: vi.fn(async () => 0),
    } as unknown as DownloadStore;

    const result = await restoreDownloadsFromPublicFolder(aliasStore);

    expect(result).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(upsertedRows).toHaveLength(0);
    expect(mockRows[0]).toMatchObject({
      status: 'complete',
      pageCount: 2,
      folderName: '1600 Exact',
    });
  });

  it('is a no-op on non-Android', async () => {
    mockIsAndroid = false;
    mockNewStore.setGalleryFolder(1500, '1500 Ignored', 'Ignored');
    await mockNewStore.putImage(1500, -1, makeManifest(['webp']), 'json');
    await mockNewStore.putImage(1500, 0, makeBytes(10), 'webp');

    const result = await restoreDownloadsFromPublicFolder(mockNewStore);

    expect(result).toEqual({ imported: 0, skipped: 0, failed: 0 });
    expect(upsertedRows).toHaveLength(0);
  });
});
