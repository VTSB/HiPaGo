import { Suspense } from 'react';
import { Spinner } from '@/shared/components/Spinner';
import { ReaderFromQuery } from '@/features/reader/components/ReaderFromQuery';

export default function StaticReaderPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-black">
          <Spinner size="lg" className="text-white" />
        </div>
      }
    >
      <ReaderFromQuery />
    </Suspense>
  );
}
