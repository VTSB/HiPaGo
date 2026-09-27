'use client';

import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/lib/store/settings';

const COLS_BY_SETTINGS: Record<number, [number, number, number, number]> = {
  2: [2, 2, 2, 2],
  3: [2, 3, 3, 3],
  4: [2, 3, 4, 4],
  5: [2, 3, 4, 5],
  6: [2, 4, 5, 6],
  7: [2, 4, 6, 7],
};

function computeGridColumns(settingsCols: number, width: number): number {
  const columns = COLS_BY_SETTINGS[settingsCols || 5] ?? [2, 3, 4, 5];
  return width >= 1024 ? columns[3] : width >= 768 ? columns[2] : width >= 640 ? columns[1] : columns[0];
}

/** Match GalleryGrid's responsive columns before the first client paint, so
 * settling the layout does not overwrite native back-scroll restoration. */
export function useGalleryColumns(): number {
  const settingsCols = useSettingsStore((s) => s.gridColumns);
  const [columns, setColumns] = useState(() =>
    typeof window === 'undefined' ? 5 : computeGridColumns(settingsCols, window.innerWidth),
  );

  useEffect(() => {
    const compute = () => setColumns(computeGridColumns(settingsCols, window.innerWidth));
    compute();
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        compute();
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(frame);
    };
  }, [settingsCols]);

  return columns;
}
