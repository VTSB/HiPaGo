# REQ - Mobile gallery and reader navigation

**Surface:** gallery list cards, gallery detail pages, and the page reader on
mobile/native app builds.

**Implementation area:** `src/features/gallery-list/`,
`src/features/gallery-detail/`, `src/features/reader/`,
`src/shared/components/AbortableImage.tsx`, and static mobile routes
`/gallery?id=<id>` and `/reader?id=<id>&page=<page>`.

**Why this doc exists.** The Android app exposed regressions not covered by
`REQ__mobile-page-nav.md`: detail-card taps looked like list refreshes, detail
images caused layout shift, Android Back could exit the app instead of
returning to the list, and reader page turns lost mobile swipe/preload behavior.
This REQ codifies the expected observable mobile flow so QA cannot treat
browser viewport checks as sufficient for native navigation.

## Observable Behavior

### List to Detail Navigation

- Tapping a gallery card opens the gallery detail page for that gallery.
- The tap must not appear to merely refresh or re-render the list.
- On static mobile builds, the canonical detail URL is
  `/gallery?id=<galleryId>`. Dynamic Next routes may exist for web/dev, but
  the mobile static app must support the query route.
- Before navigation, the app records the current list URL, including query
  state such as page/sort/search, so Back returns to the same browsing context
  when possible.

### Detail Layout Stability

- The main detail cover reserves a stable portrait area before the image bytes
  finish loading.
- The cover slot must not expand from height `0` after load.
- While the image is loading, surrounding title, tag, action, and content
  sections must not jump by more than a small skeleton/image fade difference.
- The cover image uses the reserved slot with `object-cover`; failed/missing
  images render a stable placeholder in the same slot.

### Detail Back Behavior

- Tapping the in-page Back control on detail returns to the stored list URL
  when available; otherwise it returns to `/`.
- On Android/native builds, pressing the system Back button from a detail page
  must return to the list context, not close the app.
- Returning to the list should preserve the list's page/sort/search context
  and avoid a full cold reload where possible.
- Browser mobile viewport tests are not sufficient proof for this behavior:
  at least one Android APK/emulator/system-back verification is required before
  claiming this acceptance criterion is passed.

### Image Reuse Across List, Detail, and Reader

- Moving list -> detail -> list -> detail should not visibly refetch or fade
  already loaded thumbnails/covers as if they were new images.
- Moving detail -> reader and paging near adjacent images should use the same
  platform-aware image loading path as visible images.
- On Capacitor/Tauri/native image URLs that require bypass headers, preload
  must not use raw `new Image()` only; it must route through the native-capable
  loader or equivalent cache.
- Cache size must be bounded or otherwise safe for long reader sessions.

### Reader Touch Navigation

- In the reader, a horizontal swipe-left advances to the next page.
- A horizontal swipe-right returns to the previous page.
- Vertical scroll gestures must not be captured as page turns.
- Tap zones remain usable: tapping the right half advances, tapping the left
  half goes back.
- Dual-page mode advances by two pages; single-page mode advances by one.
- Boundary gestures at the first/last page do not navigate out of range.

### Reader Preloading

- The reader preloads adjacent pages ahead of the current page so the next page
  appears immediately under normal network/cache conditions.
- Preloading is asymmetric toward forward reading, while keeping memory bounded.
- Offline/blob reader URLs are not unnecessarily preloaded through network code.
- Preload failures are best-effort and must not replace visible image error
  handling.

### Mobile Type Scale

- Main list headings and Settings headings must use app-scale mobile heading
  sizes, not oversized desktop/landing-page sizes.
- Sidebar/nav text may keep its own density if it already reads correctly on
  mobile.
- Detail and reader controls must remain at thumb-friendly tap sizes while
  avoiding desktop-web proportions shrunk into a phone viewport.

## Verification Cues

### Required Automated Checks

- `pnpm lint`
- `pnpm exec tsc --noEmit`
- Targeted reader, detail, list-card, and abortable-image tests.
- Static export build via `node scripts/build-static.mjs`, confirming
  `/gallery` and `/reader` static entry points exist.

### Required Browser QA

- At a phone viewport around 390 x 844:
  - List and Settings headings are not oversized.
  - Tapping a list card opens `/gallery?id=<id>`.
  - Detail cover reserves space before/while the image loads.
  - Reader swipe-left changes page.
  - Reader adjacent page requests/preloads begin without hidden DOM preload
    nodes that pin excessive decoded bitmaps.

### Required Native QA

- Install an Android APK or use an Android emulator.
- From the list, open a detail page, then press the Android system Back button.
  Expected: returns to the list context, not app exit.
- Open detail, tap Read, swipe several pages, then use system Back. Expected:
  navigation returns through the reader/detail/list flow in a way that feels
  native and does not close the app prematurely.
- Repeat after returning to the same detail: already seen images should not
  visibly reload from blank.

## Non-Goals

- This REQ does not define the floating page navigator pill behavior.
- This REQ does not define the mobile hamburger drawer.
- This REQ does not require full offline reader support beyond respecting
  provided blob URLs.

## Known Risk

As of the mobile reader polish task, browser simulation showed that native-like
back-stack behavior cannot be considered verified without an Android
APK/emulator run. Next App Router browser history state can diverge from
Capacitor/native expectations, so future fixes should prefer explicit
Capacitor-level back-button handling for native builds over relying solely on
generic `popstate` behavior.
