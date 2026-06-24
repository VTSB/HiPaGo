/**
 * Capacitor plugin wrapper for DownloadWorkerPlugin — the native Android
 * WorkManager background download worker (Task C).
 *
 * On Android the worker is the SOLE downloader. TS resolves a gallery's
 * work-order, hands it off to the native side via {@link writeWorkOrder} (so TS
 * never needs raw access to the app's filesDir), then schedules the worker via
 * {@link enqueue}. One unique, connected-network worker chain drains pending
 * work-orders over Wi-Fi, ethernet, or cellular, surviving app background/kill
 * with a foreground notification.
 *
 * {@link cancel} drops one gallery's pending work-order and stops the worker when
 * the queue empties.
 *
 * This plugin is implemented ONLY on Android; callers must gate on isAndroid()
 * before invoking it (web/Tauri/iOS keep the in-process TS downloader).
 */
import { registerPlugin } from '@capacitor/core';

export interface DownloadWorkerPlugin {
  /**
   * Persist a work-order JSON to the native handoff dir
   * (filesDir/dl-queue/<galleryId>.json). `json` is the already-serialized
   * {@link import('@/lib/utils/work-order').WorkOrder}. Does NOT schedule the
   * worker — call {@link enqueue} after.
   */
  writeWorkOrder(options: { galleryId: string; json: string }): Promise<void>;

  /**
   * Schedule the unique, CONNECTED-constrained download worker chain
   * (ExistingWorkPolicy.APPEND_OR_REPLACE). The work-order file is assumed
   * already written. Appending a follow-up pass closes the race where a new
   * work-order lands while the current worker run is already finishing.
   */
  enqueue(options: { galleryId: string }): Promise<void>;

  /**
   * Cancel one gallery's pending download: removes its work-order file and, when
   * none remain, cancels the unique work. Resolves the count of remaining
   * work-orders.
   */
  cancel(options: { galleryId: string }): Promise<{ remaining: number }>;

  /**
   * Read one gallery's live download progress, published by the worker to
   * `filesDir/dl-progress/<galleryId>.json`. Resolves `{current, total}` while the
   * gallery is actively downloading; resolves `{current: null}` (a sentinel the TS
   * poller maps to `null`) when no progress file exists (not started, or already
   * completed/cleared).
   *
   * Android-only: the native worker is the sole downloader on Android. iOS omits
   * this method (its foreground download is already in-process), so the TS poller
   * is isAndroid-gated and never calls it on iOS.
   */
  getProgress(options: {
    galleryId: string;
  }): Promise<{ current: number; total: number } | { current: null }>;
}

export const DownloadWorker = registerPlugin<DownloadWorkerPlugin>('DownloadWorker');
