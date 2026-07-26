/**
 * Unit tests for AndroidPublicDownloadStore.
 *
 * An in-memory mock of PublicLibraryPlugin replaces all native I/O.
 * Capacitor.convertFileSrc is stubbed to return a predictable URL.
 *
 * Contract assertions mirror download-store.test.ts (runDownloadStoreContract)
 * plus Android-specific cases (ensureGallery, resolveFolder prefix scan,
 * coverUrl, listGalleries skips .nomedia).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory PublicLibrary mock ───────────────────────────────────────────

/**
 * Minimal in-memory filesystem sufficient to exercise the adapter.
 * - files: Map<absolutePath, base64string>
 * - dirs:  Set<absolutePath>
 */
class FakePublicLibrary {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async defaultBaseDir() {
    return { path: '/fake/Download' };
  }

  async mkdir({ path }: { path: string }) {
    this.dirs.add(path);
  }

  async writeFile({ path, dataBase64 }: { path: string; dataBase64: string }) {
    this.files.set(path, dataBase64);
    // Ensure parent dir is tracked
    const parent = path.substring(0, path.lastIndexOf('/'));
    if (parent) this.dirs.add(parent);
  }

  async readFile({ path }: { path: string }) {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`file not found: ${path}`);
    return { dataBase64: data };
  }

  async readdir({ path }: { path: string }) {
    if (!this.dirs.has(path)) throw new Error(`directory not found: ${path}`);
    const prefix = path + '/';
    const seen = new Set<string>();
    const files: { name: string; size: number }[] = [];

    // Files directly inside path
    for (const [p, data] of this.files) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        if (!rest.includes('/')) {
          if (!seen.has(rest)) {
            seen.add(rest);
            // size = approximate byte count from base64
            const bytes = data ? Math.floor((data.length * 3) / 4) : 0;
            files.push({ name: rest, size: bytes });
          }
        }
      }
    }
    // Subdirectories directly inside path
    for (const d of this.dirs) {
      if (d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        if (!rest.includes('/')) {
          if (!seen.has(rest)) {
            seen.add(rest);
            files.push({ name: rest, size: 0 });
          }
        }
      }
    }

    return { files };
  }

  async stat({ path }: { path: string }) {
    if (this.files.has(path)) {
      const data = this.files.get(path)!;
      return { exists: true, size: Math.floor((data.length * 3) / 4) };
    }
    if (this.dirs.has(path)) return { exists: true, size: 0 };
    return { exists: false, size: 0 };
  }

  async exists({ path }: { path: string }) {
    return { exists: this.files.has(path) || this.dirs.has(path) };
  }

  async copy({ from, to }: { from: string; to: string }) {
    const data = this.files.get(from);
    if (data === undefined) throw new Error(`source not found: ${from}`);
    this.files.set(to, data);
    const parent = to.substring(0, to.lastIndexOf('/'));
    if (parent) this.dirs.add(parent);
  }

  async getUri({ path }: { path: string }) {
    return { uri: `file://${path}` };
  }

  async deleteDir({ path }: { path: string }) {
    // Remove all files and dirs under path
    const prefix = path + '/';
    for (const p of [...this.files.keys()]) {
      if (p === path || p.startsWith(prefix)) this.files.delete(p);
    }
    for (const d of [...this.dirs]) {
      if (d === path || d.startsWith(prefix)) this.dirs.delete(d);
    }
  }

  async delete({ path }: { path: string }) {
    this.files.delete(path);
  }

  async rename({ from, to }: { from: string; to: string }) {
    const data = this.files.get(from);
    if (data !== undefined) {
      this.files.delete(from);
      this.files.set(to, data);
    } else if (this.dirs.has(from)) {
      this.dirs.delete(from);
      this.dirs.add(to);
    } else {
      throw new Error(`not found: ${from}`);
    }
  }
}

// ── Vitest mocks ───────────────────────────────────────────────────────────

