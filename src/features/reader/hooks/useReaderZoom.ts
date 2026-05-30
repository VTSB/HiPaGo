'use client';

import { useEffect } from 'react';
import { setReaderZoom } from '@/lib/plugins/readerZoom';

/**
 * Enables native WebView pinch-zoom while the reader is mounted and disables it
 * on unmount, so zoom is available in the reader ONLY — list/settings/etc. stay
 * non-zoomable. Android-only under the hood (see setReaderZoom); a harmless
 * no-op elsewhere.
 */
export function useReaderZoom(): void {
  useEffect(() => {
    setReaderZoom(true);
    return () => {
      setReaderZoom(false);
    };
  }, []);
}
