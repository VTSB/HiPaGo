'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

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
 */
export function AbortableImage({ src, alt, className, loading = 'lazy', style, draggable, onPermanentError, preload = false }: AbortableImageProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const mountedRef = useRef(true);
  const loadedRef = useRef(false);
  const retryCountRef = useRef(0);
  const [visible, setVisible] = useState(loading === 'eager' || preload);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const onPermanentErrorRef = useRef(onPermanentError);
  onPermanentErrorRef.current = onPermanentError;

  // Reset loaded/retry/visible state when src changes
  // Resetting visible forces the IntersectionObserver to re-fire,
  // which fixes stuck-invisible images when virtual scroll reuses a DOM slot.
  useEffect(() => {
    loadedRef.current = false;
    retryCountRef.current = 0;
    setLoaded(false);
    setFailed(false);
    if (loading !== 'eager' && !preload) setVisible(false);
  }, [src, loading, preload]);

  // Track whether the image has completed loading
  const handleLoad = useCallback(() => {
    loadedRef.current = true;
    retryCountRef.current = 0;
    setLoaded(true);
  }, []);

  // Retry on error (up to 3 times with exponential backoff).
  // Fast consecutive errors (< 2s apart) indicate a permanent failure (404/gone)
  // and are not retried to avoid wasting bandwidth.
  const lastErrorTimeRef = useRef(0);
  const handleError = useCallback(() => {
    if (loadedRef.current) return;
    if (retryCountRef.current >= 3) {
      setFailed(true);
      onPermanentErrorRef.current?.();
      return;
    }
    const now = Date.now();
    if (retryCountRef.current > 0 && now - lastErrorTimeRef.current < 2000) {
      // Two fast failures in a row → likely 404, stop retrying
      setFailed(true);
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
  }, []);

  // IntersectionObserver: set visible when entering viewport, clear when leaving (if not loaded)
  useEffect(() => {
    if (loading === 'eager' || preload) return;
    const img = imgRef.current;
    if (!img) return;

    // Sync check: if already near viewport, set visible immediately to avoid 1-frame flash
    // for preloaded/cached images in virtual scroll
    const rect = img.getBoundingClientRect();
    const margin = 400;
    if (
      rect.bottom >= -margin &&
      rect.top <= (window.innerHeight || document.documentElement.clientHeight) + margin
    ) {
      setVisible(true);
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
        } else if (!loadedRef.current) {
          // Image left viewport before finishing — abort the request
          setVisible(false);
        }
      },
      { rootMargin: '400px' }, // start loading slightly before entering viewport
    );

    observer.observe(img);
    return () => observer.disconnect();
  }, [loading, src, preload]);

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
      <img
        ref={imgRef}
        src={visible ? src : undefined}
        alt=""
        data-preload="true"
        fetchPriority="low"
        style={{ position: 'absolute', visibility: 'hidden', width: 0, height: 0, pointerEvents: 'none' }}
        onLoad={handleLoad}
        onError={handleError}
      />
    );
  }

  return (
    <img
      ref={imgRef}
      src={visible ? src : undefined}
      alt={alt}
      className={className}
      loading={loading === 'eager' ? 'eager' : undefined}
      style={{ ...style, opacity: loaded ? undefined : 0 }}
      draggable={draggable}
      onLoad={handleLoad}
      onError={handleError}
    />
  );
}
