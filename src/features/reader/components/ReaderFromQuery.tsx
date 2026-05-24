'use client';

import { useSearchParams } from 'next/navigation';
import { ReaderView } from './ReaderView';

export function ReaderFromQuery() {
  const searchParams = useSearchParams();
  const id = Number.parseInt(searchParams.get('id') ?? '', 10);
  const page = Number.parseInt(searchParams.get('page') ?? '', 10);

  if (!Number.isFinite(id)) {
    return <div className="flex min-h-screen items-center justify-center bg-black text-white">Invalid gallery ID</div>;
  }

  return <ReaderView galleryId={id} initialPage={Number.isFinite(page) ? page : undefined} />;
}