let fakeLib: FakePublicLibrary;

vi.mock('@/lib/plugins/publicLibrary', () => ({
  PublicLibrary: new Proxy(
    {},
    {
      get(_target, prop) {
        return (...args: unknown[]) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (fakeLib as any)[prop as string](...args);
      },
    },
  ),
  assertNoTraversal: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => ({ downloadBasePath: null }),
  },
}));

// Capacitor.convertFileSrc stub
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    convertFileSrc: (uri: string) => `capacitor://localhost/${encodeURIComponent(uri)}`,
  },
  registerPlugin: vi.fn(() => ({})),
}));

// Import after mocks
import { AndroidPublicDownloadStore } from '../adapters/android-public';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeBytes(size: number, fill = 0xab): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The library dir is now a RELATIVE path under the picked SAF tree.
const LIB = 'HiPaGo';

// ── Contract suite (mirrors download-store.test.ts) ────────────────────────

describe('AndroidPublicDownloadStore — DownloadStore contract', () => {
  let store: AndroidPublicDownloadStore;

  beforeEach(() => {
    fakeLib = new FakePublicLibrary();
    store = AndroidPublicDownloadStore.create();
  });

  // putImage / getImage

  it('putImage then getImage returns the same bytes', async () => {
    const bytes = makeBytes(16, 0xff);
    await store.putImage(100, 0, bytes, 'webp');
    const result = await store.getImage(100, 0, 'webp');
    expect(result).not.toBeNull();
    expect(result).toEqual(bytes);
  });

  it('getImage returns null for a missing file', async () => {
    const result = await store.getImage(999, 0, 'webp');
    expect(result).toBeNull();
  });

  it('getImage propagates storage I/O errors instead of reporting a missing file', async () => {
    await store.ensureGallery(998, 'Transient Error');
    fakeLib.exists = async () => {
      throw new Error('temporary SAF failure');
    };

    await expect(store.getImage(998, -1, 'json')).rejects.toThrow('temporary SAF failure');
  });

  it('exact folder lookup propagates a stat error so reconciliation stays conservative', async () => {
    fakeLib.stat = async () => {
      throw new Error('temporary stat failure');
    };

    await expect(
      AndroidPublicDownloadStore.create().getImage(997, -1, 'json', {
        folderName: '997 Existing Folder',
      }),
    ).rejects.toThrow('temporary stat failure');
  });

  // imageExists (stat-backed, size>0)

  it('imageExists returns true for a present non-empty page', async () => {
    await store.putImage(100, 0, makeBytes(16, 0xff), 'webp');
    expect(await store.imageExists(100, 0, 'webp')).toBe(true);
  });

  it('imageExists returns false for a missing page', async () => {
    expect(await store.imageExists(999, 0, 'webp')).toBe(false);
  });

  it('imageExists treats a zero-byte page as missing', async () => {
    await store.putImage(100, 1, makeBytes(0), 'webp');
    expect(await store.imageExists(100, 1, 'webp')).toBe(false);
  });

  it('imageExists returns false when the ext differs', async () => {
    await store.putImage(100, 2, makeBytes(8), 'webp');
    expect(await store.imageExists(100, 2, 'jpg')).toBe(false);
  });

  it('imageSize returns the stored byte size and null for a missing page', async () => {
    await store.putImage(100, 3, makeBytes(12), 'webp');
    expect(await store.imageSize(100, 3, 'webp')).toBe(12);
    expect(await store.imageSize(100, 4, 'webp')).toBeNull();
  });

  it('imageSize propagates a transient stat error during restore validation', async () => {
    await store.ensureGallery(101, 'Restore Validation');
    fakeLib.stat = async () => {
      throw new Error('temporary page stat failure');
    };

    await expect(store.imageSize(101, 0, 'webp')).rejects.toThrow('temporary page stat failure');
  });

  it('allImagesExist validates every manifest page with one directory listing', async () => {
    await store.putImage(110, 0, makeBytes(8), 'webp');
    await store.putImage(110, 1, makeBytes(8), 'jpg');
    const readdir = vi.spyOn(fakeLib, 'readdir');

    await expect(store.allImagesExist(110, ['webp', 'jpg'], { folderName: '110' })).resolves.toBe(
      true,
    );
    expect(readdir).toHaveBeenCalledOnce();
  });

  it('allImagesExist rejects a missing or wrongly-extended expected page', async () => {
    await store.putImage(111, 0, makeBytes(8), 'webp');

    await expect(store.allImagesExist(111, ['webp', 'jpg'])).resolves.toBe(false);
    await store.putImage(111, 1, makeBytes(8), 'webp');
    await expect(store.allImagesExist(111, ['webp', 'jpg'])).resolves.toBe(false);
  });

  it('allImagesExist treats a zero-byte expected page as missing', async () => {
    await store.putImage(112, 0, makeBytes(8), 'webp');
    await store.putImage(112, 1, makeBytes(0), 'jpg');

    await expect(store.allImagesExist(112, ['webp', 'jpg'])).resolves.toBe(false);
  });

  it('putImage overwrites an existing file', async () => {
    const original = makeBytes(8, 0x01);
    const updated = makeBytes(8, 0x02);
    await store.putImage(100, 0, original, 'webp');
    await store.putImage(100, 0, updated, 'webp');
    const result = await store.getImage(100, 0, 'webp');
    expect(result).toEqual(updated);
  });

  it('stores multiple pages independently', async () => {
    const a = makeBytes(4, 0x0a);
    const b = makeBytes(4, 0x0b);
    const c = makeBytes(4, 0x0c);
    await store.putImage(200, 0, a, 'jpg');
    await store.putImage(200, 1, b, 'jpg');
    await store.putImage(200, 2, c, 'jpg');
    expect(await store.getImage(200, 0, 'jpg')).toEqual(a);
    expect(await store.getImage(200, 1, 'jpg')).toEqual(b);
    expect(await store.getImage(200, 2, 'jpg')).toEqual(c);
  });

  it('stores multiple galleries independently', async () => {
    const g1 = makeBytes(10, 0x11);
    const g2 = makeBytes(10, 0x22);
    await store.putImage(1, 0, g1, 'webp');
    await store.putImage(2, 0, g2, 'webp');
    expect(await store.getImage(1, 0, 'webp')).toEqual(g1);
    expect(await store.getImage(2, 0, 'webp')).toEqual(g2);
  });

  // listGalleries

  it('listGalleries returns empty array when no galleries', async () => {
    fakeLib.dirs.add(LIB);
    const ids = await store.listGalleries();
    expect(ids).toEqual([]);
  });

  it('listGalleries returns IDs of galleries that have images', async () => {
    await store.putImage(10, 0, makeBytes(4), 'webp');
    await store.putImage(20, 0, makeBytes(4), 'webp');
    const ids = await store.listGalleries();
    expect(ids).toHaveLength(2);
    expect(ids).toContain(10);
    expect(ids).toContain(20);
  });

  it('listGalleries does not duplicate a gallery with multiple pages', async () => {
    await store.putImage(50, 0, makeBytes(4), 'webp');
    await store.putImage(50, 1, makeBytes(4), 'webp');
    await store.putImage(50, 2, makeBytes(4), 'webp');
    const ids = await store.listGalleries();
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(50);
  });

  // deleteGallery

  it('deleteGallery removes all images for the gallery', async () => {
    await store.putImage(300, 0, makeBytes(8), 'webp');
    await store.putImage(300, 1, makeBytes(8), 'webp');
    await store.deleteGallery(300);
    expect(await store.getImage(300, 0, 'webp')).toBeNull();
    expect(await store.getImage(300, 1, 'webp')).toBeNull();
    const ids = await store.listGalleries();
    expect(ids).not.toContain(300);
  });

  it('deleteGallery does not affect other galleries', async () => {
    await store.putImage(400, 0, makeBytes(8), 'webp');
    await store.putImage(401, 0, makeBytes(8), 'webp');
    await store.deleteGallery(400);
    expect(await store.getImage(401, 0, 'webp')).not.toBeNull();
  });

  it('deleteGallery on a non-existent gallery does not throw', async () => {
    await expect(store.deleteGallery(99999)).resolves.not.toThrow();
  });

  it('deleteGallery removes the exact folder and stale aliases for the same gallery id', async () => {
    fakeLib.dirs.add(LIB);
    fakeLib.dirs.add(`${LIB}/450 Old Title`);
    fakeLib.dirs.add(`${LIB}/450 Current Title`);
    fakeLib.files.set(`${LIB}/450 Old Title/0001.webp`, toBase64(makeBytes(4, 0x11)));
    fakeLib.files.set(`${LIB}/450 Current Title/0001.webp`, toBase64(makeBytes(4, 0x22)));

    await store.deleteGallery(450, { folderName: '450 Current Title' });

    expect(fakeLib.dirs.has(`${LIB}/450 Current Title`)).toBe(false);
    expect(fakeLib.files.has(`${LIB}/450 Current Title/0001.webp`)).toBe(false);
    expect(fakeLib.dirs.has(`${LIB}/450 Old Title`)).toBe(false);
    expect(fakeLib.files.has(`${LIB}/450 Old Title/0001.webp`)).toBe(false);
  });

  it('keeps the DB-referenced folder when a stale-alias delete fails mid-sweep', async () => {
    fakeLib.dirs.add(LIB);
    fakeLib.dirs.add(`${LIB}/450 Current Title`);
    fakeLib.dirs.add(`${LIB}/450 Old Title`);
    fakeLib.files.set(`${LIB}/450 Current Title/0001.webp`, toBase64(makeBytes(4, 0x11)));
    fakeLib.files.set(`${LIB}/450 Old Title/0001.webp`, toBase64(makeBytes(4, 0x22)));

    // The stale alias is now deleted first; make that deletion fail so the
    // sweep aborts before touching the DB-referenced preferred folder.
    vi.spyOn(fakeLib, 'deleteDir').mockRejectedValueOnce(new Error('provider denied alias'));

    await expect(
      store.deleteGallery(450, { folderName: '450 Current Title' }),
    ).rejects.toThrow('provider denied alias');

    // The DB-referenced preferred folder must survive the mid-sweep failure.
    expect(fakeLib.dirs.has(`${LIB}/450 Current Title`)).toBe(true);
    expect(fakeLib.files.has(`${LIB}/450 Current Title/0001.webp`)).toBe(true);
  });

  it('deleteGallery propagates native delete errors and keeps the folder tracked', async () => {
    await store.ensureGallery(451, 'Provider Failure');
    await store.putImage(451, 0, makeBytes(4), 'webp');
    vi.spyOn(fakeLib, 'deleteDir').mockRejectedValueOnce(new Error('provider denied delete'));

    await expect(store.deleteGallery(451, { folderName: '451 Provider Failure' })).rejects.toThrow(
      'provider denied delete',
    );
    expect(fakeLib.dirs.has(`${LIB}/451 Provider Failure`)).toBe(true);
  });

  it('deleteGallery rejects a false-positive native success when the folder still exists', async () => {
    await store.ensureGallery(452, 'Silent Failure');
    await store.putImage(452, 0, makeBytes(4), 'webp');
    vi.spyOn(fakeLib, 'deleteDir').mockResolvedValueOnce(undefined);

    await expect(store.deleteGallery(452, { folderName: '452 Silent Failure' })).rejects.toThrow(
      'Failed to delete download folder: 452 Silent Failure',
    );
    expect(fakeLib.dirs.has(`${LIB}/452 Silent Failure`)).toBe(true);
  });

  // gallerySize / usage

  it('gallerySize returns 0 for a gallery with no images', async () => {
    expect(await store.gallerySize(500)).toBe(0);
  });

  it('gallerySize returns the total bytes for all pages', async () => {
    const b1 = makeBytes(12, 0xaa);
    const b2 = makeBytes(12, 0xbb);
    await store.putImage(500, 0, b1, 'webp');
    await store.putImage(500, 1, b2, 'webp');
    // Size is tracked via FakePublicLibrary which derives size from base64 length.
    // The mock returns Math.floor(base64.length * 3 / 4) — same as byteLength
    // for multiples of 3. Both 12-byte arrays → exactly 12 bytes each.
    const size = await store.gallerySize(500);
    expect(size).toBe(24);
  });

  it('gallerySize is 0 after deleteGallery', async () => {
    await store.putImage(600, 0, makeBytes(64), 'webp');
    await store.deleteGallery(600);
    expect(await store.gallerySize(600)).toBe(0);
  });

  it('usage returns 0 when no images stored', async () => {
    fakeLib.dirs.add(LIB);
    expect(await store.usage()).toBe(0);
  });

  it('usage returns total bytes across all galleries', async () => {
    await store.putImage(700, 0, makeBytes(12), 'webp');
    await store.putImage(701, 0, makeBytes(12), 'webp');
    expect(await store.usage()).toBe(24);
  });

  it('usage decreases after deleteGallery', async () => {
    await store.putImage(800, 0, makeBytes(12), 'webp');
    await store.putImage(801, 0, makeBytes(12), 'webp');
    await store.deleteGallery(800);
    expect(await store.usage()).toBe(12);
  });
});

