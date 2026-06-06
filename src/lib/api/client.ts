import { MI_URL } from '@/lib/utils/constants';
import type { GgConfig } from '@/lib/utils/types';
import { parseGgJs } from '@/lib/utils/image-url';
import { resolveLtnUrl, getNativeHeaders } from './url-resolver';
import { isTauri, isCapacitor, isAndroid } from '@/lib/utils/platform';

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface FetchOptions extends RequestInit {
  range?: string;
  queuePriority?: number;  // lower = higher priority; default 1
}

interface ByteRange {
  start: number;
  end: number;
  length: number;
}

function parseByteRange(range: string): ByteRange | null {
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) return null;

  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    return null;
  }

  return { start, end, length: end - start + 1 };
}

function createTimeoutSignal(ms: number): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms), cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  };
}

class ApiClient {
  private queue: { priority: number; fn: () => void }[] = [];
  private activeRequests = 0;
  private readonly maxConcurrent = 6;
  private async acquire(priority = 1, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.activeRequests < this.maxConcurrent) {
      this.activeRequests++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        priority,
        fn: () => {
          this.activeRequests++;
          resolve();
        },
      };
      // Insert in sorted order (stable: lower priority number = earlier in queue)
      const insertAt = this.queue.findIndex((q) => q.priority > entry.priority);
      if (insertAt === -1) {
        this.queue.push(entry);
      } else {
        this.queue.splice(insertAt, 0, entry);
      }
      if (signal) {
        signal.addEventListener('abort', () => {
          const i = this.queue.indexOf(entry);
          if (i !== -1) this.queue.splice(i, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }
    });
  }

  private release(): void {
    this.activeRequests--;
    const next = this.queue.shift();
    if (next) next.fn();
  }

  async fetchUrl(url: string, options: FetchOptions = {}): Promise<Response> {
    await this.acquire(options.queuePriority ?? 1, options.signal as AbortSignal | undefined);
    try {
      const headers: Record<string, string> = {
        ...getNativeHeaders(),
        ...(options.headers as Record<string, string>),
      };
      if (options.range) {
        headers['Range'] = options.range;
      }

      let response: Response;

      if (isTauri()) {
        // Tauri: use Rust bypass-core via tauri::command
        const { invoke } = await import('@tauri-apps/api/core');
        const resp = (await invoke('bypass_fetch', {
          url,
          headers,
        })) as { status: number; headers: Record<string, string>; body: string };
        const bodyBytes = Uint8Array.from(atob(resp.body), c => c.charCodeAt(0));
        response = new Response(bodyBytes, {
          status: resp.status,
          headers: new Headers(resp.headers),
        });
      } else if (isCapacitor() && !isAndroid()) {
        // iOS Capacitor: use the Rust bypass-core plugin (until the iOS
        // interceptor lands). Android falls through to plain fetch below — its
        // WebView interceptor bypasses + injects headers transparently.
        const { Bypass } = await import('@/lib/plugins/bypass');
        const resp = await Bypass.fetch({ url, headers });
        const bodyBytes = new Uint8Array(resp.body);
        response = new Response(bodyBytes, {
          status: resp.status,
          headers: new Headers(resp.headers),
        });
      } else {
        // Browser: normal fetch through /api/ proxy routes (napi bypass).
        // Android: also a plain fetch, but to the real https URL — its WebView
        // interceptor performs the bypass and injects Referer/Origin.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { range: _range, queuePriority: _qp, ...fetchInit } = options;
        const timeout = options.signal ? null : createTimeoutSignal(30000);
        try {
          response = await fetch(url, {
            ...fetchInit,
            headers,
            signal: options.signal ?? timeout?.signal,
          });
        } finally {
          timeout?.cleanup();
        }
      }

      if (!response.ok && response.status !== 206) {
        throw new ApiError(
          response.status,
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }
      return response;
    } finally {
      this.release();
    }
  }

  async fetchLtn(path: string, options: FetchOptions = {}): Promise<Response> {
    return this.fetchUrl(resolveLtnUrl(path), options);
  }

  async fetchPrimary(
    path: string,
    options: FetchOptions = {},
  ): Promise<Response> {
    return this.fetchUrl(`${MI_URL}${path}`, options);
  }

  async fetchLtnText(path: string, options: FetchOptions = {}): Promise<string> {
    const response = await this.fetchLtn(path, options);
    return response.text();
  }

  async fetchLtnBinary(path: string, range?: string): Promise<ArrayBuffer> {
    const response = await this.fetchLtn(path, { range });
    return response.arrayBuffer();
  }

  async fetchLtnBinaryWithTotal(
    path: string,
    range: string,
  ): Promise<{ data: ArrayBuffer; total: number | null }> {
    const response = await this.fetchLtn(path, { range, queuePriority: 0 });
    const contentRange = response.headers.get('Content-Range');
    let total: number | null = null;
    if (contentRange) {
      const match = /\/(\d+)$/.exec(contentRange);
      if (match) total = parseInt(match[1], 10);
    }
    const data = await response.arrayBuffer();

    const requestedRange = parseByteRange(range);
    if (!contentRange && requestedRange && data.byteLength > requestedRange.length) {
      const slicedEnd = Math.min(requestedRange.end + 1, data.byteLength);
      return {
        data: data.slice(requestedRange.start, slicedEnd),
        total: data.byteLength,
      };
    }

    return { data, total };
  }

  async fetchGgJs(): Promise<string> {
    const response = await this.fetchLtn(`gg.js?_=${Date.now()}`);
    return response.text();
  }
}

export const apiClient = new ApiClient();
export { ApiError };

let cachedGgConfig: GgConfig | null = null;
let ggConfigPromise: Promise<GgConfig> | null = null;
let cachedGgConfigAt = 0;
const GG_CONFIG_TTL = 10 * 60 * 1000; // 10 minutes

export async function getGgConfig(): Promise<GgConfig> {
  if (cachedGgConfig && Date.now() - cachedGgConfigAt < GG_CONFIG_TTL) {
    return cachedGgConfig;
  }
  if (ggConfigPromise) return ggConfigPromise;
  ggConfigPromise = (async () => {
    try {
      const text = await apiClient.fetchGgJs();
      const config = parseGgJs(text);
      cachedGgConfig = config;
      cachedGgConfigAt = Date.now();
      return config;
    } finally {
      ggConfigPromise = null;
    }
  })();
  return ggConfigPromise;
}

export function clearGgConfigCache(): void {
  cachedGgConfig = null;
  ggConfigPromise = null;
  cachedGgConfigAt = 0;
}
