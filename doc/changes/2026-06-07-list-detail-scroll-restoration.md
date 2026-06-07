# List Detail Scroll Restoration

## Context

Gallery detail uses real browser history back when the user came from a list page. That lets the browser restore the exact `window.scrollY` pixel position for list -> detail -> back navigation.

`VirtualGalleryGrid` also had a first-data layout effect that scrolled to the start row of the current `viewingPage`. After native restoration, `FloatingPageNav` derives `viewingPage` from the restored pixels. The grid effect then converted that exact pixel position into page-start alignment, so returning from detail could land slightly above the original card.

## Decision

Native back restoration must remain pixel-based. `VirtualGalleryGrid` should not scroll when `viewingPage` changes because scroll tracking observed restored pixels.

Explicit jumps remain imperative:

- `scrollToPage(page)` scrolls to a page start.
- `scrollToItem(index)` scrolls to a specific item row.
- Browser back from detail leaves the restored `window.scrollY` alone.

## Verification Cue

VirtualGalleryGrid tests should assert that changing `viewingPage` after mount does not call `virtualizer.scrollToIndex`, while explicit `scrollToPage` and `scrollToItem` still do.
