'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { GalleryImage, GgConfig } from '@/lib/utils/types';
import { getBestImageUrl, galleryImageToFile } from '@/lib/utils/image-url';
import { getGgConfig } from '@/lib/api/client';
import { useSettingsStore } from '@/lib/store/settings';
import { AbortableImage, preloadImageSource } from '@/shared/components/AbortableImage';
import { createScrollAnimator } from '@/features/reader/utils/scrollAnimator';
// Re-export so existing importers (and tests) keep resolving easeOutCubic here.
export { easeOutCubic } from '@/features/reader/utils/scrollAnimator';

// High-res manga pages can be 10–20 MB decoded each. Hidden preload <img>
// tags still get decoded by the browser, so a large mounted window pins
// hundreds of MB of bitmap memory and OOMs during rapid prev/next mashing.
// We keep the window small and asymmetric (readers mostly move forward)
// and warm the cache via JS Image() objects whose decoded bitmaps are
// released the moment the user navigates again.
const PRELOAD_AHEAD = 15;
const PRELOAD_BEHIND = 5;

// Page-turn animation. A custom rAF tween replaces the browser's native
// `behavior:'smooth'` (which is ease-in-out, slow→fast→slow, and ~400ms).
// ~200ms (≈2× faster) + easeOutCubic gives a snappier, decelerating (fast→slow)
// turn.
const SCROLL_DURATION_MS = 200;

