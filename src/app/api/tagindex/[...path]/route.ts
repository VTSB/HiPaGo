import { NextRequest, NextResponse } from 'next/server';

const TAG_INDEX_BASE = 'https://tagindex.hitomi.la';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const targetPath = path.join('/');
  const targetUrl = `${TAG_INDEX_BASE}/${targetPath}`;

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://hitomi.la/',
    'Origin': 'https://hitomi.la',
  };

  try {
    const response = await fetch(targetUrl, { headers });
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
