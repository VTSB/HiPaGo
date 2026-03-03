// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the napi module
vi.mock('@hipago/bypass-napi', () => ({
  bypassFetch: vi.fn(),
}));

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
      const { bypassFetch: napiFetch } = await import('@hipago/bypass-napi');
      const mockBody = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      vi.mocked(napiFetch).mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: mockBody,
      });

      const resp = await bypassFetch('https://hitomi.la/');
      expect(resp).toBeInstanceOf(Response);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toBe('text/html');
    });

    it('forwards headers to napi addon', async () => {
      const { bypassFetch: napiFetch } = await import('@hipago/bypass-napi');
      vi.mocked(napiFetch).mockResolvedValue({
        status: 200,
        headers: {},
        body: new Uint8Array(0),
      });

      await bypassFetch('https://hitomi.la/', {
        headers: { Referer: 'https://hitomi.la/', 'User-Agent': 'Mozilla/5.0' },
      });

      expect(napiFetch).toHaveBeenCalledWith('https://hitomi.la/', {
        Referer: 'https://hitomi.la/',
        'User-Agent': 'Mozilla/5.0',
      });
    });

    it('converts URL object to string', async () => {
      const { bypassFetch: napiFetch } = await import('@hipago/bypass-napi');
      vi.mocked(napiFetch).mockResolvedValue({
        status: 200,
        headers: {},
        body: new Uint8Array(0),
      });

      await bypassFetch(new URL('https://hitomi.la/path'));
      expect(napiFetch).toHaveBeenCalledWith('https://hitomi.la/path', undefined);
    });

    it('does not use global fetch when napi is available', async () => {
      const { bypassFetch: napiFetch } = await import('@hipago/bypass-napi');
      vi.mocked(napiFetch).mockResolvedValue({
        status: 200,
        headers: {},
        body: new Uint8Array(0),
      });

      await bypassFetch('https://hitomi.la/');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('propagates napi errors', async () => {
      const { bypassFetch: napiFetch } = await import('@hipago/bypass-napi');
      vi.mocked(napiFetch).mockRejectedValue(new Error('connection refused'));

      await expect(bypassFetch('https://hitomi.la/')).rejects.toThrow('connection refused');
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
          bypassFetch: vi.fn().mockResolvedValue({
            status: 200,
            headers: {},
            body: new Uint8Array(0),
          }),
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