// ── Android-specific tests ─────────────────────────────────────────────────

describe('AndroidPublicDownloadStore — Android-specific behaviour', () => {
  let store: AndroidPublicDownloadStore;

  beforeEach(() => {
    fakeLib = new FakePublicLibrary();
    store = AndroidPublicDownloadStore.create();
  });

  it('ensureGallery creates "<id> <title>" folder and caches it', async () => {
    await store.ensureGallery(12345, 'My Title');
    expect(fakeLib.dirs.has(`${LIB}/12345 My Title`)).toBe(true);
    // After ensureGallery, getImage should use the titled folder.
    const bytes = makeBytes(8, 0x55);
    await store.putImage(12345, 0, bytes, 'webp');
    expect(fakeLib.files.has(`${LIB}/12345 My Title/0001.webp`)).toBe(true);
  });

  it('resolveFolder finds folder by id prefix when cache is empty', async () => {
    // Manually create a titled folder in the fake fs.
    fakeLib.dirs.add(LIB);
    fakeLib.dirs.add(`${LIB}/99 Some Gallery`);

    // Fresh store — no cache.
    const freshStore = AndroidPublicDownloadStore.create();
    const bytes = makeBytes(4, 0xcc);
    // putImage should find '99 Some Gallery' via prefix scan.
    await freshStore.putImage(99, 0, bytes, 'webp');
    expect(fakeLib.files.has(`${LIB}/99 Some Gallery/0001.webp`)).toBe(true);
  });

  it('uses an exact DB folderName instead of a cached stale prefix folder', async () => {
    fakeLib.dirs.add(LIB);
    fakeLib.dirs.add(`${LIB}/123 Old Title`);
    fakeLib.dirs.add(`${LIB}/123 New Title`);
    const staleManifest = new TextEncoder().encode(JSON.stringify(['webp']));
    fakeLib.files.set(`${LIB}/123 Old Title/0000.json`, toBase64(staleManifest));

    const freshStore = AndroidPublicDownloadStore.create();
    expect(await freshStore.getImage(123, -1, 'json')).toEqual(staleManifest);

    expect(await freshStore.getImage(123, -1, 'json', { folderName: '123 New Title' })).toBeNull();
    expect(await freshStore.imageExists(123, 0, 'webp', { folderName: '123 New Title' })).toBe(
      false,
    );
  });

  it('putImage before ensureGallery creates bare "<id>" folder as last resort', async () => {
    const bytes = makeBytes(4, 0x11);
    await store.putImage(42, 0, bytes, 'webp');
    expect(fakeLib.dirs.has(`${LIB}/42`)).toBe(true);
    expect(fakeLib.files.has(`${LIB}/42/0001.webp`)).toBe(true);
  });

  it('coverUrl returns a data URL for the first page (content:// not WebView-loadable)', async () => {
    await store.ensureGallery(777, 'Cover Test');
    const img = makeBytes(8, 0x77);
    await store.putImage(777, 0, img, 'webp');

    const url = await store.coverUrl(777);
    expect(url).not.toBeNull();
    expect(url).toMatch(/^data:image\/webp;base64,/);
    // The base64 payload round-trips to the stored cover bytes.
    expect(fromBase64(url!.split(',')[1])).toEqual(img);
  });

  it('coverUrl returns null when gallery does not exist', async () => {
    const url = await store.coverUrl(9999);
    expect(url).toBeNull();
  });

  it('listGalleries skips .nomedia', async () => {
    fakeLib.dirs.add(LIB);
    // Directly add .nomedia as a file entry for readdir to expose it.
    fakeLib.files.set(`${LIB}/.nomedia`, '');
    await store.putImage(55, 0, makeBytes(4), 'webp');

    const ids = await store.listGalleries();
    expect(ids).toContain(55);
    expect(ids).not.toContain(NaN);
    // .nomedia is not a number so parseInt returns NaN → isNaN → skipped
    for (const id of ids) {
      expect(typeof id).toBe('number');
      expect(isNaN(id)).toBe(false);
    }
  });

  it('listGalleryFolders returns strict IDs, folder names, and title fallbacks', async () => {
    fakeLib.dirs.add(LIB);
    fakeLib.dirs.add(`${LIB}/123 Named Gallery`);
    fakeLib.dirs.add(`${LIB}/456`);
    fakeLib.dirs.add(`${LIB}/789invalid`);

    expect(await store.listGalleryFolders()).toEqual([
      { galleryId: 123, folderName: '123 Named Gallery', title: 'Named Gallery' },
      { galleryId: 456, folderName: '456', title: 'Gallery 456' },
    ]);
  });

  it('listGalleryFolders propagates a transient directory read error', async () => {
    fakeLib.dirs.add(LIB);
    fakeLib.readdir = async () => {
      throw new Error('temporary directory failure');
    };

    await expect(store.listGalleryFolders()).rejects.toThrow('temporary directory failure');
  });

  it('putImageFromFile copies from srcPath to the gallery folder', async () => {
    // Pre-populate a "cache" file.
    const srcPath = '/fake/cache/img_001.webp';
    const srcData = toBase64(makeBytes(12, 0xfe));
    fakeLib.files.set(srcPath, srcData);

    await store.ensureGallery(888, 'Copy Test');
    const size = await store.putImageFromFile(888, 0, srcPath, 'webp');

    expect(fakeLib.files.has(`${LIB}/888 Copy Test/0001.webp`)).toBe(true);
    expect(size).toBeGreaterThan(0);

    // Round-trip via getImage
    const result = await store.getImage(888, 0, 'webp');
    expect(result).toEqual(fromBase64(srcData));
  });

  it('manifest index -1 stores as 0000.json (imageFileName sentinel)', async () => {
    // imageFileName(-1, 'json') → String(-1+1).padStart(4,'0') + '.json' → '0000.json'
    const manifest = new TextEncoder().encode(JSON.stringify(['webp', 'jpg']));
    await store.putImage(111, -1, manifest, 'json');
    expect(fakeLib.files.has(`${LIB}/111/0000.json`)).toBe(true);
    const back = await store.getImage(111, -1, 'json');
    expect(back).toEqual(manifest);
  });
});
