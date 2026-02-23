import { NextRequest, NextResponse } from 'next/server';

const LTN_BASE = 'https://ltn.gold-usergeneratedcontent.net';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const targetPath = path.join('/');
  const url = new URL(request.url);
  const targetUrl = `${LTN_BASE}/${targetPath}${url.search}`;

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://hitomi.la/',
    'Origin': 'https://hitomi.la',
  };

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    headers['Range'] = rangeHeader;
  }

  try {
    const response = await fetch(targetUrl, { headers });

    // Read full body to avoid Content-Length mismatch from gzip decompression
    const body = await response.arrayBuffer();

    const responseHeaders = new Headers();
    const contentType = response.headers.get('Content-Type');
    if (contentType) responseHeaders.set('Content-Type', contentType);

    const contentRange = response.headers.get('Content-Range');
    if (contentRange) responseHeaders.set('Content-Range', contentRange);

    responseHeaders.set('Content-Length', String(body.byteLength));
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Cache-Control', 'public, max-age=3600');

    return new NextResponse(body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Proxy fetch failed' },
      { status: 502 },
    );
  }
}
