'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { GalleryImage, GgConfig } from '@/lib/utils/types';
import { getBestImageUrl, galleryImageToFile } from '@/lib/utils/image-url';
import { getGgConfig } from '@/lib/api/client';
import { useSettingsStore } from '@/lib/store/settings';
import { AbortableImage, preloadImageSource } from '@/shared/components/AbortableImage';

// High-res manga pages can be 10–20 MB decoded each. Hidden preload <img>
// tags still get decoded by the browser, so a large mounted window pins
// hundreds of MB of bitmap memory and OOMs during rapid prev/next mashing.
// We keep the window small and asymmetric (readers mostly move forward)
// and warm the cache via JS Image() objects whose decoded bitmaps are
// released the moment the user navigates again.
const PRELOAD_AHEAD = 15;
const PRELOAD_BEHIND = 5;
// Page-turn slide duration (ms). The turn animates the track's `transform`
// (compositor thread) instead of `scrollLeft` (main thread), so it's smooth and
// never churns the virtualizer mid-animation — ~half the browser's native
// smooth-scroll for a snappier flip. Tune here.
const PAGE_TURN_MS = 150;
const PAGE_TURN_EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

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
  // The virtualized track (spacer) whose `transform` we animate for a page turn.
  const trackRef = useRef<HTMLDivElement | null>(null);
  // In-flight transform slide, so a rapid second turn can land the first instantly.
  const slideAnimRef = useRef<{ to: number; onEnd: () => void; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [width, setWidth] = useState(0);
  // Mirror `width` so the once-attached scroll listener reads the current value
  // (and the SAME value the slides are sized with) without re-subscribing.
  const widthRef = useRef(0);
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
  const didInitRef = useRef(false);
  // Held while the first programmatic positioning (open-at-page / restoration)
  // is still settling, so onScrollEnd does not release the echo suppression at
  // an intermediate scroll position.
  const initPendingRef = useRef(false);
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
    // Round the fractional measured width UP so each slide is at least as wide
    // as the clip viewport. On fractional-DPR screens the compositor rounds the
    // slide edge and the clip edge independently; if a slide is even a fraction
    // narrower than the viewport, a 1-3 device-px strip of the next page leaks
    // at the edge. Ceil keeps it an integer (crisp) and guarantees full cover;
    // on DPR 1 the value is already integer, so desktop is unchanged.
    const update = () => {
      const w = Math.ceil(el.getBoundingClientRect().width);
      widthRef.current = w;
      setWidth(w);
    };
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
        const w = widthRef.current;
        if (programmaticRef.current || !w) return;
        const page = Math.round(el.scrollLeft / w) * step;
        if (page !== currentPageRef.current && page >= 0 && page < images.length) {
          onPageChangeRef.current(page);
        }
      });
    };
    const onScrollEnd = () => {
      if (initPendingRef.current) return;
      // A native page-turn scroll has settled — restore snap (disabled during the
      // turn) and release the echo suppression.
      el.style.scrollSnapType = 'x mandatory';
      programmaticRef.current = false;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('scrollend', onScrollEnd);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('scrollend', onScrollEnd);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [step, images.length, hasUrls]);

  // Page turn. Drive the scroll natively (`scrollTo` smooth) so the motion runs
  // on the compositor thread, exactly like a swipe. A main-thread rAF tween that
  // wrote `scrollLeft` every frame stuttered on device: each frame's write moved
  // the virtualizer window, forcing a slide mount/unmount + React re-render on
  // the same main thread that was drawing the scroll. Snap is turned off for the
  // duration (the target is an exact page boundary, so it lands without snap)
  // and restored on `scrollend` / the settle timer so swipes keep snapping.
  // Land any in-flight transform slide immediately (commit its scroll position
  // and clear the transform) — used before starting a new turn on rapid taps.
  const finishSlide = useCallback((el: HTMLDivElement, track: HTMLDivElement) => {
    const anim = slideAnimRef.current;
    if (!anim) return;
    track.removeEventListener('transitionend', anim.onEnd);
    clearTimeout(anim.timer);
    slideAnimRef.current = null;
    track.style.transition = 'none';
    track.style.transform = '';
    el.scrollLeft = anim.to;
    el.style.scrollSnapType = 'x mandatory';
    programmaticRef.current = false;
  }, []);

  // Page turn. Animate the track's `transform` on the COMPOSITOR (smooth, off the
  // main thread) and keep `scrollLeft` fixed during the motion, so the virtualizer
  // never re-renders mid-turn (the per-frame `scrollLeft` write was what made a JS
  // tween stutter). At the end we commit in one frame: clear the transform and set
  // `scrollLeft` to the target — net-zero visual change, one virtualizer update.
  // A jump beyond the mounted overscan window (target not rendered → would slide
  // to blank) falls back to the browser's native smooth scroll.
  const animateScrollTo = useCallback((el: HTMLDivElement, to: number) => {
    const track = trackRef.current;
    const w = widthRef.current || 1;
    finishSlide(el, track ?? el);
    const from = el.scrollLeft;
    const delta = to - from;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const commit = () => {
      if (track) {
        track.style.transition = 'none';
        track.style.transform = '';
      }
      el.scrollLeft = to;
      el.style.scrollSnapType = 'x mandatory';
      programmaticRef.current = false;
    };

    if (Math.abs(delta) < 1) { commit(); return; }
    // Target outside the mounted window (overscan 2) — can't slide to an unmounted
    // slide. Use the native smooth scroll; onScrollEnd restores snap.
    if (!track || reduce || Math.abs(delta) > 2 * w + 1) {
      el.style.scrollSnapType = 'none';
      el.scrollTo({ left: to, behavior: reduce ? 'auto' : 'smooth' });
      return;
    }

    el.style.scrollSnapType = 'none';
    // Start showing `from` (translateX 0), animate to showing `to` (translateX -delta).
    track.style.transition = 'none';
    track.style.transform = 'translateX(0px)';
    void track.offsetWidth; // reflow so the transition starts from 0
    track.style.transition = `transform ${PAGE_TURN_MS}ms ${PAGE_TURN_EASING}`;
    track.style.transform = `translateX(${-delta}px)`;

    const onEnd = () => {
      const anim = slideAnimRef.current;
      if (!anim) return;
      track.removeEventListener('transitionend', anim.onEnd);
      clearTimeout(anim.timer);
      slideAnimRef.current = null;
      commit();
    };
    // Safety net in case `transitionend` is missed (interrupted compositor commit).
    const timer = setTimeout(onEnd, PAGE_TURN_MS + 80);
    slideAnimRef.current = { to, onEnd, timer };
    track.addEventListener('transitionend', onEnd);
  }, [finishSlide]);

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
      // First positioning (open-at-page / scroll restoration). Two device-only
      // failures have to be defeated here:
      //  1. The scroll listener echoing the settled position back as currentPage
      //     — held off by keeping programmaticRef set (see initPendingRef) until
      //     the jump settles via the timer below.
      //  2. scroll-snap snap-back: the container is `scroll-snap: x mandatory`,
      //     and the target slide is not rendered yet, so the snap engine snaps
      //     the scroll back to the nearest *rendered* slide (the initial-window
      //     edge, ~page 3) before the virtualizer mounts the target. That left
      //     the indicator on page N but the image stuck on ~page 3. Disable snap
      //     for the jump and restore it once the target has rendered (timer).
      initPendingRef.current = true;
      el.style.scrollSnapType = 'none';
      virtualizer.scrollToIndex(targetSlide, { align: 'start' });
      el.scrollLeft = targetSlide * width;
    }
    didInitRef.current = true;
    // Safety net: restore snap and clear the programmatic/init flags even if the
    // tween or the measure settle is interrupted. By now the virtualizer has
    // mounted the target slide, so restoring `mandatory` snaps onto it (not the
    // stale window edge).
    programmaticTimerRef.current = setTimeout(() => {
      const node = scrollerRef.current;
      if (node) node.style.scrollSnapType = 'x mandatory';
      programmaticRef.current = false;
      initPendingRef.current = false;
    }, 600);
  }, [currentPage, width, step, animateScrollTo, virtualizer]);

  useEffect(() => () => {
    clearTimeout(programmaticTimerRef.current);
    const anim = slideAnimRef.current;
    if (anim) { clearTimeout(anim.timer); slideAnimRef.current = null; }
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
      <div ref={trackRef} style={{ width: virtualizer.getTotalSize(), height: '100%', position: 'relative' }}>
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
