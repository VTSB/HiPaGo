import Link from 'next/link';
import { GalleryDetail } from '@/features/gallery-detail/components/GalleryDetail';

export async function generateStaticParams() {
  return [];
}

export default async function GalleryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const galleryId = parseInt(id, 10);
  if (isNaN(galleryId)) {
    return (
      <>
        <p className="text-red-500">Invalid gallery ID</p>
        <Link href="/" className="text-sm text-blue-500 underline">Back</Link>
      </>
    );
  }
  return <GalleryDetail id={galleryId} />;
}
