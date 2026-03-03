<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src/shared/components Directory Guide

## Purpose

The `components/` directory contains reusable React UI components that are shared across multiple pages and features. These components handle image loading, navigation, pagination, filtering, error handling, and other UI patterns that appear in multiple parts of the application.

## Key Files

- **`AbortableImage.tsx`** - Smart image component with viewport-aware loading and request cancellation
- **`DbInitializer.tsx`** - Database initialization component
- **`ErrorBoundary.tsx`** - React error boundary for error handling
- **`FloatingPageNav.tsx`** - Floating page navigation widget
- **`GalleryIdListPage.tsx`** - Reusable list page layout
- **`Header.tsx`** - Application header
- **`InfiniteScrollTrigger.tsx`** - Infinite scroll sentinel
- **`LanguageFilter.tsx`** - Language dropdown selector
- **`SortSelector.tsx`** - Sort order dropdown selector
- **`Spinner.tsx`** - Loading indicator
- **`TagChip.tsx`** - Tag display component with link

## Component Overview

### Image & Media

**`AbortableImage.tsx`** (2.5 KB)
- Props: `src`, `alt`, `className`, `loading` ('lazy' | 'eager'), `style`, `draggable`
- Behavior: Uses IntersectionObserver to cancel image requests when scrolled off-screen (before load completes)
- Once fully loaded, image persists even when scrolled away
- Default `rootMargin: '200px'` starts loading slightly before viewport entry
- Use for: Gallery thumbnails, reader images, any off-screen images
- Key Hook: `useCallback`, `useRef`, `useEffect` for observer management

**`Spinner.tsx`** (432 bytes)
- Props: `size` ('sm' | 'md' | 'lg'), `className`
- Renders: Animated loading spinner with Tailwind animations
- Use for: Loading states, pagination triggers

### Navigation & Layout

**`Header.tsx`** (1.6 KB)
- Structure: Sticky header (z-50, h-14) with logo, search, language filter, nav links
- Components used: `SearchBar`, `LanguageFilter`, i18n labels via `useT()`
- Navigation links: Browse, Favorites, History, Settings
- Styling: Glass morphism effect (`bg-white/80 backdrop-blur-sm`), dark mode support
- Use for: Application-wide header in `(main)` and `(reader)` layouts

**`FloatingPageNav.tsx`** (5 KB)
- Props: `totalItems`, `loadedItems`, `pageSize`, `hasMore`, `onLoadMore`
- Position: Fixed bottom-right (`z-40`, dark glass background)
- Features: Previous/next buttons, editable page number input, auto-detects viewing page via scroll
- State: Tracks `viewingPage`, `editing`, `editValue`
- Hooks: `useCallback` for navigation, `useRef` for input focus
- Use for: Gallery lists with pagination (favorites, search results, history)

### Filtering & Selection

**`LanguageFilter.tsx`** (1.1 KB)
- Props: None (reads/writes `useSettingsStore`)
- Options: 'all', 'korean', 'japanese', 'english', 'chinese'
- Integration: Uses `useSettingsStore` for state, `useT()` for labels
- Styling: Inline Tailwind, matches SortSelector design
- Use for: Header language filtering

**`SortSelector.tsx`** (1.1 KB)
- Props: `value` (SortOrder), `onChange` callback
- Options: 'date_added', 'popular_year', 'popular_month', 'popular_week', 'popular_day'
- Integration: Caller manages state (typically in page component)
- i18n: Labels via `SORT_KEYS` mapping to `useT()`
- Use for: Search, browse pages with sort options

### Error Handling

**`ErrorBoundary.tsx`** (1.9 KB)
- Class component with `getDerivedStateFromError` and `componentDidCatch`
- State: `hasError` (boolean), `error` (Error | null)
- UI: Error card with message and "Try Again" button
- Logging: Logs to console with full error info
- Use for: Wrapping page sections or entire app

### Data Display

**`TagChip.tsx`** (988 bytes)
- Props: `tag`, `type` (TagType), `displayName` (optional), `linked` (default true), `size` ('sm' | 'md')
- Behavior: Renders tag as styled pill with color (via `getTagColor(type)`)
- If `linked=true`, renders as Link to `/search?q=...` with encoded tag type and name
- Size variants: 'sm' (text-xs, px-2) vs 'md' (text-[13px], px-3)
- Tags display: `displayName + TAG_TYPE_DISPLAY[type]` (e.g., "artist" + ":Female")
- Use for: Gallery detail, search results, tag lists

