/**
 * Unit tests for migrate-downloads.ts
 *
 * Both stores are in-memory mocks. DB helpers (listDownloads, markDownloadMigrated,
 * setDownloadFolderName, deleteDownload) are vi.fn() stubs. isAndroid is stubbed
 * to true for most suites and false for the non-Android no-op suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DBDownload } from '@/lib/db/schema';

// ── In-memory DownloadStore ──────────────────────────────────────────────────

/**
 * Minimal in-memory DownloadStore for testing migration.
 * Keyed by "<galleryId>/<filename>".
 */
class MemStore {
  private files = new Map<string, Uint8Array>();
  private galleries = new Set<number>();
  private folders = new Map<number, { folderName: string; title: string }>();

  key(galleryId: number, index: number, ext: string): string {
    const idx = index + 1;
    const name = String(idx).padStart(4, '0') + '.' + ext;
    return `${galleryId}/${name}`;
  }

  async putImage(galleryId: number, index: number, bytes: Uint8Array, ext: string): Promise<void> {
    this.files.set(this.key(galleryId, index, ext), bytes);
    this.galleries.add(galleryId);
    if (!this.folders.has(galleryId)) {
      this.folders.set(galleryId, {
        folderName: String(galleryId),
        title: `Gallery ${galleryId}`,
      });
    }
  }

  async getImage(galleryId: number, index: number, ext: string): Promise<Uint8Array | null> {
    return this.files.get(this.key(galleryId, index, ext)) ?? null;
  }

  async listGalleries(): Promise<number[]> {
    return [...this.galleries];
  }

  async listGalleryFolders(): Promise<{ galleryId: number; folderName: string; title: string }[]> {
    return [...this.galleries].map((galleryId) => ({
      galleryId,
      ...(this.folders.get(galleryId) ?? {
        folderName: String(galleryId),
        title: `Gallery ${galleryId}`,
      }),
    }));
  }

