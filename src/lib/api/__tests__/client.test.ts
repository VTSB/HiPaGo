// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient, ApiError, getGgConfig, clearGgConfigCache } from '../client';

const bypassFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/plugins/bypass', () => ({
  Bypass: {
    fetch: bypassFetchMock,
  },
}));

describe('ApiError', () => {
  it('should set status and message', () => {
    const error = new ApiError(404, 'Not Found');
    expect(error.status).toBe(404);
    expect(error.message).toBe('Not Found');
  });

  it('should be instanceof Error', () => {
    const error = new ApiError(500, 'Internal Server Error');
    expect(error).toBeInstanceOf(Error);
  });

  it('should have name ApiError', () => {
    const error = new ApiError(403, 'Forbidden');
    expect(error.name).toBe('ApiError');
  });
});

describe('apiClient.fetchUrl', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    bypassFetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return response on successful fetch', async () => {
    const mockResponse = new Response('success', { status: 200, statusText: 'OK' });
    fetchMock.mockResolvedValue(mockResponse);

    const response = await apiClient.fetchUrl('https://example.com/test');

    expect(response).toBe(mockResponse);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/test', expect.objectContaining({ headers: {} }));
  });

  it('uses the Bypass plugin on Android API fetches so Range response headers stay visible', async () => {
    // Real platform module reads window.Capacitor; make it Android.
    vi.stubGlobal('window', {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    });
    bypassFetchMock.mockResolvedValue({
      status: 206,
      headers: { 'Content-Range': 'bytes 0-399/8000' },
      body: [1, 2, 3, 4],
    });

    const response = await apiClient.fetchUrl('https://aa.gold-usergeneratedcontent.net/x', {
      range: 'bytes=0-399',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(bypassFetchMock).toHaveBeenCalledWith({
      url: 'https://aa.gold-usergeneratedcontent.net/x',
      headers: expect.objectContaining({
        Range: 'bytes=0-399',
        Referer: 'https://hitomi.la/',
      }),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 0-399/8000');
  });

  it('should throw ApiError on non-ok response', async () => {
    const mockResponse = new Response('not found', { status: 404, statusText: 'Not Found' });
    Object.defineProperty(mockResponse, 'ok', { value: false });
    fetchMock.mockResolvedValue(mockResponse);

    await expect(apiClient.fetchUrl('https://example.com/missing')).rejects.toThrow(ApiError);
    await expect(apiClient.fetchUrl('https://example.com/missing')).rejects.toThrow('HTTP 404: Not Found');
  });

  it('should NOT throw on 206 status (partial content)', async () => {
    const mockResponse = new Response('partial', { status: 206, statusText: 'Partial Content' });
    Object.defineProperty(mockResponse, 'ok', { value: false });
    fetchMock.mockResolvedValue(mockResponse);

    const response = await apiClient.fetchUrl('https://example.com/partial');

    expect(response).toBe(mockResponse);
    expect(response.status).toBe(206);
  });

  it('should add Range header when options.range is provided', async () => {
    const mockResponse = new Response('range', { status: 206 });
    Object.defineProperty(mockResponse, 'ok', { value: false });
    fetchMock.mockResolvedValue(mockResponse);

    await apiClient.fetchUrl('https://example.com/file', { range: 'bytes=0-1023' });

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file', expect.objectContaining({
      headers: { Range: 'bytes=0-1023' },
    }));
  });

  it('should forward custom headers', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    await apiClient.fetchUrl('https://example.com/api', {
      headers: { 'X-Custom-Header': 'value', 'Authorization': 'Bearer token' },
    });

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/api', expect.objectContaining({
      headers: { 'X-Custom-Header': 'value', 'Authorization': 'Bearer token' },
    }));
  });

  it('should work when AbortSignal.timeout is unavailable', async () => {
    const originalTimeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: undefined,
    });
    const mockResponse = new Response('ok', { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    try {
      const response = await apiClient.fetchUrl('https://example.com/legacy-webview');

      expect(response).toBe(mockResponse);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/legacy-webview',
        expect.objectContaining({
          headers: {},
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', {
        configurable: true,
        value: originalTimeout,
      });
    }
  });

  it('should merge custom headers with Range header', async () => {
    const mockResponse = new Response('ok', { status: 206 });
    Object.defineProperty(mockResponse, 'ok', { value: false });
    fetchMock.mockResolvedValue(mockResponse);

    await apiClient.fetchUrl('https://example.com/file', {
      headers: { 'X-Custom': 'test' },
      range: 'bytes=0-499',
    });

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file', expect.objectContaining({
      headers: { 'X-Custom': 'test', Range: 'bytes=0-499' },
    }));
  });
});

