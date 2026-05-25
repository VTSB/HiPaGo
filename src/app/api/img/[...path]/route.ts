import { NextRequest } from 'next/server';
import { parseGgJs } from '@/lib/utils/image-url';
import type { GgConfig } from '@/lib/utils/types';
import { bypassFetch } from '@/lib/server/bypass-fetch';
import { resolveTnSubdomain } from './subdomain';

// Node.js runtime required for bypass (net/tls modules). Streaming is preserved
// via WHATWG ReadableStream — bypassFetch returns a standard Response object.
export const runtime = 'nodejs';

const CDN_DOMAIN = 'gold-usergeneratedcontent.net';
const LTN_BASE = `https://ltn.${CDN_DOMAIN}`;

// Cached gg.js config for thumbnail subdomain resolution (tn → atn/btn)
let ggConfig: GgConfig | null = null;
let ggConfigAt = 0;
const GG_TTL = 30 * 60 * 1000; // 30 minutes

async function getGgConfig() {
  if (ggConfig && Date.now() - ggConfigAt < GG_TTL) return ggConfig;
  try {
    const resp = await bypassFetch(`${LTN_BASE}/gg.js?_=${Date.now()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://hitomi.la/',
      },
      signal: AbortSignal.timeout(10000),
    });
    const text = await resp.text();

    ggConfig = parseGgJs(text);
    ggConfigAt = Date.now();
    return ggConfig;
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const [subdomain, ...rest] = path;
  const targetPath = rest.join('/');

  // Validate subdomain to prevent SSRF via subdomain injection
  if (!/^[a-z0-9]{1,4}$/.test(subdomain)) {
    return new Response(null, { status: 400 });
  }

  // Validate targetPath to prevent path traversal
  if (/\.\.|\/\/|\x00/.test(targetPath) || !/^[\w.\-/]+$/.test(targetPath)) {
    return new Response(null, { status: 400 });
  }

  let actualSubdomain = subdomain;
  if (subdomain === 'tn') {
    const config = await getGgConfig();
    if (config) {
      actualSubdomain = resolveTnSubdomain(targetPath, config);
    }
  }

  const targetUrl = `https://${actualSubdomain}.${CDN_DOMAIN}/${targetPath}`;

  try {
    const response = await bypassFetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://hitomi.la/',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return new Response(null, { status: response.status });
    }

    const headers = new Headers();
    const contentType = response.headers.get('Content-Type');
    if (contentType) headers.set('Content-Type', contentType);

    const contentLength = response.headers.get('Content-Length');
    if (contentLength) headers.set('Content-Length', contentLength);

    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=86400');

    // Stream the upstream body directly to the client.
    // bypassFetch returns a Response with a true streaming ReadableStream body.
    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch {
    return Response.json({ error: 'Image proxy fetch failed' }, { status: 502 });
  }
}
