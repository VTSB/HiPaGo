/**
 * migrate-downloads.ts
 *
 * One-time Data→public migration + startup reconciliation for Android.
 *
 * Migration:
 *   For each DB download row where migratedAt is null:
 *   1. Lease the exact inactive DB snapshot in a transaction.
 *   2. Confirm the old Directory.Data folder exists and validate its manifest.
 *   3. Copy and read-verify every non-empty page in the public store.
 *   4. Publish the manifest last and validate the full target gallery.
 *   5. Delete and verify removal of the old gallery under the same lease.
 *   6. Commit folderName + migratedAt with the storage operation complete.
 *
 * Idempotent: an existing target is accepted only when its manifest matches and
 * every listed page is readable and non-empty.
 * Resumable: per-row migratedAt watermark — crash resumes at next null row.
 *
 * Reconciliation (reconcileLibrary):
 *   For each inactive DB row known to be in public storage, if the new store has
 *   no manifest for that gallery, prune only an unchanged full DB snapshot.
 *   Rows with migratedAt == null are skipped — they live in the old store and
 *   their absence from the new store is expected.
 */

import { isAndroid } from '@/lib/utils/platform';
import {
  listDownloads,
  commitDownloadMigrationIfUnchanged,
  deleteDownloadIfUnchanged,
  getDownload,
  restoreDownloadIfUnchanged,
} from '@/lib/db/download';
import type { DBDownload } from '@/lib/db/schema';
import { galleryFolderName } from '@/lib/storage/base-path-resolver';
import type { DownloadStore, DownloadStoreLookupOptions } from '@/lib/storage/download-store';

// ── Internal helpers ──────────────────────────────────────────────────────────

/** ISO-8601 timestamp for "now". */
function nowISO(): string {
  return new Date().toISOString();
}

/** True while queue, retry, or native ownership may still publish the manifest. */
function hasActiveDownloadLifecycle(row: DBDownload): boolean {
  return (
    row.status === 'downloading' ||
    row.status === 'queued' ||
    row.status === 'paused' ||
    row.nativeRunId != null ||
    row.queuePosition != null ||
    row.nextRetryAt != null
  );
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
      parsed.every((ext) => typeof ext === 'string' && /^[a-zA-Z0-9]{1,16}$/.test(ext))
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
  const bytes = await store.getImage(galleryId, index, ext, options);
  return bytes && bytes.byteLength > 0 ? bytes.byteLength : null;
}

