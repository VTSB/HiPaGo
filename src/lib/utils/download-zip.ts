import { zipSync } from 'fflate';
import { getImageUrl } from './image-url';
import { apiClient } from '@/lib/api/client';
import type { GalleryFile, GgConfig } from './types';
import { createDownloadStore } from '@/lib/storage/download-store';
import { upsertDownload, updateDownloadStatus, serializeTags } from '@/lib/db/download';

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'gallery';
}

function padIndex(idx: number, total: number): string {
  const digits = String(total).length;
  return String(idx).padStart(digits, '0');
}

export interface DownloadProgress {
  current: number;
  total: number;
}

/** Derive the actual file extension from the HTTP response content-type and file metadata. */
function deriveExt(res: Response, file: GalleryFile): string {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('webp')) return 'webp';
  if (!file.haswebp) return file.name.split('.').pop() || 'jpg';
  return 'webp';
}

// ── Index sentinel for manifest storage ───────────────────────────────────────
// The manifest (page ext array) is stored as "0000.json" inside the gallery folder.
// Real page filenames start at "0001.*" (index 0 → index+1 = 1), so 0000 is safe.
const MANIFEST_INDEX = -1; // imageFileName(-1, 'json') → "0000.json"
const MANIFEST_EXT = 'json';

/** Encode the per-page ext array as bytes for storage. */
function encodeManifest(exts: string[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(exts));
}

/** Decode the per-page ext array from stored bytes. Returns [] on error. */
function decodeManifest(bytes: Uint8Array): string[] {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as string[];
  } catch {
    return [];
  }
}

// ── Reader-facing helpers (consumed by AC-005) ─────────────────────────────────

/**
 * Returns the per-page extension list for a downloaded gallery.
 * Returns an empty array when no manifest is found.
 *
 * AC-005 uses this to know the ext for each page when calling getImage.
 */
export async function getDownloadedGalleryPages(
  galleryId: number,
): Promise<{ index: number; ext: string }[]> {
  const store = await createDownloadStore();
  const bytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT);
  if (!bytes) return [];
  const exts = decodeManifest(bytes);
  return exts.map((ext, index) => ({ index, ext }));
}

/**
 * Read one downloaded image by gallery + page index.
 * Resolves the ext via the stored manifest; returns null when missing.
 *
 * AC-005 calls this to load offline images in the reader.
 */
export async function getDownloadedImage(
  galleryId: number,
  index: number,
): Promise<Uint8Array | null> {
  const store = await createDownloadStore();
  const manifestBytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT);
  if (!manifestBytes) return null;
  const exts = decodeManifest(manifestBytes);
  const ext = exts[index];
  if (!ext) return null;
  return store.getImage(galleryId, index, ext);
}

// ── AC-003: Streaming download to the library ──────────────────────────────────

/**
 * Download a gallery into the offline library.
 *
 * Fetches each image one at a time and immediately writes it to DownloadStore
 * (no whole-zip-in-RAM). Creates a `download` DB row with status 'downloading'
 * on start; updates to 'complete' (with final pageCount / totalBytes) on
 * success, or 'failed' on abort/error.
 *
 * The per-page extension list is persisted as a manifest file (0000.json) in
 * the gallery folder so the offline reader (AC-005) can retrieve each image
 * by index without knowing the ext up front.
 */
export async function downloadGalleryToLibrary(
  galleryId: number,
  title: string,
  thumbnail: string,
  files: GalleryFile[],
  ggConfig: GgConfig,
  tags: Record<string, string[]>,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = files.length;
  const now = new Date().toISOString();

  // Register the download as in-progress immediately.
  await upsertDownload({
    galleryId,
    title,
    thumbnail,
    tags: serializeTags(tags),
    pageCount: 0,
    totalBytes: 0,
    downloadedAt: now,
    status: 'downloading',
  });

  const store = await createDownloadStore();
  const pageExts: string[] = [];
  let totalBytes = 0;

  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const file = files[i];
      const url = getImageUrl(file, ggConfig, 'webp');
      const res = await apiClient.fetchUrl(url, { signal });
      const buf = await res.arrayBuffer();
      const ext = deriveExt(res, file);
      const bytes = new Uint8Array(buf);

      await store.putImage(galleryId, i, bytes, ext);
      pageExts.push(ext);
      totalBytes += bytes.byteLength;

      onProgress?.({ current: i + 1, total });
    }

    // Persist the manifest (ext array) so the reader can resolve filenames.
    await store.putImage(galleryId, MANIFEST_INDEX, encodeManifest(pageExts), MANIFEST_EXT);

    // Mark complete with final stats.
    await upsertDownload({
      galleryId,
      title,
      thumbnail,
      tags: serializeTags(tags),
      pageCount: total,
      totalBytes,
      downloadedAt: now,
      status: 'complete',
    });
  } catch (err) {
    await updateDownloadStatus(galleryId, 'failed');
    throw err;
  }
}

// ── AC-007: ZIP export from a library item ─────────────────────────────────────

/**
 * Re-zip the stored loose images for a gallery and trigger an OS download.
 *
 * Reads pages via the stored manifest so it knows each page's ext, then
 * builds a zip with fflate (level 0 — images are already compressed) and
 * triggers the browser `<a download>` to the OS downloads folder.
 *
 * This preserves the original downloadGalleryAsZip behaviour as a secondary
 * action on a library item (AC-004 wires the button).
 */
export async function exportGalleryZip(galleryId: number, title: string): Promise<void> {
  const store = await createDownloadStore();

  // Load the manifest to know how many pages and their exts.
  const manifestBytes = await store.getImage(galleryId, MANIFEST_INDEX, MANIFEST_EXT);
  if (!manifestBytes) {
    throw new Error(`No manifest found for gallery ${galleryId}. Is it fully downloaded?`);
  }
  const exts = decodeManifest(manifestBytes);

  const entries: Record<string, Uint8Array> = {};
  for (let i = 0; i < exts.length; i++) {
    const ext = exts[i];
    const bytes = await store.getImage(galleryId, i, ext);
    if (bytes) {
      // Use the same zero-padded name that the store used, e.g. "0001.webp"
      const name = String(i + 1).padStart(4, '0') + '.' + ext;
      entries[name] = bytes;
    }
  }

  const zipped = zipSync(entries, { level: 0 });
  const safeName = sanitizeFilename(title);
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${galleryId} ${safeName}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Legacy: OS-folder zip download (kept for fallback / older callsites) ───────

export async function downloadGalleryAsZip(
  galleryId: number,
  title: string,
  files: GalleryFile[],
  ggConfig: GgConfig,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const total = files.length;
  const entries: Record<string, Uint8Array> = {};

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const file = files[i];
    const url = getImageUrl(file, ggConfig, 'webp');
    const res = await apiClient.fetchUrl(url, { signal });
    const buf = await res.arrayBuffer();
    // Derive extension from actual content type or URL
    const ct = res.headers.get('content-type') || '';
    let ext = 'webp';
    if (ct.includes('avif')) ext = 'avif';
    else if (ct.includes('png')) ext = 'png';
    else if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg';
    else if (ct.includes('gif')) ext = 'gif';
    else if (!file.haswebp) ext = file.name.split('.').pop() || 'jpg';
    const name = `${padIndex(i + 1, total)}.${ext}`;
    entries[name] = new Uint8Array(buf);

    onProgress?.({ current: i + 1, total });
  }

  const zipped = zipSync(entries, { level: 0 }); // no compression, images are already compressed

  const safeName = sanitizeFilename(title);
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${galleryId} ${safeName}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}
