/**
 * migrate-downloads.ts
 *
 * One-time Data→public migration + startup reconciliation for Android.
 *
 * Migration:
 *   For each DB download row where migratedAt is null:
 *   1. Confirm the old Directory.Data folder exists (listGalleries on old store).
 *   2. Read the old manifest (0000.json) to discover page extensions.
 *   3. ensureGallery on the new store (creates "<id> <title>" folder).
 *   4. Copy manifest + each page to the new store.
 *   5. Validate the new folder has the manifest (getImage non-null).
 *   6. markDownloadMigrated + setDownloadFolderName.
 *   7. deleteGallery on the old store.
 *
 * Idempotent: if new folder already has the manifest, skip copy.
 * Resumable: per-row migratedAt watermark — crash resumes at next null row.
 *
 * Reconciliation (reconcileLibrary):
 *   For each DB row that has already been migrated (migratedAt != null), if the
 *   new store has no manifest for that gallery (folder deleted/renamed by user),
 *   prune the dead DB row via deleteDownload.
 *   Rows with migratedAt == null are skipped — they live in the old store and
 *   their absence from the new store is expected.
 */

import { isAndroid } from '@/lib/utils/platform';
import {
  listDownloads,
  markDownloadMigrated,
  setDownloadFolderName,
  deleteDownload,
  getDownload,
  upsertDownload,
} from '@/lib/db/download';
import { galleryFolderName } from '@/lib/storage/base-path-resolver';
import type { DownloadStore, DownloadStoreLookupOptions } from '@/lib/storage/download-store';

// ── Internal helpers ──────────────────────────────────────────────────────────

/** ISO-8601 timestamp for "now". */
function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Decode a manifest JSON byte array to a string extension array.
 * The 0000.json manifest is a flat JSON array of extension strings, one per page.
 * Returns null if the manifest is missing or malformed.
 */
