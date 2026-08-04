'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getGgConfig } from '@/lib/api/client';
import { useSettingsStore } from '@/lib/store/settings';
import { galleryImageToFile, getBestImageUrl } from '@/lib/utils/image-url';
import type { GalleryImage, GgConfig } from '@/lib/utils/types';
import type { OfflineImageSource } from './useOfflineImages';

interface ReaderImageSourcesOptions {
  images: GalleryImage[];
  offlineUrls?: string[];
  offlineSources?: OfflineImageSource[];
}

/** Resolves reader URLs and turns gg.js failures into a retryable state. */
export function useReaderImageSources({
  images,
  offlineUrls,
  offlineSources,
}: ReaderImageSourcesOptions) {
  const imageFormat = useSettingsStore((state) => state.imageFormat);
  const [ggConfig, setGgConfig] = useState<GgConfig | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const normalizedOfflineSources = useMemo<OfflineImageSource[] | undefined>(() => {
    if (offlineSources) return offlineSources;
    return offlineUrls?.map((url, index) => ({ index, ext: '', url }));
  }, [offlineSources, offlineUrls]);
  const isOffline = normalizedOfflineSources !== undefined;

  const retry = useCallback(() => {
    setError(null);
    setGgConfig(null);
    setRetryToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (isOffline || ggConfig) return;
    let cancelled = false;
    getGgConfig().then(
      (config) => {
        if (!cancelled) {
          setError(null);
          setGgConfig(config);
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason : new Error(String(reason)));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ggConfig, isOffline, retryToken]);

  useEffect(() => {
    if (!error || isOffline) return;
    window.addEventListener('online', retry, { once: true });
    return () => window.removeEventListener('online', retry);
  }, [error, isOffline, retry]);

  const urls = useMemo(() => {
    if (normalizedOfflineSources) {
      return normalizedOfflineSources.map((source) => source.url ?? `offline:${source.index}`);
    }
    if (!ggConfig) return [];
    return images.map((image) => getBestImageUrl(galleryImageToFile(image), ggConfig, imageFormat));
  }, [normalizedOfflineSources, ggConfig, images, imageFormat]);

  return {
    urls,
    normalizedOfflineSources,
    loading: !isOffline && !ggConfig && !error,
    error,
    retry,
  };
}
