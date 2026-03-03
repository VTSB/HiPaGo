import { isTauri, isCapacitor } from '@/lib/utils/platform';

export interface TagFetcher {
  /** Fetch a hitomi.la tag page and return raw HTML */
  fetchPage(path: string): Promise<string>;
  /** Clean up resources (kill sidecar, etc.) */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// WebProxyFetcher — default for plain browser / Next.js
// ---------------------------------------------------------------------------

class WebProxyFetcher implements TagFetcher {
  async fetchPage(path: string): Promise<string> {
    const url = '/api/tags/fetch?url=' + encodeURIComponent(path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        throw new Error(
          `WebProxyFetcher: request failed with status ${resp.status} for path "${path}"`
        );
      }
      return await resp.text();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`WebProxyFetcher: request timed out after 30s for path "${path}"`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async dispose(): Promise<void> {
    // no-op for web proxy
  }
}

// ---------------------------------------------------------------------------
// TauriBypassFetcher — Tauri desktop (Rust bypass-core via tauri::command)
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;

class TauriBypassFetcher implements TagFetcher {
  async fetchPage(path: string): Promise<string> {
    const tauriModule = '@tauri-apps/api/core';
    const { invoke } = await import(/* webpackIgnore: true */ tauriModule);
    const resp = (await invoke('bypass_fetch', {
      url: `https://hitomi.la/${path}`,
      headers: { Referer: 'https://hitomi.la/', Origin: 'https://hitomi.la' },
    })) as { status: number; headers: Record<string, string>; body: string };
    // Decode base64 body to string
    return atob(resp.body);
  }

  async dispose(): Promise<void> {
    // no-op — Rust client is managed globally
  }
}

// ---------------------------------------------------------------------------
// CapacitorBypassFetcher — Capacitor (Rust bypass-core via Capacitor plugin)
// ---------------------------------------------------------------------------

class CapacitorBypassFetcher implements TagFetcher {
  async fetchPage(path: string): Promise<string> {
    const { Bypass } = await import('@/lib/plugins/bypass');
    const resp = await Bypass.fetch({
      url: `https://hitomi.la/${path}`,
      headers: { Referer: 'https://hitomi.la/', Origin: 'https://hitomi.la' },
    });
    return new TextDecoder().decode(new Uint8Array(resp.body));
  }

  async dispose(): Promise<void> {
    // no-op — Rust client is managed globally
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTagFetcher(): TagFetcher {
  if (isTauri()) return new TauriBypassFetcher();
  if (isCapacitor()) return new CapacitorBypassFetcher();
  return new WebProxyFetcher();
}
