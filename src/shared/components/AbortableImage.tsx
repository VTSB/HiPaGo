'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { isAndroid, isCapacitor, isTauri } from '@/lib/utils/platform';
import { getImageCache } from '@/lib/cache/image-cache';
import { useScheduledImageLoad } from './useScheduledImageLoad';
import { Spinner } from '@/shared/components/Spinner';

interface AbortableImageProps {
  src: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  style?: React.CSSProperties;
  draggable?: boolean;
  /** Called when all retries are exhausted — image permanently failed to load */
  onPermanentError?: () => void;
  /**
   * When true, loads the image immediately (like eager) but renders it hidden
   * so it warms the browser cache without affecting layout or competing with
   * visible page loads (fetchPriority="low").
   */
  preload?: boolean;
  /**
   * When true, renders a centered loading spinner (absolutely positioned in the
   * nearest positioned ancestor) while the image is visible but not yet loaded
   * and not failed. Off by default so grid/card call-sites are unchanged.
   */
  spinner?: boolean;
  /**
   * Maps to the native <img fetchpriority> attribute. The reader passes "high"
   * for the currently visible page so it is not starved by lower-priority
   * preload requests sharing the CDN connection pool.
   */
  fetchPriority?: 'high' | 'low' | 'auto';
}

const CDN_HOST_SUFFIX = '.gold-usergeneratedcontent.net';
const loadedSrcCache = new Set<string>();
// Cache file URLs (convertFileSrc) resolved this session, keyed by the original
// CDN src — lets a re-mount paint from disk instantly without re-checking.
const resolvedFileUrlCache = new Map<string, string>();
// srcs already warmed into the persistent cache (Android background warm dedupe).
const warmedSrcCache = new Set<string>();

/**
 * Whether this platform must serve a CDN image from the persistent cache file
 * (it cannot display the CDN URL directly): iOS + Tauri load CDN images through
 * the bypass, which now streams to a cache file served via convertFileSrc.
 * Android uses the WebView interceptor (plain <img src> works) and web loads the
 * CDN directly, so for them the cache is an optional accelerator, not required.
 */
function mustServeFromCache(src: string): boolean {
  if (isAndroid()) return false;
  if (!isTauri() && !isCapacitor()) return false;
  try {
    const url = new URL(src);
    return url.protocol === 'https:' && url.hostname.endsWith(CDN_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/** Whether a CDN src is eligible for the persistent cache at all (any platform). */
function isCacheableCdn(src: string): boolean {
  try {
    const url = new URL(src);
    return url.protocol === 'https:' && url.hostname.endsWith(CDN_HOST_SUFFIX);
  } catch {
    return false;
  }
}

function getImageHeaders(): Record<string, string> {
  return {
    Referer: 'https://hitomi.la/',
    Origin: 'https://hitomi.la',
    Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
  };
}

/** Cache-hit lookup: a disk file URL for `src`, or null on a miss. Never downloads. */
async function cacheFileUrl(src: string): Promise<string | null> {
  const mem = resolvedFileUrlCache.get(src);
  if (mem) return mem;
  try {
    const cache = await getImageCache();
    const url = await cache.fileUrl(src);
    if (url) resolvedFileUrlCache.set(src, url);
    return url;
  } catch {
    return null;
  }
}

/**
 * Ensure `src` is in the persistent cache (native streaming download on a miss)
 * and return its disk file URL, or null on failure. Used to SERVE on the
 * bypass-served platforms and to background-WARM on Android.
 */
async function ensureCachedFileUrl(src: string): Promise<string | null> {
  try {
    const cache = await getImageCache();
    const url = await cache.ensureCached(src, src, getImageHeaders());
    if (url) {
      resolvedFileUrlCache.set(src, url);
      loadedSrcCache.add(src);
    }
    return url;
  } catch {
    return null;
  }
}

export function preloadImageSource(src: string, signal?: AbortSignal): Promise<void> {
  if (loadedSrcCache.has(src)) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  if (mustServeFromCache(src)) {
    // The native streaming download isn't backed by the browser connection pool,
    // so a hard cancel isn't needed for slot-starvation; just short-circuit the
    // JS waiter when navigation aborts so the caller's queue can advance.
    const run = ensureCachedFileUrl(src).then(() => undefined);
    if (!signal) return run;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      run
        .then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        })
        .catch((err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        });
    });
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.fetchPriority = 'low';
    const detach = () => {
      img.onload = null;
      img.onerror = null;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      // Clearing src aborts the in-flight HTTP request and frees the per-host
      // connection slot — without this, warm requests stalled by the throttling
      // CDN pin every slot and the visible page never loads.
      img.src = '';
      detach();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    img.onload = () => {
      loadedSrcCache.add(src);
      detach();
      resolve();
    };
    img.onerror = () => {
      detach();
      reject(new Error(`preload failed: ${src}`));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    img.src = src;
  });
}

