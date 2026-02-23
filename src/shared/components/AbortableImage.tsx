'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface AbortableImageProps {
  src: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  style?: React.CSSProperties;
  draggable?: boolean;
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
export function AbortableImage({ src, alt, className, loading = 'lazy', style, draggable }: AbortableImageProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const mountedRef = useRef(true);
  const loadedRef = useRef(false);
  const [visible, setVisible] = useState(loading === 'eager');

  // Reset loaded state when src changes
  useEffect(() => {
    loadedRef.current = false;
  }, [src]);

  // Track whether the image has completed loading
  const handleLoad = useCallback(() => {
    loadedRef.current = true;
  }, []);

  // IntersectionObserver: set visible when entering viewport, clear when leaving (if not loaded)
  useEffect(() => {
    if (loading === 'eager') return;
    const img = imgRef.current;
    if (!img) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
        } else if (!loadedRef.current) {
          // Image left viewport before finishing — abort the request
          setVisible(false);
        }
      },
      { rootMargin: '200px' }, // start loading slightly before entering viewport
    );

    observer.observe(img);
    return () => observer.disconnect();
  }, [loading]);

  // Abort on unmount (same as before)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const img = imgRef.current;
      if (img) {
        setTimeout(() => {
          if (!mountedRef.current) {
            img.src = '';
          }
        }, 0);
      }
    };
  }, []);

  return (
    <img
      ref={imgRef}
      src={visible ? src : undefined}
      alt={alt}
      className={className}
      loading={loading === 'eager' ? 'eager' : undefined}
      style={style}
      draggable={draggable}
      onLoad={handleLoad}
    />
  );
}
