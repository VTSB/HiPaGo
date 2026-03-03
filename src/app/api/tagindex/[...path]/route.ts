import { NextRequest, NextResponse } from 'next/server';
import { bypassFetch } from '@/lib/server/bypass-fetch';

const TAG_INDEX_BASE = 'https://tagindex.hitomi.la';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const targetPath = path.join('/');

  // Validate path to prevent traversal and unexpected requests
  if (/\.\.|\/\/|\x00/.test(targetPath) || !/^[\w.\-/]+$/.test(targetPath)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  const targetUrl = `${TAG_INDEX_BASE}/${targetPath}`;

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://hitomi.la/',
    'Origin': 'https://hitomi.la',
  };

  try {
    const response = await bypassFetch(targetUrl, { headers, signal: AbortSignal.timeout(15000) });
    const body = await response.arrayBuffer();

    const responseHeaders = new Headers();
    const contentType = response.headers.get('Content-Type');
    if (contentType) responseHeaders.set('Content-Type', contentType);
    responseHeaders.set('Content-Length', String(body.byteLength));
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Cache-Control', 'public, max-age=300');

    return new NextResponse(body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: 'Tag index proxy fetch failed' },
      { status: 502 },
    );
  }
}