/**
 * Drop the in-memory image-display memos (resolved `convertFileSrc` URLs,
 * loaded-src set, Android warm dedupe). MUST be called whenever the persistent
 * cache is cleared: otherwise these memos keep serving file URLs that point at
 * now-deleted cache files, and every image list comes back blank after a clear
 * (the resolve effect short-circuits on the seeded stale URL and never
 * re-downloads). After a reset the next mount re-resolves from the (empty)
 * cache and re-downloads / falls back to the plain CDN source.
 */
export function resetImageDisplayCaches() {
  loadedSrcCache.clear();
  resolvedFileUrlCache.clear();
  warmedSrcCache.clear();
}

export function __resetAbortableImageCacheForTests() {
  resetImageDisplayCaches();
}

/**
 * Image that prioritises viewport-visible loads and cancels off-screen requests.
 *
 * - Uses IntersectionObserver instead of native `loading="lazy"` so that
 *   images leaving the viewport *before* they finish loading get their `src`
 *   cleared, freeing up browser connection slots for images the user can
 *   actually see.
 * - Once an image has fully loaded it is never cleared (even if scrolled away).
 * - `loading="eager"` bypasses the observer and loads immediately.
 * - Serves from the persistent, file-backed LRU cache: a cache hit is streamed
 *   from disk via a file URL (no image bytes in the JS heap, works offline).
 *   Shared by reader, gallery-detail, and gallery-list/library — they all get
 *   caching for free through this one component.
 */
