import { NextRequest, NextResponse } from 'next/server';
import { bypassFetch } from '@/lib/server/bypass-fetch';

export const runtime = 'nodejs';

const VALID_URL_RE = /^all(artists|series|characters|groups|tags)-[a-z0-9]\.html$/;

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const url = searchParams.get('url');

  if (!url || !VALID_URL_RE.test(url)) {
    return NextResponse.json({ error: 'invalid url parameter' }, { status: 400 });
  }

  const targetUrl = `https://hitomi.la/${url}`;

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
      return NextResponse.json({ error: 'fetch failed' }, { status: resp.status });
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
    console.error('[tags/fetch] fetch error:', err);
    return NextResponse.json({ error: 'fetch failed' }, { status: 502 });
  }
}
