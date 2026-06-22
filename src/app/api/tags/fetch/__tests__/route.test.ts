// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockBypassFetch = vi.fn();
vi.mock('@/lib/server/bypass-fetch', () => ({
  bypassFetch: (...args: unknown[]) => mockBypassFetch(...args),
}));

import { GET } from '../route';
import { NextRequest } from 'next/server';

beforeEach(() => {
  mockBypassFetch.mockReset();
});

function req(url: string): NextRequest {
  return new NextRequest('http://localhost/api/tags/fetch?url=' + encodeURIComponent(url));
}

describe('/api/tags/fetch — 429 / Retry-After', () => {
  it('forwards a 429 status and the upstream Retry-After header to the client', async () => {
    mockBypassFetch.mockResolvedValue(
      new Response('rate limited', { status: 429, headers: { 'Retry-After': '120' } }),
    );

    const res = await GET(req('allartists-a.html'));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('120');
  });

  it('returns 200 with HTML on a successful upstream fetch', async () => {
    mockBypassFetch.mockResolvedValue(new Response('<html>ok</html>', { status: 200 }));

    const res = await GET(req('allartists-a.html'));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>ok</html>');
    expect(mockBypassFetch).toHaveBeenCalledWith(
      'https://hitomi.la/allartists-a.html',
      expect.objectContaining({
        headers: expect.objectContaining({
          Referer: 'https://hitomi.la/',
        }),
      }),
    );
  });

  it('rejects an invalid url parameter with 400', async () => {
    const res = await GET(req('../etc/passwd'));
    expect(res.status).toBe(400);
    expect(mockBypassFetch).not.toHaveBeenCalled();
  });
});
