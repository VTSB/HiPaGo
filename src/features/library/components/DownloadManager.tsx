'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadQueueView } from './DownloadQueueView';
import { BackBar } from '@/shared/components/BackBar';
import { DbStageSpinner } from '@/shared/components/DbStageSpinner';
import { useGalleryActions } from '@/shared/hooks/useGalleryActions';
import { useT } from '@/lib/i18n/useT';
import { listDownloads, deserializeTags } from '@/lib/db/download';
import { clearAutoRetry, AUTO_RETRY_MAX } from '@/lib/db/download-retry';
import {
  DOWNLOAD_LIBRARY_CHANGED_EVENT,
  armAutoRetryTimer,
  useDownloadProgressStore,
} from '@/lib/store/download-progress';
import type { DBDownload } from '@/lib/db/schema';
import { galleryHref } from '@/lib/utils/routes';

export function DownloadManager() {
  const t = useT();
  const actions = useGalleryActions();
  const queryClient = useQueryClient();
  const queue = useDownloadProgressStore((state) => state.queue);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  const {
    data: downloads = [],
    isLoading,
    error: queryError,
  } = useQuery({ queryKey: ['library-downloads'], queryFn: listDownloads, staleTime: 0 });
  useEffect(() => {
    const changed = () => {
      void queryClient.invalidateQueries({ queryKey: ['library-downloads'] });
    };
    window.addEventListener(DOWNLOAD_LIBRARY_CHANGED_EVENT, changed);
    return () => window.removeEventListener(DOWNLOAD_LIBRARY_CHANGED_EVENT, changed);
  }, [queryClient]);
  const failed = downloads.filter((item) => item.status === 'failed');
  const retry = async (item: DBDownload, stop = false) => {
    setBusy(item.galleryId);
    setError('');
    try {
      if (stop) {
        await clearAutoRetry(item.galleryId);
        useDownloadProgressStore.getState().clearRetryPending(item.galleryId);
        armAutoRetryTimer();
      } else
        await actions.download({
          id: item.galleryId,
          title: item.title,
          thumbnail: item.thumbnail,
          tags: deserializeTags(item.tags),
        });
      await queryClient.invalidateQueries({ queryKey: ['library-downloads'] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <BackBar title={t('library.manager')} fallbackHref="/library" />
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t('library.manager')}
        </h1>
        <Link href="/library" className="text-sm font-medium text-blue-600 dark:text-blue-400">
          {t('nav.library')}
        </Link>
      </div>
      {(error || queryError) && (
        <p
          role="alert"
          className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300"
        >
          {error || (queryError instanceof Error ? queryError.message : String(queryError))}
        </p>
      )}
      <DownloadQueueView />
      {isLoading ? (
        <DbStageSpinner />
      ) : queue.length === 0 && failed.length === 0 ? (
        <p className="py-12 text-center text-sm text-zinc-500">{t('library.queue.empty')}</p>
      ) : null}
      {failed.length > 0 && (
        <section className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 font-semibold text-zinc-900 dark:text-zinc-100">
            {t('library.failedDownloads')} ({failed.length})
          </h2>
          <div className="space-y-3">
            {failed.map((item) => (
              <div key={item.galleryId} className="rounded-xl bg-zinc-100 p-3 dark:bg-zinc-900">
                <Link
                  href={galleryHref(item.galleryId)}
                  className="line-clamp-2 text-sm font-medium text-zinc-900 dark:text-zinc-100"
                >
                  {item.title || `#${item.galleryId}`}
                </Link>
                {item.lastError && (
                  <p className="mt-1 break-words text-xs text-red-600 dark:text-red-400">
                    {item.lastError}
                  </p>
                )}
                {item.nextRetryAt && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    {t('library.retry.autoIn').replace(
                      '{time}',
                      new Date(item.nextRetryAt).toLocaleTimeString(),
                    )}{' '}
                    ·{' '}
                    {t('library.retry.attempt')
                      .replace('{k}', String(item.retryCount ?? 0))
                      .replace('{max}', String(AUTO_RETRY_MAX))}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void retry(item)}
                    className="min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {t(busy === item.galleryId ? 'library.retrying' : 'library.retry')}
                  </button>
                  {item.nextRetryAt && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void retry(item, true)}
                      className="min-h-11 rounded-xl border border-zinc-300 px-4 text-sm dark:border-zinc-700"
                    >
                      {t('library.stopRetry')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      actions.open({
                        id: item.galleryId,
                        title: item.title,
                        thumbnail: item.thumbnail,
                        tags: deserializeTags(item.tags),
                      })
                    }
                    className="min-h-11 rounded-xl border border-zinc-300 px-4 text-sm dark:border-zinc-700"
                  >
                    {t('actions.title')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
