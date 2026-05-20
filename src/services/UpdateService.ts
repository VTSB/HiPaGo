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
import { registerPlugin } from '@capacitor/core';
import packageJson from '../../package.json';

const OWNER = 'VTSB';
const REPO = 'HiPaGo';
const APP_VERSION: string = packageJson.version;

export type CheckResult = {
  available: boolean;
  version?: string;
  notes?: string;
  /** Present when the platform can install in-place. UI calls this on "Install". */
  applyFn?: () => Promise<void>;
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
  install(opts: { apkUrl: string }): Promise<void>;
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
    applyFn: async () => {
      await update.downloadAndInstall();
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
    applyFn: async () => {
      // Native side: DownloadManager → ACTION_DOWNLOAD_COMPLETE →
      // install intent via FileProvider. Resolves after the install
      // intent is fired (user still has to tap "Install" in system UI).
      await AndroidUpdater.install({ apkUrl });
    },
  };
}

async function checkIos(): Promise<CheckResult> {
  // iOS sideload cannot self-install: surface a release URL only.
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`);
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
