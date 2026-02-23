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

  if (!urls.length) return null;

  return (
    <div className="flex min-h-screen cursor-pointer items-center justify-center" onClick={(e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (e.clientX - rect.left > rect.width / 2) {
        if (currentPage < images.length - 1) onPageChange(currentPage + 1);
      } else {
        if (currentPage > 0) onPageChange(currentPage - 1);
      }
    }}>
      {Array.from({ length: end - start + 1 }, (_, i) => {
        const idx = start + i;
        const isCurrent = idx === currentPage;
        return (
          <img
            key={idx}
            src={urls[idx]}
            alt={isCurrent ? `Page ${idx + 1}` : ''}
            draggable={false}
            className="pointer-events-none max-h-screen max-w-full select-none object-contain"
            style={isCurrent ? undefined : { display: 'none' }}
          />
        );
      })}
    </div>
  );
}