function manifestsMatch(actual: string[] | null, expected: readonly string[]): boolean {
  return (
    actual !== null &&
    actual.length === expected.length &&
    actual.every((ext, index) => ext === expected[index])
  );
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array): boolean {
  if (!left || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < right.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function targetGalleryIsComplete(
  store: DownloadStore,
  galleryId: number,
  exts: readonly string[],
  options: DownloadStoreLookupOptions,
): Promise<boolean> {
  const manifest = await store.getImage(galleryId, -1, 'json', options);
  if (!manifest || !manifestsMatch(decodeManifest(manifest), exts)) return false;

  // Migration is a destructive boundary: read each page successfully instead
  // of treating a manifest or a provider's existence bit as proof of durability.
  for (let index = 0; index < exts.length; index++) {
    const page = await store.getImage(galleryId, index, exts[index], options);
    if (!page || page.byteLength === 0) return false;
  }
  return true;
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

  // Filter lifecycle ownership before touching the legacy filesystem at all.
  // Active rows may still be manifest-last and must not trigger migration IO.
  const rows = (await listDownloads()).filter(
    (row) => row.migratedAt == null && !hasActiveDownloadLifecycle(row),
  );

  // Lazy-import adapters to avoid loading native modules on non-Android paths.
  const { AndroidPublicDownloadStore } = await import('./adapters/android-public');
  const newStore: DownloadStore = AndroidPublicDownloadStore.create();
  if (rows.length === 0) {
    return { migrated: 0, reconciled: await reconcileLibrary(newStore) };
  }

  const { CapacitorDownloadStore } = await import('./adapters/capacitor');
  const oldStore: DownloadStore = await CapacitorDownloadStore.create();
  // One stable scan avoids an O(rows * folders) native directory walk and, more
  // importantly, prevents a transient later scan from changing the migration
  // decision halfway through the same pass.
  const oldIds = await oldStore.listGalleries();
  const oldIdSet = new Set(oldIds);
  let migrated = 0;

  for (const row of rows) {
    const { galleryId, title } = row;

    try {
      const folderName = galleryFolderName(galleryId, title);
      const targetLookup = { folderName };
      const committed = await commitDownloadMigrationIfUnchanged(
        row,
        folderName,
        nowISO(),
        async () => {
          // The DB transaction has leased the exact inactive snapshot before
          // any target write. A concurrent replacement waits until this storage
          // operation and its final watermark commit have completed.
          if (!oldIdSet.has(galleryId)) {
            const targetManifest = await newStore.getImage(galleryId, -1, 'json', targetLookup);
            const targetExts = targetManifest ? decodeManifest(targetManifest) : null;
            return Boolean(
              targetExts &&
              targetExts.length === row.pageCount &&
              (await targetGalleryIsComplete(newStore, galleryId, targetExts, targetLookup)),
            );
          }

          const manifestBytes = await oldStore.getImage(galleryId, -1, 'json');
          if (!manifestBytes) return false;
          const exts = decodeManifest(manifestBytes);
          if (!exts || exts.length !== row.pageCount) {
            // The snapshot page count is authoritative at this destructive
            // boundary. Never delete a source behind a truncated manifest.
            return false;
          }

          await newStore.ensureGallery!(galleryId, title);
          const targetAlreadyComplete = await targetGalleryIsComplete(
            newStore,
            galleryId,
            exts,
            targetLookup,
          );

          // Verify target bytes against the still-authoritative source even
          // when an older run already published a manifest.
          for (let i = 0; i < exts.length; i++) {
            const ext = exts[i];
            const pageBytes = await oldStore.getImage(galleryId, i, ext);
            if (!pageBytes || pageBytes.byteLength === 0) return false;
            const existingPage = await newStore.getImage(galleryId, i, ext, targetLookup);
            if (!bytesEqual(existingPage, pageBytes)) {
              await newStore.putImage(galleryId, i, pageBytes, ext, targetLookup);
              const storedPage = await newStore.getImage(galleryId, i, ext, targetLookup);
              if (!bytesEqual(storedPage, pageBytes)) return false;
            }
          }

          if (!targetAlreadyComplete) {
            await newStore.putImage(galleryId, -1, manifestBytes, 'json', targetLookup);
          }
          if (!(await targetGalleryIsComplete(newStore, galleryId, exts, targetLookup))) {
            return false;
          }

          // Source deletion remains inside the same snapshot lease. A crash
          // here rolls the uncommitted watermark back; the verified target then
          // drives the existing no-source recovery path on the next launch.
          await oldStore.deleteGallery(galleryId);
          const remainingOldIds = await oldStore.listGalleries();
          if (remainingOldIds.includes(galleryId)) return false;
          oldIdSet.delete(galleryId);
          return true;
        },
      );

      if (committed) migrated++;
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

  const foldersByGallery = new Map<number, typeof folders>();
  for (const folder of folders) {
    const candidates = foldersByGallery.get(folder.galleryId) ?? [];
    candidates.push(folder);
    foldersByGallery.set(folder.galleryId, candidates);
  }

  for (const [galleryId, galleryFolders] of foldersByGallery) {
    try {
      // A failed catalog read is not evidence that the row is absent. Let the
      // outer fail-closed path abort restoration so an INSERT OR REPLACE cannot
      // erase an active queue/native ownership lifecycle after a transient fault.
      const existing = await getDownload(galleryId);
      if (existing && hasActiveDownloadLifecycle(existing)) {
        skipped++;
        continue;
      }
      const scanned: Array<{
        folder: (typeof galleryFolders)[number];
        exts: string[];
        totalBytes: number;
        complete: boolean;
      }> = [];

      for (const folder of galleryFolders) {
        const lookup = { folderName: folder.folderName };
        const manifest = await publicStore.getImage(galleryId, -1, 'json', lookup);
        const exts = manifest ? decodeManifest(manifest) : null;
        if (!exts) continue;

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
        scanned.push({ folder, exts, totalBytes, complete });
      }

      if (scanned.length === 0) {
        failed++;
        continue;
      }

      // A gallery id may have several title aliases. Preserve the exact folder
      // already chosen by the DB/catalog; otherwise choose one deterministic,
      // complete candidate and upsert only once for the gallery.
      const exact = existing?.folderName
        ? scanned.find(({ folder }) => folder.folderName === existing.folderName)
        : undefined;
      const selected =
        exact ??
        [...scanned].sort(
          (left, right) =>
            Number(right.complete) - Number(left.complete) ||
            right.exts.length - left.exts.length ||
            left.folder.folderName.localeCompare(right.folder.folderName),
        )[0];
      const { folder, exts, totalBytes, complete } = selected;

      // A catalog-restored partial row may know a larger target than an older
      // short manifest. Preserve that failed/partial state instead of shrinking
      // the target and falsely declaring the folder complete.
      if (existing && existing.pageCount > exts.length) {
        skipped++;
        continue;
      }
      if (
        complete &&
        existing?.status === 'complete' &&
        existing.pageCount === exts.length &&
        existing.folderName === folder.folderName
      ) {
        skipped++;
        continue;
      }

      const restored = await restoreDownloadIfUnchanged(existing, {
        galleryId,
        title: existing?.title || folder.title,
        thumbnail: existing?.thumbnail ?? '',
        tags: existing?.tags ?? '{}',
        pageCount: exts.length,
        totalBytes,
        downloadedAt: existing?.downloadedAt ?? restoredAt,
        status: complete ? 'complete' : 'failed',
        folderName: folder.folderName,
        migratedAt: existing?.migratedAt ?? restoredAt,
        lastError: complete ? null : 'Recovered partial download',
        queuePosition: null,
        retryCount: 0,
        nextRetryAt: null,
      });
      if (restored) imported++;
      else skipped++;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to scan public download ${galleryId}: ${detail}`);
    }
  }

  return { imported, skipped, failed };
}

/**
 * Reconcile the DB against the new public store.
 *
 * Only checks inactive rows where migratedAt != null (rows known to be in public
 * storage). Active queue/native rows may legitimately be manifest-last and are
 * skipped before any filesystem read. Rows with migratedAt == null live in the
 * old Directory.Data store; their absence from the new store is expected and
 * they are never pruned here.
 *
 * For each checked row, if the new store has no manifest (folder deleted/renamed
 * by the user), delete the DB row only if its full snapshot is still unchanged.
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
    // Active workers publish the manifest last, so absence is expected while
    // their lifecycle still owns the row. Skip before starting storage IO.
    if (row.migratedAt == null || hasActiveDownloadLifecycle(row)) continue;

    const { galleryId } = row;
    try {
      const manifest = await store.getImage(galleryId, -1, 'json', {
        folderName: row.folderName ?? undefined,
      });
      if (manifest == null) {
        if (await deleteDownloadIfUnchanged(row)) pruned++;
      }
    } catch {
      // Best-effort; do not prune on errors — conservative.
    }
  }

  return pruned;
}
