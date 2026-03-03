<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# src/lib/api — API Client and Gallery Fetching

Handles HTTP requests to hitomi.la CDN and tagindex servers, gallery/image metadata fetching, search indexing, and image URL resolution.

## Purpose

The API layer provides abstraction over hitomi's multi-source architecture:
- **ApiClient**: rate-limited HTTP fetching with native headers (for Tauri/Capacitor)
- **Gallery API**: fetch metadata (title, pages, tags, thumbnails) and cache to DB
- **Search API**: B-tree index queries and nozomi binary format parsing
- **URL resolution**: proxy gallery image URLs through local API routes or resolve to CDN

## Key Files

| File | Purpose |
|------|---------|
| `client.ts` | ApiClient singleton: rate-limit queue (max 6 concurrent), GG config cache |
| `gallery.ts` | fetchGalleryInfo, fetchGalleryBlockHtmlById, fetchGalleryImagesCached (DB cache) |
| `search.ts` | B-tree gallery index: parseQuery, getGalleryIdsForQuery, getSuggestionsForQuery |
| `nozomi.ts` | Nozomi binary parsing: fetchGalleryIds (browse/popular), fetchGalleryIdsByTag, parseNozomiData |
| `parser.ts` | JSON/HTML parsing: parseGalleryJson, parseGalleryBlockHtml, parseLanguageSupport |
| `url-resolver.ts` | resolveLtnUrl, resolveTagIndexUrl: CDN domain mapping |

## Public API

### ApiClient Methods
```typescript
apiClient.fetchUrl(url, options)          // Raw fetch with rate limit
apiClient.fetchLtn(path)                  // Fetch from ltn.{CDN_DOMAIN}
apiClient.fetchPrimary(path)              // Fetch from hitomi.la
apiClient.fetchLtnText(path)              // fetchLtn + response.text()
apiClient.fetchLtnBinary(path, range?)    // fetchLtn + response.arrayBuffer()
apiClient.fetchLtnBinaryWithTotal(path, range)  // With Content-Range parsing
getGgConfig()                             // Cached 10min; parse gg.js for image URL secrets
```

### Gallery Fetching
```typescript
fetchGalleryInfo(id)                      // Full metadata: title, pages, tags
fetchGalleryBlockHtmlById(id)             // Minimal block from HTML (title, thumbnail)
fetchGalleryBlockDetailed(id)             // Full block from API
fetchGalleryImages(id)                    // Image list with hash/dimension
fetchGalleryImagesCached(id)              // Image list (cached in DB)
fetchBrowseIds(lang, page)                // Browse index (latest galleries)
fetchSearchIds(tagType, tag, lang, page)  // Search by tag
fetchLanguages()                          // Available languages list
```

### Search & Suggestions
```typescript
getGalleryIdsForQuery(query, lang, sort?) // B-tree + nozomi search (AND logic)
getSuggestionsForQuery(query)             // tagindex JSON API autocomplete
parseQuery(query)                         // Parse "field:value" or plain term
parseCompoundQuery(query)                 // Split space-separated terms
decodeGalleryIdData(buffer)              // Parse 4-byte ID array
decodeSuggestionData(buffer, tagType)    // Parse B-tree suggestion format
```

## Rate Limiting

ApiClient implements a **semaphore queue**:
- Max 6 concurrent requests (configurable via `maxConcurrent`)
- Queue holds pending requests; released on completion
- Each fetch: acquire → fetch → release

```typescript
// Example: 20 parallel fetches queued to 6 concurrent
await Promise.all([...].map(id => fetchGalleryInfo(id)))
```

## Search Index Format

### B-Tree Galleries Index
- **Path**: `galleriesindex/galleries.{version}.{index|data}`
- **Query**: SHA256(term) → B-tree lookup → offset/length → data file
- **Untyped queries** use this (e.g., searching "loli" in full text)

### Nozomi Binary Format
- **Path**: `n/{area}/{tag}-{lang}.nozomi` or `popular/{period}-{lang}.nozomi`
- **Format**: 4-byte little-endian gallery IDs (one per ID)
- **Pagination**: range header `bytes={start}-{end}` for efficient slicing
- **Typed queries** (female:tag, artist:name) use this

### tagindex JSON API
- **Path**: `/api/tagindex/{field}/{char1}/{char2}/.../charN.json` (nested by prefix)
- **Response**: `[[tag_name, count, namespace], ...]`
- **Used for**: autocomplete suggestions

## Error Handling

- **HTTP errors**: ApiError with status code (non-206 responses throw)
- **Parse failures**: return empty results or failed blocks
- **GG config missing**: error thrown (required for image URLs)
- **Gallery not found**: createFailedBlock() returns FAILED block type

## Caching

- **GG config**: 10-minute TTL (updated every gg.js fetch)
- **Gallery images**: saved to DB via `saveGalleryImages()` (index-based cache)
- **No HTTP caching**: Headers sent with `_={timestamp}` to bypass cache for version files

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `__tests__/` | Unit/integration tests for client, gallery, nozomi, parser, search |

## Dependencies

- `@/lib/utils`: constants, types, image URL generation
- `@/lib/db`: saveGalleryImages (gallery caching)
- `@/lib/store`: (none; API is side-effect-free)

## For AI Agents

When adding features to API:
1. **New gallery fields**: update parser.ts, schema.ts, and type definitions
2. **New search type**: add to SYNC_FIELDS, update nozomi/search routing
3. **CDN changes**: update url-resolver.ts and constants.ts domain mappings
4. **Rate limit tuning**: adjust ApiClient.maxConcurrent (test with throttled network)
5. **GG config parsing**: verify gg.js format hasn't changed (parseGgJs in utils/image-url.ts)

<!-- MANUAL: -->
