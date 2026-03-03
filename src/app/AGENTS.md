<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 -->

# HiPaGo/src/app Directory Guide

## Purpose

The `app/` directory contains the Next.js 16 App Router implementation for HiPaGo. It defines the page structure, layout hierarchy, and API proxy routes. Two route groups provide different layouts: `(main)` for standard pages with header/navbar, and `(reader)` for fullscreen gallery reader. API routes proxy external services (Hitomi metadata, image CDN, tag index).

## Key Files

- **`layout.tsx`** - Root layout with theme initialization script, Geist fonts, global error boundary, and provider setup
- **`globals.css`** - Global styles (Tailwind, theme variables, dark mode)

## Subdirectories

### `(main)/` - Main Route Group
Standard pages with header/navbar layout:
- **`layout.tsx`** - Main layout component with Header and content wrapper
- **`page.tsx`** - Home page (renders GalleryListView)
- **`gallery/[id]/`** - Gallery detail page (single gallery metadata and preview)
- **`search/`** - Search results page with tag query and pagination
- **`favorites/`** - Favorites list page
- **`history/`** - View history page
- **`settings/`** - User settings page
- **`error.tsx`** - Error boundary for main layout
- **`loading.tsx`** - Loading skeleton for main layout

### `(reader)/` - Reader Route Group
Fullscreen reader layout with black background:
- **`layout.tsx`** - Reader layout component (minimal styling, full-height dark bg)
- **`gallery/[id]/`** - Reader segment grouping
  - **`layout.tsx`** - Gallery reader layout
  - **`reader/page.tsx`** - Full-screen image reader page

### `api/` - API Proxy Routes
Backend routes that proxy external services:
- **`hitomi/[...path]/route.ts`** - Proxy to Hitomi metadata API (gallery info, file lists)
- **`img/[...path]/route.ts`** - Proxy to CDN for images (with gg.js subdomain resolution, edge runtime)
- **`tagindex/[...path]/route.ts`** - Proxy to tag index API (tag suggestions, category mapping)

## Route Structure

```
/                                  → (main) home page
/gallery/[id]                      → (main) gallery detail
/gallery/[id]/reader?page=N        → (reader) fullscreen reader
/search?q=...                      → (main) search results
/favorites                         → (main) favorites list
/history                           → (main) view history
/settings                          → (main) user settings
/api/hitomi/[...path]              → Proxy GET requests
/api/img/[...path]                 → Proxy GET requests (edge runtime)
/api/tagindex/[...path]            → Proxy GET requests
```

## For AI Agents

### Adding a New Page in (main)

1. Create `src/app/(main)/[segment]/page.tsx`
2. Import feature components or use existing shared components
3. Page inherits `MainLayout` (header, navbar, max-width wrapper)
4. Use `'use client'` if needs interactive state

Example:
```typescript
import { MyFeature } from '@/features/my-feature/components/MyFeature';

export default function MyPage() {
  return <MyFeature />;
}
```

### Adding a New Reader Page

1. Create `src/app/(reader)/gallery/[id]/reader/page.tsx` (or new path under reader group)
2. Page inherits `ReaderLayout` (black background, fullscreen)
3. Use streaming and lazy loading for performance
4. Handle invalid gallery IDs gracefully

### Modifying API Proxy Routes

**Image proxy** (`img/[...path]/route.ts`):
- Uses edge runtime for low-latency streaming
- Resolves `tn` subdomain to `atn`/`btn` via gg.js config
- Streams response directly without buffering
- Cache-Control: public, max-age=86400

**Hitomi proxy** (`hitomi/[...path]/route.ts`):
- Standard Node.js runtime
- Supports Range requests for partial fetches
- Cache-Control: public, max-age=3600
- Handles gzip decompression

**Tag index proxy** (`tagindex/[...path]/route.ts`):
- Standard Node.js runtime
- Short cache window (300s) for live tag data
- Used during search suggestions and tag sync

### Adding Route Parameters

Use dynamic segments with `[param]` naming:
- `[id]` for gallery IDs
- `[...path]` for catch-all proxy paths
- Always use `Promise<{ param: string }>` typing in Next.js 16

Example:
```typescript
export default async function MyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Use id
}
```

### Layout Inheritance Rules

- Root layout (`layout.tsx`) → all pages
- `(main)/layout.tsx` → all main group pages (adds header, wrapper)
- `(reader)/layout.tsx` → all reader group pages (black bg, fullscreen)
- Nested layouts stack in order

### Error Handling

- `(main)/error.tsx` catches errors in main group pages
- `(reader)/` currently has no dedicated error boundary (uses root ErrorBoundary)
- Always validate route params (e.g., parse gallery ID as integer, check for NaN)

### Static Parameters & ISR

- Set `export const generateStaticParams() = []` for dynamic routes (gallery detail, reader)
- This prevents pregeneration and uses dynamic rendering
- Use `revalidate: false` if caching not needed

<!-- MANUAL: -->