function decodeManifest(bytes: Uint8Array): string[] | null {
  try {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((ext) => typeof ext === 'string' && ext.length > 0)
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function listRestorableFolders(
  store: DownloadStore,
): Promise<{ galleryId: number; folderName: string; title: string }[]> {
  if (store.listGalleryFolders) return store.listGalleryFolders();

  const ids = await store.listGalleries();
  return ids.map((galleryId) => ({
    galleryId,
    folderName: String(galleryId),
    title: `Gallery ${galleryId}`,
  }));
}

async function storedPageSize(
  store: DownloadStore,
  galleryId: number,
  index: number,
  ext: string,
  options: DownloadStoreLookupOptions,
): Promise<number | null> {
  if (store.imageSize) return store.imageSize(galleryId, index, ext, options);
  if (store.imageExists && !(await store.imageExists(galleryId, index, ext, options))) return null;
  const bytes = await store.getImage(galleryId, index, ext, options).catch(() => null);
  return bytes && bytes.byteLength > 0 ? bytes.byteLength : null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Migrate all un-migrated DB download rows from Directory.Data (old
 * CapacitorDownloadStore) to Android public storage (AndroidPublicDownloadStore).
 *
 * Guard: no-op on non-Android platforms.
 * Returns { migrated, reconciled } counts.
 */
export async function migrateDownloadsToPublic(): Promise<{
  migrated: number;
  reconciled: number;
}> {
  if (!isAndroid()) return { migrated: 0, reconciled: 0 };

  // Lazy-import adapters to avoid loading native modules on non-Android paths.
  const { CapacitorDownloadStore } = await import('./adapters/capacitor');
  const { AndroidPublicDownloadStore } = await import('./adapters/android-public');

  const oldStore: DownloadStore = await CapacitorDownloadStore.create();
  const newStore: DownloadStore = AndroidPublicDownloadStore.create();

  const rows = await listDownloads();
  let migrated = 0;

  for (const row of rows) {
    // Skip rows that are already migrated.
    if (row.migratedAt != null) continue;

    const { galleryId, title } = row;

    try {
      // ── Check if old folder exists ──────────────────────────────────────────
      const oldIds = await oldStore.listGalleries();
      if (!oldIds.includes(galleryId)) {
        // Old folder not present — nothing to copy; row stays with null migratedAt
        // so reconciliation can decide what to do later.
        continue;
      }

      // ── Read old manifest ────────────────────────────────────────────────────
      const manifestBytes = await oldStore.getImage(galleryId, -1, 'json');
      if (!manifestBytes) {
        // No manifest in old store — cannot determine page extensions; skip this row.
        continue;
      }
      const exts = decodeManifest(manifestBytes);
      if (!exts) {
        // Malformed manifest; skip.
        continue;
      }

      // ── Check if new folder already has the manifest (idempotent) ─────────
      const folderName = galleryFolderName(galleryId, title);
      await newStore.ensureGallery!(galleryId, title);
      const existingManifest = await newStore.getImage(galleryId, -1, 'json');
      if (existingManifest != null) {
        // Already migrated — just update DB to mark it and move on.
        await markDownloadMigrated(galleryId, folderName, nowISO());
        await setDownloadFolderName(galleryId, folderName);
        migrated++;
        continue;
      }

      // ── Copy manifest ─────────────────────────────────────────────────────
      await newStore.putImage(galleryId, -1, manifestBytes, 'json');

      // ── Copy each page ────────────────────────────────────────────────────
      for (let i = 0; i < exts.length; i++) {
        const ext = exts[i];
        const pageBytes = await oldStore.getImage(galleryId, i, ext);
        if (pageBytes == null) {
          // Missing page — skip (partial download preserved in new store as-is).
          continue;
        }
        await newStore.putImage(galleryId, i, pageBytes, ext);
      }

      // ── Validate new folder has the manifest ──────────────────────────────
      const newManifest = await newStore.getImage(galleryId, -1, 'json');
      if (!newManifest) {
        // Validation failed — do not delete old folder; leave for next run.
        continue;
      }

      // ── Update DB ─────────────────────────────────────────────────────────
      await markDownloadMigrated(galleryId, folderName, nowISO());
      await setDownloadFolderName(galleryId, folderName);

      // ── Delete old folder only after validation ───────────────────────────
      await oldStore.deleteGallery(galleryId);

      migrated++;
    } catch {
      // Per-row error: log and continue so subsequent rows are not blocked.
      // This is intentional — crash-resumable via migratedAt watermark.
    }
  }

  // Run reconciliation after migration and return combined counts.
  const reconciled = await reconcileLibrary(newStore);

  return { migrated, reconciled };
}

/**
 * Restore DB download rows from the user-selected Android public download
 * folder after app data loss/reinstall.
 *
 * Source of truth is the app's manifest file in each gallery folder:
 *   <picked tree>/HiPaGo/<galleryId> <title>/0000.json
 *
 * Complete folders are restored as complete. Partial/torn folders are restored
 * as failed rows so their valid pages remain visible and the normal manual retry
 * path can resolve fresh gallery metadata and resume them. Metadata that is not
 * present on disk (thumbnail/tags) is restored conservatively as empty.
 */
export async function restoreDownloadsFromPublicFolder(
  store?: DownloadStore,
): Promise<{ imported: number; skipped: number; failed: number }> {
  if (!isAndroid()) return { imported: 0, skipped: 0, failed: 0 };

  let publicStore = store;
  if (!publicStore) {
    const { AndroidPublicDownloadStore } = await import('./adapters/android-public');
    publicStore = AndroidPublicDownloadStore.create();
  }

  const folders = await listRestorableFolders(publicStore);
  const restoredAt = nowISO();
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const folder of folders) {
    const { galleryId, folderName, title } = folder;
    const lookup = { folderName };
    try {
      const manifest = await publicStore.getImage(galleryId, -1, 'json', lookup);
      const exts = manifest ? decodeManifest(manifest) : null;
      if (!exts) {
        failed++;
        continue;
      }

      let totalBytes = 0;
      let complete = true;
      for (let i = 0; i < exts.length; i++) {
        const size = await storedPageSize(publicStore, galleryId, i, exts[i], lookup);
        if (size === null) {
          complete = false;
          continue;
        }
        totalBytes += size;
      }

      const existing = await getDownload(galleryId).catch(() => null);
      // Preserve an already-complete DB row even when the on-disk scan reported
      // a missing page. A transient SAF stat failure (or a genuinely torn folder
      // the user can retry) must not downgrade a complete row on the boot path;
      // the explicit download-integrity check surfaces real incompleteness.
      if (
        existing?.status === 'complete' &&
        existing.pageCount === exts.length &&
        existing.folderName === folderName
      ) {
        skipped++;
        continue;
      }

      await upsertDownload({
        galleryId,
        title: existing?.title || title,
        thumbnail: existing?.thumbnail ?? '',
        tags: existing?.tags ?? '{}',
        pageCount: exts.length,
        totalBytes,
        downloadedAt: existing?.downloadedAt ?? restoredAt,
        status: complete ? 'complete' : 'failed',
        folderName,
        migratedAt: existing?.migratedAt ?? restoredAt,
        lastError: complete ? null : 'Recovered partial download',
        queuePosition: null,
        retryCount: 0,
        nextRetryAt: null,
      });
      imported++;
    } catch {
      failed++;
    }
  }

  return { imported, skipped, failed };
}

/**
 * Reconcile the DB against the new public store.
 *
 * Only checks rows where migratedAt != null (rows known to be in public storage).
 * Rows with migratedAt == null live in the old Directory.Data store; their
 * absence from the new store is expected and they are never pruned here.
 *
 * For each checked row, if the new store has no manifest (folder deleted/renamed
 * by the user), delete the DB row (prune the dead entry).
 *
 * Can be called standalone (e.g. after a permission grant recheck).
 * Returns the count of pruned rows.
 */
export async function reconcileLibrary(newStore?: DownloadStore): Promise<number> {
  if (!isAndroid()) return 0;

  let store = newStore;
  if (!store) {
    const { AndroidPublicDownloadStore } = await import('./adapters/android-public');
    store = AndroidPublicDownloadStore.create();
  }

  const rows = await listDownloads();
  let pruned = 0;

  for (const row of rows) {
    // Skip un-migrated rows — they are not expected to be in the new store yet.
    if (row.migratedAt == null) continue;

    const { galleryId } = row;
    try {
      const manifest = await store.getImage(galleryId, -1, 'json');
      if (manifest == null) {
        await deleteDownload(galleryId);
        pruned++;
      }
    } catch {
      // Best-effort; do not prune on errors — conservative.
    }
  }

  return pruned;
}
