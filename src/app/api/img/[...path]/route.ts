import { NextRequest } from 'next/server';

// Force edge runtime — streams bytes directly without Node.js buffering
export const runtime = 'edge';

const CDN_DOMAIN = 'gold-usergeneratedcontent.net';
const LTN_BASE = `https://ltn.${CDN_DOMAIN}`;

// Cached gg.js config for thumbnail subdomain resolution (tn → atn/btn)
let ggConfig: { mDefault: number; mCases: Set<number>; mCaseValue: number } | null = null;
let ggConfigAt = 0;
const GG_TTL = 30 * 60 * 1000; // 30 minutes

async function getGgConfig() {
  if (ggConfig && Date.now() - ggConfigAt < GG_TTL) return ggConfig;
  try {
    const resp = await fetch(`${LTN_BASE}/gg.js?_=${Date.now()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://hitomi.la/',
      },
    });
    const text = await resp.text();

    const mDefault = parseInt((/var\s+o\s*=\s*(\d+)/.exec(text) || ['', '1'])[1], 10);
    const caseAssignMatch = /case\s+\d+:[^}]*?o\s*=\s*(\d+)\s*;?\s*break/.exec(text);
    const mCaseValue = caseAssignMatch ? parseInt(caseAssignMatch[1], 10) : (1 - mDefault);

    const mCases = new Set<number>();
    const re = /case\s+(\d+):/g;
    let m;
    while ((m = re.exec(text)) !== null) mCases.add(parseInt(m[1], 10));

    ggConfig = { mDefault, mCases, mCaseValue };
    ggConfigAt = Date.now();
    return ggConfig;
  } catch {
    return null;
  }
}

/**
 * Resolve 'tn' subdomain to actual atn/btn based on gg.js config.
 */
function resolveTnSubdomain(targetPath: string, config: NonNullable<typeof ggConfig>): string {
  const hashMatch = /([0-9a-f]{64})\./.exec(targetPath);
  if (!hashMatch) return 'atn'; // fallback
  const hash = hashMatch[1];
  const g = parseInt(hash.slice(-1) + hash.slice(-3, -1), 16);
  const m = config.mCases.has(g) ? config.mCaseValue : config.mDefault;
  return String.fromCharCode(97 + m) + 'tn';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const [subdomain, ...rest] = path;
  const targetPath = rest.join('/');

  let actualSubdomain = subdomain;
  if (subdomain === 'tn') {
    const config = await getGgConfig();
    if (config) {
      actualSubdomain = resolveTnSubdomain(targetPath, config);
    }
  }

  const targetUrl = `https://${actualSubdomain}.${CDN_DOMAIN}/${targetPath}`;

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://hitomi.la/',
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,*/*',
      },
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

    // Stream the upstream body directly to the client — no buffering.
    // Edge runtime + passing ReadableStream ensures true byte-level streaming,
    // so the browser can progressively render the image as chunks arrive.
    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch {
    return Response.json(
      { error: 'Image proxy fetch failed' },
      { status: 502 },
    );
  }
}
