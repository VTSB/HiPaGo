# Hitomi.la API Reverse Engineering Analysis

Last updated: 2026-02-19

## Overview

Hitomi.la uses a CDN-based architecture with multiple domains serving different types of content. All API data is static files served via CDN, not a traditional REST API.

## Domains

| Domain | Purpose |
|--------|---------|
| `ltn.gold-usergeneratedcontent.net` | Main LTN CDN. Gallery data, nozomi indexes, images, JS configs |
| `tagindex.hitomi.la` | Tag suggestion JSON API |
| `{sub}.gold-usergeneratedcontent.net` | Image CDN. Subdomain varies by content type |
| `hitomi.la` | Website frontend |

### Domain Migration (2025+)

The CDN domain migrated from `ltn.hitomi.la` → `ltn.gold-usergeneratedcontent.net`. Image subdomains follow the same pattern: `a1.hitomi.la` → `a1.gold-usergeneratedcontent.net`.

The `domain` variable in `common.js`:
```js
const domain2 = 'gold-usergeneratedcontent.net';
var domain = 'ltn.' + domain2;
```

## gg.js - Image Routing Configuration

**Endpoint:** `https://ltn.gold-usergeneratedcontent.net/gg.js`

### Format (Current - Object Literal)

```js
gg = {
  m: function(g) { var o = DEFAULT; switch(g) { case N: o = VALUE; break; ... } return o; },
  s: function(h) { ... },
  b: 'PATH/'
}
```

### Parsed Values

| Field | Description |
|-------|-------------|
| `b` (pathCode) | Path prefix for image URLs (e.g., `"aa/"`) |
| `m(g)` (mDefault / mCases / mCaseValue) | Subdomain routing function. Returns 0 or 1 based on hash code `g` |
| `s(h)` | Hash code function. Returns `hash[-1] + hash[-3:-1]` parsed as hex |

### How gg.m(g) Works

```
g = parseInt(hash.slice(-1) + hash.slice(-3, -1), 16)
m = mCases.has(g) ? mCaseValue : mDefault
```

The `m` value determines the image subdomain number. For example, if `mDefault=1` and `mCaseValue=0`, most images go to subdomain `2` (1+1), and cases in the switch set go to subdomain `1` (1+0).

**TTL:** Cache for ~30 minutes, then refresh.

## Image URL Construction

### Full-size Images

```
/api/img/{subdomain}/{dirPrefix}{pathCode}/{hashCode}/{hash}.{ext}
```

| Format | Subdomain | Dir Prefix | Extension |
|--------|-----------|------------|-----------|
| AVIF | `a(1+m)` | (none) | `.avif` |
| WebP | `w(1+m)` | (none) | `.webp` |
| Original | `(1+m)` | `images/` | original ext |

Where:
- `m = gg.m(g)` (0 or 1)
- `g = parseInt(hash[-1] + hash[-3:-1], 16)`
- `pathCode = gg.b` (without trailing slash)
- `hashCode = g` (decimal)

**Example (AVIF):** `https://a2.gold-usergeneratedcontent.net/aa/1234/abcdef...64chars.avif`

### Thumbnails

```
/api/img/tn/{format}{size}tn/{hash[-1]}/{hash[-3:-1]}/{hash}.{ext}
```

| Condition | Format | Extension |
|-----------|--------|-----------|
| `hasavif` or `hasavifsmalltn` | `avif` | `.avif` |
| `haswebp` | `webp` | `.webp` |
| Otherwise | (none) | original ext |

**Size:** `small` or `big`

**Subdomain Resolution:** Thumbnails use `tn` as proxy subdomain. The server-side proxy resolves `tn` to actual `atn`/`btn` using gg.js config:
```
g = parseInt(hash[-1] + hash[-3:-1], 16)
m = gg.mCases.has(g) ? mCaseValue : mDefault
subdomain = String.fromCharCode(97 + m) + 'tn'  // 'atn' or 'btn'
```

