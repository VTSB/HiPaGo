<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 -->

# HiPaGo/src/app/(main) Route Group Guide

## Purpose

The `(main)` route group contains the standard user-facing pages with a consistent header/navbar layout. All pages share the same `MainLayout` wrapper which includes the Header component and responsive content constraints. This is the primary user interface for browsing, searching, and managing galleries.

## Key Files

- **`layout.tsx`** - Main layout wrapper with Header component and content area styling
- **`page.tsx`** - Home page entry point (renders GalleryListView)
- **`error.tsx`** - Error boundary for main layout pages

## Subdirectories & Pages

### Root Pages

- **`page.tsx`** - Home page
  - Renders `GalleryListView` from `@/features/gallery-list`
  - Displays gallery grid with infinite scroll pagination
  - Default entry point for the application

### Gallery Pages

- **`gallery/[id]/`** - Gallery detail page
  - **`page.tsx`** - Displays single gallery metadata (title, tags, date, pages)
  - **`loading.tsx`** - Loading skeleton during metadata fetch
  - **`error.tsx`** - Error boundary for gallery detail
  - Uses dynamic route parameter `[id]` (gallery ID as integer)
  - Validates ID is numeric, returns error UI if invalid
  - Renders `GalleryDetail` component from `@/features/gallery-detail`

### Search Page

- **`search/`** - Search results page
  - **`page.tsx`** - Search UI and results display
  - **`loading.tsx`** - Loading spinner during search
  - Wrapped in Suspense with fallback
  - Renders `SearchResults` component from `@/features/search`
  - Branches search type based on `dbReady` state:
    - If DB ready → local SQLite search
    - If DB not ready → remote API search

### User Collection Pages

- **`favorites/`** - Favorites list
  - **`page.tsx`** - Displays user's favorited galleries
  - Client component (`'use client'`)
  - Uses `getFavoriteIds` from `@/lib/db/gallery`
  - Renders `GalleryIdListPage` component
  - Supports infinite scroll pagination

- **`history/`** - View history
  - **`page.tsx`** - Displays galleries the user has viewed
  - Client component (`'use client'`)
  - Uses database to fetch view history
  - Renders `GalleryIdListPage` component

### Settings Page

- **`settings/`** - User preferences
  - **`page.tsx`** - Settings UI (theme, language, reader mode, image format, tag blur)
  - Client component (`'use client'`)
  - Uses `useSettingsStore` from `@/lib/store/settings`
  - Persists settings to localStorage

## Layout Structure

```
(main)
├── layout.tsx                  (header + wrapper)
│
├── page.tsx                    (home)
├── error.tsx
├── loading.tsx
│
├── gallery/[id]/
│   ├── page.tsx                (detail)
│   ├── loading.tsx
│   └── error.tsx
│
├── search/
│   ├── page.tsx                (results)
│   └── loading.tsx
│
├── favorites/
│   └── page.tsx
│
├── history/
│   └── page.tsx
│
└── settings/
    └── page.tsx
```

## For AI Agents

### Adding a New Main Route Page

1. Create `src/app/(main)/[segment]/page.tsx`
2. Page automatically inherits `MainLayout` (header, wrapper)
3. For static/server pages: use default export
4. For interactive pages: add `'use client'` at top

Example:
```typescript
// Server-rendered page
import { MyFeature } from '@/features/my-feature/components/MyFeature';

export default function MyPage() {
  return <MyFeature />;
}
```

Example with client state:
```typescript
'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n/useT';

export default function MyPage() {
  const t = useT();
  const [state, setState] = useState(false);
  return <div>{t('my.key')}</div>;
}
```

### Gallery Detail Flow

1. User navigates to `/gallery/123`
2. `page.tsx` receives `params: Promise<{ id: string }>`
3. Parse and validate: `parseInt(id, 10)` and check `isNaN()`
4. Invalid IDs return error UI with link to home
5. Valid IDs render `GalleryDetail` component with ID prop

### Search Implementation

Search page uses Suspense boundary with loading fallback. The `SearchResults` component:
- Reads `dbReady` state from `useDbStatusStore`
- If DB ready → calls local search functions
- If DB not ready → calls remote API search
- Handles tag autocomplete, query parsing, pagination

Update search behavior in `src/features/search/hooks/useSearch.ts`.

### Favorites & History

Both use `GalleryIdListPage` utility component:
- Accepts `fetchIds` function (async generator or callback)
- Handles infinite scroll pagination
- Displays gallery grid
- Supports query key for React Query caching

To add similar page:
```typescript
import { GalleryIdListPage } from '@/shared/components/GalleryIdListPage';
import { getMyCollectionIds } from '@/lib/db/gallery';
import { useT } from '@/lib/i18n/useT';

export default function MyCollectionPage() {
  const t = useT();
  return (
    <GalleryIdListPage
      fetchIds={getMyCollectionIds}
      title={t('my.collection.title')}
      emptyMessage={t('my.collection.empty')}
      queryKey="my-collection-pages"
    />
  );
}
```

### Loading & Error States

For pages with async data:

**Loading skeleton:**
```typescript
// loading.tsx
export default function Loading() {
  return <GallerySkeleton />;
}
```

**Error boundary:**
```typescript
// error.tsx
'use client';

export default function Error({ error }: { error: Error }) {
  return <div className="text-red-500">{error.message}</div>;
}
```

### Settings State Management

Use `useSettingsStore` for all user preferences:
- Theme (light/dark/system)
- Language (en/ko)
- Reader mode (page/scroll)
- Image format (jpg/webp)
- Tag blur (enabled/disabled)

Store is persisted to localStorage automatically.

### Header Interaction

The `Header` component displays:
- Logo/home link
- Search bar (routes to `/search?q=...`)
- Navigation menu (favorites, history, settings)
- Language selector
- Theme toggle

Modify header in `src/shared/components/Header/index.tsx`.

<!-- MANUAL: -->
