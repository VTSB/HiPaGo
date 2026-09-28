// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamResponse } from '@hipago/bypass-napi';

// Mock the napi module
vi.mock('@hipago/bypass-napi', () => ({
  bypassFetch: vi.fn(),
}));

function mockStreamResponse(
  chunks: Uint8Array[],
  status = 200,
  headers: Record<string, string> = {},
): StreamResponse {
  let index = 0;
  return {
    status,
    headers,
    read: vi.fn(async () => {
      if (index < chunks.length) {
        return chunks[index++] as unknown as Buffer;
      }
      return null;
    }),
  };
}

describe('bypassFetch', () => {
  let bypassFetch: typeof import('../bypass-fetch').bypassFetch;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('when napi addon is available', () => {
    beforeEach(async () => {
      const mod = await import('../bypass-fetch');
      bypassFetch = mod.bypassFetch;
    });

    it('routes through napi addon and returns Response', async () => {
      const { bypassFetch: napiStreamFetch } = await import('@hipago/bypass-napi');
      const chunk = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      vi.mocked(napiStreamFetch).mockResolvedValue(
        mockStreamResponse([chunk], 200, { 'content-type': 'text/html' }),
      );

      const resp = await bypassFetch('https://hitomi.la/');
      expect(resp).toBeInstanceOf(Response);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('text/html');
      const body = await resp.text();
      expect(body).toBe('Hello');
    });

    it('forwards headers to napi addon', async () => {
      const { bypassFetch: napiStreamFetch } = await import('@hipago/bypass-napi');
      vi.mocked(napiStreamFetch).mockResolvedValue(mockStreamResponse([], 200));

      await bypassFetch('https://hitomi.la/', {
        headers: { Referer: 'https://hitomi.la/', 'User-Agent': 'Mozilla/5.0' },
      });

      expect(napiStreamFetch).toHaveBeenCalledWith('https://hitomi.la/', {
        Referer: 'https://hitomi.la/',
        'User-Agent': 'Mozilla/5.0',
      });
    });

    it('converts URL object to string', async () => {
      const { bypassFetch: napiStreamFetch } = await import('@hipago/bypass-napi');
      vi.mocked(napiStreamFetch).mockResolvedValue(mockStreamResponse([], 200));

      await bypassFetch(new URL('https://hitomi.la/path'));
      expect(napiStreamFetch).toHaveBeenCalledWith('https://hitomi.la/path', undefined);
    });

    it('does not use global fetch when napi is available', async () => {
      const { bypassFetch: napiStreamFetch } = await import('@hipago/bypass-napi');
      vi.mocked(napiStreamFetch).mockResolvedValue(mockStreamResponse([], 200));

      await bypassFetch('https://hitomi.la/');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('propagates napi errors', async () => {
      const { bypassFetch: napiStreamFetch } = await import('@hipago/bypass-napi');
      vi.mocked(napiStreamFetch).mockRejectedValue(new Error('connection refused'));

      await expect(bypassFetch('https://hitomi.la/')).rejects.toThrow('connection refused');
    });

    it('rejects with AbortError when signal is already aborted before call', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        bypassFetch('https://hitomi.la/', { signal: controller.signal }),
      ).rejects.toThrow(/abort/i);
    });

    it('rejects with AbortError when signal is aborted during napi call', async () => {
      const { bypassFetch: napiStreamFetch } = await import('@hipago/bypass-napi');
      // Make napi hang forever
      vi.mocked(napiStreamFetch).mockImplementation(() => new Promise(() => {}));

      const controller = new AbortController();
      const fetchPromise = bypassFetch('https://hitomi.la/', { signal: controller.signal });

      // Abort after a tick
      await Promise.resolve();
      controller.abort();

      await expect(fetchPromise).rejects.toThrow(/abort/i);
    });

    it('resolves normally when signal is provided but not aborted', async () => {
      const { bypassFetch: napiStreamFetch } = await import('@hipago/bypass-napi');
      vi.mocked(napiStreamFetch).mockResolvedValue(
        mockStreamResponse([], 200, { 'content-type': 'text/plain' }),
      );

      const controller = new AbortController();
      const resp = await bypassFetch('https://hitomi.la/', { signal: controller.signal });
      expect(resp.status).toBe(200);
    });

    it('streams body chunks correctly', async () => {
      const { bypassFetch: napiStreamFetch } = await import('@hipago/bypass-napi');
      const chunk1 = new Uint8Array([72, 101]); // "He"
      const chunk2 = new Uint8Array([108, 108, 111]); // "llo"
      vi.mocked(napiStreamFetch).mockResolvedValue(mockStreamResponse([chunk1, chunk2]));

      const resp = await bypassFetch('https://hitomi.la/');
      const text = await resp.text();
      expect(text).toBe('Hello');
    });
  });

  describe('native stream lifecycle', () => {
    let nativeFetch: ReturnType<typeof vi.fn>;
    beforeEach(async () => {
      nativeFetch = vi.fn();
      vi.doMock('@hipago/bypass-napi', () => ({ bypassFetch: nativeFetch }));
      bypassFetch = (await import('../bypass-fetch')).bypassFetch;
    });

    it('closes a late native stream after abort before headers', async () => {
      let resolve!: (stream: StreamResponse) => void;
      nativeFetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
      const abort = new AbortController();
      const remove = vi.spyOn(abort.signal, 'removeEventListener');
      const pending = bypassFetch('https://example.test/', { signal: abort.signal });
      await vi.waitFor(() => expect(nativeFetch).toHaveBeenCalled());
      abort.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      const late = { ...mockStreamResponse([]), close: vi.fn() };
      resolve(late);
      await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(late.read).not.toHaveBeenCalled();
    });

    it('errors a pending read immediately on abort and removes its listener', async () => {
      const stream = { ...mockStreamResponse([]), read: vi.fn(() => new Promise<Buffer | null>(() => {})), close: vi.fn() };
      nativeFetch.mockResolvedValue(stream);
      const abort = new AbortController();
      const remove = vi.spyOn(abort.signal, 'removeEventListener');
      const resp = await bypassFetch('https://example.test/', { signal: abort.signal });
      const body = resp.text();
      await vi.waitFor(() => expect(stream.read).toHaveBeenCalled());
      abort.abort();
      await expect(body).rejects.toMatchObject({ name: 'AbortError' });
      expect(stream.close).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('consumer cancellation closes native work even while read is pending', async () => {
      let resolve!: (chunk: Buffer | null) => void;
      const stream = { ...mockStreamResponse([]), read: vi.fn(() => new Promise<Buffer | null>((done) => { resolve = done; })), close: vi.fn() };
      nativeFetch.mockResolvedValue(stream);
      const abort = new AbortController();
      const remove = vi.spyOn(abort.signal, 'removeEventListener');
      const resp = await bypassFetch('https://example.test/', { signal: abort.signal });
      const reader = resp.body!.getReader();
      const pending = reader.read();
      await vi.waitFor(() => expect(stream.read).toHaveBeenCalled());
      await reader.cancel();
      resolve(Buffer.from('late'));
      await expect(pending).resolves.toEqual({ done: true, value: undefined });
      expect(stream.close).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('propagates body failure after a chunk instead of accepting truncated success', async () => {
      const stream = { ...mockStreamResponse([]), read: vi.fn().mockResolvedValueOnce(Buffer.from('part')).mockRejectedValueOnce(new Error('truncated')), close: vi.fn() };
      nativeFetch.mockResolvedValue(stream);
      const abort = new AbortController();
      const remove = vi.spyOn(abort.signal, 'removeEventListener');
      const resp = await bypassFetch('https://example.test/', { signal: abort.signal });
      await expect(resp.text()).rejects.toThrow('truncated');
      expect(stream.close).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it.each([204, 205, 304])('constructs a null body for native and legacy status %i', async (status) => {
      const stream = { ...mockStreamResponse([], status), close: vi.fn() };
      nativeFetch.mockResolvedValueOnce(stream).mockResolvedValueOnce({ status, headers: {}, body: Buffer.alloc(0) });
      const current = await bypassFetch('https://example.test/');
      const legacy = await bypassFetch('https://example.test/');
      expect(current.body).toBeNull();
      expect(legacy.body).toBeNull();
      expect(current.status).toBe(status);
      expect(legacy.status).toBe(status);
      expect(stream.read).not.toHaveBeenCalled();
      expect(stream.close).toHaveBeenCalledOnce();
    });

    it('normal EOF closes native work and removes abort listener', async () => {
      const stream = { ...mockStreamResponse([Buffer.from('ok')]), close: vi.fn() };
      nativeFetch.mockResolvedValue(stream);
      const abort = new AbortController();
      const remove = vi.spyOn(abort.signal, 'removeEventListener');
      const resp = await bypassFetch('https://example.test/', { signal: abort.signal });
      expect(await resp.text()).toBe('ok');
      abort.abort();
      expect(stream.close).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('preserves buffered legacy bodies', async () => {
      nativeFetch.mockResolvedValue({ status: 200, headers: {}, body: Buffer.from('legacy') });
      expect(await (await bypassFetch('https://example.test/')).text()).toBe('legacy');
    });
  });

  describe('when napi addon is unavailable', () => {
    beforeEach(async () => {
      vi.resetModules();
      // Make the napi import fail
      vi.doMock('@hipago/bypass-napi', () => {
        throw new Error('Cannot find module');
      });
      const mod = await import('../bypass-fetch');
      bypassFetch = mod.bypassFetch;
    });

    it('falls back to plain fetch', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('OK', { status: 200 }),
      );

      const resp = await bypassFetch('https://hitomi.la/');
      expect(fetch).toHaveBeenCalled();
      expect(resp.status).toBe(200);
    });

    it('passes headers and signal to plain fetch', async () => {
      const controller = new AbortController();
      vi.mocked(fetch).mockResolvedValue(new Response('OK'));

      await bypassFetch('https://hitomi.la/', {
        headers: { Referer: 'https://hitomi.la/' },
        signal: controller.signal,
      });

      expect(fetch).toHaveBeenCalledWith('https://hitomi.la/', {
        headers: { Referer: 'https://hitomi.la/' },
        signal: controller.signal,
      });
    });

    it('logs warning when falling back', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fetch).mockResolvedValue(new Response('OK'));

      await bypassFetch('https://hitomi.la/');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('napi addon unavailable'),
      );
    });
  });

  describe('napi module caching', () => {
    it('imports napi only once across multiple calls', async () => {
      vi.resetModules();
      let importCount = 0;
      vi.doMock('@hipago/bypass-napi', () => {
        importCount++;
        return {
          bypassFetch: vi.fn().mockResolvedValue(mockStreamResponse([])),
        };
      });
      const mod = await import('../bypass-fetch');

      await mod.bypassFetch('https://hitomi.la/');
      await mod.bypassFetch('https://hitomi.la/');
      await mod.bypassFetch('https://hitomi.la/');

      // Module should only be imported once (cached after first import)
      expect(importCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // AC-002 — addon-availability surface. A failed napi import must be
  // exposed as readable state, not just a console.warn.
  // -------------------------------------------------------------------------
  describe('addon-availability surface', () => {
    it('reports the addon unavailable after an import failure', async () => {
      vi.resetModules();
      vi.doMock('@hipago/bypass-napi', () => {
        throw new Error('Cannot find module');
      });
      const mod = await import('../bypass-fetch');
      vi.mocked(fetch).mockResolvedValue(new Response('OK', { status: 200 }));

      // Not probed yet — must not pre-emptively report unavailable.
      expect(mod.isBypassAddonUnavailable()).toBe(false);
      expect(mod.getBypassAddonError()).toBeNull();

      await mod.bypassFetch('https://hitomi.la/');

      // The failure is surfaced as readable state with a non-empty message.
      expect(mod.isBypassAddonUnavailable()).toBe(true);
      expect(mod.getBypassAddonError()).toBeTruthy();
    });

    it('reports the addon available after a successful CJS-default import', async () => {
      vi.resetModules();
      // Mimic the CommonJS-via-dynamic-import shape: exports land on `.default`.
      vi.doMock('@hipago/bypass-napi', () => ({
        default: { bypassFetch: vi.fn().mockResolvedValue(mockStreamResponse([])) },
      }));
      const mod = await import('../bypass-fetch');

      const resp = await mod.bypassFetch('https://hitomi.la/');
      expect(resp.status).toBe(200);
      expect(mod.isBypassAddonUnavailable()).toBe(false);
      expect(mod.getBypassAddonError()).toBeNull();
    });

    it('treats an addon missing the bypassFetch export as unavailable', async () => {
      vi.resetModules();
      vi.doMock('@hipago/bypass-napi', () => ({ default: {} }));
      const mod = await import('../bypass-fetch');
      vi.mocked(fetch).mockResolvedValue(new Response('OK', { status: 200 }));

      await mod.bypassFetch('https://hitomi.la/');
      expect(mod.isBypassAddonUnavailable()).toBe(true);
      expect(fetch).toHaveBeenCalled();
    });
  });
});
