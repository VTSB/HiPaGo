import { Spinner } from '@/shared/components/Spinner';

export default function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-black">
      <Spinner size="lg" className="text-white" />
    </div>
  );
}
