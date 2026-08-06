import { ReaderView } from '@/features/reader/components/ReaderView';

export async function generateStaticParams() {
  return [];
}

export default async function ReaderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const { page } = await searchParams;
  const galleryId = parseInt(id, 10);
  if (isNaN(galleryId))
    return (
      <div className="flex min-h-dvh items-center justify-center bg-black text-white">
        Invalid gallery ID
      </div>
    );
  const initialPage = page ? parseInt(page, 10) : undefined;
  return (
    <ReaderView
      galleryId={galleryId}
      initialPage={initialPage && !isNaN(initialPage) ? initialPage : undefined}
    />
  );
}
