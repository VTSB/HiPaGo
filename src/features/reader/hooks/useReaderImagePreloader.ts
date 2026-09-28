'use client';

import { useEffect } from 'react';
import { preloadImageSource } from '@/shared/components/AbortableImage';

/** Shared by paged and continuous readers; never mount hidden decoded pages. */
export function useReaderImagePreloader(
  urls: string[], currentPage: number, visibleCount = 1, offline = false,
) {
  useEffect(() => {
    if (offline || !urls.length) return;
    const controller = new AbortController();
    const queue: Array<{ url: string; distance: number }> = [];
    const current = Math.max(0, Math.min(currentPage, urls.length - 1));
    const lastVisible = Math.min(urls.length - 1, current + visibleCount - 1);
    for (let distance = 1; distance <= 15; distance++) {
      const next = lastVisible + distance;
      const previous = current - distance;
      if (next < urls.length && next <= current + 15) queue.push({ url: urls[next], distance });
      if (distance <= 5 && previous >= 0) queue.push({ url: urls[previous], distance });
    }
    let active = 0;
    let cursor = 0;
    const pump = () => {
      while (!controller.signal.aborted && active < 4 && cursor < queue.length) {
        const { url, distance } = queue[cursor++];
        active++;
        void preloadImageSource(url, controller.signal, () => distance)
          .catch(() => { /* Visible image owns errors; warming is best effort. */ })
          .finally(() => { active--; pump(); });
      }
    };
    pump();
    return () => controller.abort();
  }, [urls, currentPage, visibleCount, offline]);
}
