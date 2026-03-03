import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock platform module BEFORE importing tag-fetcher
vi.mock('@/lib/utils/platform', () => ({
  isTauri: vi.fn(() => false),
  isCapacitor: vi.fn(() => false),
}));

import { createTagFetcher } from '../tag-fetcher';
import { isTauri, isCapacitor } from '@/lib/utils/platform';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(isCapacitor).mockReturnValue(false);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe('createTagFetcher — factory', () => {
  it('returns WebProxyFetcher by default (browser)', () => {
    const fetcher = createTagFetcher();
    expect(typeof fetcher.fetchPage).toBe('function');
    expect(typeof fetcher.dispose).toBe('function');
  });

  it('returns TauriSidecarFetcher when Tauri detected', () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const fetcher = createTagFetcher();
    expect(typeof fetcher.fetchPage).toBe('function');
    expect(typeof fetcher.dispose).toBe('function');
  });

  it('returns CapacitorHttpFetcher when Capacitor detected', () => {
    vi.mocked(isCapacitor).mockReturnValue(true);
    const fetcher = createTagFetcher();
    expect(typeof fetcher.fetchPage).toBe('function');
    expect(typeof fetcher.dispose).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// WebProxyFetcher behavior tests
// ---------------------------------------------------------------------------

describe('WebProxyFetcher — behavior', () => {
  it('fetchPage calls correct proxy URL and returns text', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html>test</html>'),
    });

    const fetcher = createTagFetcher(); // default = WebProxyFetcher
    const result = await fetcher.fetchPage('allartists-a.html');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/tags/fetch?url=allartists-a.html',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result).toBe('<html>test</html>');
  });

  it('fetchPage throws on HTTP error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const fetcher = createTagFetcher();
    await expect(fetcher.fetchPage('test.html')).rejects.toThrow(/status 500/);
  });

  it('fetchPage throws on timeout (AbortError)', async () => {
    vi.useFakeTimers();
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetch.mockRejectedValue(abortError);

    const fetcher = createTagFetcher();
    await expect(fetcher.fetchPage('test.html')).rejects.toThrow(/timed out/);

    vi.useRealTimers();
  });

  it('dispose is a no-op for WebProxyFetcher', async () => {
    const fetcher = createTagFetcher();
    await expect(fetcher.dispose()).resolves.toBeUndefined();
  });
});
