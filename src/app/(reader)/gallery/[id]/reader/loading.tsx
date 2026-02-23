import { Spinner } from '@/shared/components/Spinner';

export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black">
      <Spinner size="lg" className="text-white" />
    </div>
  );
}