**Important:** Hitomi.la always rewrites `smalltn` → `avifsmalltn` when `hasavif` is set (not just when `hasavifsmalltn` is set). This is done via their `rewrite_tn_paths` function.

## Gallery Data

### Gallery Info JSON

**Endpoint:** `https://ltn.gold-usergeneratedcontent.net/galleries/{id}.js`

**Format:** `var galleryinfo = { ... }`

**Key Fields:**
```json
{
  "id": 1234567,
  "title": "Gallery Title",
  "japanese_title": "日本語タイトル",
  "language": "english",
  "language_localname": "English",
  "type": "doujinshi",
  "date": "2026-01-15 12:00:00-05",
  "files": [
    {
      "name": "001.jpg",
      "hash": "64-char-hex-hash",
      "width": 1200,
      "height": 1600,
      "haswebp": 1,
      "hasavif": 1,
      "hasavifsmalltn": 1
    }
  ],
  "tags": [
    { "tag": "tagname", "url": "artist/tagname-all-1.html", "female": "0", "male": "0" }
  ],
  "related": [3272467, 3650127, 2698362]
}
```

### Gallery Block HTML

**Endpoint:** `https://ltn.gold-usergeneratedcontent.net/galleryblock/{id}.html`

Returns an HTML snippet with gallery title, thumbnail, date, tags, and related IDs (in a `<script>` tag).

## Nozomi Files (Gallery ID Lists)

Binary files containing int32 big-endian gallery IDs. Used for browsing and tag-filtered search.

### Browse (Main Page)

**Endpoint:** `https://ltn.gold-usergeneratedcontent.net/index-{language}.nozomi`

Uses HTTP Range requests for pagination:
```
Range: bytes={page*pageSize*4}-{(page+1)*pageSize*4 - 1}
```

Content-Range response tells total file size → total gallery count.

### Tag Search (Compressed Nozomi)

**Prefix:** `n/` (compressed nozomi prefix)

**Endpoints:**

| Query Type | Path |
|------------|------|
| `female:tag` or `male:tag` | `n/tag/{female:tag}-{language}.nozomi` |
| `artist:name` | `n/artist/{name}-{language}.nozomi` |
| `series:name` | `n/series/{name}-{language}.nozomi` |
| `group:name` | `n/group/{name}-{language}.nozomi` |
| `character:name` | `n/character/{name}-{language}.nozomi` |
| `type:doujinshi` | `n/type/{type}-{language}.nozomi` |
| `language:chinese` | `n/index-{language}.nozomi` |

**Format:** Same as regular nozomi - raw int32 big-endian IDs. Supports Range requests.

**Note:** Tag names with special characters must be URL-encoded. The `language` parameter defaults to `all` for unfiltered results.

## B-Tree Indexes

Used for **untyped text search** and **suggestions** (though suggestions have migrated to JSON API).

### Structure

Each index has two files:
- `{dir}/{field}.{version}.index` - B-tree nodes
- `{dir}/{field}.{version}.data` - Leaf data blobs

### Index Directories

| Field | Directory | Version Endpoint |
|-------|-----------|-----------------|
| `galleries` | `galleriesindex/` | `galleriesindex/version` |
| `languages` | `languagesindex/` | `languagesindex/version` |
| `nozomiurl` | `nozomiurlindex/` | `nozomiurlindex/version` |
| Tag fields (`artist`, `tag`, etc.) | `tagindex/` | `tagindex/version` (**BROKEN as of 2026-02**) |

### Constants

- `B = 16` (branching factor)
- `MAX_NODE_SIZE = 464` bytes
- Key = first 4 bytes of SHA-256 hash of search term

### Node Format (Binary, Big-Endian)

```
[numberOfKeys: int32]
  [keyLength: int32] [keyBytes: keyLength bytes] × numberOfKeys
[numberOfDatas: int32]
  [offset: int64] [length: int32] × numberOfDatas
[subnodeAddresses: int64] × (B + 1)
```

