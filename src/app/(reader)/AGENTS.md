<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 -->

# HiPaGo/src/app/(reader) Route Group Guide

## Purpose

The `(reader)` route group provides a dedicated fullscreen gallery reader layout. It supports immersive image viewing with minimal UI chrome. The layout is optimized for reading experience with black background and fullscreen styling. Only the gallery reader view uses this group currently.

## Key Files

- **`layout.tsx`** - Reader layout wrapper with black background and fullscreen styling

## Subdirectories & Pages

### Reader Structure

- **`gallery/[id]/`** - Gallery reader segment grouping
  - **`layout.tsx`** - Gallery reader layout (nesting layer)
  - **`reader/`** - Fullscreen reader page
    - **`page.tsx`** - Full-screen image viewer with controls
    - **`loading.tsx`** - Loading spinner for page transitions

## Route Structure

```
(reader)
├── layout.tsx                  (black bg, fullscreen)
│
└── gallery/[id]/
    ├── layout.tsx              (gallery reader nesting)
    │
    └── reader/
        ├── page.tsx            (fullscreen reader)
        └── loading.tsx
```

## For AI Agents

### Reader Page Implementation

The reader page at `/gallery/[id]/reader?page=N` provides fullscreen image viewing:

1. **Route parameters:**
   - `[id]` - Gallery ID (required, integer)
   - `?page=N` - Initial page number (optional, 1-indexed)

2. **Page signature:**
```typescript
export async function generateStaticParams() {
  return [];
}

export default async function ReaderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page } = await searchParams;

  const galleryId = parseInt(id, 10);
  if (isNaN(galleryId)) {
    return <div className="...">Invalid gallery ID</div>;
  }

  const initialPage = page ? parseInt(page, 10) : undefined;
  if (initialPage && !isNaN(initialPage)) {
    // Use initialPage
  }

  return <ReaderView galleryId={galleryId} initialPage={initialPage} />;
}
```

3. **Always validate IDs:**
   - Parse as integer using `parseInt(id, 10)`
   - Check for NaN using `isNaN()`
   - Return error UI if invalid

4. **Handle optional page param:**
   - Parse similarly, check `!isNaN()`
   - Pass to `ReaderView` component
   - Component handles undefined gracefully

### Reader Layout Usage

The root reader layout applies minimal styling:
```typescript
export default function ReaderLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-black">
      {children}
    </div>
  );
}
```

This ensures:
- Full-height viewport (100vh)
- Black background (no white flash during image load)
- Minimal wrapper (no header, no padding, no constraints)

### ReaderView Component

The `ReaderView` component (from `@/features/reader/components/ReaderView`) handles:
- Image loading and rendering
- Page navigation (next/prev, jump to page)
- Keyboard shortcuts (arrow keys, space, esc)
- Reader mode switching (page-by-page vs scroll)
- Zoom and pan controls
- Full-screen API integration

Configuration from `useSettingsStore`:
- Reader mode preference (page or scroll)
- Image format preference (jpg or webp)
- Theme preference (affects UI overlays)

### Navigation to Reader

Link from gallery detail page:
```typescript
<Link href={`/gallery/${id}/reader`}>
  Open Reader
</Link>
```

With initial page:
```typescript
<Link href={`/gallery/${id}/reader?page=5`}>
  Start at Page 5
</Link>
```

### Loading State

During page transitions, show a spinner:
```typescript
// loading.tsx
export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );
}
```

### Performance Considerations

- Use edge runtime for image proxy if needed
- Implement image lazy-loading (load next/prev pages ahead)
- Utilize browser cache headers from CDN proxy
- Consider virtualization for large galleries (100+ pages)
- Use abort signals to cancel in-flight requests on navigation

### Keyboard Shortcuts

Document in help or settings:
- Arrow Right/Space → Next page
- Arrow Left/Backspace → Previous page
- Home/End → First/last page
- Escape → Exit reader (return to gallery detail)
- Z/+/- → Zoom controls
- F → Fullscreen API

### Dark Mode in Reader

Reader layout inherits theme from root. The black background works in both light and dark modes. For reader UI overlays (controls, page info):
- Use transparent overlays
- High-contrast text (white on semi-transparent black)
- Fade in/out on mouse movement
- Respect user's theme preference for text color

<!-- MANUAL: -->
