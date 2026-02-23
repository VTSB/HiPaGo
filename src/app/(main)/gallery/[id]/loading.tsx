import { Spinner } from '@/shared/components/Spinner';

export default function Loading() {
  return (
    <div className="flex justify-center py-12">
      <Spinner size="md" />
    </div>
  );
}