### Gallery ID Data Format

```
[count: int32] [galleryId: int32] × count
```

### Suggestion Data Format

```
[count: int32]
  [nsLen: int32] [nsBytes] [tagLen: int32] [tagBytes (UTF-8)] [amount: int32]
× count
```

Where `ns` is the tag namespace (e.g., "artist", "female", "tag").

### Important Note

As of 2026-02, `tagindex/version` returns 404. This means the B-tree tag index is no longer maintained. The `galleriesindex/version` still works for untyped text search. Tag searches should use nozomi files instead.

## Tag Suggestion JSON API

**Domain:** `tagindex.hitomi.la`

**Endpoint:** `https://tagindex.hitomi.la/{field}/{c1}/{c2}/.../{cN}.json`

Where each `{ci}` is a character from the search term with encoding:
- Space → `_`
- `/` → `slash`
- `.` → `dot`
- Other characters as-is

**Fields:** `global` (untyped), `artist`, `series`, `group`, `character`, `tag`, `female`, `male`

**Response Format:**
```json
[
  ["tag_name", count, "namespace"],
  ["beauty mark", 34294, "female"],
  ...
]
```

**Example:** Searching "beau" in the "female" field:
```
GET https://tagindex.hitomi.la/female/b/e/a/u.json
```

## Proxy Architecture (HiPaGo)

HiPaGo proxies all requests through Next.js API routes to add required headers:

| Proxy Route | Upstream |
|-------------|----------|
| `/api/hitomi/{path}` | `https://ltn.gold-usergeneratedcontent.net/{path}` |
| `/api/img/{subdomain}/{path}` | `https://{subdomain}.gold-usergeneratedcontent.net/{path}` |
| `/api/tagindex/{path}` | `https://tagindex.hitomi.la/{path}` |

### Required Headers

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
Referer: https://hitomi.la/
Origin: https://hitomi.la
```

### Known Proxy Issues

1. **gzip Content-Length mismatch:** When upstream responds with gzip-compressed body, Node.js `fetch` auto-decompresses it but the `Content-Length` header still reflects compressed size. Fix: read the full body with `response.arrayBuffer()` and set `Content-Length` from `body.byteLength`.

2. **Thumbnail subdomain resolution:** The `tn` subdomain must be resolved to actual `atn`/`btn` server-side using gg.js config, not forwarded as `tn`.

## Analysis Methodology

### How to Reverse Engineer Changes

1. **Check JavaScript sources:** Load a hitomi.la gallery page and inspect loaded scripts:
   - `common.js` - Domain config, image URL construction, gg.js loading
   - `searchlib.js` - Search constants, B-tree code, suggestion fetching
   - `search.js` - Search query parsing, nozomi fetching, suggestion UI
   - `gg.js` - Dynamic image routing config (changes frequently)
   - `gallery.js` - Gallery page logic

2. **Use Chrome DevTools MCP:** Connect to both hitomi.la and localhost:3000 to compare behavior side-by-side.

3. **Fetch and inspect JS directly:**
   ```js
   // On hitomi.la page:
   const resp = await fetch('https://ltn.gold-usergeneratedcontent.net/searchlib.js');
   const text = await resp.text();
   ```

4. **Test endpoints via proxy:**
   ```js
   // On localhost:
   const resp = await fetch('/api/hitomi/n/tag/female%3Abeauty%20mark-all.nozomi', {
     headers: { Range: 'bytes=0-99' }
   });
   ```

5. **Compare network requests:** Use DevTools Network panel on both hitomi.la and localhost to compare request patterns and responses.

### Key Variables to Monitor

- `domain` in `common.js` - CDN domain (has changed before)
- `compressed_nozomi_prefix` in `searchlib.js` - Nozomi path prefix
- `tag_index_domain` in `searchlib.js` - Tag suggestion API domain
- `gg.js` format - Changes when they update image routing
- B-tree index availability - `tagindex/version` is currently broken
