import { NextRequest, NextResponse } from 'next/server';
import { bypassFetch } from '@/lib/server/bypass-fetch';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const url = searchParams.get('url');

  // Only allow simple filenames — no path traversal, no slashes, no protocol
  if (!url || /[\/\\:]|\.\./.test(url) || !url.endsWith('.html')) {
    return NextResponse.json({ error: 'invalid url parameter' }, { status: 400 });
  }

  const targetUrl = `https://hitomi.la/${url}`;

  const MAX_RETRIES = 2;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    try {
      const resp = await bypassFetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://hitomi.la/',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`[tags/fetch] upstream returned ${resp.status}:`, body);
        if (resp.status >= 500 && attempt < MAX_RETRIES) {
          lastErr = new Error(`upstream ${resp.status}`);
          continue;
        }
        // Forward the status, and the upstream Retry-After header (429 rate
        // limit) so the client can honor the rate-limit window.
        const errResp = NextResponse.json({ error: 'fetch failed' }, { status: resp.status });
        const retryAfter = resp.headers.get('retry-after');
        if (retryAfter) errResp.headers.set('Retry-After', retryAfter);
        return errResp;
      }

      const html = await resp.text();
      return new NextResponse(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      lastErr = err;
      console.error(`[tags/fetch] attempt ${attempt + 1} failed:`, err);
      if (attempt < MAX_RETRIES) continue;
    }
  }

  console.error('[tags/fetch] all retries exhausted:', lastErr);
  return NextResponse.json({ error: 'fetch failed' }, { status: 502 });
}
