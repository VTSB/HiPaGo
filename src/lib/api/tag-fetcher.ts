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

/**
 * Parse an HTTP `Retry-After` header value to milliseconds.
 * Accepts delta-seconds (`"120"`) or an HTTP-date. Returns null when the
 * header is absent or unparseable, so the caller can fall back to its own
 * backoff. The value is honored verbatim — no upper cap.
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

class WebProxyFetcher implements TagFetcher {
  private maxRetries = 3;

  async fetchPage(path: string): Promise<string> {
    let lastError: Error | undefined;
    // Set from a 429 response's Retry-After header; consumed by the next
    // iteration's backoff wait, then cleared.
    let retryAfterMs: number | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = retryAfterMs ?? 1000 * 2 ** (attempt - 1);
        retryAfterMs = null;
        await new Promise((r) => setTimeout(r, delay));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const resp = await fetch('/api/tags/fetch?url=' + encodeURIComponent(path), {
          signal: controller.signal,
        });
        if (resp.status === 429) {
          // Rate limited — retry, honoring Retry-After verbatim when present.
          retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'));
          lastError = new Error(
            `WebProxyFetcher: rate limited (429) for "${path}" (attempt ${attempt + 1})`
          );
          continue;
        }
        if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
          lastError = new Error(
            `WebProxyFetcher: status ${resp.status} for "${path}" (attempt ${attempt + 1})`
          );
          continue;
        }
        if (!resp.ok) {
          throw new Error(
            `WebProxyFetcher: request failed with status ${resp.status} for path "${path}"`
          );
        }
        return await resp.text();
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          lastError = new Error(`WebProxyFetcher: timeout for "${path}" (attempt ${attempt + 1})`);
          continue;
        }
        lastError = err as Error;
        if (attempt < this.maxRetries) continue;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error(`WebProxyFetcher: failed after retries for "${path}"`);
  }

  async dispose(): Promise<void> {
    // no-op for web proxy
  }
}

// ---------------------------------------------------------------------------
// TauriBypassFetcher — Tauri desktop (Rust bypass-core via tauri::command)
// ---------------------------------------------------------------------------

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
