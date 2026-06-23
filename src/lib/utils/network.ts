/**
 * Network-type detection for the Wi-Fi-only auto-resume gate.
 *
 * The gate governs ONLY automatic work (auto-resume on launch, auto-advance to
 * the next queued item). A manual tap is userInitiated and bypasses it.
 *
 * Detection strategy:
 *  - Capacitor native: use the Network native plugin's getStatus() through
 *    @capacitor/core's registerPlugin proxy and treat connectionType === 'wifi'
 *    as unmetered. The plugin is optional; if it is absent we fall through.
 *  - Web / desktop: navigator.onLine + the NetworkInformation API
 *    (navigator.connection). A 'cellular' type or saveData hint is metered.
 *  - When nothing is conclusive: best-effort. Treat as unmetered while online
 *    (so a desktop on ethernet / a browser without NetworkInformation is not
 *    permanently gated), metered while offline.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { isCapacitor } from './platform';

interface NetworkInformationLike {
  type?: string;
  effectiveType?: string;
  saveData?: boolean;
}

interface CapacitorNetworkPlugin {
  getStatus(): Promise<{ connected: boolean; connectionType: string }>;
}

// `registerPlugin` returns a proxy without requiring a separate Network JS
// package to be bundled. If the native Network plugin is absent, calls reject
// and nativeIsWifi() falls back to browser best-effort.
const CapacitorNetwork = registerPlugin<CapacitorNetworkPlugin>('Network');

async function nativeIsWifi(): Promise<boolean | null> {
  try {
    if (!Capacitor.isPluginAvailable('Network')) return null;
    const status = await CapacitorNetwork.getStatus();
    if (!status.connected) return false;
    return status.connectionType === 'wifi';
  } catch {
    return null;
  }
}

/**
 * Resolve whether the current network is unmetered (Wi-Fi / ethernet) and safe
 * for automatic downloads. Best-effort; never throws.
 */
export async function isUnmeteredNetwork(): Promise<boolean> {
  // Offline is always metered (nothing to download over).
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }

  // Capacitor native: authoritative connectionType.
  if (isCapacitor()) {
    const wifi = await nativeIsWifi();
    if (wifi !== null) return wifi;
    // Plugin absent: best-effort — online ⇒ allow.
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  }

  // Web / desktop: NetworkInformation when available.
  if (typeof navigator !== 'undefined') {
    const conn = (navigator as unknown as { connection?: NetworkInformationLike }).connection;
    if (conn) {
      if (conn.saveData === true) return false;
      const type = conn.type;
      if (type === 'cellular') return false;
      if (type === 'wifi' || type === 'ethernet') return true;
      // effectiveType is a speed hint, not a metering signal; only the slowest
      // tiers strongly imply a constrained/metered link.
      if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return false;
      // Unknown type but a connection object exists: treat as unmetered.
      return true;
    }
  }

  // No NetworkInformation at all: best-effort allow while online.
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}
