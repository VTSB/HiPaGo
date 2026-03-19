/**
 * Bypass fetch — routes through the Rust bypass-core native addon.
 * Combines DoH + TLS ClientHello fragmentation + Chrome TLS fingerprint.
 */

interface NativeBypassModule {
  bypassFetch(url: string, headers?: Record<string, string> | null): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }>;
}

let nativeModule: NativeBypassModule | null = null;

async function getNativeBypassFetch() {
  if (!nativeModule) {
    try {
      // Use a variable so Turbopack/webpack won't statically analyze the import
      const id = '@hipago/bypass-napi';
      nativeModule = await import(id);
    } catch {
      console.warn('[bypass-fetch] napi addon unavailable, falling back to plain fetch');
      return null;
    }
  }
  return nativeModule;
}

interface BypassFetchInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Fetch a URL with ISP bypass (DoH + TLS fragmentation + Chrome fingerprint).
 * Uses native Rust addon when available, falls back to plain fetch.
 */
export async function bypassFetch(
  url: string | URL,
  init?: BypassFetchInit,
): Promise<Response> {
  const urlStr = url.toString();
  const headers = init?.headers;

  const native = await getNativeBypassFetch();
  if (native) {
    const signal = init?.signal;
    const nativePromise = native.bypassFetch(urlStr, headers).then(
      (resp) =>
        new Response(resp.body as unknown as BodyInit, {
          status: resp.status,
          headers: new Headers(resp.headers),
        }),
    );

    if (!signal) {
      return nativePromise;
    }

    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    }

    const abortPromise = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });

    return Promise.race([nativePromise, abortPromise]);
  }

  // Fallback: plain fetch (no bypass)
  return fetch(urlStr, { headers, signal: init?.signal });
}
