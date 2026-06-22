import { isTauri, isCapacitor } from '@/lib/utils/platform';

export interface TagFetcher {
  /** Fetch a hitomi.la tag page and return raw HTML */
  fetchPage(path: string): Promise<string>;
  /** Clean up resources (kill sidecar, etc.) */
  dispose(): Promise<void>;
}

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const TAG_PAGE_BASE_URL = 'https://hitomi.la';
const TAG_PAGE_ORIGIN = 'https://hitomi.la';

const TAG_PAGE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  Referer: `${TAG_PAGE_ORIGIN}/`,
  Origin: TAG_PAGE_ORIGIN,
};

type HeaderBag = Headers | Record<string, string> | { get(name: string): string | null };

interface FetchPageResponse {
  status: number;
  headers?: HeaderBag;
  text(): Promise<string>;
}

class NonRetryableTagFetchError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHeader(headers: HeaderBag | undefined, name: string): string | null {
  if (!headers) return null;

  const get = (headers as { get?: (headerName: string) => string | null | undefined }).get;
  if (typeof get === 'function') {
    return get.call(headers, name) ?? null;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function decodeBase64Utf8(body: string): string {
  const bytes = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function errorName(err: unknown): string | undefined {
  const name = (err as { name?: unknown })?.name;
  return typeof name === 'string' ? name : undefined;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  const error = new Error(String(err));
  const name = errorName(err);
  if (name) error.name = name;
  return error;
}

async function fetchPageWithRetries(
  label: string,
  path: string,
  fetchOnce: () => Promise<FetchPageResponse>,
): Promise<string> {
  let lastError: Error | undefined;
  // Set from a 429 response's Retry-After header; consumed by the next
  // iteration's backoff wait, then cleared.
  let retryAfterMs: number | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = retryAfterMs ?? 1000 * 2 ** (attempt - 1);
      retryAfterMs = null;
      await sleep(delay);
    }

    try {
      const resp = await fetchOnce();

      if (resp.status === 429) {
        retryAfterMs = parseRetryAfter(getHeader(resp.headers, 'retry-after'));
        lastError = new Error(
          `${label}: rate limited (429) for "${path}" (attempt ${attempt + 1})`,
        );
        continue;
      }

      if (isRetryableStatus(resp.status)) {
        lastError = new Error(
          `${label}: status ${resp.status} for "${path}" (attempt ${attempt + 1})`,
        );
        continue;
      }

      if (!isSuccessfulStatus(resp.status)) {
        throw new NonRetryableTagFetchError(
          `${label}: request failed with status ${resp.status} for path "${path}"`,
        );
      }

      return await resp.text();
    } catch (err) {
      if (err instanceof NonRetryableTagFetchError) throw err;

      const error = toError(err);
      if (errorName(err) === 'AbortError') {
        lastError = new Error(`${label}: timeout for "${path}" (attempt ${attempt + 1})`);
      } else {
        lastError = error;
      }

      if (attempt < MAX_RETRIES) continue;
      throw lastError;
    }
  }

  throw lastError ?? new Error(`${label}: failed after retries for "${path}"`);
}

// ---------------------------------------------------------------------------
// HttpFetcher — plain fetch with retry/backoff. The URL builder is injected so
// browser builds can go through the web proxy (/api/tags/fetch). Native builds
// below reuse the same status/retry helper around bypass-core.
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
  /** @param buildUrl maps a hitomi path to the URL this platform should fetch. */
  constructor(private readonly buildUrl: (path: string) => string) {}

  async fetchPage(path: string): Promise<string> {
    return fetchPageWithRetries('HttpFetcher', path, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const resp = await fetch(this.buildUrl(path), {
          signal: controller.signal,
        });
        return {
          status: resp.status,
          headers: resp.headers,
          text: () => resp.text(),
        };
      } finally {
        clearTimeout(timer);
      }
    });
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
    return fetchPageWithRetries('TauriBypassFetcher', path, async () => {
      const resp = (await invoke('bypass_fetch', {
        url: `${TAG_PAGE_BASE_URL}/${path}`,
        headers: { ...TAG_PAGE_HEADERS },
      })) as { status: number; headers: Record<string, string>; body: string };

      return {
        status: resp.status,
        headers: resp.headers,
        text: async () => decodeBase64Utf8(resp.body),
      };
    });
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
    return fetchPageWithRetries('CapacitorBypassFetcher', path, async () => {
      const resp = await Bypass.fetch({
        url: `${TAG_PAGE_BASE_URL}/${path}`,
        headers: { ...TAG_PAGE_HEADERS },
      });

      return {
        status: resp.status,
        headers: resp.headers,
        text: async () => new TextDecoder().decode(new Uint8Array(resp.body)),
      };
    });
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