export function PageReader({
  images,
  currentPage,
  onPageChange,
  offlineUrls,
}: {
  images: GalleryImage[];
  currentPage: number;
  onPageChange: (p: number) => void;
  /** When provided, use these blob URLs instead of fetching from the network. */
  offlineUrls?: string[];
}) {
  const [ggConfig, setGgConfig] = useState<GgConfig | null>(null);
  const imageFormat = useSettingsStore((s) => s.imageFormat);
  const dualPage = useSettingsStore((s) => s.dualPage);
  const step = dualPage ? 2 : 1;

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // Keep latest props in refs so the (once-attached) scroll listener reads
  // current values without re-subscribing on every page change.
  const currentPageRef = useRef(currentPage);
  const onPageChangeRef = useRef(onPageChange);
  useEffect(() => { currentPageRef.current = currentPage; });
  useEffect(() => { onPageChangeRef.current = onPageChange; });

  // True while WE drive the scroll (button / key / tap / prop change) so the
  // scroll listener doesn't echo a redundant onPageChange back.
  const programmaticRef = useRef(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const animatorRef = useRef<ReturnType<typeof createScrollAnimator> | null>(null);
  if (!animatorRef.current) animatorRef.current = createScrollAnimator(SCROLL_DURATION_MS);
  const didInitRef = useRef(false);
  const dragRef = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    // Skip the gg.js network fetch when all images are served from local storage.
    if (offlineUrls) return;
    getGgConfig().then(setGgConfig);
  }, [offlineUrls]);

  const urls = useMemo(() => {
    if (offlineUrls) return offlineUrls;
    if (!ggConfig) return [];
    return images.map((img) => getBestImageUrl(galleryImageToFile(img), ggConfig, imageFormat));
  }, [offlineUrls, images, ggConfig, imageFormat]);

  const hasUrls = urls.length > 0;
  const slideCount = Math.ceil(images.length / step);

  // Measure the scroll container so every slide is exactly one viewport wide.
  // Uniform exact sizes make the virtualized scroll-snap land precisely.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasUrls]);

  const estimateSize = useCallback(
    () => width || (typeof window !== 'undefined' ? window.innerWidth : 0),
    [width],
  );

  const virtualizer = useVirtualizer({
    count: slideCount,
    horizontal: true,
    getScrollElement: () => scrollerRef.current,
    estimateSize,
    overscan: 2,
  });

  // Re-measure virtual items when the viewport width changes.
  useEffect(() => {
    if (width) virtualizer.measure();
  }, [width, virtualizer]);

  // Warm nearby pages through the same platform-aware image loader used by
  // AbortableImage. This matters on Capacitor: a raw JS Image() cannot attach
  // the bypass headers, so Android would skip preloading and then visibly wait
  // on every page turn.
  useEffect(() => {
    if (!urls.length) return;
    // Skip JS-Image preloading for offline (blob) URLs — they are already in
    // memory so there is nothing to warm and no network request to abort.
    if (offlineUrls) return;
    const end = Math.min(urls.length - 1, currentPage + PRELOAD_AHEAD);
    const start = Math.max(0, currentPage - PRELOAD_BEHIND);
    const skip = new Set(dualPage ? [currentPage, currentPage + 1] : [currentPage]);

    // Warm nearest-first, forward-biased (readers move forward): +1, +2, …
    // ahead, then -1, -2, … behind. Order matters because we cap concurrency.
    const queue: string[] = [];
    for (let i = currentPage + 1; i <= end; i++) if (!skip.has(i)) queue.push(urls[i]);
    for (let i = currentPage - 1; i >= start; i--) if (!skip.has(i)) queue.push(urls[i]);

    // Cap in-flight warming requests. The visible page's <img> shares the CDN's
    // small connection pool; firing all ~20 preloads at once let low-priority
    // warming starve the page the user is actually looking at (stuck "loading
    // forever"). MAX_PRELOAD leaves slots free for the high-priority visible
    // image. No timeout — slow syncs are allowed to finish.
    const MAX_PRELOAD = 4;
    // Abort warms for the page we leave: stalled CDN requests otherwise hold the
    // per-host connection slots forever, permanently starving the next visible
    // page into "loading". Aborting on navigation frees those slots at once.
    const controller = new AbortController();
    let cancelled = false;
    let active = 0;
    let next = 0;
    const pump = () => {
      while (!cancelled && active < MAX_PRELOAD && next < queue.length) {
        const url = queue[next++];
        active += 1;
        preloadImageSource(url, controller.signal)
          .catch(() => {
            // Best-effort warming only (aborted or failed). Visible image load
            // owns user-facing errors.
          })
          .finally(() => {
            active -= 1;
            if (!cancelled) pump();
          });
      }
    };
    pump();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [urls, currentPage, dualPage, offlineUrls]);

  // Sync the snapped page back to the parent (native scroll → currentPage).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const w = el.clientWidth;
        if (programmaticRef.current || !w) return;
        const page = Math.round(el.scrollLeft / w) * step;
        if (page !== currentPageRef.current && page >= 0 && page < images.length) {
          onPageChangeRef.current(page);
        }
      });
    };
    const onScrollEnd = () => { programmaticRef.current = false; };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('scrollend', onScrollEnd);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scrollend', onScrollEnd);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [step, images.length, hasUrls]);

  // Custom eased page-turn tween. Replaces the browser's native smooth scroll so
  // we control speed (~2× faster) and easing (ease-out, fast→slow). CSS
  // scroll-snap is turned off for the duration so `mandatory` snapping doesn't
  // jump straight to the target and skip the easing.
  const animateScrollTo = useCallback((el: HTMLDivElement, to: number) => {
    animatorRef.current!.to(el, to, () => {
      programmaticRef.current = false;
    });
  }, []);

  // Drive the scroll when the logical page changes from outside (buttons, arrow
  // keys, tap zones, jump modal).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !width) return;
    const targetSlide = Math.floor(currentPage / step);
    const currentSlide = Math.round(el.scrollLeft / width);
    if (currentSlide === targetSlide) return;
    programmaticRef.current = true;
    clearTimeout(programmaticTimerRef.current);
    if (didInitRef.current) {
      animateScrollTo(el, targetSlide * width);
    } else {
      // First positioning (scroll restoration): jump instantly, no animation.
      el.scrollLeft = targetSlide * width;
      programmaticRef.current = false;
    }
    didInitRef.current = true;
    // Safety net: clear the programmatic flag even if the tween is interrupted.
    programmaticTimerRef.current = setTimeout(() => { programmaticRef.current = false; }, 600);
  }, [currentPage, width, step, animateScrollTo]);

  useEffect(() => () => {
    clearTimeout(programmaticTimerRef.current);
    animatorRef.current?.cancel();
  }, []);

  const navigate = useCallback((target: number) => {
    if (target < 0 || target >= images.length || target === currentPageRef.current) return;
    onPageChangeRef.current(target);
  }, [images.length]);

  // Desktop mouse drag-to-pan: native scroll-snap responds to touch/trackpad but
  // not a click-drag, so add a minimal handler (no physics) that snaps on release.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const el = scrollerRef.current;
    if (!el) return;
    dragRef.current = { x: e.clientX, left: el.scrollLeft, moved: false };
    el.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = scrollerRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 3) d.moved = true;
    el.scrollLeft = d.left - dx;
  };
  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = scrollerRef.current;
    dragRef.current = null;
    if (!d || !el) return;
    el.releasePointerCapture?.(e.pointerId);
    if (d.moved && width) {
      suppressClickRef.current = true;
      programmaticRef.current = true;
      animateScrollTo(el, Math.round(el.scrollLeft / width) * width);
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX - rect.left > rect.width / 2) navigate(currentPage + step);
    else navigate(currentPage - step);
  };

  if (!hasUrls) return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-white/80" />
    </div>
  );

  // The slide the reader is currently parked on. Its image gets fetchPriority
  // "high" so it wins CDN connection slots over the low-priority preloads of
  // surrounding pages — otherwise the visible page can queue behind warming
  // requests and appear stuck "loading forever".
  const currentSlide = Math.floor(currentPage / step);

  const renderSlide = (slideIndex: number) => {
    const pageIdx = slideIndex * step;
    const secondIdx = dualPage ? pageIdx + 1 : -1;
    const hasSecond = dualPage && secondIdx < images.length;
    const priority = slideIndex === currentSlide ? 'high' : undefined;
    return (
      <div className={dualPage ? 'flex items-center justify-center gap-1' : ''}>
        <AbortableImage
          src={urls[pageIdx]}
          alt={`Page ${pageIdx + 1}`}
          draggable={false}
          loading="eager"
          spinner
          fetchPriority={priority}
          // On <sm we drop max-h so the image fills the viewport width
          // (portrait phones + portrait manga → no big black bands). The slide
          // scrolls vertically if the image is taller than the viewport.
          className={`pointer-events-none select-none object-contain ${
            dualPage ? 'max-h-screen max-w-[50vw]' : 'max-w-full sm:max-h-screen'
          }`}
        />
        {hasSecond && (
          <AbortableImage
            src={urls[secondIdx]}
            alt={`Page ${secondIdx + 1}`}
            draggable={false}
            loading="eager"
            spinner
            fetchPriority={priority}
            className="pointer-events-none max-h-screen max-w-[50vw] select-none object-contain"
          />
        )}
      </div>
    );
  };

  return (
    <div
      ref={scrollerRef}
      className="scrollbar-hide group relative h-screen w-screen cursor-pointer overflow-x-auto overflow-y-hidden"
      style={{ scrollSnapType: 'x mandatory' }}
      onClick={handleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      {/* Virtualized track — only a small window of viewport-wide, snap-aligned
          slides is mounted; the spacer width keeps scrollLeft mapped to pages. */}
      <div style={{ width: virtualizer.getTotalSize(), height: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => (
          <div
            key={vi.key}
            data-slide-index={vi.index}
            className="scrollbar-hide absolute top-0 flex h-full items-center justify-center overflow-y-auto"
            style={{
              left: 0,
              width: vi.size,
              transform: `translateX(${vi.start}px)`,
              scrollSnapAlign: 'start',
              // Force the scroll to stop at every page: without this a fast
              // flick's momentum skips past several snap points and jumps
              // multiple pages at once. `always` snaps exactly one page per swipe.
              scrollSnapStop: 'always',
            }}
          >
            {renderSlide(vi.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
