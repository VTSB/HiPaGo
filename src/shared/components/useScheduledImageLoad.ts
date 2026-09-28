import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { imageLoadScheduler, imageViewportDistance, STUCK_MS } from '@/shared/utils/imageLoadScheduler';

/** Own one browser attempt from actual src assignment through settle/cancel. */
export function useScheduledImageLoad(params: {
  shouldSchedule: boolean;
  wantsToLoad: boolean;
  loadKey: string | null;
  imgRef: React.RefObject<HTMLImageElement | null>;
  background?: boolean;
  onTimeout?: () => void;
}): { granted: boolean; onSettled: (ok: boolean) => void } {
  const { shouldSchedule, wantsToLoad, loadKey, imgRef, background = false } = params;
  const activeKey = shouldSchedule && wantsToLoad ? loadKey : null;
  const [previousKey, setPreviousKey] = useState(activeKey);
  const [grantedKey, setGrantedKey] = useState<string | null>(null);
  if (previousKey !== activeKey) {
    setPreviousKey(activeKey);
    setGrantedKey(null);
  }
  const backgroundRef = useRef(background);
  useEffect(() => {
    backgroundRef.current = background;
    imageLoadScheduler.refresh();
  }, [background]);
  const releaseRef = useRef<((ok: boolean) => void) | null>(null);
  const markStartedRef = useRef<(() => void) | null>(null);
  const timeoutRef = useRef(params.onTimeout);
  useEffect(() => { timeoutRef.current = params.onTimeout; });

  useEffect(() => {
    if (!shouldSchedule || !wantsToLoad || !loadKey) return;
    let cancelled = false;
    let held = false;
    let settled = false;
    let startedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handle = imageLoadScheduler.acquire(
      () => imageViewportDistance(imgRef.current),
      { background: () => backgroundRef.current, awaitStart: true },
    );
    const imageElement = imgRef.current;
    const clearSource = () => {
      // React clears the ref before passive unmount cleanup; retain this attempt's element.
      if (imageElement?.getAttribute('src') === loadKey) imageElement.removeAttribute('src');
    };
    const settle = (ok: boolean) => {
      if (!held || settled) return;
      settled = true;
      clearTimeout(timer);
      handle.release({ ok, ms: performance.now() - startedAt });
    };
    handle.granted.then(() => {
      held = true;
      if (cancelled) { handle.release(); return; }
      startedAt = performance.now();
      releaseRef.current = settle;
      markStartedRef.current = handle.markStarted;
      setGrantedKey(loadKey);
      timer = setTimeout(() => {
        // Stop the real browser attempt BEFORE making its capacity available.
        clearSource();
        settle(false);
        setGrantedKey(null);
        timeoutRef.current?.();
      }, STUCK_MS);
    });
    return () => {
      cancelled = true;
      handle.cancel();
      clearTimeout(timer);
      if (held && !settled) {
        clearSource();
        handle.release(); // navigation/src replacement is not network congestion
      }
      if (releaseRef.current === settle) releaseRef.current = null;
      if (markStartedRef.current === handle.markStarted) markStartedRef.current = null;
    };
  }, [shouldSchedule, wantsToLoad, loadKey, imgRef]);

  useLayoutEffect(() => {
    if (shouldSchedule && wantsToLoad && loadKey && grantedKey === loadKey) {
      markStartedRef.current?.();
    }
  }, [shouldSchedule, wantsToLoad, loadKey, grantedKey]);

  const onSettled = useCallback((ok: boolean) => {
    releaseRef.current?.(ok);
    releaseRef.current = null;
  }, []);
  return { granted: !shouldSchedule || (wantsToLoad && grantedKey === loadKey), onSettled };
}
