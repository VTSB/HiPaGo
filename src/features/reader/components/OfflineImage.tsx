'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/shared/components/Spinner';
import { AbortableImage } from '@/shared/components/AbortableImage';
import type { OfflineImageSource } from '@/features/reader/hooks/useOfflineImages';
import { useT } from '@/lib/i18n/useT';

interface OfflineImageProps {
  source: OfflineImageSource;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  style?: React.CSSProperties;
  draggable?: boolean;
  spinner?: boolean;
  fetchPriority?: 'high' | 'low' | 'auto';
}

const sourceKeys = new WeakMap<OfflineImageSource, string>();
let nextSourceKey = 0;

function getSourceKey(source: OfflineImageSource): string {
  let key = sourceKeys.get(source);
  if (!key) {
    key = `${source.index}:${source.ext}:${++nextSourceKey}`;
    sourceKeys.set(source, key);
  }
  return key;
}

function LocalBlobImage({
  source,
  alt,
  className,
  loading = 'lazy',
  style,
  draggable,
  spinner = false,
  fetchPriority,
}: OfflineImageProps) {
  const t = useT();
  const imgRef = useRef<HTMLImageElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [visible, setVisible] = useState(loading === 'eager');
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (loading === 'eager') return;
    const img = imgRef.current;
    if (!img) return;

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
        if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: '400px' },
    );
    observer.observe(img);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [loading, source]);

  useEffect(() => {
    if (!visible || url || failed) return;
    let cancelled = false;
    source
      .loadUrl?.()
      .then((nextUrl) => {
        if (cancelled) {
          if (nextUrl?.startsWith('blob:')) URL.revokeObjectURL(nextUrl);
          return;
        }
        if (!nextUrl) {
          setFailed(true);
          return;
        }
        objectUrlRef.current = nextUrl.startsWith('blob:') ? nextUrl : null;
        setUrl(nextUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [failed, source, url, visible]);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  const retry = useCallback(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    setUrl(null);
    setLoaded(false);
    setFailed(false);
  }, []);

  if (failed) {
    return (
      <button
        type="button"
        aria-label={`${t('reader.retry')}: ${alt}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          retry();
        }}
        className={className}
        style={{
          ...style,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-zinc-800, #27272a)',
          pointerEvents: 'auto',
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          style={{ width: 32, height: 32, color: 'var(--color-zinc-500, #71717a)' }}
        >
          <path
            fillRule="evenodd"
            d="M1.5 6a2.25 2.25 0 012.25-2.25h16.5A2.25 2.25 0 0122.5 6v12a2.25 2.25 0 01-2.25 2.25H3.75A2.25 2.25 0 011.5 18V6zM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0021 18v-1.94l-2.69-2.689a1.5 1.5 0 00-2.12 0l-.88.879.97.97a.75.75 0 11-1.06 1.06l-5.16-5.159a1.5 1.5 0 00-2.12 0L3 16.061zm10.125-7.81a1.125 1.125 0 112.25 0 1.125 1.125 0 01-2.25 0z"
            clipRule="evenodd"
          />
        </svg>
        <span style={{ color: 'var(--color-zinc-300, #d4d4d8)', fontSize: 14 }}>
          {t('reader.imageLoadFailed')} · {t('reader.retry')}
        </span>
      </button>
    );
  }

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
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={url ?? undefined}
        alt={alt}
        className={className}
        loading={loading === 'eager' ? 'eager' : undefined}
        fetchPriority={fetchPriority}
        style={{ ...style, opacity: loaded ? undefined : 0 }}
        draggable={draggable}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </>
  );
}

export function OfflineImage({ source, ...props }: OfflineImageProps) {
  if (source.url) {
    return <AbortableImage {...props} src={source.url} />;
  }
  return <LocalBlobImage key={getSourceKey(source)} source={source} {...props} />;
}
