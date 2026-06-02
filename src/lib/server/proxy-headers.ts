/**
 * Build the header map a web /api proxy route sends upstream through
 * bypass-core. Mirrors the native Android interceptor contract
 * (BypassWebViewClient.buildUpstreamHeaders): forward the client's request
 * headers as-is and overwrite only what the bypass transport must own.
 *
 * Forwarded: Accept, User-Agent, Accept-Language, sec-ch-ua*, Sec-Fetch-*,
 * Range, If-Range, If-None-Match, If-Modified-Since, and any custom client
 * header — so byte-range index/image reads and conditional requests reach
 * upstream intact.
 *
 * Overwritten / dropped (case-insensitive):
 *  - Referer / Origin: replaced with the spoofed hitomi values so the
 *    browser's own cross-origin values can't leak through.
 *  - Accept-Encoding: dropped so bypass-core (rquest Chrome impersonation)
 *    owns content negotiation and transparently decompresses; forwarding it
 *    would hand back a compressed body and corrupt binary index reads.
 *  - Cookie + client-IP headers (x-forwarded-for, x-real-ip, forwarded):
 *    never forwarded — this is an ISP-bypass / privacy tool; our-origin
 *    cookies and the client IP must not leak to the third-party CDN.
 *  - Hop-by-hop / wrong-host / body-framing headers (host, connection,
 *    keep-alive, proxy-connection, transfer-encoding, te, upgrade,
 *    content-length): forwarding these breaks the upstream request.
 *  - Next.js infra headers (x-middleware-*, x-invoke-*): not client intent.
 */

const DENY = new Set<string>([
  // identity — overwritten with spoofed values below
  'referer',
  'origin',
  // bypass-core owns content-encoding/decompression
  'accept-encoding',
  // privacy: never leak our-origin cookies or the client IP to the CDN
  'cookie',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  // hop-by-hop / wrong-host / body framing — forwarding these breaks the request
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'upgrade',
  'content-length',
]);

function isInfraHeader(key: string): boolean {
  return key.startsWith('x-middleware-') || key.startsWith('x-invoke-') || key.startsWith('x-nextjs-');
}

/**
 * @param reqHeaders the incoming request's headers (`request.headers`)
 * @returns a plain header map for `bypassFetch({ headers })`
 */
export function buildProxyUpstreamHeaders(reqHeaders: Headers): Record<string, string> {
  const out: Record<string, string> = {};

  reqHeaders.forEach((value, key) => {
    const k = key.toLowerCase(); // WHATWG Headers already lowercases keys
    if (DENY.has(k) || isInfraHeader(k)) return;
    out[k] = value;
  });

  out['Referer'] = 'https://hitomi.la/';
  out['Origin'] = 'https://hitomi.la';
  return out;
}
