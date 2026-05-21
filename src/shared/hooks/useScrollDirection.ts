'use client';

import { useEffect, useRef, useState } from 'react';

export type ScrollDirection = 'up' | 'down' | 'idle';

/**
 * Tracks vertical scroll direction with a debounce. Returns 'idle' after
 * scrolling stops for `idleMs`; flips between 'up'/'down' only after
 * scrolling past `threshold` so micro-jitter does not toggle state.
 */
export function useScrollDirection(threshold = 10, idleMs = 150): ScrollDirection {
  const [dir, setDir] = useState<ScrollDirection>('idle');
  const lastYRef = useRef(0);
  const idleTimerRef = useRef<number>(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    lastYRef.current = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - lastYRef.current;
      if (Math.abs(delta) >= threshold) {
        setDir(delta > 0 ? 'down' : 'up');
        lastYRef.current = y;
      }
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => setDir('idle'), idleMs);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.clearTimeout(idleTimerRef.current);
    };
  }, [threshold, idleMs]);

  return dir;
}
