'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GalleryCardById } from '@/features/gallery-list/components/GalleryCard';
import {
  SavedGalleryGrid,
  type SavedGalleryGridHandle,
} from '@/features/gallery-list/components/SavedGalleryGrid';
import { FilterBar } from '@/shared/components/FilterBar';
import { DbErrorBanner } from '@/shared/components/DbErrorBanner';
import { DbStageSpinner } from '@/shared/components/DbStageSpinner';
import { FloatingPageNav } from '@/shared/components/FloatingPageNav';
import { useGalleryActions } from '@/shared/hooks/useGalleryActions';
import { useT } from '@/lib/i18n/useT';
import { ensureDb } from '@/lib/db/adapter';
import { listDownloads, deserializeTags } from '@/lib/db/download';
import { filterFavoritesByTags } from '@/lib/db/search-local';
import {
  getLibraryIds,
  getCollections,
  createCollection,
  renameCollection,
  deleteCollection,
  addToCollection,
  removeFromCollection,
} from '@/lib/db/library';
import {
  DOWNLOAD_LIBRARY_CHANGED_EVENT,
  useDownloadProgressStore,
} from '@/lib/store/download-progress';
import type { TagType } from '@/lib/utils/types';

type Filters = { tags: Array<{ type: TagType; name: string }>; titleQuery: string };
const control =
  'min-h-11 rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

