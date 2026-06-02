import { describe, it, expect } from 'vitest';
import { buildProxyUpstreamHeaders } from '../proxy-headers';

describe('buildProxyUpstreamHeaders', () => {
  it('always sends the spoofed hitomi Referer/Origin', () => {
    const out = buildProxyUpstreamHeaders(new Headers());
    expect(out['Referer']).toBe('https://hitomi.la/');
    expect(out['Origin']).toBe('https://hitomi.la');
  });

  it('forwards arbitrary client headers verbatim', () => {
    const out = buildProxyUpstreamHeaders(
      new Headers({
        Range: 'bytes=12345-12808',
        'If-Range': '"etag-xyz"',
        Accept: 'image/avif,image/webp,*/*',
        'Accept-Language': 'ko,en;q=0.9',
        'Sec-Fetch-Mode': 'cors',
        'User-Agent': 'CustomUA/1.0',
        'X-Custom': 'keep-me',
      }),
    );
    expect(out['range']).toBe('bytes=12345-12808');
    expect(out['if-range']).toBe('"etag-xyz"');
    expect(out['accept']).toBe('image/avif,image/webp,*/*');
    expect(out['accept-language']).toBe('ko,en;q=0.9');
    expect(out['sec-fetch-mode']).toBe('cors');
    expect(out['user-agent']).toBe('CustomUA/1.0');
    expect(out['x-custom']).toBe('keep-me');
  });

  it('overwrites any client Referer/Origin with the spoofed values', () => {
    const out = buildProxyUpstreamHeaders(
      new Headers({
        Origin: 'http://localhost:3000',
        Referer: 'http://localhost:3000/search',
        Range: 'bytes=0-9',
      }),
    );
    expect(out['Referer']).toBe('https://hitomi.la/');
    expect(out['Origin']).toBe('https://hitomi.la');
    expect(out['range']).toBe('bytes=0-9');
    // no leaked localhost identity values
    expect(Object.values(out)).not.toContain('http://localhost:3000');
    expect(Object.values(out)).not.toContain('http://localhost:3000/search');
  });

  it('drops Accept-Encoding so bypass-core owns decompression', () => {
    const out = buildProxyUpstreamHeaders(
      new Headers({ 'Accept-Encoding': 'gzip, deflate, br', Range: 'bytes=0-9' }),
    );
    expect('accept-encoding' in out).toBe(false);
    expect(out['range']).toBe('bytes=0-9');
  });

  it('never forwards Cookie or client-IP headers (privacy)', () => {
    const out = buildProxyUpstreamHeaders(
      new Headers({
        Cookie: 'session=secret; theme=dark',
        'X-Forwarded-For': '203.0.113.7',
        'X-Real-IP': '203.0.113.7',
        Forwarded: 'for=203.0.113.7',
        Accept: '*/*',
      }),
    );
    expect('cookie' in out).toBe(false);
    expect('x-forwarded-for' in out).toBe(false);
    expect('x-real-ip' in out).toBe(false);
    expect('forwarded' in out).toBe(false);
    expect(out['accept']).toBe('*/*');
  });

  it('drops hop-by-hop / wrong-host / body-framing headers', () => {
    const out = buildProxyUpstreamHeaders(
      new Headers({
        Host: 'localhost:3000',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'Content-Length': '123',
        TE: 'trailers',
        Upgrade: 'h2c',
        Range: 'bytes=1-2',
      }),
    );
    for (const k of ['host', 'connection', 'transfer-encoding', 'content-length', 'te', 'upgrade']) {
      expect(k in out).toBe(false);
    }
    expect(out['range']).toBe('bytes=1-2');
  });

  it('drops Next.js infra headers', () => {
    const out = buildProxyUpstreamHeaders(
      new Headers({
        'x-middleware-invoke': '1',
        'x-invoke-path': '/api/hitomi/x',
        Accept: '*/*',
      }),
    );
    expect('x-middleware-invoke' in out).toBe(false);
    expect('x-invoke-path' in out).toBe(false);
    expect(out['accept']).toBe('*/*');
  });

  it('is case-insensitive for both deny matches and identity overwrite', () => {
    const out = buildProxyUpstreamHeaders(
      new Headers({
        'ACCEPT-ENCODING': 'gzip',
        COOKIE: 'a=b',
        oRiGiN: 'http://evil',
        RANGE: 'bytes=5-6',
      }),
    );
    expect('accept-encoding' in out).toBe(false);
    expect('cookie' in out).toBe(false);
    expect(out['Origin']).toBe('https://hitomi.la');
    expect(out['range']).toBe('bytes=5-6');
  });
});