**`InfiniteScrollTrigger.tsx`** (1.1 KB)
- Props: `hasMore`, `isFetching`, `onLoadMore`, `rootMargin` (default '0px 0px 800px 0px')
- Behavior: Renders invisible sentinel element; triggers `onLoadMore` when near bottom
- IntersectionObserver detects when user scrolled 800px before bottom
- Shows Spinner while fetching
- Use for: Pagination trigger in list pages

**`GalleryIdListPage.tsx`** (2.8 KB)
- Props: `fetchIds` (async), `title`, `emptyMessage`, `queryKey`
- Behavior: Full page layout for list-based views (favorites, history)
- State: Local `allIds` array, `isLoading` flag
- Pagination: Uses `useInfiniteQuery` with `PAGE_SIZE = 25`
- Components: `GalleryGridById`, `InfiniteScrollTrigger`, `FloatingPageNav`
- Features: Shows total count in title, empty state message, smooth infinite scroll
- Use for: Favorites, History, any gallery ID list page

**`DbInitializer.tsx`** (914 bytes)
- Props: None
- Behavior: Invisible component that runs on mount
- Flow: `initializeDatabase()` → `checkDbReady()` → conditionally `runTagSync()`
- Error handling: Catches and logs errors, allows fallback to remote API
- Use for: Root layout wrap (via `Providers`)

## Development Patterns

### Props Design
- Keep props minimal and focused
- Use `children: ReactNode` for composition
- Define TypeScript interfaces for all props
- Use optional chaining (`?.`) for optional callbacks

### Hooks Usage
```typescript
// Standard pattern
'use client';
import { useState, useEffect, useCallback, useRef } from 'react';

const Component = () => {
  const [state, setState] = useState(initialValue);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    // setup logic
    return () => {
      // cleanup
    };
  }, [dependencies]);

  const handler = useCallback(() => {
    // handler logic
  }, [dependencies]);

  return <div>...</div>;
};
```

### Styling Pattern
- Use Tailwind CSS utilities (no CSS files)
- Always include dark mode variants: `dark:bg-zinc-900`, `dark:text-zinc-100`
- Use Tailwind prose classes for text layouts
- Responsive: `sm:`, `md:`, `lg:` prefixes as needed

### Client Component Pattern
- Always include `'use client'` at top
- Never import from `'server'` modules
- Never call server functions directly (use API routes)
- Use React hooks for state/effects, not globals

## For AI Agents

### Common Tasks

**Add a new reusable component:**
1. Create file: `src/shared/components/[ComponentName].tsx`
2. Add `'use client'` at top
3. Define props interface with JSDoc
4. Implement with hooks and Tailwind styling
5. Export as named export
6. Add to this AGENTS.md file

**Modify filter/selector behavior:**
1. Edit component file (LanguageFilter.tsx, SortSelector.tsx)
2. Update options array if adding new values
3. Update i18n keys in corresponding store or useT() mapping
4. Test integration with consuming page

**Optimize image performance:**
1. Replace `<img>` with `<AbortableImage>`
2. Use `loading="lazy"` for off-screen images
3. Use `loading="eager"` only for above-fold
4. Component auto-manages IntersectionObserver cleanup

**Add error handling:**
1. Wrap page or feature in `<ErrorBoundary>`
2. Component will catch render errors
3. User sees error message with "Try Again" button
4. Console logs full error for debugging

**Create infinite scroll list:**
1. Use `GalleryIdListPage` component
2. Pass async `fetchIds()` function
3. Configure `title`, `emptyMessage`, `queryKey`
4. Component handles pagination and nav automatically

### Testing Considerations
- Components are client-side only (mock in tests)
- Mock IntersectionObserver in tests: `global.IntersectionObserver = jest.fn()`
- Mock Zustand stores: `useSettingsStore` (use hook mock)
- Mock React Query: `useInfiniteQuery` (provide test data)
- Test with dark mode: check Tailwind dark: variants apply correctly

### Performance Notes
- AbortableImage reduces unnecessary image fetches (critical for gallery grids)
- InfiniteScrollTrigger prevents loading all items upfront
- FloatingPageNav enables fast navigation without refetch
- QueryClient caching prevents redundant API calls

<!-- MANUAL: -->
