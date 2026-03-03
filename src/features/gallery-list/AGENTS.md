<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src/features/gallery-list Directory Guide

## Purpose

The `gallery-list` feature renders a paginated grid of gallery cards with infinite scroll. It fetches gallery IDs in pages, renders each card with progressive data loading, and implements performance optimizations like prefetching ahead and prefetching detail info on hover.

## Key Files

- **`hooks/useGalleryList.ts`** - Pagination and ID fetching
  - Infinite query for gallery IDs (paginated, ~25 items per page)
  - Prefetches 3 pages ahead automatically
  - Returns IDs, loading state, has-more flag, load-more function
  - Handles language setting and sort order

- **`hooks/useGalleryBlock.ts`** - Per-card data fetching
  - Fetches gallery block (metadata) by ID
  - Caches via Dexie or React Query
  - Returns `GalleryBlock` with loading/failed states
  - Used by both `GalleryCard` and `GalleryCardById`

- **`components/GalleryGrid.tsx`** - Pre-loaded grid renderer
  - Renders grid of `GalleryCard` components (for search results with blocks already loaded)
  - Skeleton loading UI for initial state
  - Fixed grid layout (responsive: 2-6 cols)

- **`components/GalleryGridById.tsx`** - Fetch-as-you-go grid renderer
  - Renders grid of `GalleryCardById` components (each card fetches its own data)
  - Used by browse pages and infinite scroll
  - Data attributes for intersection observer

- **`components/GalleryCard.tsx`** - Individual card with prefetch
  - Renders gallery thumbnail, title, and tag chips
  - Prefetches detail info on hover
  - Blur effect for user-configured blur tags
  - Shows loading skeleton while data fetches
  - Shows error state for failed cards
  - Uses content visibility API for virtual scrolling

## Subdirectories

### components/
- **`GalleryCard.tsx`** - Individual card rendering (accepts pre-loaded block or ID)
- **`GalleryGrid.tsx`** - Grid of pre-loaded blocks
- **`GalleryGridById.tsx`** - Grid of IDs (fetch-as-you-go)
- **`GalleryListView.tsx`** - Full browse page with sort, infinite scroll trigger, floating nav

### hooks/
- **`useGalleryList.ts`** - Infinite pagination of IDs
- **`useGalleryBlock.ts`** - Per-card data fetching

### store/
- No store (state managed by React Query)

## Architecture Patterns

### Data Flow

1. **Browse page** → `GalleryListView` loads via App Router
2. **Initial load**:
   - `useGalleryList()` fetches first page of IDs (default sort: date_added)
   - `GalleryGridById` renders each ID as `GalleryCardById`
   - Each card calls `useGalleryBlock(id)` independently
3. **Infinite scroll**:
   - `InfiniteScrollTrigger` detects scroll to bottom
   - `loadMore()` fetches next page
   - New cards render with loading skeletons
4. **Prefetch ahead**:
   - `useGalleryList` automatically fetches 3 pages ahead when user is on page N
   - Reduces loading time for fast scrollers
5. **Hover prefetch**:
   - `GalleryCard` prefetches detail info on pointer-enter
   - React Query caches for 5 minutes
   - When user clicks, detail page loads instantly

### Blur Tags

- `GalleryCard` reads `blurTags` from `useSettingsStore`
- Tags stored as `${type}:${tag}` with underscores (e.g., `female:loli`)
- Card checks `block.tags` against blur list
- If match, applies `blur-lg` CSS class
- Handles legacy format (tags with ♂/♀ suffixes)

### State Management

- **React Query**: Infinite query for IDs, query for each block
- **Zustand**: `useSettingsStore` for blur tags and language
- **Dexie**: Automatic cache of blocks and images

## For AI Agents

### Common Tasks

**Change grid layout:**
1. Edit `GRID_CLASS` in `GalleryGrid.tsx`
2. Update class string: `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5`
3. Update `CardSkeleton` aspect ratio if needed

**Add sort option:**
1. Add option to `SortOrder` type in `src/lib/utils/types.ts`
2. Update `SortSelector.tsx` to include new option
3. Hook already supports any `SortOrder` value

**Modify card appearance:**
1. Edit `CardContent` component in `GalleryCard.tsx`
2. Change thumbnail size, title lines, tag display
3. Adjust skeleton dimensions in `CardSkeleton`

**Change prefetch trigger:**
1. In `GalleryCard.tsx`, replace `onPointerEnter={onPrefetch}` with other event
2. Or adjust prefetch timing via React Query options

**Add filter to grid:**
1. Create new hook similar to `useGalleryList()`
2. Pass filtered IDs to `GalleryGridById`
3. UI filter controls separate from grid component

### Key Patterns to Follow

- **Use `GalleryCardById`** for dynamic loading (one network request per card, but cacheable)
- **Use `GalleryCard`** for pre-loaded results (search results where blocks already fetched)
- **Always provide `isLoading` prop** to grid (renders skeleton on first load)
- **Prefetch on hover** for perceived performance
- **Check `blurTags`** before rendering sensitive content
- **Handle loading and error states** gracefully (skeleton, error message)
- **Use `contentVisibility: auto`** for large lists (60+ cards)

<!-- MANUAL: -->