describe('apiClient.fetchLtn', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should call fetchUrl with /api/hitomi/ prefix', async () => {
    const mockResponse = new Response('ltn', { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    const response = await apiClient.fetchLtn('galleries/123.json');

    expect(response).toBe(mockResponse);
    expect(fetchMock).toHaveBeenCalledWith('/api/hitomi/galleries/123.json', expect.objectContaining({ headers: {} }));
  });

  it('should correctly append path', async () => {
    const mockResponse = new Response('gg', { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    await apiClient.fetchLtn('gg.js');

    expect(fetchMock).toHaveBeenCalledWith('/api/hitomi/gg.js', expect.objectContaining({ headers: {} }));
  });

  it('should pass options to fetchUrl', async () => {
    const mockResponse = new Response('range', { status: 206 });
    Object.defineProperty(mockResponse, 'ok', { value: false });
    fetchMock.mockResolvedValue(mockResponse);

    await apiClient.fetchLtn('data.bin', { range: 'bytes=100-199' });

    expect(fetchMock).toHaveBeenCalledWith('/api/hitomi/data.bin', expect.objectContaining({
      headers: { Range: 'bytes=100-199' },
    }));
  });
});

describe('apiClient.fetchLtnText', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return text content from response', async () => {
    const mockResponse = new Response('text content', { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    const text = await apiClient.fetchLtnText('file.txt');

    expect(text).toBe('text content');
    expect(fetchMock).toHaveBeenCalledWith('/api/hitomi/file.txt', expect.objectContaining({ headers: {} }));
  });
});

