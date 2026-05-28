'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Returns `true` when a floating navigation surface should be hidden because
 * the user has scrolled the page down past the threshold. Restoration
 * requires an explicit upward scroll gesture (>= `deltaPx`) — idle /
 * scroll-stop does NOT auto-restore. Near the top of the scroll source
 * (`scrollTop < topThreshold`) the surface always stays visible.
 *
 * This matches iOS Safari URL-bar behavior. An earlier implementation
 * restored after a 150 ms scroll-stop, which flickered during momentum-scroll
 * deceleration: the page was still scrolling but velocity dropped below the
 * direction-flip threshold, the hook flipped to 'idle', the surface briefly
 * returned, then momentum resumed and it hid again.
 *
 * The optional `scrollElement` parameter swaps the listener target from
 * `window` (default) to a specific element — used by the reader's scroll
 * mode where the scrolling container is an inner `overflow-y-auto` div, not
 * the page itself.
 */
export function useHideOnScroll(
  topThreshold = 80,
  deltaPx = 8,
  disabled = false,
  scrollElement?: HTMLElement | null,
): boolean {
  const [hidden, setHidden] = useState(false);
  const lastYRef = useRef(0);
  const hiddenRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // When the caller passes a scrollElement prop, an explicit null means
    // "the target isn't mounted yet" — bail out and wait for the next render
    // to bring it in. Don't fall back to window in that case.
    if (scrollElement === null) return;
    const target: HTMLElement | Window = scrollElement ?? window;
    const readY = () =>
      scrollElement ? scrollElement.scrollTop : window.scrollY;
    lastYRef.current = readY();
    if (disabled) {
      hiddenRef.current = false;
      const resetTimer = window.setTimeout(() => setHidden(false), 0);
      return () => window.clearTimeout(resetTimer);
    }
    const onScroll = () => {
      const y = readY();
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
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => target.removeEventListener('scroll', onScroll);
  }, [topThreshold, deltaPx, disabled, scrollElement]);

  return disabled ? false : hidden;
}
