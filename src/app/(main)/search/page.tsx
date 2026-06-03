'use client';

import { Suspense } from 'react';
import { SearchResults } from '@/features/search/components/SearchResults';
import { MobileSearchPage } from '@/features/search/components/MobileSearchPage';
import { Spinner } from '@/shared/components/Spinner';
import { useIsMobile } from '@/shared/hooks/useIsMobile';

export default function SearchPage() {
  // Mobile (<md) gets the full-page inline search experience (top box +
  // inline recent/popular/suggestions, then results). Desktop (>=md) keeps the
  // header SearchBar + Ctrl+K dropdown and just renders the results grid here.
  // useIsMobile is SSR-safe (false until mounted) so only one branch mounts —
  // this avoids the mobile auto-focus effect firing on desktop.
  const isMobile = useIsMobile();

  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Spinner size="sm" className="h-6 w-6" /></div>}>
      {isMobile ? <MobileSearchPage /> : <SearchResults />}
    </Suspense>
  );
}
