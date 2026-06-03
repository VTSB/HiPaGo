import { Suspense } from 'react';
import { SearchResults } from '@/features/search/components/SearchResults';
import { SearchBar } from '@/features/search/components/SearchBar';
import { Spinner } from '@/shared/components/Spinner';

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Spinner size="sm" className="h-6 w-6" /></div>}>
      {/* Mobile search entry — desktop uses the header SearchBar. Auto-focuses
          on mount so tapping the Search tab drops straight into typing. */}
      <div className="mb-4 md:hidden">
        <SearchBar autoFocus />
      </div>
      <SearchResults />
    </Suspense>
  );
}
