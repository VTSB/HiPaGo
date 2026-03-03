<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src Directory Guide

## Purpose

The `src/` directory is the root of the HiPaGo Next.js 16 application codebase. It implements a cross-platform gallery viewer with App Router pages, feature modules, shared libraries, and utility layers. The architecture supports multiple platforms (web, desktop via Tauri, mobile via Capacitor) with a local SQLite database for offline search and a remote API fallback.

## Key Files

- **`app/layout.tsx`** - Root layout with theme initialization script and provider setup
- **`shared/providers/providers.tsx`** - React Query client setup and DbInitializer component wrapper
- **`lib/api/client.ts`** - Concurrency-limited API client with queue system (max 6 concurrent requests)
- **`lib/db/adapter.ts`** - Platform-agnostic database adapter interface (Tauri, Capacitor, test implementations)
- **`lib/store/settings.ts`** - Zustand store for user settings (theme, language, reader mode, image format, blur tags)
- **`lib/store/db-status.ts`** - Zustand store for database sync status and readiness
- **`shared/components/DbInitializer.tsx`** - Invisible component that initializes SQLite database on mount

## Subdirectories

### `app/` - Next.js App Router
Pages and API routes organized by layout and segment:
- `(main)/` - Main layout with header/nav (home, search, favorites, history, settings, gallery detail)
- `(reader)/` - Reader-only layout (fullscreen reader view with different styling)
- `api/` - API proxy routes (hitomi, img, tagindex)
- Route files: `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`

### `features/` - Feature Modules
Isolated feature bundles with components and hooks:
- **`gallery-detail/`** - Gallery metadata display (title, tags, date, page count)
- **`gallery-list/`** - Grid view of galleries with infinite scroll pagination
- **`reader/`** - Image viewer (page-by-page or scroll modes) with controls and keyboard navigation
- **`search/`** - Search UI with tag autocomplete and query parsing (local DB or remote API)

### `lib/` - Shared Libraries
Core business logic, utilities, and platform adapters:
- **`api/`** - HTTP client, gallery API, Nozomi (tag list), search, parser, URL resolver, integration tests
- **`db/`** - Database adapter interface, platform implementations (Tauri, Capacitor), schema, initialization, tag sync
- **`store/`** - Zustand stores (settings, db-status) with localStorage persistence
- **`data/`** - Static data (Korean tag translations in JSON)
- **`i18n/`** - Internationalization (translation strings, locale detection, tag translations)
- **`utils/`** - Constants, platform detection, image URL generation, download utilities, type definitions

### `shared/` - Shared Components & Providers
Reusable UI components and context providers:
- **`components/`** - DbInitializer, ErrorBoundary, Header, gallery cards, infinite scroll trigger, language/sort filters, spinner, tag chip
- **`providers/providers.tsx`** - Wraps app with React Query client and DB initialization

### `types/` - TypeScript Definitions
- **`vendor.d.ts`** - Type definitions for third-party libraries and platform APIs

### `test/` - Test Configuration
- **`setup.ts`** - Vitest/Jest setup and test utilities

## Architecture Patterns

### State Management
- **Zustand stores** in `lib/store/` with persistence middleware for user settings
- **React Query** (`@tanstack/react-query`) for server state and caching
- **Internal state** in feature-level hooks (`useSearch`, `useGalleryList`, `useReader`)

### Data Flow
1. **Database initialization** via `DbInitializer` component (runs on root layout mount)
2. **Check DB readiness** (`dbReady` state in `useDbStatusStore`)
3. **Search branching**:
   - If `dbReady=true` → use local SQLite queries (`searchLocalTags`, `searchLocalGalleryIds`)
   - If `dbReady=false` → fall back to remote API (`getSuggestionsForQuery`, `getGalleryIdsForQuery`)
4. **Gallery loading** via `useGalleryList` (infinite scroll) or `useGalleryDetail` (single gallery)
5. **Image rendering** via `AbortableImage` with CDN URL resolution and format selection

### Platform Abstraction
- **`DbAdapter` interface** (`lib/db/adapter.ts`) with implementations:
  - TauriAdapter (desktop SQLite via `tauri-plugin-sql`)
  - CapacitorAdapter (mobile SQLite via `@capacitor-community/sqlite`)
  - TestAdapter (in-memory for tests)
- **Platform detection** via `lib/utils/platform.ts` (checks for `window.__TAURI__`, `window.Capacitor`)

### API Design
- **Concurrency control**: `ApiClient` queue system limits concurrent requests to 6
- **Proxy routes** under `/api/` forward requests to external hosts (hitomi.la, tagindex.hitomi.la)
- **Range requests** supported for partial image fetches
- **Native headers** injected for platform-specific requests

## For AI Agents

### Common Tasks

**Add a new page:**
1. Create `src/app/(main)/[segment]/page.tsx` (or `(reader)/` for fullscreen)
2. Import feature components or shared components
3. Route will be automatically available

**Modify search behavior:**
1. Edit `src/features/search/hooks/useSearch.ts` for query parsing
2. Check `dbReady` state to decide local vs. remote API
3. Update `src/features/search/store/search.store.ts` if new state needed

**Change gallery display:**
1. Feature logic in `src/features/gallery-list/` (pagination, filtering)
2. Components in `src/features/gallery-list/components/` (render)
3. API calls in `src/lib/api/gallery.ts`

**Add database functionality:**
1. Define schema in `src/lib/db/schema.ts`
2. Use `DbAdapter` interface (platform-agnostic)
3. Test with TestAdapter for unit tests

**Adjust styling or theme:**
1. Global CSS in `src/app/globals.css`
2. Component-level styles in adjacent `.module.css` files
3. Theme detection script in `src/app/layout.tsx`
4. Settings persisted via `useSettingsStore` in `lib/store/settings.ts`

### Key Patterns to Follow
- **Use hooks** for data fetching (`useGalleryList`, `useSearch`, `useReader`)
- **Persist settings** via `useSettingsStore.persist()` middleware
- **Check `dbReady`** before using local search to prevent crashes
- **Handle errors** gracefully (remote API fallback, error boundary component)
- **Avoid direct DOM** — use React Query, Zustand, and Next.js APIs
- **Test with adapters** — mock `DbAdapter` for unit tests

### Code Organization Rules
1. **Feature components** live in `src/features/[feature]/components/`
2. **Feature logic** lives in `src/features/[feature]/hooks/` and `src/features/[feature]/store/`
3. **Shared reusable** code lives in `src/lib/` or `src/shared/`
4. **API calls** go in `src/lib/api/` with client/server considerations
5. **Page routes** go in `src/app/` following Next.js App Router conventions

<!-- MANUAL: -->
