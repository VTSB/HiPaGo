'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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

// Carousel slide animation. Commit is timer-driven (not transitionend) so it is
// deterministic in tests and can never get stuck if a transitionend is missed.
const SLIDE_MS = 300;
const SLIDE_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

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

  const containerRef = useRef<HTMLDivElement | null>(null);
  // `base` is the page currently centered in the track; it follows `currentPage`
  // through an animation rather than jumping. `offset` is the live drag offset
  // (px) layered on top of the resting translateX(-100vw). `trackedPage` lets us
  // detect logical-page changes during render.
  const [base, setBase] = useState(currentPage);
  const [offset, setOffset] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [trackedPage, setTrackedPage] = useState(currentPage);

  const dragRef = useRef<{ x: number; y: number; id: number; lock: null | 'h' | 'v' } | null>(null);
  const activePointersRef = useRef<Set<number>>(new Set());
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

  // Single animation driver: whenever the logical page (prop) diverges from the
  // centered `base`, slide toward it. Adjacent → animate (commit lands on the
  // timer below); a far jump (page-jump modal) snaps instantly. Every navigation
  // source (drag-commit, buttons, ←/→ keys, tap zones) flows through here.
  //
  // This runs during render — React's endorsed "adjust state when a prop
  // changes" pattern — so the slide begins in the same commit as the prop change
  // (no extra paint, and no set-state-in-effect).
  if (currentPage !== trackedPage) {
    setTrackedPage(currentPage);
    const diff = currentPage - base;
    if (Math.abs(diff) === step) {
      // Full-screen reader: viewport width == the track cell width. Avoid
      // reading containerRef here (refs are off-limits during render).
      const w = typeof window !== 'undefined' ? window.innerWidth : 0;
      setAnimating(true);
      setOffset(diff > 0 ? -w : w);
    } else {
      setBase(currentPage);
      setOffset(0);
      setAnimating(false);
    }
  }

  // End the slide on a duration-matched timer (deterministic; survives a missed
  // transitionend). A snap-back — `animating` set in pointerup with no page
  // change — also lands here, where `setBase(currentPage)` is a no-op.
  useEffect(() => {
    if (!animating) return;
    const t = setTimeout(() => {
      setBase(currentPage);
      setOffset(0);
      setAnimating(false);
    }, SLIDE_MS);
    return () => clearTimeout(t);
  }, [animating, currentPage]);

  const navigate = useCallback((target: number) => {
    if (target < 0 || target >= images.length || target === currentPage) return;
    onPageChange(target);
  }, [images.length, currentPage, onPageChange]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX - rect.left > rect.width / 2) navigate(currentPage + step);
    else navigate(currentPage - step);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return;
    activePointersRef.current.add(e.pointerId);
    // A second concurrent finger means the user is pinching, not swiping.
    if (activePointersRef.current.size > 1) {
      dragRef.current = null;
      return;
    }
    // Cancel any in-flight slide so the finger grabs the track immediately.
    setAnimating(false);
    dragRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId, lock: null };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.lock === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      // Horizontal-dominant → drive the carousel; otherwise let the browser
      // scroll a tall page vertically (touch-action: pan-y) and abandon the swipe.
      if (Math.abs(dx) > Math.abs(dy)) {
        d.lock = 'h';
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } else {
        d.lock = 'v';
        dragRef.current = null;
        return;
      }
    }
    if (d.lock !== 'h') return;
    e.preventDefault();
    // Edge damping: nothing to reveal past the first/last page.
    let next = dx;
    if ((dx > 0 && currentPage - step < 0) || (dx < 0 && currentPage + step >= images.length)) {
      next = dx * 0.3;
    }
    setOffset(next);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(e.pointerId);
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const w = containerRef.current?.clientWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
    const threshold = Math.max(48, w * 0.15);
    const horizontal = Math.abs(dx) >= threshold && Math.abs(dx) >= Math.abs(dy) * 1.4;

    if (horizontal) {
      const target = dx < 0 ? currentPage + step : currentPage - step;
      if (target >= 0 && target < images.length) {
        suppressClickRef.current = true;
        // Keep the live offset; the currentPage-prop effect animates it home.
        navigate(target);
        return;
      }
    }
    // Sub-threshold (or edge): animate the peeked page back to rest. The timer
    // effect (keyed on `animating`) ends the transition.
    if (offset !== 0) {
      setAnimating(true);
      setOffset(0);
    }
  };

  if (!urls.length) return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-white/80" />
    </div>
  );

  // Three cells: previous, current, next (relative to the visually-centered
  // `base`). Keying each cell by its page index lets React keep an already-
  // loaded neighbour's <img> as it becomes the centre — no reload/flash.
  const cells = [-step, 0, step].map((rel) => base + rel);

  const renderCell = (pageIdx: number, rel: number) => {
    const valid = pageIdx >= 0 && pageIdx < images.length;
    const secondIdx = dualPage ? pageIdx + 1 : -1;
    const hasSecond = dualPage && secondIdx < images.length;
    return (
      <div
        key={valid ? `pg-${pageIdx}` : `empty-${rel}`}
        className="flex h-screen w-screen shrink-0 items-center justify-center overflow-y-auto"
      >
        {valid && (
          <div className={dualPage ? 'flex items-center justify-center gap-1' : ''}>
            <AbortableImage
              src={urls[pageIdx]}
              alt={`Page ${pageIdx + 1}`}
              draggable={false}
              loading="eager"
              // On <sm we drop max-h so the image fills the viewport width
              // (portrait phones + portrait manga → no big black bands). The
              // cell scrolls vertically if the image is taller than the viewport.
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
        )}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className="group relative h-screen w-screen cursor-pointer overflow-hidden"
      style={{ touchAction: 'pan-y pinch-zoom' }}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={(e) => {
        activePointersRef.current.delete(e.pointerId);
        dragRef.current = null;
      }}
    >
      {/* Sliding track — three viewport-wide cells, centre shown at -100vw. */}
      <div
        className="flex h-full"
        style={{
          transform: `translateX(calc(-100vw + ${offset}px))`,
          transition: animating ? `transform ${SLIDE_MS}ms ${SLIDE_EASE}` : 'none',
        }}
      >
        {cells.map((pageIdx, i) => renderCell(pageIdx, [-step, 0, step][i]))}
      </div>

      {/* Navigation affordance arrows (desktop hover). */}
      {currentPage > 0 && (
        <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-30">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-10 w-10 text-white drop-shadow-lg">
            <path fillRule="evenodd" d="M7.72 12.53a.75.75 0 010-1.06l7.5-7.5a.75.75 0 111.06 1.06L9.31 12l6.97 6.97a.75.75 0 11-1.06 1.06l-7.5-7.5z" clipRule="evenodd" />
          </svg>
        </div>
      )}
      {currentPage + step < images.length && (
        <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-30">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-10 w-10 text-white drop-shadow-lg">
            <path fillRule="evenodd" d="M16.28 11.47a.75.75 0 010 1.06l-7.5 7.5a.75.75 0 01-1.06-1.06L14.69 12 7.72 5.03a.75.75 0 011.06-1.06l7.5 7.5z" clipRule="evenodd" />
          </svg>
        </div>
      )}
    </div>
  );
}
