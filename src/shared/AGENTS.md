<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src/shared Directory Guide

## Purpose

The `shared/` directory contains reusable UI components and context providers that are used across multiple pages and features in the HiPaGo application. These components and providers form the foundation of the application's UI layer and state initialization.

## Key Files

- **`components/`** - Reusable React components used across pages (AbortableImage, ErrorBoundary, Header, filters, navigation, pagination)
- **`providers/providers.tsx`** - Root React Query setup and database initialization provider wrapper

## Subdirectories

### `components/` - Reusable UI Components
Stateless and stateful components reused across features and pages:
- **`AbortableImage.tsx`** - Smart image loader that cancels off-screen requests using IntersectionObserver (frees browser connection slots)
- **`DbInitializer.tsx`** - Invisible component that runs database initialization on mount
- **`ErrorBoundary.tsx`** - React error boundary wrapper with reset button and error display
- **`FloatingPageNav.tsx`** - Fixed floating page navigator with prev/next buttons and editable page number (bottom-right)
- **`GalleryIdListPage.tsx`** - Reusable page layout for gallery ID lists (favorites, history) with infinite scroll and floating nav
- **`Header.tsx`** - Sticky app header with logo, search bar, language filter, and navigation links
- **`InfiniteScrollTrigger.tsx`** - Sentinel component that detects when user scrolls near bottom and triggers load-more callback
- **`LanguageFilter.tsx`** - Dropdown selector for language filtering (all, korean, japanese, english, chinese)
- **`SortSelector.tsx`** - Dropdown selector for sort order (date_added, popular_year/month/week/day)
- **`Spinner.tsx`** - Loading spinner component
- **`TagChip.tsx`** - Tag display pill with color coding, optional link to search, i18n display name

### `providers/` - React Context Providers
Application-level provider configuration:
- **`providers.tsx`** - Wraps app with React Query QueryClientProvider, DbInitializer, and locale initialization

## Architecture Patterns

### Component Design
- **Client-side rendering** - All components in `shared/` are client components (`'use client'`)
- **Composition** - Components are small, focused, and combined in page layouts
- **Hooks-based** - Use React hooks for state and effects (IntersectionObserver, form state, scroll tracking)
- **i18n ready** - Components use `useT()` hook for translated labels
- **Styling** - Tailwind CSS with dark mode support (`dark:` prefix)

### Query Client Configuration
- **staleTime**: 5 minutes — queries considered fresh for 5 minutes
- **gcTime**: 30 minutes — cache garbage collected after 30 minutes
- **retry**: 2 — automatic retry on failure
- **refetchOnWindowFocus**: false — don't refetch when window regains focus

### Database Initialization Flow
1. `Providers` component mounts in root layout
2. `DbInitializer` runs on mount (invisible component)
3. Database initialization happens before app is interactive
4. Background tag sync runs if database not yet initialized
5. App state (`dbReady`) controls local vs. remote search

## For AI Agents

### Common Tasks

**Add a reusable component:**
1. Create new file in `src/shared/components/[ComponentName].tsx`
2. Mark as client component: `'use client'`
3. Define props interface and JSDoc comment
4. Use Tailwind for styling with dark mode support
5. Import and use in page or feature components

**Modify the app header:**
1. Edit `src/shared/components/Header.tsx`
2. Add navigation links, filters, or branding
3. Update layout height in sticky header if needed
4. Test responsive behavior on mobile

**Add a new filter or selector:**
1. Create dropdown in `src/shared/components/[FilterName].tsx`
2. Use Zustand store hook to read/set settings (e.g., `useSettingsStore`)
3. Use `useT()` for translated labels
4. Style to match Header design (Tailwind, dark mode)

**Create a new page layout:**
1. Use `GalleryIdListPage` component for list-based pages (favorites, history)
2. Pass `fetchIds`, `title`, `emptyMessage`, `queryKey` props
3. Component handles infinite scroll, pagination nav, and grid rendering

**Optimize image loading:**
1. Use `AbortableImage` instead of native `<img>` for gallery images
2. Set `loading="lazy"` (default) for viewport-aware loading
3. Set `loading="eager"` for above-the-fold images
4. IntersectionObserver automatically manages connection slots

### Key Patterns to Follow
- **Composition over nesting** — use simple components in page layouts
- **Props as config** — pass `fetchIds`, `onChange` callbacks, not entire stores
- **Dark mode** — always add `dark:` Tailwind variants for text/bg colors
- **Accessibility** — use `aria-label` on interactive elements
- **Client-safe** — never import server-only modules in `'use client'` components
- **i18n** — use `useT()` hook for all user-facing text

### Code Organization Rules
1. **Simple, reusable components** live in `src/shared/components/`
2. **Feature-specific components** live in `src/features/[feature]/components/`
3. **Providers and configuration** live in `src/shared/providers/`
4. **Styling** is inline Tailwind (no separate CSS modules)
5. **State hooks** are imported from feature stores (`useSettingsStore`, `useDbStatusStore`)

<!-- MANUAL: -->
