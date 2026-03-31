/**
 * Bypass fetch — routes through the Rust bypass-core native addon.
 * Combines DoH + TLS ClientHello fragmentation + Chrome TLS fingerprint.
 */

interface StreamResponse {
  status: number;
  headers: Record<string, string>;
  read(): Promise<Buffer | null>;
}

interface BufferedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

interface NativeBypassModule {
  bypassFetch(url: string, headers?: Record<string, string> | null): Promise<StreamResponse | BufferedResponse>;
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
 * Uses streaming napi addon (no full-body buffering), falls back to plain fetch.
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

    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    }

    const resp = await native.bypassFetch(urlStr, headers ?? undefined);

    // Streaming response (new .node) vs buffered response (old .node)
    if ('read' in resp && typeof resp.read === 'function') {
      let aborted = false;
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });

      const readable = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (aborted) { controller.close(); return; }
          const chunk = await (resp as StreamResponse).read();
          if (chunk === null || aborted) { controller.close(); }
          else { controller.enqueue(new Uint8Array(chunk)); }
        },
      });

      return new Response(readable, {
        status: resp.status,
        headers: new Headers(resp.headers),
      });
    }

    return new Response((resp as BufferedResponse).body, {
      status: resp.status,
      headers: new Headers(resp.headers),
    });
  }

  // Fallback: plain fetch (no bypass)
  return fetch(urlStr, { headers, signal: init?.signal });
}