export function LibraryHub() {
  const t = useT();
  const actions = useGalleryActions();
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const legacyTab = searchParams.get('tab');
  useEffect(() => {
    if (legacyTab === 'history' || legacyTab === 'downloads')
      router.replace(legacyTab === 'history' ? '/history' : '/downloads');
  }, [legacyTab, router]);
  const [collection, setCollection] = useState('all');
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const [sort, setSort] = useState('newest');
  const [filters, setFilters] = useState<Filters>({ tags: [], titleQuery: '' });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [collectionTarget, setCollectionTarget] = useState('');
  const [collectionTools, setCollectionTools] = useState(false);
  const [editor, setEditor] = useState<{
    mode: 'create' | 'rename' | 'delete';
    id?: number;
    name: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const queue = useDownloadProgressStore((state) => state.queue);
  const refreshQueue = useDownloadProgressStore((state) => state.refreshQueue);
  const gridRef = useRef<SavedGalleryGridHandle>(null);
  const hasFilters = !!filters.titleQuery || filters.tags.length > 0;
  const {
    data: ids = [],
    isLoading,
    error: idsError,
  } = useQuery({
    queryKey: ['library-ids', collection],
    queryFn: () =>
      getLibraryIds(
        collection === 'unclassified'
          ? { unclassified: true }
          : collection === 'all'
            ? {}
            : { collectionId: Number(collection) },
      ),
    staleTime: 0,
  });
  const {
    data: downloads = [],
    isLoading: downloadsLoading,
    error: downloadError,
  } = useQuery({
    queryKey: ['library-downloads'],
    queryFn: listDownloads,
    staleTime: 0,
  });
  const { data: collections = [], error: collectionError } = useQuery({
    queryKey: ['library-collections'],
    queryFn: getCollections,
    staleTime: 0,
  });
  const { data: titles = [] } = useQuery({
    queryKey: ['library-titles'],
    queryFn: async () =>
      (await ensureDb()).query<{ galleryId: number; title: string }>(
        "SELECT f.galleryId, COALESCE(NULLIF(g.title, ''), d.title, '') AS title FROM favorites f LEFT JOIN gallery g ON g.id = f.galleryId LEFT JOIN download d ON d.galleryId = f.galleryId",
      ),
    staleTime: 0,
  });
  const {
    data: matchingIds = [],
    isLoading: filterLoading,
    error: filterError,
  } = useQuery({
    queryKey: ['library-filtered', filters],
    queryFn: () =>
      filterFavoritesByTags(
        filters.tags.map((tag) => ({ ...tag, name: tag.name.replace(/_/g, ' ') })),
        filters.titleQuery || undefined,
      ),
    enabled: hasFilters,
    staleTime: 0,
  });
  useEffect(() => {
    void refreshQueue();
    const changed = () => {
      for (const key of [
        'library-ids',
        'library-downloads',
        'library-titles',
        'library-filtered',
        'library-collections',
      ])
        void queryClient.invalidateQueries({ queryKey: [key] });
    };
    window.addEventListener(DOWNLOAD_LIBRARY_CHANGED_EVENT, changed);
    return () => window.removeEventListener(DOWNLOAD_LIBRARY_CHANGED_EVENT, changed);
  }, [queryClient, refreshQueue]);
  const downloadMap = useMemo(
    () => new Map(downloads.map((item) => [item.galleryId, item])),
    [downloads],
  );
  const visibleIds = useMemo(() => {
    const matches = new Set(matchingIds);
    const titleMap = new Map(titles.map((item) => [item.galleryId, item.title]));
    const normal = (value: string) => value.replace(/_/g, ' ').toLowerCase();
    const result = ids.filter((id) => {
      const download = downloadMap.get(id);
      if (downloadedOnly && (download?.status !== 'complete' || download.pageCount === 0))
        return false;
      if (!hasFilters || matches.has(id)) return true;
      if (!download) return false;
      if (
        filters.titleQuery &&
        !download.title.toLowerCase().includes(filters.titleQuery.toLowerCase())
      )
        return false;
      const tags = deserializeTags(download.tags);
      return filters.tags.every((filter) =>
        (tags[filter.type] ?? []).some((name) => normal(name) === normal(filter.name)),
      );
    });
    if (sort === 'oldest') result.reverse();
    if (sort === 'title')
      result.sort((a, b) => (titleMap.get(a) ?? '').localeCompare(titleMap.get(b) ?? '') || a - b);
    return result;
  }, [ids, matchingIds, titles, downloadMap, downloadedOnly, filters, hasFilters, sort]);
  const visibleSelected = visibleIds.filter((id) => selected.has(id));
  const groups = useMemo(() => [{ key: 'library', items: visibleIds }], [visibleIds]);
  const activeCollection = collections.find((item) => String(item.id) === collection);
  const resetSelection = () => setSelected(new Set());
  const onFilterChange = useCallback((next: Filters) => {
    setFilters(next);
    setSelected(new Set());
  }, []);
  const mutate = async (fn: () => Promise<void>, clearSelection = false) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      if (clearSelection) {
        resetSelection();
        setSelecting(false);
      }
      for (const key of [
        'library-ids',
        'library-downloads',
        'library-collections',
        'library-titles',
        'library-filtered',
      ])
        await queryClient.invalidateQueries({ queryKey: [key] });
    } catch (failure) {
      if (!(failure instanceof Error && failure.name === 'AbortError'))
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const targets = () =>
    visibleSelected.map((id) => {
      const download = downloadMap.get(id);
      return {
        id,
        title: download?.title ?? titles.find((item) => item.galleryId === id)?.title,
        thumbnail: download?.thumbnail,
        tags: download ? deserializeTags(download.tags) : undefined,
      };
    });
  const summary = {
    active: Math.max(
      queue.filter((item) => item.status === 'downloading').length,
      downloads.filter((item) => item.status === 'downloading').length,
    ),
    queued: Math.max(
      queue.filter((item) => item.status === 'queued').length,
      downloads.filter((item) => item.status === 'queued').length,
    ),
    paused: Math.max(
      queue.filter((item) => item.status === 'paused').length,
      downloads.filter((item) => item.status === 'paused').length,
    ),
    failed: downloads.filter((item) => item.status === 'failed').length,
  };
  const loading = isLoading || downloadsLoading || (hasFilters && filterLoading);
  const queryError = idsError ?? downloadError ?? collectionError ?? filterError;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t('nav.library')}{' '}
          <span className="text-lg font-normal text-zinc-500">({visibleIds.length})</span>
        </h1>
        <div className="flex gap-2">
          <Link href="/downloads" className={control + ' inline-flex items-center'}>
            {t('library.manager')}
          </Link>
          <button
            type="button"
            className={control}
            disabled={busy}
            onClick={() => {
              setSelecting(!selecting);
              resetSelection();
            }}
          >
            {t(selecting ? 'library.done' : 'library.select')}
          </button>
        </div>
      </div>
      {Object.values(summary).some((count) => count > 0) && (
        <Link
          href="/downloads"
          className="mb-4 block rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:bg-blue-950/40 dark:text-blue-200"
        >
          {[
            summary.active ? t('library.status.downloading') + ' ' + summary.active : '',
            summary.queued ? t('library.queue.queued') + ' ' + summary.queued : '',
            summary.paused ? t('library.queue.paused') + ' ' + summary.paused : '',
            summary.failed ? t('library.status.failed') + ' ' + summary.failed : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Link>
      )}
      <DbErrorBanner />
      <div className="mb-3">
        <FilterBar onFilterChange={onFilterChange} placeholder={t('library.searchSaved')} />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className={control + ' max-w-full'}
          aria-label={t('actions.manageCollections')}
          value={collection}
          onChange={(event) => {
            setCollection(event.target.value);
            resetSelection();
          }}
        >
          <option value="all">{t('library.all')}</option>
          <option value="unclassified">{t('library.unclassified')}</option>
          {collections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.count})
            </option>
          ))}
        </select>
        <button
          type="button"
          className={control}
          aria-expanded={collectionTools}
          aria-controls="library-collection-tools"
          onClick={() => setCollectionTools(!collectionTools)}
        >
          {t('actions.manageCollections')}
        </button>
        <select
          className={control}
          aria-label={t('library.sort')}
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="newest">{t('library.sortNewest')}</option>
          <option value="oldest">{t('library.sortOldest')}</option>
          <option value="title">{t('library.sortTitle')}</option>
        </select>
        <label className={control + ' inline-flex items-center gap-2'}>
          <input
            type="checkbox"
            checked={downloadedOnly}
            onChange={(event) => {
              setDownloadedOnly(event.target.checked);
              resetSelection();
            }}
          />
          {t('library.downloadedOnly')}
        </label>
      </div>
      {collectionTools && (
        <div
          id="library-collection-tools"
          className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-zinc-100 p-3 dark:bg-zinc-800"
        >
          <button
            type="button"
            className={control}
            onClick={() => setEditor({ mode: 'create', name: '' })}
          >
            {t('library.collectionNew')}
          </button>
          {activeCollection && (
            <>
              <button
                type="button"
                className={control}
                onClick={() =>
                  setEditor({
                    mode: 'rename',
                    id: activeCollection.id,
                    name: activeCollection.name,
                  })
                }
              >
                {t('library.collectionRename')}
              </button>
              <button
                type="button"
                className={control}
                onClick={() =>
                  setEditor({
                    mode: 'delete',
                    id: activeCollection.id,
                    name: activeCollection.name,
                  })
                }
              >
                {t('library.collectionDelete')}
              </button>
            </>
          )}
        </div>
      )}
      {editor && (
        <form
          className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-zinc-100 p-3 dark:bg-zinc-800"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              if (editor.mode === 'create') await createCollection(editor.name);
              if (editor.mode === 'rename') await renameCollection(editor.id!, editor.name);
              if (editor.mode === 'delete') {
                await deleteCollection(editor.id!);
                if (collection === String(editor.id)) setCollection('all');
              }
              setEditor(null);
            });
          }}
        >
          {editor.mode === 'delete' ? (
            <p className="w-full text-sm">
              {t('library.collectionDeleteConfirm')} <strong>{editor.name}</strong>
            </p>
          ) : (
            <input
              autoFocus
              className={control + ' min-w-0 flex-1'}
              aria-label={t('library.collectionName')}
              placeholder={t('library.collectionName')}
              value={editor.name}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
            />
          )}
          <button
            type="submit"
            className={control}
            disabled={busy || (editor.mode !== 'delete' && !editor.name.trim())}
          >
            {t(editor.mode === 'delete' ? 'library.collectionDelete' : 'actions.saveChanges')}
          </button>
          <button type="button" className={control} disabled={busy} onClick={() => setEditor(null)}>
            {t('actions.cancel')}
          </button>
        </form>
      )}
      {selecting ? (
        <div
          className="sticky top-0 z-20 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-white p-3 dark:border-blue-900 dark:bg-zinc-900"
          aria-label={t('library.select')}
        >
          <span className="text-sm">
            {t('library.selectedCount').replace('{count}', String(visibleSelected.length))}
          </span>
          <button
            className={control}
            type="button"
            disabled={busy || loading}
            onClick={() => setSelected(new Set(visibleIds))}
          >
            {t('library.selectAll')}
          </button>
          <button className={control} type="button" disabled={busy} onClick={resetSelection}>
            {t('library.selectNone')}
          </button>
          <select
            className={control + ' max-w-full'}
            aria-label={t('library.collectionTarget')}
            value={collectionTarget}
            onChange={(event) => setCollectionTarget(event.target.value)}
          >
            <option value="">{t('library.collectionTarget')}</option>
            {collections.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            className={control}
            type="button"
            disabled={busy || loading || !visibleSelected.length || !collectionTarget}
            onClick={() =>
              void mutate(() => addToCollection(visibleSelected, Number(collectionTarget)), true)
            }
          >
            {t('library.collectionAdd')}
          </button>
          <button
            className={control}
            type="button"
            disabled={busy || loading || !visibleSelected.length || !collectionTarget}
            onClick={() =>
              void mutate(
                () => removeFromCollection(visibleSelected, Number(collectionTarget)),
                true,
              )
            }
          >
            {t('library.collectionRemove')}
          </button>
          <button
            className={control}
            type="button"
            disabled={busy || loading || !visibleSelected.length}
            onClick={() => void mutate(() => actions.deleteFiles(targets()), true)}
          >
            {t('actions.deleteFiles')}
          </button>
          <button
            className={control + ' text-red-600 dark:text-red-400'}
            type="button"
            disabled={busy || loading || !visibleSelected.length}
            onClick={() => void mutate(() => actions.remove(targets()), true)}
          >
            {t('actions.remove')}
          </button>
        </div>
      ) : (
        <p className="mb-3 text-xs text-zinc-500">{t('library.gestureHint')}</p>
      )}
      {(error || queryError) && (
        <p
          role="alert"
          className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300"
        >
          {error || (queryError instanceof Error ? queryError.message : String(queryError))}
        </p>
      )}
      {loading ? (
        <DbStageSpinner />
      ) : visibleIds.length === 0 ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center">
          <p className="max-w-sm text-sm text-zinc-500">
            {hasFilters || collection !== 'all' || downloadedOnly
              ? t('search.noResults')
              : t('library.savedEmpty')}
          </p>
          <Link href="/" className={control + ' inline-flex items-center'}>
            {t('empty.browseGalleries')}
          </Link>
        </div>
      ) : (
        <SavedGalleryGrid
          ref={gridRef}
          groups={groups}
          getItemKey={(id) => id}
          renderItem={(id) => (
            <GalleryCardById
              id={id}
              download={downloadMap.get(id)}
              onBeginSelection={
                selecting
                  ? undefined
                  : () => {
                      setSelecting(true);
                      setSelected(new Set([id]));
                    }
              }
              selected={selecting && selected.has(id)}
              onSelect={
                selecting
                  ? () =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                  : undefined
              }
            />
          )}
        />
      )}
      <FloatingPageNav
        totalItems={visibleIds.length}
        loadedItems={visibleIds.length}
        pageSize={25}
        onJumpToPage={(page) => gridRef.current?.scrollToItem((page - 1) * 25)}
      />
    </>
  );
}
