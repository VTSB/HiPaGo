'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Returns `true` when a floating bottom navigation should be hidden because
 * the user has scrolled down past the threshold. Restoration requires an
 * explicit upward scroll gesture (>= `deltaPx`) — idle / scroll-stop does
 * NOT auto-restore. Near the top of the page (`scrollY < topThreshold`)
 * the pill always stays visible.
 *
 * This matches iOS Safari URL-bar behavior. An earlier implementation
 * restored the pill after a 150 ms scroll-stop, which flickered during
 * momentum-scroll deceleration: the page was still scrolling but velocity
 * dropped below the direction-flip threshold, the hook flipped to 'idle',
 * the pill briefly returned, then momentum resumed and the pill hid again.
 */
export function useHideOnScroll(
  topThreshold = 80,
  deltaPx = 8,
): boolean {
  const [hidden, setHidden] = useState(false);
  const lastYRef = useRef(0);
  const hiddenRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    lastYRef.current = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y < topThreshold) {
        if (hiddenRef.current) {
          hiddenRef.current = false;
          setHidden(false);
        }
        lastYRef.current = y;
        return;
      }
      const delta = y - lastYRef.current;
      if (delta > deltaPx) {
        if (!hiddenRef.current) {
          hiddenRef.current = true;
          setHidden(true);
        }
        lastYRef.current = y;
      } else if (delta < -deltaPx) {
        if (hiddenRef.current) {
          hiddenRef.current = false;
          setHidden(false);
        }
        lastYRef.current = y;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [topThreshold, deltaPx]);

  return hidden;
}
