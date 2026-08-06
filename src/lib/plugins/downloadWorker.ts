/**
 * Shared Capacitor contract for the native Android WorkManager downloader and
 * the iOS BGProcessingTask backstop.
 *
 * On Android the worker is the SOLE downloader. TS resolves a gallery's
 * work-order, hands it off to the native side via {@link writeWorkOrder} (so TS
 * never needs raw access to the app's filesDir), then schedules the worker via
 * {@link enqueue}. One unique, connected-network worker chain drains pending
 * work-orders over Wi-Fi, ethernet, or cellular, surviving app background/kill
 * with a foreground notification. On iOS the same generation-aware contract
 * schedules a best-effort backstop while the in-process TS downloader remains
 * primary. Web and Tauri do not register this plugin.
 */
import { registerPlugin } from '@capacitor/core';

export interface NativeRunLookup {
  runId: string | null;
  /** Order and progress both exist but identify different valid generations. */
  conflict?: boolean;
  /** Native files exist, but their identity cannot be read or validated safely. */
  unknown?: boolean;
  /**
   * A strictly validated pre-runId work order is pending one-time replacement.
   * This is not proof of absence: generic cancel/finalize paths must keep their
   * ownership barrier, while restart recovery may requeue a DB row that also has
   * no run token so writeWorkOrder can perform the guarded legacy replacement.
   */
  legacy?: boolean;
}

/** True when native state exists but cannot safely prove one run or absence. */
export function isNativeRunLookupUncertain(result: NativeRunLookup): boolean {
  return result.conflict === true || result.unknown === true;
}

export interface DownloadWorkerPlugin {
  /**
   * Persist a work-order JSON to the native handoff dir
   * (`dl-queue/<galleryId>.json` in app-private storage). `json` is the serialized
   * {@link import('@/lib/utils/work-order').WorkOrder}. Does NOT schedule the
   * worker — call {@link enqueue} after.
   */
  writeWorkOrder(options: { galleryId: string; runId: string; json: string }): Promise<void>;

  /**
   * Schedule the platform's native background drain. The work-order file is
   * assumed already written and must still belong to this runId.
   */
  enqueue(options: { galleryId: string; runId: string }): Promise<void>;

  /**
   * Cancel one concrete gallery attempt. A late cancellation is a no-op when the
   * pathname already belongs to another runId. When no work-orders remain, native
   * also cancels the unique work chain.
   */
  cancel(options: { galleryId: string; runId: string }): Promise<{
    runId: string;
    cancelled: boolean;
    stale: boolean;
    remaining: number;
  }>;

  /**
   * Read one gallery's live download progress, published by the worker to
   * app-private `dl-progress/<galleryId>.json`. Native returns progress only when its
   * embedded runId matches the requested attempt. A replacement is returned as
   * `{current: null, stale: true, runId}`; absence/completion is `{current: null}`.
   * A native terminal failure is `{current: null, error}`.
   */
  getProgress(options: { galleryId: string; runId: string }): Promise<
    | {
        runId: string;
        current: number;
        total: number;
        downloadedBytes?: number;
        state?: 'running' | 'failed' | 'completed';
        completed?: boolean;
        manifestPageCount?: number;
        completedAt?: string;
        error?: string;
        stale?: false;
        unknown?: false;
      }
    | {
        runId: string;
        current: null;
        error?: string;
        stale?: boolean;
        unknown?: boolean;
      }
  >;

  /**
   * Read-only identity discovery for restoring native polling after the JS
   * runtime restarts. A bare `{runId:null}` is confirmed absence. Conflicting
   * identities return `conflict:true`; unreadable or otherwise indeterminate
   * native state returns `unknown:true`. A confirmed pre-runId order returns
   * `legacy:true`. Callers must fail closed for conflict/unknown and may replace
   * legacy state only from the explicit restart-upgrade path.
   */
  getCurrentRun(options: { galleryId: string }): Promise<NativeRunLookup>;
}

export const DownloadWorker = registerPlugin<DownloadWorkerPlugin>('DownloadWorker');
