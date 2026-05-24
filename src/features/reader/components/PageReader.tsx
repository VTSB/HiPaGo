'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
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
  const pointerStartRef = useRef<{ x: number; y: number; id: number } | null>(null);
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

  if (!urls.length) return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-white/80" />
    </div>
  );

  const step = dualPage ? 2 : 1;
  const secondPage = dualPage ? currentPage + 1 : -1;
  const hasSecond = dualPage && secondPage < images.length;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX - rect.left > rect.width / 2) {
      const next = currentPage + step;
      if (next < images.length) onPageChange(next);
    } else {
      const prev = currentPage - step;
      if (prev >= 0) onPageChange(prev);
    }
  };
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return;
    pointerStartRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || start.id !== e.pointerId) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4) return;

    suppressClickRef.current = true;
    if (dx < 0) {
      const next = currentPage + step;
      if (next < images.length) onPageChange(next);
    } else {
      const prev = currentPage - step;
      if (prev >= 0) onPageChange(prev);
    }
  };

  return (
    <div
      className="group relative flex min-h-screen cursor-pointer items-center justify-center"
      style={{ touchAction: 'pan-y' }}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { pointerStartRef.current = null; }}
    >
      {/* Navigation affordance arrows */}
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
      {/* Pages — stable keys so React reuses the same <img> element across
          page changes. Keying by `currentPage` creates a fresh element on
          every nav, so rapid prev/next leaves dead elements (each pinning a
          decoded bitmap) churning faster than the browser can GC them and
          the same URL gets re-decoded into a new bitmap slot every revisit
          instead of hitting the image cache — that's the real OOM source. */}
      <div className={dualPage ? 'flex items-center justify-center gap-1' : ''}>
        <AbortableImage
          key="primary"
          src={urls[currentPage]}
          alt={`Page ${currentPage + 1}`}
          draggable={false}
          loading="eager"
          // On <sm we drop max-h so the image fills the viewport width
          // (portrait phones + portrait manga → no big black bands above
          // and below). The page scrolls vertically if the image is taller
          // than the viewport; tap zones still work because they use
          // clientX relative to the image rect, not the viewport.
          className={`pointer-events-none select-none object-contain ${
            dualPage
              ? 'max-h-screen max-w-[50vw]'
              : 'max-w-full sm:max-h-screen'
          }`}
        />
        {hasSecond && (
          <AbortableImage
            key="secondary"
            src={urls[secondPage]}
            alt={`Page ${secondPage + 1}`}
            draggable={false}
            loading="eager"
            className="pointer-events-none max-h-screen max-w-[50vw] select-none object-contain"
          />
        )}
      </div>
    </div>
  );
}
