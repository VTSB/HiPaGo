<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src/features Directory Guide

## Purpose

The `features/` directory contains isolated feature modules that implement user-facing functionality. Each feature is self-contained with its own components, hooks, and state management. Features integrate with core libraries (`lib/`) and shared components (`shared/`) to build the complete application.

## Key Files

Each feature module follows this structure:
- **`components/`** - React components (UI rendering)
- **`hooks/`** - Custom React hooks (data fetching, state management, side effects)
- **`store/`** - Zustand stores (if feature requires persistent or shared state)

## Subdirectories

### gallery-detail
Displays detailed view of a single gallery with metadata, tags, related galleries, and download functionality.
- **Components**: `GalleryDetail.tsx` (main view, metadata display, related galleries)
- **Hooks**: `useGalleryDetail()` (fetch gallery info and convert to block)
- **State**: None (uses React Query for server state)

### gallery-list
Renders a paginated grid of gallery cards with infinite scroll and card-level prefetching.
- **Components**: `GalleryGrid.tsx` (pre-loaded blocks), `GalleryGridById.tsx` (fetch-as-you-go), `GalleryCard.tsx` (individual card with blur tags and prefetch)
- **Hooks**: `useGalleryList()` (pagination and ID fetching), `useGalleryBlock()` (per-card data fetching)
- **State**: None (uses React Query and Dexie cache)

### reader
Full-screen image viewer with page-by-page and scroll modes, browser history per-page, and reading progress tracking.
- **Components**: `ReaderView.tsx` (main view dispatcher), `PageReader.tsx` (page-flip mode), `ScrollReader.tsx` (continuous scroll), `ReaderControls.tsx` (UI controls)
- **Hooks**: `useReader()` (gallery loading, page navigation, history management, keyboard shortcuts, reading progress persistence)
- **Store**: `reader.store.ts` (Zustand store with gallery, page, mode, scroll position)

### search
Search interface with chip-based query input, tag autocomplete (local or remote), and search history persistence.
- **Components**: `SearchBar.tsx` (chip-based input, dropdown suggestions, recent search history), `SearchResults.tsx` (grid of search results)
- **Hooks**: `useSearch()` (query parsing, local/remote suggestion switching based on DB ready state, debouncing)
- **Store**: `search.store.ts` (Zustand store with query, suggestions, recent searches; persisted via localStorage)

## Architecture Patterns

### Data Flow

1. **Gallery discovery**:
   - `GalleryListView` → `useGalleryList()` (fetches IDs with pagination)
   - `GalleryGridById` → `GalleryCardById` → `useGalleryBlock()` (fetches each card's data)
   - Each card prefetches detail info on hover

2. **Gallery detail**:
   - `GalleryDetail` → `useGalleryDetail()` (fetches full gallery info)
   - Falls back to cached block from `useGalleryBlock()` while loading
   - Displays tags, file list, related galleries

3. **Reader**:
   - `ReaderView` → `useReader()` (manages page, mode, history, progress)
   - `PageReader` or `ScrollReader` render based on mode
   - Browser history per-page (user can navigate back with mouse button)
   - Reading progress debounced and saved to Dexie

4. **Search**:
   - `SearchBar` → `useSearch()` (queries local DB or remote API)
   - DB status checked to decide strategy (local instant vs remote with debounce)
   - Results displayed via `GalleryGrid`
   - Recent searches persisted in localStorage

### State Management

- **React Query**: Server state and caching (gallery info, suggestions)
- **Zustand stores**: `search.store.ts` (query, suggestions), `reader.store.ts` (reader state)
- **Dexie cache**: Per-gallery card data cached automatically
- **localStorage**: Search history (persisted via `zustand/middleware`)

### Performance Optimizations

- **Prefetch ahead**: `useGalleryList` prefetches 3 pages ahead
- **Lazy rendering**: Only render current page ± 10 in `PageReader`
- **Selective API calls**: Only fetch detail info on demand (hover or navigation)
- **Debounced search**: 300ms debounce for remote suggestions, instant for local
- **Content visibility**: Gallery cards use `contentVisibility: auto` for virtual scrolling

## For AI Agents

### Common Tasks

**Add a new gallery feature:**
1. Create new directory under `src/features/[feature-name]/`
2. Mkdir `components/`, `hooks/`, `store/` subdirs
3. Implement components first, then hooks, then store if needed
4. Export from parent `index.ts` or import directly

**Modify search behavior:**
1. Update `useSearch()` in `search/hooks/useSearch.ts` for new parsing logic
2. Check `dbReady` state to decide local vs remote
3. Update `search.store.ts` if new state fields needed

**Change gallery layout:**
1. Edit `GalleryGrid.tsx` or `GalleryGridById.tsx` for grid structure
2. Modify `GalleryCard.tsx` for individual card rendering
3. Adjust `GRID_CLASS` constant for responsive breakpoints

**Add reader feature (bookmarks, annotations, etc.):**
1. Extend `reader.store.ts` with new Zustand state
2. Update `useReader()` hook to handle new actions
3. Add UI controls in `ReaderControls.tsx`

**Add gallery metadata field:**
1. Update type in `src/lib/utils/types.ts`
2. Update API parser in `src/lib/api/parser.ts`
3. Update `GalleryDetail.tsx` to render the field

### Key Patterns to Follow

- **Use React Query** for server state (fetch functions in `src/lib/api/`)
- **Use Zustand** for client state that persists or is shared across components
- **Check `dbReady`** before using local search to avoid crashes
- **Handle loading states** with skeleton UI (`CardSkeleton`, `Spinner`)
- **Prefetch on hover** for better perceived performance
- **Debounce rapid updates** to avoid excessive API calls
- **Persist reading progress** debounced (2s delay) and on unmount

### Code Organization Rules

1. **Components** render only — no business logic
2. **Hooks** contain all data fetching and state management
3. **Stores** are Zustand instances for shared, persistent state
4. **Always export** from feature root or subdirectory index
5. **No cross-feature imports** (features are isolated, communicate via props)

<!-- MANUAL: -->
