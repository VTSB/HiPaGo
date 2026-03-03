<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# src/lib/utils — Utilities and Constants

Constants, type definitions, image URL generation, download helpers, and other utility functions.

## Purpose

Provides shared utilities and constants used across the application:
- **Constants**: API URLs, CDN domains, magic numbers, pagination settings
- **Types**: TypeScript interfaces for API responses, database entities, configurations
- **Image URLs**: generation and format selection (avif/webp/original)
- **Download**: ZIP creation for bulk gallery downloads
- **Helpers**: platform detection, CSS utilities, URL encoding

## Key Files

| File | Purpose |
|------|---------|
| `constants.ts` | API URLs, CDN domains, PAGE_SIZE, INDEX_DIR, B-tree constants |
| `types.ts` | TypeScript enums/interfaces: GalleryBlockType, TagType, SortOrder, GalleryBlock, GgConfig |
| `image-url.ts` | getImageUrl(): image URL generation with format selection and GG encryption |
| `download-zip.ts` | downloadGalleryAsZip(): bulk image download with progress tracking |
| `cn.ts` | classNameJoin(): CSS class merging utility (tailwindcss) |
| `platform.ts` | detectPlatform(): return 'web' \| 'tauri' \| 'capacitor' |

## Constants

### API & CDN
```typescript
CDN_DOMAIN = 'gold-usergeneratedcontent.net'
MI_BASE = 'hitomi.la'
MI_URL = 'https://hitomi.la/'
MI_URL_LTN = 'https://ltn.{CDN_DOMAIN}/'
```

### Pagination & Search
```typescript
PAGE_SIZE = 25                    // Galleries per page
PREFETCH_PAGE = 2                 // Prefetch pages ahead
SEARCH_LIMIT = 100                // Max suggestions
BYTES_PER_ID = 4                  // Nozomi format
```

### Index Configuration
```typescript
INDEX_DIR = 'tagindex'
GALLERIES_INDEX_DIR = 'galleriesindex'
NOZOMIURL_INDEX_DIR = 'nozomiurlindex'
MAX_NODE_SIZE = 464               // B-tree node bytes
B = 16                            // B-tree branching factor
```

## Type Definitions

### Enums
```typescript
enum GalleryBlockType {
  NORMAL = 0,
  LOADING = 1,
  FAILED = 2,
}

enum TagType {
  FEMALE = 'female',
  MALE = 'male',
  ARTIST = 'artist',
  SERIES = 'series',
  CHARACTER = 'character',
  TYPE = 'type',
  TAG = 'tag',
  GROUP = 'group',
  LANGUAGE = 'language',
}

type SortOrder = 'date_added' | 'popular_year' | 'popular_month' | 'popular_week' | 'popular_day'
```

### Interfaces
```typescript
// API response
interface GalleryInfo {
  id: number;
  title: string;
  files: GalleryFile[];
  tags: Record<string, string[]>;
  // ...
}

interface GalleryBlock {
  id: number;
  type: GalleryBlockType;
  title: string;
  date: Date;
  tags: Record<string, string[]>;
  thumbnail: string;
  related: number[];
}

interface GalleryFile {
  name: string;
  hash: string;
  width: number;
  height: number;
  haswebp?: boolean;
  hasavif?: boolean;
}

// GG config (image URL encryption)
interface GgConfig {
  ggjs: string;           // Last known value
  buildDate: number;      // Timestamp
  version: string;
  // ...
}
```

## Image URL Generation

### getImageUrl()
```typescript
getImageUrl(
  file: GalleryFile,
  ggConfig: GgConfig,
  format: 'avif' | 'webp' | 'original' = 'webp',
): string
```

**Process**:
1. Compute SHA-1 hash of gallery ID
2. Load GG keys from ggConfig
3. XOR hash with keys
4. Build URL: `{CDN}/images/{hash}/...{name}.{ext}`
5. Support extensions: `.avif`, `.webp`, `.jpg` (original)

**Format selection**:
- **auto**: use webp if supported, fallback to original
- **avif**: use .avif if available (hasavif=true)
- **webp**: use .webp if available (haswebp=true)
- **original**: use .jpg (always available)

## Downloading

### downloadGalleryAsZip()
```typescript
async downloadGalleryAsZip(
  galleryId: number,
  title: string,
  files: GalleryFile[],
  ggConfig: GgConfig,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void>
```

**Process**:
1. Iterate files, fetch each image
2. Pad index (e.g., 001.webp, 010.webp)
3. Create ZIP with fflate
4. Trigger browser download
5. Optional abort signal support
6. Progress callback for UI updates

**Format**: Always uses webp format (smallest reasonable size).

## Helpers

### cn()
```typescript
cn('px-2', condition && 'text-red', ['flex', 'items-center'])
// → 'px-2 text-red flex items-center'
```
Simple class merging for Tailwind; handles conditionals and arrays.

### detectPlatform()
```typescript
detectPlatform(): 'web' | 'tauri' | 'capacitor'
```
Checks for Tauri/Capacitor runtime objects; defaults to 'web'.

## Type Mappings

### TAG_TYPE_TO_BYTE
```typescript
const TAG_TYPE_TO_BYTE: Record<TagType, number> = {
  female: 0,
  male: 1,
  artist: 2,
  // ...
}
```
Used to serialize tag types as bytes in database.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `__tests__/` | Unit tests for image URL generation, ZIP download, utilities |

## Dependencies

- `fflate`: ZIP compression for downloads
- `@/lib/api`: image URL construction uses API constants

## For AI Agents

When working with utilities:
1. **New constant**: add to constants.ts (not hardcoded in components)
2. **New type**: add to types.ts; export; use in other modules
3. **Image format changes**: update getImageUrl() and format selection logic
4. **Platform-specific logic**: wrap with detectPlatform() + conditionals
5. **GG key rotation**: update ggConfig parsing logic if hitomi changes gg.js format
6. **Download improvements**: enhance progress tracking, add pause/resume support

<!-- MANUAL: -->
