// @vitest-environment node
/**
 * AC-003: pause != cancel in downloadGalleryToLibrary.
 *
 * A pause-abort (opts.isPauseSignal() === true) must:
 *   - write status 'paused' (NOT 'failed'),
 *   - retain partial pages (no delete),
 *   - rethrow DownloadPausedError.
 * A genuine cancel-abort (isPauseSignal absent/false) keeps today's behavior:
 *   - 'failed' row with NO lastError, rethrows the AbortError.
 * A genuine failure keeps today's behavior: 'failed' WITH lastError.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock the DB layer so we can observe the status writes ─────────────────────
const dbCalls = {
  upsert: vi.fn(),
  updateProgress: vi.fn(),
  setError: vi.fn(),
  updateStatus: vi.fn(),
};

vi.mock('@/lib/db/download', () => ({
  getDownload: vi.fn(async () => null),
  upsertDownload: (...a: unknown[]) => dbCalls.upsert(...a),
  updateDownloadProgress: (...a: unknown[]) => dbCalls.updateProgress(...a),
  setDownloadError: (...a: unknown[]) => dbCalls.setError(...a),
  updateDownloadStatus: (...a: unknown[]) => dbCalls.updateStatus(...a),
  serializeTags: (t: unknown) => JSON.stringify(t),
}));

// ── Mock the image cache (off — forces network path) ──────────────────────────
vi.mock('@/lib/cache/image-cache', () => ({
  getImageCache: vi.fn(async () => null),
}));

// ── Mock the download store (in-memory) ───────────────────────────────────────
const memory = new Map<string, Uint8Array>();
const fakeStore = {
  ensureReady: vi.fn(async () => {}),
  ensureGallery: vi.fn(async () => {}),
  putImage: vi.fn(async (gid: number, idx: number, bytes: Uint8Array, ext: string) => {
    memory.set(`${gid}/${idx}.${ext}`, bytes);
  }),
  getImage: vi.fn(async () => null),
  gallerySize: vi.fn(async () => 0),
  // putImageFromFile intentionally omitted so the cache-copy path is skipped.
};

vi.mock('@/lib/storage/download-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/storage/download-store')>(
    '@/lib/storage/download-store',
  );
  return {
    ...actual,
    createDownloadStore: vi.fn(async () => fakeStore),
  };
});

// ── Mock the API client to serve image bytes / or abort ───────────────────────
const fetchUrl = vi.fn();
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiClient: { fetchUrl: (...a: unknown[]) => fetchUrl(...a) },
  };
});

import { downloadGalleryToLibrary, DownloadPausedError } from '../download-zip';
import type { GalleryFile, GgConfig } from '../types';

const ggConfig: GgConfig = {
  pathCode: '1700000000',
  mDefault: 0,
  mCases: new Set<number>(),
  mCaseValue: 1,
};

const file = (hash: string): GalleryFile => ({
  width: 800,
  height: 1200,
  haswebp: 1,
  hasavif: 0,
  hasavifsmalltn: 0,
  name: 'p.webp',
  hash,
});

function okResponse(): Response {
  return {
    status: 200,
    headers: { get: (h: string) => (h === 'content-type' ? 'image/webp' : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  memory.clear();
});

describe('downloadGalleryToLibrary pause vs cancel (AC-003)', () => {
  it('PAUSE: writes "paused", keeps pages, throws DownloadPausedError', async () => {
    const controller = new AbortController();
    // First page succeeds (creates the row), then abort before the second.
    fetchUrl.mockImplementationOnce(async () => okResponse());
    fetchUrl.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });

    const files = [file('a'.repeat(64)), file('b'.repeat(64))];

    await expect(
      downloadGalleryToLibrary(
        7,
        'T',
        '/tn',
        files,
        ggConfig,
        {},
        undefined,
        controller.signal,
        { isPauseSignal: () => true },
      ),
    ).rejects.toBeInstanceOf(DownloadPausedError);

    // Row was created on page 1, then flipped to 'paused' (NOT 'failed').
    expect(dbCalls.updateStatus).toHaveBeenCalledWith(7, 'paused');
    expect(dbCalls.setError).not.toHaveBeenCalled();
    // Partial page retained in the store.
    expect(memory.size).toBeGreaterThan(0);
  });

  it('CANCEL (no pause signal): writes "failed" with null lastError, rethrows AbortError', async () => {
    const controller = new AbortController();
    fetchUrl.mockImplementationOnce(async () => okResponse());
    fetchUrl.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });

    const files = [file('c'.repeat(64)), file('d'.repeat(64))];

    await expect(
      downloadGalleryToLibrary(8, 'T', '/tn', files, ggConfig, {}, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(dbCalls.setError).toHaveBeenCalledWith(8, 'failed', null);
    expect(dbCalls.updateStatus).not.toHaveBeenCalledWith(8, 'paused');
  });

  it('GENUINE FAILURE: writes "failed" WITH lastError (not paused)', async () => {
    // First page ok (creates row), second page throws a non-abort error.
    fetchUrl.mockImplementationOnce(async () => okResponse());
    fetchUrl.mockImplementationOnce(async () => {
      throw new Error('network exploded');
    });

    const files = [file('e'.repeat(64)), file('f'.repeat(64))];

    await expect(
      downloadGalleryToLibrary(9, 'T', '/tn', files, ggConfig, {}, undefined, undefined, {
        isPauseSignal: () => true, // even with a pause signal, a non-abort error is a failure
      }),
    ).rejects.toThrow('network exploded');

    expect(dbCalls.setError).toHaveBeenCalledWith(9, 'failed', 'network exploded');
    expect(dbCalls.updateStatus).not.toHaveBeenCalledWith(9, 'paused');
  });
});
