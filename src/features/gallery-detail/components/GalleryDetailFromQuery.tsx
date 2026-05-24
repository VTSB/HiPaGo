'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { GalleryDetail } from './GalleryDetail';

export function GalleryDetailFromQuery() {
  const searchParams = useSearchParams();
  const id = Number.parseInt(searchParams.get('id') ?? '', 10);

  if (!Number.isFinite(id)) {
    return (
      <div className="space-y-3 py-12 text-center">
        <p className="text-red-500">Invalid gallery ID</p>
        <Link href="/" className="text-sm text-blue-500 underline">Back</Link>
      </div>
    );
  }

  return <GalleryDetail id={id} />;
}
