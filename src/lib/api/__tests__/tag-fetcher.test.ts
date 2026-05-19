import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock platform module BEFORE importing tag-fetcher
vi.mock('@/lib/utils/platform', () => ({
  isTauri: vi.fn(() => false),
  isCapacitor: vi.fn(() => false),
}));

import { createTagFetcher, parseRetryAfter } from '../tag-fetcher';
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
    const request = expect(fetcher.fetchPage('test.html')).rejects.toThrow(/timeout/);
    await vi.runAllTimersAsync();
    await request;
  });

  it('dispose is a no-op for WebProxyFetcher', async () => {
    const fetcher = createTagFetcher();
    await expect(fetcher.dispose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 429 / Retry-After backoff
// ---------------------------------------------------------------------------

describe('parseRetryAfter', () => {
  it('parses delta-seconds to milliseconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter(' 5 ')).toBe(5_000);
  });

  it('returns null for a missing header', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
  });

  it('returns null for an unparseable value', () => {
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('parses an HTTP-date to a future delta', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(0);
    expect(ms!).toBeLessThanOrEqual(30_000);
  });
});

describe('WebProxyFetcher — 429 handling', () => {
  it('retries on 429 then succeeds', async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce({ status: 429, ok: false, headers: { get: () => '1' } })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: () => Promise.resolve('<html>ok</html>'),
      });

    const fetcher = createTagFetcher();
    const request = fetcher.fetchPage('test.html');
    await vi.runAllTimersAsync();

    await expect(request).resolves.toBe('<html>ok</html>');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects with a rate-limited error after maxRetries of 429', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ status: 429, ok: false, headers: { get: () => null } });

    const fetcher = createTagFetcher();
    const request = expect(fetcher.fetchPage('test.html')).rejects.toThrow(/rate limited/i);
    await vi.runAllTimersAsync();
    await request;

    // attempt 0 + 3 retries = 4 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});
