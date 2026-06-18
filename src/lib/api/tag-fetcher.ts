import { isTauri, isCapacitor } from '@/lib/utils/platform';

export interface TagFetcher {
  /** Fetch a hitomi.la tag page and return raw HTML */
  fetchPage(path: string): Promise<string>;
  /** Clean up resources (kill sidecar, etc.) */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// HttpFetcher — plain fetch with retry/backoff. The URL builder is injected so
// the same retry logic serves the web proxy (/api/tags/fetch) and Android's
// direct https fetch (bypassed transparently by the WebView interceptor).
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

class HttpFetcher implements TagFetcher {
  private maxRetries = 3;

  /** @param buildUrl maps a hitomi path to the URL this platform should fetch. */
  constructor(private readonly buildUrl: (path: string) => string) {}

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
        const resp = await fetch(this.buildUrl(path), {
          signal: controller.signal,
        });
        if (resp.status === 429) {
          // Rate limited — retry, honoring Retry-After verbatim when present.
          retryAfterMs = parseRetryAfter(resp.headers.get('retry-after'));
          lastError = new Error(
            `HttpFetcher: rate limited (429) for "${path}" (attempt ${attempt + 1})`
          );
          continue;
        }
        if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
          lastError = new Error(
            `HttpFetcher: status ${resp.status} for "${path}" (attempt ${attempt + 1})`
          );
          continue;
        }
        if (!resp.ok) {
          throw new Error(
            `HttpFetcher: request failed with status ${resp.status} for path "${path}"`
          );
        }
        return await resp.text();
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          lastError = new Error(`HttpFetcher: timeout for "${path}" (attempt ${attempt + 1})`);
          continue;
        }
        lastError = err as Error;
        if (attempt < this.maxRetries) continue;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error(`HttpFetcher: failed after retries for "${path}"`);
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
    const { invoke } = await import('@tauri-apps/api/core');
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
  // Capacitor (Android + iOS): fetch tag pages through the Bypass plugin
  // (Rust bypass-core), the same JS-fetch transport the api client uses for ltn.
  // The Android WebView interceptor only bypasses <img>/resource loads, NOT JS
  // fetch() calls, so a plain fetch to hitomi.la here goes out un-bypassed and
  // fails on device — which silently blocked the tag-DB sync (and Korean
  // autocomplete, which has no remote fallback). See platform.ts isAndroid docs.
  if (isCapacitor()) return new CapacitorBypassFetcher();
  return new HttpFetcher((path) => '/api/tags/fetch?url=' + encodeURIComponent(path));
}