export function AbortableImage({ src, alt, className, loading = 'lazy', style, draggable, onPermanentError, preload = false, spinner = false, fetchPriority }: AbortableImageProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const mountedRef = useRef(true);
  // Seed from the cache: a src the browser already has is "loaded", so it is
  // never treated as an abortable in-flight request on re-mount.
  const loadedRef = useRef(loadedSrcCache.has(src));
  const retryCountRef = useRef(0);
  const fromCache = mustServeFromCache(src);
  // The resolved cache file URL for this src (convertFileSrc), if any. Seeded
  // synchronously from the in-memory map so a re-mount paints from disk instantly.
  const [cacheUrlState, setCacheUrlState] = useState<{ src: string; url: string } | null>(() => {
    const url = resolvedFileUrlCache.get(src);
    return url ? { src, url } : null;
  });
  const cacheUrl = cacheUrlState?.src === src ? cacheUrlState.url : null;
  // Bypass-served platforms MUST have a cache file URL to display (no plain-src
  // fallback). Others display the plain src, but a cache-hit file URL takes
  // precedence (instant + offline).
  const effectiveSrc = fromCache ? cacheUrl : (cacheUrl ?? src);
  // When the URL is already in loadedSrcCache, treat it as authoritative: the
  // browser has the bytes and the <img> can paint synchronously. Without this,
  // a re-mount (e.g. list ↔ detail navigation) makes every cached card wait
  // for the deferred rAF + IntersectionObserver round-trip — measured ~500ms
  // with 35+ cards mounting in one commit behind the virtualizer's two-pass
  // layout. The observer still attaches below; it's only the *initial* gate
  // that gets the fast path.
  const [visible, setVisible] = useState(
    loading === 'eager' || preload || loadedSrcCache.has(src),
  );
  const [loaded, setLoaded] = useState(() => loadedSrcCache.has(src));
  const [failed, setFailed] = useState(false);
  // Set when this src is a non-bypass cache miss: the plain <img src> displays
  // as today and its bytes are warmed into the cache once it has loaded.
  const shouldWarmRef = useRef(false);

  // Order the network <img> load through the viewport-first scheduler. Skip it
  // for cached / eager / preload / explicit-high / bypass-served images, which
  // must never be queued behind the grid.
  const shouldSchedule =
    !fromCache &&
    loading !== 'eager' &&
    !preload &&
    fetchPriority !== 'high' &&
    !loadedSrcCache.has(src);
  const { granted, onSettled } = useScheduledImageLoad({
    shouldSchedule,
    wantsToLoad: visible && !!effectiveSrc,
    loadKey: shouldSchedule ? effectiveSrc : null,
    imgRef,
  });

  // Keep the latest onPermanentError in a ref so callbacks always call the
  // current version without re-subscribing effects (react-hooks/refs).
  const onPermanentErrorRef = useRef(onPermanentError);
  useEffect(() => {
    onPermanentErrorRef.current = onPermanentError;
  });

  // Resolve the display source from the file-backed cache. Runs once per src; the
  // top guard short-circuits when a file URL is already in hand (seeded).
  useEffect(() => {
    if (cacheUrlState?.src === src) return;
    let cancelled = false;
    shouldWarmRef.current = false;
    (async () => {
      if (fromCache) {
        // iOS/Tauri: the WebView can only show the CDN image from a local file,
        // so serve from the cache (streaming download on a miss).
        const url = await ensureCachedFileUrl(src);
        if (cancelled) return;
        if (url) setCacheUrlState({ src, url });
        else {
          setFailed(true);
          onPermanentErrorRef.current?.();
        }
        return;
      }
      // Android/web: serve from disk if already cached (offline + instant); else
      // keep the plain <img src> and warm in the background after it displays.
      if (isCacheableCdn(src)) {
        const url = await cacheFileUrl(src);
        if (cancelled) return;
        if (url && !loadedRef.current) {
          setCacheUrlState({ src, url });
          return;
        }
        shouldWarmRef.current = true;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fromCache, src, cacheUrlState]);

  // Reset state when src/loading/preload changes using render-phase setState
  // (the React-documented derived-state pattern — react-hooks/set-state-in-effect safe).
  // Resetting visible forces the IntersectionObserver to re-fire,
  // which fixes stuck-invisible images when virtual scroll reuses a DOM slot.
  const [prevSrc, setPrevSrc] = useState(effectiveSrc);
  const [prevLoading, setPrevLoading] = useState(loading);
  const [prevPreload, setPrevPreload] = useState(preload);
  if (effectiveSrc !== prevSrc || loading !== prevLoading || preload !== prevPreload) {
    setPrevSrc(effectiveSrc);
    setPrevLoading(loading);
    setPrevPreload(preload);
    setLoaded(loadedSrcCache.has(src));
    setFailed(false);
    // Same cache-hit fast path as the initial useState: if the new URL is
    // already cached, keep visible=true so the <img> emits its src on the
    // first commit instead of waiting for the observer round-trip.
    if (loading !== 'eager' && !preload && !loadedSrcCache.has(src)) setVisible(false);
  }

  // Reset the internal tracking refs when src/loading/preload changes.
  // Done in a separate effect (not during render) to satisfy react-hooks/refs.
  useEffect(() => {
    loadedRef.current = loadedSrcCache.has(src);
    retryCountRef.current = 0;
  }, [effectiveSrc, loading, preload, src]);

  // Track whether the image has completed loading
  const handleLoad = useCallback(() => {
    loadedRef.current = true;
    retryCountRef.current = 0;
    loadedSrcCache.add(src);
    if (effectiveSrc) loadedSrcCache.add(effectiveSrc);
    setLoaded(true);
    onSettled(true);
    // Warm the persistent cache from a displayed Android image (the interceptor
    // never exposes the bytes to JS, so re-fetch them natively into the cache
    // file once shown). Only when showing the plain src, not already warmed, and
    // only where a native download exists (Android; not web).
    if (
      shouldWarmRef.current &&
      effectiveSrc === src &&
      !warmedSrcCache.has(src) &&
      (isCapacitor() || isTauri())
    ) {
      warmedSrcCache.add(src);
      void (async () => {
        const cache = await getImageCache().catch(() => null);
        if (!cache || cache.getMaxBytes() === 0) return; // caching off → skip warm
        await ensureCachedFileUrl(src);
      })();
    }
  }, [effectiveSrc, src, onSettled]);

  // Retry on error (up to 3 times with exponential backoff).
  // Fast consecutive errors (< 2s apart) indicate a permanent failure (404/gone)
  // and are not retried to avoid wasting bandwidth.
  const lastErrorTimeRef = useRef(0);
  const handleError = useCallback(() => {
    if (loadedRef.current) return;
    if (retryCountRef.current >= 3) {
      setFailed(true);
      onSettled(false);
      onPermanentErrorRef.current?.();
      return;
    }
    const now = Date.now();
    if (retryCountRef.current > 0 && now - lastErrorTimeRef.current < 2000) {
      // Two fast failures in a row → likely 404, stop retrying
      setFailed(true);
      onSettled(false);
      onPermanentErrorRef.current?.();
      return;
    }
    lastErrorTimeRef.current = now;
    retryCountRef.current += 1;
    const delay = Math.min(1000 * 2 ** (retryCountRef.current - 1), 10000);
    setTimeout(() => {
      const img = imgRef.current;
      if (img && mountedRef.current && !loadedRef.current) {
        const cur = img.src;
        img.src = '';
        img.src = cur;
      }
    }, delay);
  }, [onSettled]);

  // IntersectionObserver: set visible when entering viewport, clear when leaving (if not loaded).
  // The sync viewport check (already-in-view on mount) is deferred via requestAnimationFrame
  // to avoid calling setState synchronously in an effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (loading === 'eager' || preload) return;
    const img = imgRef.current;
    if (!img) return;

    // Async viewport check: if already near viewport, set visible on next frame
    // to avoid a 1-frame flash for preloaded/cached images in virtual scroll.
    // Using rAF keeps the setState out of the synchronous effect body.
    const rafId = requestAnimationFrame(() => {
      const rect = img.getBoundingClientRect();
      const margin = 400;
      if (
        rect.bottom >= -margin &&
        rect.top <= (window.innerHeight || document.documentElement.clientHeight) + margin
      ) {
        setVisible(true);
      }
    });

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
        }
        // Deliberately NO abort-on-leave: clearing src for a not-yet-loaded
        // image raced load-completion and left images permanently blank when
        // many cards toggled at once (non-virtualized related grid, list
        // re-mount, fast scroll). Off-screen virtualized rows are unmounted by
        // their virtualizer, which already cancels those in-flight requests, so
        // dropping src here bought almost nothing and cost correctness.
      },
      { rootMargin: '400px' }, // start loading slightly before entering viewport
    );

    observer.observe(img);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [loading, effectiveSrc, preload]);

  // Track mount state for retry safety
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  if (failed) {
    if (preload) return null;
    return (
      <div className={className} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-zinc-800, #27272a)' }}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style={{ width: 32, height: 32, color: 'var(--color-zinc-500, #71717a)' }}>
          <path fillRule="evenodd" d="M1.5 6a2.25 2.25 0 012.25-2.25h16.5A2.25 2.25 0 0122.5 6v12a2.25 2.25 0 01-2.25 2.25H3.75A2.25 2.25 0 011.5 18V6zM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0021 18v-1.94l-2.69-2.689a1.5 1.5 0 00-2.12 0l-.88.879.97.97a.75.75 0 11-1.06 1.06l-5.16-5.159a1.5 1.5 0 00-2.12 0L3 16.061zm10.125-7.81a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0z" clipRule="evenodd" />
        </svg>
      </div>
    );
  }

  if (preload) {
    return (
      // Custom abortable-fetch image; next/image cannot host the abort logic.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={imgRef}
        src={visible && granted ? effectiveSrc ?? undefined : undefined}
        alt=""
        data-preload="true"
        fetchPriority="low"
        style={{ position: 'absolute', visibility: 'hidden', width: 0, height: 0, pointerEvents: 'none' }}
        onLoad={handleLoad}
        onError={handleError}
      />
    );
  }

  // Spinner is shown while the image is meant to be on screen (visible) but the
  // browser hasn't painted it yet. `failed` is already handled above, so here
  // it only ever covers the genuine loading window.
  const showSpinner = spinner && visible && !loaded;
  return (
    <>
      {showSpinner && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          aria-hidden="true"
        >
          <Spinner size="md" />
        </div>
      )}
      {/* Custom abortable-fetch image; next/image cannot host the abort logic. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={visible && granted ? effectiveSrc ?? undefined : undefined}
        alt={alt}
        className={className}
        loading={loading === 'eager' ? 'eager' : undefined}
        fetchPriority={fetchPriority}
        style={{ ...style, opacity: loaded ? undefined : 0 }}
        draggable={draggable}
        onLoad={handleLoad}
        onError={handleError}
      />
    </>
  );
}