  async deleteGallery(galleryId: number): Promise<void> {
    const prefix = `${galleryId}/`;
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(prefix)) this.files.delete(k);
    }
    this.galleries.delete(galleryId);
    this.folders.delete(galleryId);
  }

  async ensureGallery(galleryId: number, title: string): Promise<void> {
    this.galleries.add(galleryId);
    this.folders.set(galleryId, {
      folderName: title.trim() ? `${galleryId} ${title.trim()}` : String(galleryId),
      title: title.trim() || `Gallery ${galleryId}`,
    });
  }

  setGalleryFolder(galleryId: number, folderName: string, title: string): void {
    this.galleries.add(galleryId);
    this.folders.set(galleryId, { folderName, title });
  }

  async imageSize(galleryId: number, index: number, ext: string): Promise<number | null> {
    return this.files.get(this.key(galleryId, index, ext))?.byteLength ?? null;
  }

  async gallerySize(galleryId: number): Promise<number> {
    const prefix = `${galleryId}/`;
    let total = 0;
    for (const [key, bytes] of this.files) {
      if (key.startsWith(prefix)) total += bytes.byteLength;
    }
    return total;
  }

  async usage(): Promise<number> {
    let total = 0;
    for (const id of this.galleries) total += await this.gallerySize(id);
    return total;
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

vi.mock('@/lib/utils/platform', () => ({
  isAndroid: () => mockIsAndroid,
}));

vi.mock('@/lib/db/download', () => ({
  listDownloads: vi.fn(async () => mockRows),
  markDownloadMigrated: vi.fn(async (id: number, folder: string, ts: string) => {
    markMigratedCalls.push([id, folder, ts]);
    // Update the mock rows so re-runs see migratedAt set
    const row = mockRows.find((r) => r.galleryId === id);
    if (row) row.migratedAt = ts;
  }),
  setDownloadFolderName: vi.fn(async (id: number, folder: string) => {
    setFolderCalls.push([id, folder]);
  }),
  deleteDownload: vi.fn(async (id: number) => {
    deletedRows.push(id);
    mockRows = mockRows.filter((r) => r.galleryId !== id);
  }),
  getDownload: vi.fn(async (id: number) => mockRows.find((r) => r.galleryId === id) ?? null),
  upsertDownload: vi.fn(async (row: DBDownload) => {
    upsertedRows.push(row);
    const idx = mockRows.findIndex((r) => r.galleryId === row.galleryId);
    if (idx >= 0) {
      mockRows[idx] = row;
    } else {
      mockRows.push(row);
    }
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
    pageCount: 2,
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
    upsertedRows.length = 0;
    vi.clearAllMocks();
  });

  it('migrates an old "<id>" gallery into "<id> <title>" with all pages + manifest', async () => {
    const row = makeRow({ galleryId: 100, title: 'My Gallery' });
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
    expect(setFolderCalls[0]).toEqual([100, '100 My Gallery']);

    // Old folder was deleted
    const oldIds = await mockOldStore.listGalleries();
    expect(oldIds).not.toContain(100);
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
    upsertedRows.length = 0;
    vi.clearAllMocks();
  });

  it('re-run is a no-op when migratedAt is already set', async () => {
    const row = makeRow({ galleryId: 300, migratedAt: '2026-01-01T00:00:00.000Z' });
    mockRows = [row];

    const result = await migrateDownloadsToPublic();

    expect(result.migrated).toBe(0);
    expect(markMigratedCalls).toHaveLength(0);
  });

  it('re-run is a no-op when new folder already has the manifest', async () => {
    const row = makeRow({ galleryId: 400, title: 'Idempotent Gallery', migratedAt: null });
    mockRows = [row];

    // Simulate old folder present + new folder already has manifest
    await mockOldStore.putImage(400, -1, makeManifest(['webp']), 'json');
    await mockOldStore.putImage(400, 0, makeBytes(8), 'webp');
    // New store already has the manifest
    await mockNewStore.putImage(400, -1, makeManifest(['webp']), 'json');

    const result = await migrateDownloadsToPublic();

    // Should have marked migrated (idempotent path), but NOT copied pages again
    expect(result.migrated).toBe(1);
    expect(markMigratedCalls).toHaveLength(1);
    expect(markMigratedCalls[0][0]).toBe(400);
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
    upsertedRows.length = 0;
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
    upsertedRows.length = 0;
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
    upsertedRows.length = 0;
    vi.clearAllMocks();
  });

  it('prunes a DB row whose new folder is missing (no manifest)', async () => {
    const row = makeRow({
      galleryId: 900,
      title: 'Dead Row',
      migratedAt: '2026-01-01T00:00:00.000Z',
    });
    mockRows = [row];
    // New store has no files for gallery 900

    const pruned = await reconcileLibrary(mockNewStore);

    expect(pruned).toBe(1);
    expect(deletedRows).toContain(900);
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
    markMigratedCalls.length = 0;
    setFolderCalls.length = 0;
    deletedRows.length = 0;
    upsertedRows.length = 0;
    vi.clearAllMocks();
  });

  it('rebuilds complete download DB rows from public folder manifests', async () => {
    mockNewStore.setGalleryFolder(1200, '1200 Restored Title', 'Restored Title');
    await mockNewStore.putImage(1200, -1, makeManifest(['webp', 'jpg']), 'json');
    await mockNewStore.putImage(1200, 0, makeBytes(10, 0x12), 'webp');
    await mockNewStore.putImage(1200, 1, makeBytes(20, 0x34), 'jpg');

    const result = await restoreDownloadsFromPublicFolder(mockNewStore);

    expect(result).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(upsertedRows).toHaveLength(1);
    expect(upsertedRows[0]).toMatchObject({
      galleryId: 1200,
      title: 'Restored Title',
      thumbnail: '',
      tags: '{}',
      pageCount: 2,
      totalBytes: 30,
      status: 'complete',
      folderName: '1200 Restored Title',
      lastError: null,
      queuePosition: null,
      retryCount: 0,
      nextRetryAt: null,
    });
    expect(upsertedRows[0].migratedAt).toBeTruthy();
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

  it('skips a DB row that already points at the same complete public folder', async () => {
    mockRows = [
      makeRow({
        galleryId: 1400,
        title: 'Already There',
        pageCount: 1,
        status: 'complete',
        folderName: '1400 Already There',
        migratedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    mockNewStore.setGalleryFolder(1400, '1400 Already There', 'Already There');
    await mockNewStore.putImage(1400, -1, makeManifest(['webp']), 'json');
    await mockNewStore.putImage(1400, 0, makeBytes(10), 'webp');

    const result = await restoreDownloadsFromPublicFolder(mockNewStore);

    expect(result).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(upsertedRows).toHaveLength(0);
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
