<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src/features/gallery-detail Directory Guide

## Purpose

The `gallery-detail` feature displays the detailed view of a single gallery. It fetches full gallery information (metadata, files, tags), displays tags organized by type, shows thumbnail grid of all pages, lists related galleries, and provides download and favorite controls.

## Key Files

- **`components/GalleryDetail.tsx`** - Main gallery detail view component
  - Fetches gallery info via `useGalleryDetail()`
  - Falls back to cached block from `useGalleryBlock()` while loading
  - Renders tags by type, page thumbnails, related galleries
  - Handles favorite toggle and gallery zip download
  - Displays thumbnail click links to reader (e.g., `/gallery/{id}/reader?page={pageNum}`)

- **`hooks/useGalleryDetail.ts`** - Data fetching hook
  - Queries gallery info via `fetchGalleryInfo(id)`
  - Converts info to `GalleryBlock` and `GalleryImage[]` for rendering
  - Returns loading, error, and data states

## Subdirectories

### components/
- **`GalleryDetail.tsx`** - Only component in this feature

### hooks/
- **`useGalleryDetail.ts`** - Only hook in this feature

## Architecture Patterns

### Data Flow

1. Component mounts with gallery ID
2. `useGalleryDetail(id)` fetches full gallery info (large response, ~2s)
3. While loading, display cached block from list view (instant preview)
4. On load, render full detail view:
   - Title, type, language, date
   - Tags sorted by type (artist, group, series, character, female, male, tag)
   - Page thumbnails grid with click-through to reader
   - Related galleries (12 max)
5. Side effects on mount:
   - Check favorite status
   - Record visit to history
   - Warm gg.js config cache for reader

### State Management

- **React Query**: Caches gallery info by ID
- **Local state**: Favorite status, download progress
- **Database**: `recordVisit()` and `isFavorite()` via Dexie

### User Interactions

- **Favorite button**: Toggle with `addFavorite()`/`removeFavorite()`, refetch favorites query
- **Read button**: Link to `/gallery/{id}/reader`
- **Download button**: Zip all gallery images using `downloadGalleryAsZip()`
  - Progress indicator during download
  - Abortable via `AbortController`
- **Page thumbnail click**: Link to reader with `?page={pageNum}` query param
- **Related gallery cards**: Render as `GalleryCardById` (fetch-as-you-go)

## For AI Agents

### Common Tasks

**Add new metadata field:**
1. Verify field exists in API response (check `fetchGalleryInfo()` response)
2. Update `galleryInfoToBlock()` parser if needed
3. Add render section in `GalleryDetail.tsx`

**Modify tag display:**
1. Update `TAG_ORDER` constant to reorder types
2. Adjust `tagEntries` rendering loop
3. Change `useTagI18n()` call if needed

**Change related galleries count:**
1. Edit line: `const relatedIds = displayBlock?.related?.slice(0, 12) ?? [];`
2. Adjust grid columns in `lg:grid-cols-6` as needed

**Add download format selector:**
1. Add state to track format (zip, cbz, tar.gz)
2. Pass format to `downloadGalleryAsZip()` call
3. Update progress UI if needed

### Key Patterns to Follow

- **Always check `displayBlock`** before rendering (null while loading)
- **Fall back to cached block** while full info loads (prevents UI flicker)
- **Use `useQueryClient()`** to invalidate related queries after mutations (favorites)
- **Handle errors gracefully** with spinner or error message
- **Use `AbortController`** for cancellable async operations (download)
- **Debounce saves** with timers to avoid excessive database writes

<!-- MANUAL: -->
