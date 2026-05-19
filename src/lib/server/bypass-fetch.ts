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

/**
 * Whether the napi bypass addon failed to load. `null` until the first
 * `bypassFetch` call resolves the addon; `true`/`false` afterwards. When
 * `true`, `bypassFetch` is silently using the network-blocked plain `fetch`
 * fallback — the UI can surface this instead of failing invisibly.
 */
let addonLoadFailed: boolean | null = null;

/** Last addon-load error message, for diagnostics. */
let addonLoadError: string | null = null;

/**
 * Returns `true` when the napi bypass addon is known to be unavailable
 * (import failed). Returns `false` when it loaded or has not been probed yet.
 */
export function isBypassAddonUnavailable(): boolean {
  return addonLoadFailed === true;
}

/** The addon-load failure message, or `null` if the addon loaded / was not probed. */
export function getBypassAddonError(): string | null {
  return addonLoadError;
}

async function getNativeBypassFetch() {
  if (!nativeModule) {
    try {
      // Use a variable so Turbopack/webpack won't statically analyze the import
      const id = '@hipago/bypass-napi';
      const imported = await import(id);
      // The addon is a CommonJS module — when loaded via dynamic import its
      // exports land on the namespace's `.default`. Prefer a direct
      // `bypassFetch` export when present, otherwise unwrap `.default`.
      // `pick` reads a key defensively: a strict ESM-namespace proxy throws on
      // access to an undefined export, so missing keys resolve to `undefined`.
      const pick = (obj: unknown, key: string): unknown => {
        try {
          return (obj as Record<string, unknown>)?.[key];
        } catch {
          return undefined;
        }
      };
      const resolved = (typeof pick(imported, 'bypassFetch') === 'function'
        ? imported
        : pick(imported, 'default')) as NativeBypassModule | undefined;
      if (!resolved || typeof pick(resolved, 'bypassFetch') !== 'function') {
        throw new Error('addon loaded but bypassFetch export is missing');
      }
      nativeModule = resolved;
      addonLoadFailed = false;
      addonLoadError = null;
    } catch (err) {
      addonLoadFailed = true;
      addonLoadError = err instanceof Error ? err.message : String(err);
      console.warn(`[bypass-fetch] napi addon unavailable, falling back to plain fetch: ${addonLoadError}`);
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

    // Wrap the Node Buffer in a Uint8Array — the WHATWG `Response` constructor
    // accepts a Uint8Array as BodyInit but not a Node Buffer. Buffer is already
    // a Uint8Array view, so this re-wraps the same bytes without copying. The
    // `as ArrayBuffer` cast is sound: a Node Buffer is always backed by a real
    // ArrayBuffer (never SharedArrayBuffer), and BodyInit requires the precise
    // `Uint8Array<ArrayBuffer>` type rather than `Uint8Array<ArrayBufferLike>`.
    const buf = (resp as BufferedResponse).body;
    return new Response(
      new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength),
      {
        status: resp.status,
        headers: new Headers(resp.headers),
      },
    );
  }

  // Fallback: plain fetch (no bypass)
  return fetch(urlStr, { headers, signal: init?.signal });
}
