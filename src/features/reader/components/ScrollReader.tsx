'use client';

import { useEffect, useRef, useState, useMemo, type RefCallback, type RefObject } from 'react';
import type { GalleryImage, GgConfig } from '@/lib/utils/types';
import { getBestImageUrl, galleryImageToFile } from '@/lib/utils/image-url';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { getGgConfig } from '@/lib/api/client';
import { useSettingsStore } from '@/lib/store/settings';

export function ScrollReader({
  images,
  initialPage,
  onScrollPositionChange,
  onVisiblePageChange,
  scrollCallbackRef,
  offlineUrls,
}: {
  images: GalleryImage[];
  initialPage?: number;
  onScrollPositionChange: (p: number) => void;
  onVisiblePageChange: (page: number) => void;
  scrollCallbackRef: RefCallback<HTMLDivElement>;
  /** Populated by ReaderView via scrollCallbackRef; ScrollReader itself does not read it. */
  scrollNodeRef?: RefObject<HTMLDivElement | null>;
  /** When provided, use these blob URLs instead of fetching from the network. */
  offlineUrls?: string[];
}) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef(false);
  const [ggConfig, setGgConfig] = useState<GgConfig | null>(null);
  const imageFormat = useSettingsStore((s) => s.imageFormat);

  // Keep the latest onVisiblePageChange in a ref so the IntersectionObserver
  // effect (which intentionally omits it from deps) always calls the current
  // callback. Assigned in an effect, not during render (react-hooks/refs).
  const onVisiblePageChangeRef = useRef(onVisiblePageChange);
  useEffect(() => {
    onVisiblePageChangeRef.current = onVisiblePageChange;
  });

  const setRef = (node: HTMLDivElement | null) => {
    localRef.current = node;
    scrollCallbackRef(node);
  };

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

  // Auto-scroll to initial page
  useEffect(() => {
    if (!urls.length || !localRef.current || scrolledRef.current || !initialPage || initialPage <= 0) return;
    const targetEl = localRef.current.querySelector(`[data-page-index="${initialPage}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'instant' });
      scrolledRef.current = true;
    }
  }, [urls.length, initialPage]);

  useEffect(() => {
    const el = localRef.current;
    if (!el) return;
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => { onScrollPositionChange(el.scrollTop); ticking = false; });
        ticking = true;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [onScrollPositionChange]);

  // Track most-visible page via IntersectionObserver
  useEffect(() => {
    const container = localRef.current;
    if (!container || !urls.length) return;
    const pages = container.querySelectorAll<HTMLElement>('[data-page-index]');
    if (!pages.length) return;

    const ratioMap = new Map<number, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
          ratioMap.set(idx, entry.intersectionRatio);
        }
        let bestIdx = -1;
        let bestRatio = 0;
        for (const [idx, ratio] of ratioMap) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIdx = idx;
          }
        }
        if (bestIdx >= 0) {
          onVisiblePageChangeRef.current(bestIdx);
        }
      },
      { root: container, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    pages.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [urls.length]);

  const scrollWidth = useSettingsStore((s) => s.scrollWidth);

  if (!urls.length) return null;

  // 100% base = 56/1.15 ≈ 48.7rem, so that 115% ≈ 56rem (original max-w-4xl).
  // 0 = Full (no constraint).
  const BASE_REM = 56 / 1.15;
  const innerStyle: React.CSSProperties = scrollWidth === 0
    ? {}
    : { maxWidth: `${BASE_REM * scrollWidth / 100}rem` };

  return (
    <div ref={setRef} className="h-screen overflow-y-auto">
      <div className="mx-auto" style={innerStyle}>
        {images.map((img, i) => (
          <div key={`${img.hash}-${i}`} data-page-index={i}>
            <AbortableImage src={urls[i]} alt={`Page ${i + 1}`} className="w-full select-none" loading="lazy" draggable={false} style={{ aspectRatio: `${img.width} / ${img.height}` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
