'use client';

import { GalleryIdListPage } from '@/shared/components/GalleryIdListPage';
import { getFavoriteIds } from '@/lib/db/gallery';
import { useT } from '@/lib/i18n/useT';

export default function FavoritesPage() {
  const t = useT();
  return <GalleryIdListPage fetchIds={getFavoriteIds} title={t('favorites.title')} emptyMessage={t('favorites.empty')} queryKey="favorites-pages" />;
}
