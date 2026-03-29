// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the napi module
vi.mock('@hipago/bypass-napi', () => ({
  bypassFetch: vi.fn(),
}));

function mockStreamResponse(
  chunks: Uint8Array[],
  status = 200,
  headers: Record<string, string> = {},
) {
  let index = 0;
  return {
    status,
    headers,
    read: vi.fn(async () => {
      if (index < chunks.length) {
        return chunks[index++];
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
});
