'use client';

import { GalleryIdListPage } from '@/shared/components/GalleryIdListPage';
import { getRecentlyViewedIds } from '@/lib/db/gallery';
import { useT } from '@/lib/i18n/useT';

export default function HistoryPage() {
  const t = useT();
  return <GalleryIdListPage fetchIds={getRecentlyViewedIds} title={t('history.title')} emptyMessage={t('history.empty')} queryKey="history-pages" />;
}