describe('apiClient.fetchLtnBinary', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return ArrayBuffer from response', async () => {
    const buffer = new ArrayBuffer(8);
    const mockResponse = new Response(buffer, { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    const result = await apiClient.fetchLtnBinary('data.bin');

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(8);
  });

  it('should pass range header when provided', async () => {
    const buffer = new ArrayBuffer(16);
    const mockResponse = new Response(buffer, { status: 206 });
    Object.defineProperty(mockResponse, 'ok', { value: false });
    fetchMock.mockResolvedValue(mockResponse);

    await apiClient.fetchLtnBinary('data.bin', 'bytes=0-15');

    expect(fetchMock).toHaveBeenCalledWith('/api/hitomi/data.bin', expect.objectContaining({
      headers: { Range: 'bytes=0-15' },
    }));
  });

  it('should work without range parameter', async () => {
    const buffer = new ArrayBuffer(32);
    const mockResponse = new Response(buffer, { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    const result = await apiClient.fetchLtnBinary('full.bin');

    expect(result.byteLength).toBe(32);
    expect(fetchMock).toHaveBeenCalledWith('/api/hitomi/full.bin', expect.objectContaining({ headers: {} }));
  });
});

describe('apiClient.fetchLtnBinaryWithTotal', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should parse Content-Range header to extract total', async () => {
    const buffer = new ArrayBuffer(100);
    const mockResponse = new Response(buffer, {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-99/5000' },
    });
    Object.defineProperty(mockResponse, 'ok', { value: false });
    fetchMock.mockResolvedValue(mockResponse);

    const result = await apiClient.fetchLtnBinaryWithTotal('file.bin', 'bytes=0-99');

    expect(result.data).toBeInstanceOf(ArrayBuffer);
    expect(result.data.byteLength).toBe(100);
    expect(result.total).toBe(5000);
  });

  it('should return null total when no Content-Range header', async () => {
    const buffer = new ArrayBuffer(50);
    const mockResponse = new Response(buffer, { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    const result = await apiClient.fetchLtnBinaryWithTotal('file.bin', 'bytes=0-49');

    expect(result.data.byteLength).toBe(50);
    expect(result.total).toBeNull();
  });

  it('should slice a full 200 response when the Range request is ignored', async () => {
    const buffer = new ArrayBuffer(256);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < view.length; i++) {
      view[i] = i;
    }
    const mockResponse = new Response(buffer, { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    const result = await apiClient.fetchLtnBinaryWithTotal('file.bin', 'bytes=100-199');

    const resultView = new Uint8Array(result.data);
    expect(result.data.byteLength).toBe(100);
    expect(resultView[0]).toBe(100);
    expect(resultView[99]).toBe(199);
    expect(result.total).toBe(256);
  });

  it('should return an empty slice when an ignored Range starts beyond the full response', async () => {
    const buffer = new ArrayBuffer(256);
    const mockResponse = new Response(buffer, { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    const result = await apiClient.fetchLtnBinaryWithTotal('file.bin', 'bytes=300-399');

    expect(result.data.byteLength).toBe(0);
    expect(result.total).toBe(256);
  });

  it('should not slice a 206 response that includes Content-Range', async () => {
    const buffer = new ArrayBuffer(256);
    const mockResponse = new Response(buffer, {
      status: 206,
      headers: { 'Content-Range': 'bytes 100-199/256' },
    });
    Object.defineProperty(mockResponse, 'ok', { value: false });
    fetchMock.mockResolvedValue(mockResponse);

    const result = await apiClient.fetchLtnBinaryWithTotal('file.bin', 'bytes=100-199');

    expect(result.data.byteLength).toBe(256);
    expect(result.total).toBe(256);
  });

  it('should return correct data ArrayBuffer', async () => {
    const buffer = new ArrayBuffer(256);
    const view = new Uint8Array(buffer);
    view[0] = 0xDE;
    view[1] = 0xAD;
    view[2] = 0xBE;
    view[3] = 0xEF;

    const mockResponse = new Response(buffer, {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-255/1024' },
    });
    Object.defineProperty(mockResponse, 'ok', { value: false });
    fetchMock.mockResolvedValue(mockResponse);

    const result = await apiClient.fetchLtnBinaryWithTotal('data.bin', 'bytes=0-255');

    const resultView = new Uint8Array(result.data);
    expect(resultView[0]).toBe(0xDE);
    expect(resultView[1]).toBe(0xAD);
    expect(resultView[2]).toBe(0xBE);
    expect(resultView[3]).toBe(0xEF);
    expect(result.total).toBe(1024);
  });

  it('should handle Content-Range with different byte ranges', async () => {
    const buffer = new ArrayBuffer(200);
    const mockResponse = new Response(buffer, {
      status: 206,
      headers: { 'Content-Range': 'bytes 500-699/10000' },
    });
    Object.defineProperty(mockResponse, 'ok', { value: false });
    fetchMock.mockResolvedValue(mockResponse);

    const result = await apiClient.fetchLtnBinaryWithTotal('large.bin', 'bytes=500-699');

    expect(result.total).toBe(10000);
  });
});

describe('getGgConfig', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearGgConfigCache();
    vi.unstubAllGlobals();
  });

  it('should return parsed GgConfig', async () => {
    const ggJsText = `
      case 18:
      case 20:
      case 97:
      var b = '1234567890/';
      var o = 0;
    `;
    const mockResponse = new Response(ggJsText, { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    const config = await getGgConfig();

    expect(config).toEqual({
      pathCode: '1234567890',
      mDefault: 0,
      mCases: new Set([18, 20, 97]),
      mCaseValue: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should cache result on second call', async () => {
    const ggJsText = `
      case 42:
      var b = 'cached/';
      var o = 1;
    `;
    const mockResponse = new Response(ggJsText, { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    const config1 = await getGgConfig();
    const config2 = await getGgConfig();

    expect(config1).toBe(config2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should deduplicate concurrent calls', async () => {
    const ggJsText = `
      case 1:
      case 2:
      var b = 'concurrent/';
      var o = 0;
    `;
    const mockResponse = new Response(ggJsText, { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    // Call getGgConfig twice simultaneously
    const [config1, config2] = await Promise.all([
      getGgConfig(),
      getGgConfig(),
    ]);

    expect(config1).toBe(config2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should handle multiple concurrent calls with same result', async () => {
    const ggJsText = `
      case 99:
      var b = 'multi/';
      var o = 1;
    `;
    const mockResponse = new Response(ggJsText, { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);

    // Call getGgConfig three times simultaneously
    const results = await Promise.all([
      getGgConfig(),
      getGgConfig(),
      getGgConfig(),
    ]);

    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('clearGgConfigCache', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearGgConfigCache();
    vi.unstubAllGlobals();
  });

  it('should clear cache so next getGgConfig fetches again', async () => {
    const ggJsText1 = `
      case 10:
      var b = 'first/';
      var o = 0;
    `;
    const ggJsText2 = `
      case 20:
      var b = 'second/';
      var o = 1;
    `;

    const mockResponse1 = new Response(ggJsText1, { status: 200 });
    const mockResponse2 = new Response(ggJsText2, { status: 200 });
    fetchMock
      .mockResolvedValueOnce(mockResponse1)
      .mockResolvedValueOnce(mockResponse2);

    // First call
    const config1 = await getGgConfig();
    expect(config1.pathCode).toBe('first');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Clear cache
    clearGgConfigCache();

    // Second call should fetch again
    const config2 = await getGgConfig();
    expect(config2.pathCode).toBe('second');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should allow fresh fetch after clearing cache from concurrent calls', async () => {
    const ggJsText1 = `
      case 5:
      var b = 'cache1/';
      var o = 0;
    `;
    const ggJsText2 = `
      case 6:
      var b = 'cache2/';
      var o = 1;
    `;

    const mockResponse1 = new Response(ggJsText1, { status: 200 });
    const mockResponse2 = new Response(ggJsText2, { status: 200 });
    fetchMock
      .mockResolvedValueOnce(mockResponse1)
      .mockResolvedValueOnce(mockResponse2);

    // Concurrent calls
    await Promise.all([getGgConfig(), getGgConfig()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Clear and fetch again
    clearGgConfigCache();
    const config = await getGgConfig();

    expect(config.pathCode).toBe('cache2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('apiClient.fetchPrimary', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should call fetchUrl with MI_URL prefix', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    fetchMock.mockResolvedValue(mockResponse);
    const response = await apiClient.fetchPrimary('test/path');
    expect(response).toBe(mockResponse);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('test/path'),
      expect.anything()
    );
    // Verify the URL starts with the MI base (not the LTN proxy prefix)
    const calledUrl: string = fetchMock.mock.calls[0][0];
    expect(calledUrl).not.toContain('/api/hitomi/');
    expect(calledUrl).toMatch(/test\/path$/);
  });
});

describe('apiClient concurrency', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should queue requests when exceeding maxConcurrent (6)', async () => {
    // Create deferred promises so we can control when each fetch resolves
    const deferreds: Array<{ resolve: (r: Response) => void }> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      deferreds.push({ resolve });
    }));

    // Fire 7 concurrent requests
    const promises = Array.from({ length: 7 }, (_, i) =>
      apiClient.fetchUrl(`https://example.com/${i}`)
    );

    // Wait a tick for all to be initiated
    await new Promise(r => setTimeout(r, 10));

    // Only 6 should have called fetch (7th is queued)
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // Resolve one request — this should release the queue and start the 7th
    deferreds[0].resolve(new Response('ok', { status: 200 }));
    await new Promise(r => setTimeout(r, 10));

    expect(fetchMock).toHaveBeenCalledTimes(7);

    // Resolve remaining to cleanup
    for (let i = 1; i < deferreds.length; i++) {
      deferreds[i].resolve(new Response('ok', { status: 200 }));
    }
    await Promise.all(promises);
  });
});
