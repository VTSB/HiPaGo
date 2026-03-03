'use client';

import { useState, useEffect, useMemo } from 'react';
import type { GalleryImage, GgConfig } from '@/lib/utils/types';
import { getBestImageUrl, galleryImageToFile } from '@/lib/utils/image-url';
import { getGgConfig } from '@/lib/api/client';
import { useSettingsStore } from '@/lib/store/settings';

const PRELOAD_AHEAD = 10;

export function PageReader({ images, currentPage, onPageChange }: { images: GalleryImage[]; currentPage: number; onPageChange: (p: number) => void }) {
  const [ggConfig, setGgConfig] = useState<GgConfig | null>(null);
  const imageFormat = useSettingsStore((s) => s.imageFormat);
  const dualPage = useSettingsStore((s) => s.dualPage);

  useEffect(() => {
    getGgConfig().then(setGgConfig);
  }, []);

  const urls = useMemo(() => {
    if (!ggConfig) return [];
    return images.map((img) => getBestImageUrl(galleryImageToFile(img), ggConfig, imageFormat));
  }, [images, ggConfig, imageFormat]);

  // Range of pages to keep in DOM
  const start = Math.max(0, currentPage - PRELOAD_AHEAD);
  const end = Math.min(urls.length - 1, currentPage + PRELOAD_AHEAD);

  // Preload adjacent pages
  useEffect(() => {
    if (!urls.length) return;
    const preloaded: HTMLImageElement[] = [];
    for (let idx = start; idx <= end; idx++) {
      if (idx === currentPage || !urls[idx]) continue;
      const img = new Image();
      img.src = urls[idx];
      preloaded.push(img);
    }
    return () => {
      for (const img of preloaded) {
        img.src = '';
      }
    };
  }, [urls, currentPage, start, end]);

  if (!urls.length) return null;

  const step = dualPage ? 2 : 1;
  const secondPage = dualPage ? currentPage + 1 : -1;
  const hasSecond = dualPage && secondPage < images.length;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX - rect.left > rect.width / 2) {
      const next = currentPage + step;
      if (next < images.length) onPageChange(next);
    } else {
      const prev = currentPage - step;
      if (prev >= 0) onPageChange(prev);
    }
  };

  return (
    <div className="group relative flex min-h-screen cursor-pointer items-center justify-center" onClick={handleClick}>
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
      {/* Pages */}
      <div className={dualPage ? 'flex items-center justify-center gap-1' : ''}>
        <img
          key={currentPage}
          src={urls[currentPage]}
          alt={`Page ${currentPage + 1}`}
          draggable={false}
          className={`pointer-events-none select-none object-contain ${dualPage ? 'max-h-screen max-w-[50vw]' : 'max-h-screen max-w-full'}`}
        />
        {hasSecond && (
          <img
            key={secondPage}
            src={urls[secondPage]}
            alt={`Page ${secondPage + 1}`}
            draggable={false}
            className="pointer-events-none max-h-screen max-w-[50vw] select-none object-contain"
          />
        )}
      </div>
    </div>
  );
}
