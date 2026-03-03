<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 -->

# HiPaGo/src/app/api Directory Guide

## Purpose

The `api/` directory contains backend proxy routes that forward requests to external services. These routes implement the API layer between the client and Hitomi infrastructure, including gallery metadata, image CDN, and tag index services. Proxies handle authentication headers, range requests, content negotiation, and caching policies.

## Key Files

- **`hitomi/[...path]/route.ts`** - Hitomi metadata API proxy
- **`img/[...path]/route.ts`** - Image CDN proxy with gg.js subdomain resolution
- **`tagindex/[...path]/route.ts`** - Tag index API proxy

## Routes & Functionality

### Hitomi Metadata Proxy
**Route:** `/api/hitomi/[...path]`
**Backend:** `https://ltn.gold-usergeneratedcontent.net`

Proxies requests to Hitomi's metadata API:
- Gallery info (title, date, page count, tags)
- File lists (images with hash and CDN path info)
- Gallery listings by tag

**Key implementation details:**
- Node.js runtime (standard server)
- Handles Range requests for partial fetches (sets Range header)
- Reads full response body to avoid Content-Length mismatch
- Sets native headers (User-Agent, Referer, Origin)
- Returns status, Content-Type, and Content-Range headers
- Cache-Control: `public, max-age=3600` (1 hour)
- CORS: `Access-Control-Allow-Origin: *`
- Error handling: Returns 502 on fetch failure

**Usage example:**
```typescript
const res = await fetch('/api/hitomi/galleries/123.json');
const gallery = await res.json();
```

### Image CDN Proxy
**Route:** `/api/img/[...path]`
**Backend:** `https://[subdomain].gold-usergeneratedcontent.net`

Proxies image requests to CDN with intelligent subdomain resolution:
- `atn.` / `btn.` / `dtn.` / ... - Thumbnail servers
- `a.` / `b.` / `c.` / ... - Full-size image servers

**Key implementation details:**
- **Edge runtime** for low-latency byte-level streaming
- **gg.js config caching** (30-minute TTL)
- **Subdomain resolution logic:** For `tn` (thumbnail), fetches `gg.js` from LTN, parses case statements, computes hash-based subdomain mapping
- **Direct streaming:** Passes upstream response.body directly to client (no buffering)
- **Range request support** (implicit via streaming)
- Cache-Control: `public, max-age=86400` (24 hours)
- CORS: `Access-Control-Allow-Origin: *`
- Preserves Content-Type and Content-Length headers
- Error handling: Returns 502 on fetch failure, 404/5xx for upstream errors

**Subdomain resolution:**
```
Input path: img/tn/123abc456def.jpg
  ↓
1. Fetch gg.js config (cached)
2. Parse case statements and mDefault value
3. Extract hash from path: 123abc456def
4. Compute: g = parseInt(hash[-1] + hash[-3:-1], 16)
5. Lookup: if g in mCases → use mCaseValue, else mDefault
6. Resolve to subdomain: atn, btn, ctn, etc.
  ↓
Proxy to: https://atn.gold-usergeneratedcontent.net/123abc456def.jpg
```

**Usage example:**
```typescript
// Thumbnail subdomain resolution automatic
const img = <img src="/api/img/tn/hashvalue.jpg" />;

// Full-size image
const img = <img src="/api/img/a/hashvalue.jpg" />;
```

### Tag Index API Proxy
**Route:** `/api/tagindex/[...path]`
**Backend:** `https://tagindex.hitomi.la`

Proxies requests to Hitomi's tag index API:
- Tag suggestions (autocomplete)
- Category mappings (artist, tag, parody, etc.)
- Gallery counts per tag

**Key implementation details:**
- Node.js runtime (standard server)
- Returns arrayBuffer to preserve binary data and encoding
- Sets native headers (User-Agent, Referer, Origin)
- Returns status and Content-Type headers
- Cache-Control: `public, max-age=300` (5 minutes, short for freshness)
- CORS: `Access-Control-Allow-Origin: *`
- Error handling: Returns 502 on fetch failure

**Usage example:**
```typescript
const res = await fetch('/api/tagindex/tag/en');
const tags = await res.json();
```

## For AI Agents

### Adding a New API Proxy Route

1. Create `src/app/api/[service]/[...path]/route.ts`
2. Export async function `GET()` with NextRequest and params
3. Construct target URL from path parameters
4. Fetch upstream with appropriate headers
5. Forward response with proper headers and caching

Template:
```typescript
import { NextRequest, NextResponse } from 'next/server';

const SERVICE_BASE = 'https://upstream-host.com';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const targetPath = path.join('/');
  const targetUrl = `${SERVICE_BASE}/${targetPath}`;

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 ...',
    'Referer': 'https://hitomi.la/',
  };

  try {
    const response = await fetch(targetUrl, { headers });
    const body = await response.arrayBuffer();

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', response.headers.get('Content-Type') || 'application/octet-stream');
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
```

### Modifying Image Proxy Behavior

**To change subdomain resolution logic:**
1. Edit `resolveTnSubdomain()` function in `src/app/api/img/[...path]/route.ts`
2. Update hash computation or case statement parsing if gg.js format changes
3. Test with known image hashes to verify correct subdomain resolution

**To adjust gg.js cache TTL:**
1. Change `GG_TTL` constant (currently 30 minutes)
2. Longer TTL = fewer gg.js fetches but potential stale mappings
3. Shorter TTL = more overhead but fresher subdomain data

**To change cache headers:**
1. Edit `Cache-Control` header in response
2. For images: max-age=86400 (24 hours) is reasonable
3. For metadata: max-age=3600 (1 hour) recommended
4. For tags: max-age=300 (5 minutes) to keep suggestions fresh

### Streaming vs. Buffering

**Image proxy uses streaming (edge runtime):**
- Reads `response.body` directly
- No buffering in memory
- Supports partial range requests
- Faster first-byte time

**Metadata/tag proxies use buffering (Node.js runtime):**
- Reads full response with `arrayBuffer()`
- Ensures Content-Length accuracy
- Simpler error handling
- Sufficient for JSON responses

### Range Request Support

Image proxy supports HTTP Range requests natively:
- Client sends `Range: bytes=0-1023` header
- Proxy forwards to upstream
- Upstream returns `206 Partial Content`
- Client receives partial body with `Content-Range` header

Example use case: Resuming large image downloads.

### Error Handling

All proxies return 502 Bad Gateway on upstream failures:
```typescript
catch (error) {
  return NextResponse.json(
    { error: 'Proxy fetch failed' },
    { status: 502 },
  );
}
```

This signals a gateway error to the client. Consider adding retry logic in client for resilience.

### Testing Proxies

Use curl to test:
```bash
# Metadata
curl http://localhost:3000/api/hitomi/galleries/123.json

# Image (thumbnail)
curl -I http://localhost:3000/api/img/tn/hashvalue.jpg

# Tag index
curl http://localhost:3000/api/tagindex/tag/en
```

### CORS and Cross-Origin Requests

All proxies set `Access-Control-Allow-Origin: *` to allow client-side requests from any origin. This is safe because:
- Proxy verifies no authentication is needed
- Upstream services expect cross-origin requests
- Client-side code doesn't rely on credentials

<!-- MANUAL: -->
