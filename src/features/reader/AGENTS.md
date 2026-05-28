<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src/features/reader Directory Guide

## Purpose

The `reader` feature implements a full-screen image viewer with two modes: page-by-page flipping and continuous scroll. It manages reading state (current page, mode), persists reading progress to the database, tracks browser history per-page for mouse-back navigation, and provides keyboard controls and page navigation UI.

## Key Files

- **`hooks/useReader.ts`** - Main reader logic and state management
  - Loads gallery images via `useGalleryDetail()`
  - Manages reader state (page, mode, scroll position) via `useReaderStore`
  - Initializes from URL query param or saved reading progress
  - Handles browser history: pushes/pops per-page for mouse-back button
  - Debounced save of reading progress (2s delay, also on unmount)
  - Keyboard shortcuts (arrow keys, vim keys) for page navigation
  - Returns state and actions (setCurrentPage, nextPage, prevPage, goBack, etc.)

- **`store/reader.store.ts`** - Zustand store
  - State: `galleryId`, `images`, `currentPage`, `totalPages`, `mode`, `scrollPosition`
  - Actions: `setGallery`, `setCurrentPage`, `setMode`, `setScrollPosition`, `nextPage`, `prevPage`, `reset`

- **`components/ReaderView.tsx`** - Main dispatcher component
  - Mounts `useReader()` hook
  - Dispatches to `PageReader` or `ScrollReader` based on mode
  - Renders back button, reader controls
  - Handles scroll-to-page in scroll mode

- **`components/PageReader.tsx`** - Page-by-page mode
  - Click left/right to navigate pages
  - Renders current page + PRELOAD_AHEAD (±10 pages kept in DOM)
  - Hides non-current pages with `display: none`

- **`components/ScrollReader.tsx`** - Continuous scroll mode
  - Vertical scroll through all pages
  - Intersection observer detects visible page
  - Updates `currentPage` based on visible page
  - Smooth scroll-to-page on mode switch or control click

- **`components/ReaderControls.tsx`** - UI controls
  - Page input (direct jump)
  - Previous/Next page buttons
  - Mode toggle (page/scroll)
  - Back button

## Subdirectories

### components/
- **`ReaderView.tsx`** - Main view and dispatcher
- **`PageReader.tsx`** - Page-by-page rendering
- **`ScrollReader.tsx`** - Continuous scroll rendering
- **`ReaderControls.tsx`** - Navigation UI

### hooks/
- **`useReader.ts`** - Main logic hook

### store/
- **`reader.store.ts`** - Zustand state management

## Architecture Patterns

### Data Flow

1. **Reader init**:
   - URL: `/gallery/{id}/reader?page={n}`
   - `useReader(id, initialPage)` loads images via `useGalleryDetail(id)`
2. **Page navigation**:
   - User clicks image, presses arrow key, or uses controls
   - `setCurrentPage()` updates store
   - URL is not touched on page flips — the URL stays at `/gallery/<id>/reader`
     for the whole session
   - Reading progress saved after 2s debounce (handles resume on next visit)
3. **Back button behavior**:
   - One reader session === one history entry. Page flips do not grow the stack.
   - Browser / hardware back exits the reader to the detail page in one press
   - `goBack()` is a thin wrapper around `window.history.back()`

### Reading Progress Persistence

- On page change: debounce timer set for 2s
- On unmount: save immediately (in cleanup effect)
- Saved fields: `galleryId`, `lastPage`, `totalPages`, `readerMode`
- Next session loads from saved progress (unless URL has `?page=N`)

### Browser History Management

- The reader makes no history mutations during a session. Page flips are
  pure store state — the URL never reflects the current page number.
- A single back press exits to the detail page because the reader entry
  is the only one the navigation pushed.
- **goBack()**: forwards directly to `window.history.back()`.
- External deep-links may still pass `?page=N` to set the initial page
  (read by `ReaderFromQuery` / `(reader)/gallery/[id]/reader/page.tsx`);
  the URL parameter is consumed once and not re-written.

### Keyboard Shortcuts

- **Arrow Right/Down**: Next page (page mode only)
- **Arrow Left/Up**: Previous page (page mode only)
- **Escape**: Exit reader (handled by back button)

### State Management

- **Zustand store**: Reader state (page, mode, gallery, images)
- **React Query**: Gallery images (via `useGalleryDetail`)
- **Browser history**: Page tracking for back button
- **Dexie**: Reading progress persistence

## For AI Agents

### Common Tasks

**Add page jump feature:**
1. Update `ReaderControls.tsx` to render input field
2. Add new state for input value
3. Call `reader.setCurrentPage()` on submit

**Change preload range:**
1. Edit `PRELOAD_AHEAD` constant in `PageReader.tsx`
2. Value is: pages before current + pages after current
3. Default 10 = ±10 pages = 21 pages in DOM

**Add zoom controls:**
1. Update `PageReader.tsx` to track zoom state
2. Apply transform/scale to image element
3. Save zoom to store if persistence needed

**Modify keyboard shortcuts:**
1. Edit `useReader.ts` handleKeyDown function
2. Add/remove key cases
3. Call appropriate action (nextPage, prevPage, etc.)

**Add annotations/bookmarks:**
1. Extend `reader.store.ts` with bookmarks array
2. Add actions to add/remove bookmarks
3. Update `ReaderControls.tsx` to show bookmark button
4. Save bookmarks to Dexie via separate function

**Change scroll behavior:**
1. Modify `ScrollReader.tsx` intersection observer options
2. Adjust scroll-to-page animation in `ReaderView.tsx`
3. Update `scrollTimerRef` delay if needed

### Key Patterns to Follow

- **Always debounce saves** to avoid excessive database writes
- **Use `window.history` carefully** — test back button behavior
- **Check `initialPage` range** (clamp to 0-totalPages)
- **Preload adjacent pages** only (don't load entire gallery upfront)
- **Handle scroll to page gracefully** (check if DOM node exists)
- **Use refs for side effects** (programmatic scroll, history push flag)
- **Save on unmount** in cleanup effect (don't rely on debounce alone)

### Code Organization Rules

1. **Logic** in `useReader.ts` (data, history, keyboard)
2. **Rendering** in component files (PageReader, ScrollReader)
3. **UI controls** in `ReaderControls.tsx` only
4. **State** in `reader.store.ts` (Zustand)
5. **Persistence** via `recordHistory()` function (in `useReader.ts` effect)

<!-- MANUAL: -->
