'use client';

import { useEffect, useLayoutEffect, useRef, useState, useMemo, type RefCallback, type RefObject } from 'react';
import type { GalleryImage, GgConfig } from '@/lib/utils/types';
import { getBestImageUrl, galleryImageToFile } from '@/lib/utils/image-url';
import { AbortableImage } from '@/shared/components/AbortableImage';
import { getGgConfig } from '@/lib/api/client';
import { useSettingsStore } from '@/lib/store/settings';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

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

  const scrollZoom = useSettingsStore((s) => s.scrollZoom);

  // Desktop zoom + pan. No platform detection — the input type selects behavior:
  //  - Ctrl/⌘ + wheel (also how browsers deliver trackpad pinch) → cursor-
  //    anchored zoom. Plain wheel / two-finger trackpad drag → native scroll.
  //  - Mouse click-drag → hand-tool pan. Double-click → reset to fit.
  // Touch fires none of these, so mobile stays fully native (pinch + scroll).
  const zoomAnchorRef = useRef<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const el = localRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain scroll stays native
      e.preventDefault();
      const { scrollZoom: oldZoom, setScrollZoom } = useSettingsStore.getState();
      const newZoom = clampZoom(oldZoom * Math.exp(-e.deltaY * 0.0015));
      if (newZoom === oldZoom) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const ratio = newZoom / oldZoom;
      // Keep the content point under the cursor fixed across the zoom.
      zoomAnchorRef.current = {
        left: (el.scrollLeft + cx) * ratio - cx,
        top: (el.scrollTop + cy) * ratio - cy,
      };
      setScrollZoom(newZoom);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      dragRef.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      el.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      el.scrollLeft = d.left - (e.clientX - d.x);
      el.scrollTop = d.top - (e.clientY - d.y);
    };
    const endDrag = (e: PointerEvent) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    const onDblClick = () => useSettingsStore.getState().setScrollZoom(1);

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('dblclick', onDblClick);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endDrag);
      el.removeEventListener('pointercancel', endDrag);
      el.removeEventListener('dblclick', onDblClick);
    };
  }, [urls.length]);

  // Apply the cursor-anchored scroll target once the zoom width change reflows.
  useLayoutEffect(() => {
    const el = localRef.current;
    const anchor = zoomAnchorRef.current;
    if (!el || !anchor) return;
    el.scrollLeft = anchor.left;
    el.scrollTop = anchor.top;
    zoomAnchorRef.current = null;
  }, [scrollZoom]);

  if (!urls.length) return null;

  return (
    <div ref={setRef} className="h-screen overflow-auto cursor-grab active:cursor-grabbing">
      <div className="mx-auto" style={{ width: `${scrollZoom * 100}%` }}>
        {images.map((img, i) => (
          <div key={`${img.hash}-${i}`} data-page-index={i}>
            <AbortableImage src={urls[i]} alt={`Page ${i + 1}`} className="w-full select-none" loading="lazy" draggable={false} style={{ aspectRatio: `${img.width} / ${img.height}` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
