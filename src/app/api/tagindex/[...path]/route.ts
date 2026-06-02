import { NextRequest, NextResponse } from 'next/server';
import { bypassFetch } from '@/lib/server/bypass-fetch';
import { buildProxyUpstreamHeaders } from '@/lib/server/proxy-headers';

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

  const headers = buildProxyUpstreamHeaders(request.headers);

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
