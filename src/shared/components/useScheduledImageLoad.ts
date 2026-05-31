import { useCallback, useEffect, useRef, useState } from 'react';
import { imageLoadScheduler, STUCK_MS } from '@/shared/utils/imageLoadScheduler';

/**
 * Gate an image's network load through the viewport-first {@link imageLoadScheduler}.
 *
 * When `shouldSchedule` is false (cached / eager / preload / explicit-high /
 * native-fetch path), this is a no-op: `granted` is always true. Otherwise the
 * image waits for a scheduler slot before emitting its `src`, so the overflow
 * during fast scroll loads in viewport order instead of FIFO.
 *
 * Robustness: the slot lifecycle is keyed on `loadKey` (not on `granted`, which
 * would release the slot the instant it is granted). It releases exactly once on
 * settle/unmount, never leaks on the acquire-vs-unmount race, and a fallback
 * timer force-grants after STUCK_MS so a scheduler stall can never leave an
 * image permanently blank.
 */
export function useScheduledImageLoad(params: {
  shouldSchedule: boolean;
  wantsToLoad: boolean;
  loadKey: string | null;
  imgRef: React.RefObject<HTMLImageElement | null>;
}): { granted: boolean; onSettled: (ok: boolean) => void } {
  const { shouldSchedule, wantsToLoad, loadKey, imgRef } = params;
  const [granted, setGranted] = useState(false);
  const releaseRef = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    if (!shouldSchedule || !wantsToLoad || !loadKey) return;

    let cancelled = false;
    let held = false;
    let releasedScheduler = false;
    let startedAt = 0;

    const priority = () => {
      const el = imgRef.current;
      if (!el) return Number.POSITIVE_INFINITY;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (r.bottom >= 0 && r.top <= vh) return 0; // on screen — load next
      return r.top < 0 ? -r.top : r.top - vh; // distance from the viewport
    };

    const releaseScheduler = (ok: boolean) => {
      if (!held || releasedScheduler) return;
      releasedScheduler = true;
      imageLoadScheduler.release({ ok, ms: performance.now() - startedAt });
    };

    const handle = imageLoadScheduler.acquire(priority);
    let stuckTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const onGrant = () => {
      held = true; // the scheduler has counted this slot as active
      if (cancelled) {
        releaseScheduler(false); // unmounted during the grant — free it
        return;
      }
      startedAt = performance.now();
      releaseRef.current = releaseScheduler;
      setGranted(true);
      // Safety: a granted load that never settles must not pin the slot forever.
      stuckTimer = setTimeout(() => releaseScheduler(false), STUCK_MS);
    };

    if (handle.immediate) {
      // A slot was free — grant synchronously (no microtask delay), preserving
      // the immediate paint for the common, unsaturated case.
      onGrant();
    } else {
      handle.granted.then(onGrant);
      // Safety net: never let a scheduler stall leave the image blank. Give up
      // the queued slot and load unthrottled if we have waited too long.
      fallbackTimer = setTimeout(() => {
        if (cancelled || held) return;
        handle.cancel();
        setGranted(true);
      }, STUCK_MS);
    }

    return () => {
      cancelled = true;
      handle.cancel(); // drop out of the queue if still waiting (no-op once granted)
      releaseScheduler(false); // free the slot if granted but not yet settled
      clearTimeout(stuckTimer);
      clearTimeout(fallbackTimer);
      releaseRef.current = null;
      setGranted(false);
    };
    // Keyed on the load attempt, NOT on `granted` — including `granted` would
    // re-run this effect (and release the slot) the moment it is granted.
  }, [shouldSchedule, wantsToLoad, loadKey, imgRef]);

  const onSettled = useCallback((ok: boolean) => {
    releaseRef.current?.(ok);
    releaseRef.current = null;
  }, []);

  return { granted: !shouldSchedule || granted, onSettled };
}
