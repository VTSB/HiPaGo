'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchGalleryInfo } from '@/lib/api/gallery';
import { galleryInfoToBlock, galleryInfoToImages } from '@/lib/api/parser';

export function useGalleryDetail(id: number) {
  const infoQuery = useQuery({
    queryKey: ['gallery-info', id],
    queryFn: () => fetchGalleryInfo(id),
    enabled: id > 0,
  });

  const block = useMemo(
    () => (infoQuery.data ? galleryInfoToBlock(infoQuery.data) : null),
    [infoQuery.data],
  );
  const images = useMemo(
    () => (infoQuery.data ? galleryInfoToImages(infoQuery.data) : null),
    [infoQuery.data],
  );

  return {
    block,
    images,
    info: infoQuery.data ?? null,
    isLoading: infoQuery.isLoading,
    error: infoQuery.error,
  };
}
