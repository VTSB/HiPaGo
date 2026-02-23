import { Suspense } from 'react';
import { SearchResults } from '@/features/search/components/SearchResults';
import { Spinner } from '@/shared/components/Spinner';

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Spinner size="sm" className="h-6 w-6" /></div>}>
      <SearchResults />
    </Suspense>
  );
}
