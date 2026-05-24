import { Suspense } from 'react';
import { Spinner } from '@/shared/components/Spinner';
import { GalleryDetailFromQuery } from '@/features/gallery-detail/components/GalleryDetailFromQuery';

export default function StaticGalleryDetailPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Spinner size="md" /></div>}>
      <GalleryDetailFromQuery />
    </Suspense>
  );
}
