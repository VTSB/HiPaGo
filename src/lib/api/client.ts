import { MI_URL } from '@/lib/utils/constants';
import type { GgConfig } from '@/lib/utils/types';
import { parseGgJs } from '@/lib/utils/image-url';
import { resolveLtnUrl, getNativeHeaders } from './url-resolver';
import { isTauri, isCapacitor } from '@/lib/utils/platform';

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
}

class ApiClient {
  private queue: (() => void)[] = [];
  private activeRequests = 0;
  private readonly maxConcurrent = 6;
  private async acquire(): Promise<void> {
    if (this.activeRequests < this.maxConcurrent) {
      this.activeRequests++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.activeRequests++;
        resolve();
      });
    });
  }

  private release(): void {
    this.activeRequests--;
    const next = this.queue.shift();
    if (next) next();
  }

  async fetchUrl(url: string, options: FetchOptions = {}): Promise<Response> {
    await this.acquire();
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
      } else if (isCapacitor()) {
        // Capacitor: use Rust bypass-core via Capacitor plugin
        const { Bypass } = await import('@/lib/plugins/bypass');
        const resp = await Bypass.fetch({ url, headers });
        const bodyBytes = new Uint8Array(resp.body);
        response = new Response(bodyBytes, {
          status: resp.status,
          headers: new Headers(resp.headers),
        });
      } else {
        // Browser: normal fetch (goes through /api/ proxy routes with napi bypass)
        response = await fetch(url, {
          ...options,
          headers,
          signal: options.signal ?? AbortSignal.timeout(30000),
        });
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

  async fetchLtnText(path: string): Promise<string> {
    const response = await this.fetchLtn(path);
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
    const response = await this.fetchLtn(path, { range });
    const contentRange = response.headers.get('Content-Range');
    let total: number | null = null;
    if (contentRange) {
      const match = /\/(\d+)$/.exec(contentRange);
      if (match) total = parseInt(match[1], 10);
    }
    const data = await response.arrayBuffer();
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
