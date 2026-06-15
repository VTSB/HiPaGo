/**
 * Cross-platform update detection + apply.
 *
 * Branches on three runtimes:
 *  - Tauri (window.__TAURI_INTERNALS__ set)   → @tauri-apps/plugin-updater
 *  - Capacitor Android (Capacitor.getPlatform() === 'android') → custom
 *      Capacitor plugin "Updater" implemented in
 *      android/app/src/main/java/com/hipago/app/UpdaterPlugin.java
 *  - Capacitor iOS (Capacitor.getPlatform() === 'ios')         → no
 *      auto-install; surface the GitHub Release page as a deep link only.
 *  - Plain web (no Tauri, no Capacitor)                          → no-op.
 *
 * The service is intentionally side-effect-light: `checkForUpdate()` only
 * reads remote state; mutation happens inside the returned `applyFn`.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import packageJson from '../../package.json';

const OWNER = 'VTSB';
const REPO = 'HiPaGo';
const APP_VERSION: string = packageJson.version;

export const CURRENT_VERSION = APP_VERSION;

export type ProgressCallback = (percent: number) => void;
export type ApplyResult = {
  status: 'completed' | 'installer_started' | 'permission_required';
  message?: string;
};

export type CheckResult = {
  available: boolean;
  version?: string;
  notes?: string;
  /** Present when the platform can install in-place. UI calls this on
   *  "Install" and may pass a progress callback (0-100). Both the Tauri
   *  backend and Android (via DownloadManager polling) report progress. */
  applyFn?: (onProgress?: ProgressCallback) => Promise<ApplyResult>;
  /** Present when the platform cannot install in-place (iOS). UI deep-links. */
  releaseUrl?: string;
};

interface AndroidUpdaterPlugin {
  check(opts: { owner: string; repo: string }): Promise<{
    available: boolean;
    version?: string;
    notes?: string;
    apkUrl?: string;
  }>;
  install(opts: { apkUrl: string }): Promise<ApplyResult>;
  addListener(
    eventName: 'downloadProgress',
    listenerFunc: (event: { percent: number }) => void,
  ): Promise<PluginListenerHandle>;
}

// `registerPlugin` returns a proxy even when the native plugin is absent —
// calls just reject on non-Android runtimes. Safe to define at module scope.
const AndroidUpdater = registerPlugin<AndroidUpdaterPlugin>('Updater');

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>);
}

function capacitorPlatform(): 'android' | 'ios' | 'web' {
  if (typeof window === 'undefined') return 'web';
  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  if (!cap || typeof cap.getPlatform !== 'function') return 'web';
  const plat = cap.getPlatform();
  return plat === 'android' || plat === 'ios' ? plat : 'web';
}

async function checkTauri(): Promise<CheckResult> {
  // Dynamic import so non-Tauri bundles don't try to resolve the plugin.
  const mod = await import('@tauri-apps/plugin-updater');
  const update = await mod.check();
  if (!update) return { available: false };
  return {
    available: true,
    version: update.version,
    notes: update.body || undefined,
    applyFn: async (onProgress) => {
      let contentLength = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        // Tauri 2 emits Started → Progress* → Finished. Translate the
        // running byte total into a 0-100% value for the UI.
        if (event.event === 'Started') {
          contentLength = event.data.contentLength ?? 0;
          onProgress?.(0);
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          if (contentLength > 0) onProgress?.((received / contentLength) * 100);
        } else if (event.event === 'Finished') {
          onProgress?.(100);
        }
      });
      return { status: 'completed' };
    },
  };
}

async function checkAndroid(): Promise<CheckResult> {
  const res = await AndroidUpdater.check({ owner: OWNER, repo: REPO });
  if (!res.available || !res.apkUrl) return { available: false };
  const apkUrl = res.apkUrl;
  return {
    available: true,
    version: res.version,
    notes: res.notes,
    applyFn: async (onProgress) => {
      // Native side: DownloadManager → ACTION_DOWNLOAD_COMPLETE →
      // install intent via FileProvider. Opening the system installer is
      // not the same thing as a completed install, so the native result is
      // surfaced to let the UI recover if the user cancels.
      //
      // DownloadManager has no progress callback, so the native plugin polls it
      // and emits `downloadProgress` events; forward them to the UI's progress
      // callback. The listener is always removed once install settles.
      const handle = await AndroidUpdater.addListener('downloadProgress', (e) => {
        onProgress?.(Math.max(0, Math.min(100, e.percent)));
      });
      try {
        return await AndroidUpdater.install({ apkUrl });
      } finally {
        await handle.remove();
      }
    },
  };
}

async function checkIos(): Promise<CheckResult> {
  // iOS sideload cannot self-install: surface a release URL only.
  //
  // `cache: 'no-store'` is REQUIRED. With the default fetch cache mode the
  // WKWebView HTTP cache honours GitHub's `Cache-Control: ... max-age` on
  // /releases/latest, so a manual "Check for updates" tap inside the same app
  // session keeps replaying the FIRST response of that session (e.g. taken
  // before the release was published) — the update only appears after an app
  // restart clears the in-process cache. A user-initiated check must always hit
  // the network fresh.
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    cache: 'no-store',
    headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) return { available: false };
  const json = (await res.json()) as { tag_name?: string; html_url?: string; body?: string };
  const tag = json.tag_name;
  if (!tag) return { available: false };
  const remoteVer = tag.startsWith('v') ? tag.slice(1) : tag;
  if (!isNewer(remoteVer, APP_VERSION)) return { available: false };
  return {
    available: true,
    version: remoteVer,
    notes: json.body || undefined,
    releaseUrl: json.html_url,
  };
}

function isNewer(remote: string, current: string): boolean {
  const r = remote.split('.').map((s) => parseInt(s, 10) || 0);
  const c = current.split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    if ((r[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

export const UpdateService = {
  async checkForUpdate(): Promise<CheckResult> {
    try {
      if (isTauri()) return await checkTauri();
      const plat = capacitorPlatform();
      if (plat === 'android') return await checkAndroid();
      if (plat === 'ios') return await checkIos();
      return { available: false };
    } catch (err) {
      // Offline launch, plugin missing, malformed response, etc. — always
      // resolve to "no update". A broken banner is worse than no banner.
      console.warn('[UpdateService] check failed', err);
      return { available: false };
    }
  },
};
