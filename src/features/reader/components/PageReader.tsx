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
    const start = Math.max(0, currentPage - PRELOAD_BEHIND);
    const end = Math.min(urls.length - 1, currentPage + PRELOAD_AHEAD);
    const skip = new Set(dualPage ? [currentPage, currentPage + 1] : [currentPage]);
    let cancelled = false;
    for (let i = start; i <= end; i++) {
      if (skip.has(i)) continue;
      preloadImageSource(urls[i]).catch(() => {
        if (!cancelled) {
          // Best-effort warming only. Visible image load still owns user-facing errors.
        }
      });
    }
    return () => {
      cancelled = true;
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

  // Drive the scroll when the logical page changes from outside (buttons, arrow
  // keys, tap zones, jump modal). The browser's scroll-snap supplies the motion.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !width) return;
    const targetSlide = Math.floor(currentPage / step);
    const currentSlide = Math.round(el.scrollLeft / width);
    if (currentSlide === targetSlide) return;
    programmaticRef.current = true;
    clearTimeout(programmaticTimerRef.current);
    el.scrollTo({ left: targetSlide * width, behavior: didInitRef.current ? 'smooth' : 'auto' });
    didInitRef.current = true;
    // Fallback in case `scrollend` doesn't fire (e.g. already at target sub-pixel).
    programmaticTimerRef.current = setTimeout(() => { programmaticRef.current = false; }, 600);
  }, [currentPage, width, step]);

  useEffect(() => () => clearTimeout(programmaticTimerRef.current), []);

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
      el.scrollTo({ left: Math.round(el.scrollLeft / width) * width, behavior: 'smooth' });
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

  const renderSlide = (slideIndex: number) => {
    const pageIdx = slideIndex * step;
    const secondIdx = dualPage ? pageIdx + 1 : -1;
    const hasSecond = dualPage && secondIdx < images.length;
    return (
      <div className={dualPage ? 'flex items-center justify-center gap-1' : ''}>
        <AbortableImage
          src={urls[pageIdx]}
          alt={`Page ${pageIdx + 1}`}
          draggable={false}
          loading="eager"
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
            className="pointer-events-none max-h-screen max-w-[50vw] select-none object-contain"
          />
        )}
      </div>
    );
  };

  return (
    <div
      ref={scrollerRef}
      className="group relative h-screen w-screen cursor-pointer overflow-x-auto overflow-y-hidden"
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
            className="absolute top-0 flex h-full items-center justify-center overflow-y-auto"
            style={{
              left: 0,
              width: vi.size,
              transform: `translateX(${vi.start}px)`,
              scrollSnapAlign: 'start',
            }}
          >
            {renderSlide(vi.index)}
          </div>
        ))}
      </div>

      {/* Navigation affordance arrows (desktop hover). */}
      {currentPage > 0 && (
        <div className="pointer-events-none fixed left-4 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-30">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-10 w-10 text-white drop-shadow-lg">
            <path fillRule="evenodd" d="M7.72 12.53a.75.75 0 010-1.06l7.5-7.5a.75.75 0 111.06 1.06L9.31 12l6.97 6.97a.75.75 0 11-1.06 1.06l-7.5-7.5z" clipRule="evenodd" />
          </svg>
        </div>
      )}
      {currentPage + step < images.length && (
        <div className="pointer-events-none fixed right-4 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-30">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-10 w-10 text-white drop-shadow-lg">
            <path fillRule="evenodd" d="M16.28 11.47a.75.75 0 010 1.06l-7.5 7.5a.75.75 0 01-1.06-1.06L14.69 12 7.72 5.03a.75.75 0 011.06-1.06l7.5 7.5z" clipRule="evenodd" />
          </svg>
        </div>
      )}
    </div>
  );
}
