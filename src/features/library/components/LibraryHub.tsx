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
import { ActionMenu } from '@/shared/components/ActionMenu';
import { ConfirmActionDialog } from '@/shared/components/ConfirmActionDialog';
import { GalleryActionTarget } from '@/shared/components/GalleryActionTarget';
import { LibraryIcon } from './LibraryIcon';
import { getCollectionPath, getCollectionLabel } from '@/lib/utils/collection-tree';
import type { GalleryActionAnchor } from '@/shared/hooks/useGalleryActions';
import { FilterBar } from '@/shared/components/FilterBar';
import { DbErrorBanner } from '@/shared/components/DbErrorBanner';
import { DbStageSpinner } from '@/shared/components/DbStageSpinner';
import { FloatingPageNav } from '@/shared/components/FloatingPageNav';
import { useGalleryActions } from '@/shared/hooks/useGalleryActions';
import { useT } from '@/lib/i18n/useT';
import { ensureDb, persistDb } from '@/lib/db/adapter';
import { listDownloads, deserializeTags } from '@/lib/db/download';
import { filterFavoritesByTags } from '@/lib/db/search-local';
import {
  LibraryCollectionError,
  getLibraryIds,
  getCollections,
  createCollection,
  renameCollection,
  moveCollection,
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

type Location = { kind: 'root' } | { kind: 'all' } | { kind: 'folder'; id: number };
type Editor = {
  mode: 'create' | 'rename' | 'move' | 'delete';
  id?: number;
  name: string;
  parentId: number | null;
};
const iconControl =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-zinc-600 transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800';

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
  const [location, setLocation] = useState<Location>({ kind: 'root' });
  const [sort, setSort] = useState('newest');
  const [filters, setFilters] = useState<Filters>({ tags: [], titleQuery: '' });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [collectionTarget, setCollectionTarget] = useState('');
  const [menu, setMenu] = useState<{
    kind: 'sort' | 'folder';
    id?: number;
    anchor?: GalleryActionAnchor;
  } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [busy, setBusy] = useState(false);
  const closeEditor = useCallback(() => {
    if (!busy) setEditor(null);
  }, [busy]);
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
    queryKey: ['library-ids', location],
    queryFn: () =>
      getLibraryIds(
        location.kind === 'root'
          ? { unclassified: true }
          : location.kind === 'all'
            ? {}
            : { collectionId: location.id },
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
  const {
    data: allIds = [],
    isLoading: allLoading,
    error: allError,
  } = useQuery({
    queryKey: ['library-all-ids'],
    queryFn: () => getLibraryIds(),
    staleTime: 0,
  });
  const {
    data: collections = [],
    isLoading: collectionsLoading,
    error: collectionError,
  } = useQuery({
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
        'library-all-ids',
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
  }, [ids, matchingIds, titles, downloadMap, filters, hasFilters, sort]);
  const visibleSelected = visibleIds.filter((id) => selected.has(id));
  const groups = useMemo(() => [{ key: 'library', items: visibleIds }], [visibleIds]);
  const folderId = location.kind === 'folder' ? location.id : null;
  const activeCollection = collections.find((item) => item.id === folderId);
  const path = useMemo(
    () => (folderId === null ? [] : getCollectionPath(collections, folderId)),
    [collections, folderId],
  );
  const folderLabels = useMemo(
    () => new Map(collections.map((item) => [item.id, getCollectionLabel(collections, item.id)])),
    [collections],
  );
  const children = collections.filter(
    (item) => item.parentId === folderId && location.kind !== 'all',
  );
  const navigate = (nextLocation: Location) => {
    setLocation(nextLocation);
    setSelected(new Set());
    setCollectionTarget('');
  };
  useEffect(() => {
    if (
      location.kind === 'folder' &&
      !collectionsLoading &&
      !collectionError &&
      !collections.some((item) => item.id === location.id)
    ) {
      setLocation({ kind: 'root' });
      setSelected(new Set());
      setCollectionTarget('');
    }
  }, [collections, collectionsLoading, collectionError, location]);
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
    } catch (failure) {
      if (!(failure instanceof Error && failure.name === 'AbortError'))
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      await Promise.allSettled(
        [
          'library-ids',
          'library-all-ids',
          'library-downloads',
          'library-collections',
          'library-titles',
          'library-filtered',
        ].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      );
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
  const loading =
    isLoading ||
    allLoading ||
    collectionsLoading ||
    downloadsLoading ||
    (hasFilters && filterLoading);
  const queryError = idsError ?? allError ?? downloadError ?? collectionError ?? filterError;

  const statusText = [
    summary.active ? t('library.status.downloading') + ' ' + summary.active : '',
    summary.queued ? t('library.queue.queued') + ' ' + summary.queued : '',
    summary.paused ? t('library.queue.paused') + ' ' + summary.paused : '',
    summary.failed ? t('library.status.failed') + ' ' + summary.failed : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const beginEditor = (mode: Editor['mode'], id?: number) => {
    const folder = collections.find((item) => item.id === id);
    setError('');
    setMenu(null);
    setEditor({
      mode,
      id,
      name: folder?.name ?? '',
      parentId: mode === 'create' ? folderId : (folder?.parentId ?? null),
    });
  };
  const submitEditor = () => {
    if (!editor || busy) return;
    const draft = editor;
    void mutate(async () => {
      try {
        if (draft.mode === 'create') {
          if (draft.id !== undefined) await persistDb();
          else await createCollection(draft.name, draft.parentId);
        }
        if (draft.mode === 'rename') await renameCollection(draft.id!, draft.name);
        if (draft.mode === 'move') await moveCollection(draft.id!, draft.parentId);
        if (draft.mode === 'delete') {
          await deleteCollection(draft.id!);
          if (folderId === draft.id)
            navigate(
              draft.parentId === null ? { kind: 'root' } : { kind: 'folder', id: draft.parentId },
            );
        }
        setEditor(null);
      } catch (failure) {
        if (failure instanceof LibraryCollectionError && failure.createdCollectionId !== undefined)
          setEditor({ ...draft, id: failure.createdCollectionId });
        const code =
          failure instanceof LibraryCollectionError
            ? failure.code
            : draft.mode === 'create' && draft.id !== undefined
              ? 'created-unsaved'
              : 'failed';
        throw new Error(t(`library.folderError.${code}`));
      }
    });
  };
  const menuFolder = collections.find((item) => item.id === menu?.id);
  const emptyText = hasFilters
    ? t('search.noResults')
    : location.kind === 'folder'
      ? t('library.folderEmpty')
      : t('library.savedEmpty');
  return (
    <div className={selecting ? 'pb-64 sm:pb-44' : ''}>
      <header className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium text-zinc-500">
            {t('library.workCount').replace('{count}', allLoading ? '…' : String(allIds.length))}
          </p>
          <h1 className="break-words text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            {activeCollection?.name ?? t(location.kind === 'all' ? 'library.all' : 'nav.library')}
          </h1>
        </div>
      </header>
      <Link
        href="/downloads"
        className="mb-5 flex min-h-16 items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-4 py-3 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          <LibraryIcon name="download" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            {t('library.manager')}
          </p>
          <p
            className={
              'mt-0.5 break-words text-xs ' +
              (statusText ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-500')
            }
          >
            {statusText || t('library.managerDescription')}
          </p>
        </div>
        <LibraryIcon name="chevron" className="h-4 w-4 shrink-0 text-zinc-400" />
      </Link>
      <DbErrorBanner />
      <div className="mb-3">
        <FilterBar onFilterChange={onFilterChange} placeholder={t('library.searchSaved')} />
      </div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <nav
          aria-label={t('library.location')}
          className="flex min-w-0 max-w-full flex-1 items-center gap-1 overflow-x-auto text-sm"
        >
          <button
            type="button"
            className="min-h-11 shrink-0 rounded-lg px-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-current={location.kind === 'root' ? 'page' : undefined}
            onClick={() => navigate({ kind: 'root' })}
          >
            {t('nav.library')}
          </button>
          {path.map((folder, index) => (
            <span key={folder.id} className="flex shrink-0 items-center gap-1">
              <LibraryIcon name="chevron" className="h-3 w-3 text-zinc-400" />
              <button
                type="button"
                title={folder.name}
                aria-current={index === path.length - 1 ? 'page' : undefined}
                className="min-h-11 max-w-40 truncate rounded-lg px-2 font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                onClick={() => navigate({ kind: 'folder', id: folder.id })}
              >
                {folder.name}
              </button>
            </span>
          ))}
          {location.kind === 'all' && (
            <span className="flex shrink-0 items-center gap-1">
              <LibraryIcon name="chevron" className="h-3 w-3 text-zinc-400" />
              <span aria-current="page" className="font-medium text-zinc-700 dark:text-zinc-200">
                {t('library.all')}
              </span>
            </span>
          )}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          {activeCollection && (
            <button
              type="button"
              className={iconControl}
              aria-label={t('library.folderActions')}
              title={t('library.folderActions')}
              disabled={busy}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({
                  kind: 'folder',
                  id: activeCollection.id,
                  anchor: { x: rect.left, y: rect.bottom },
                });
              }}
            >
              <LibraryIcon name="manage" />
            </button>
          )}
          {location.kind !== 'all' && (
            <button
              type="button"
              className={iconControl}
              aria-label={t('library.collectionNew')}
              title={t('library.collectionNew')}
              disabled={busy || collectionsLoading || !!collectionError}
              onClick={() => beginEditor('create')}
            >
              <LibraryIcon name="folderPlus" />
            </button>
          )}
          <button
            type="button"
            className={iconControl}
            aria-label={t('library.sort')}
            title={t(
              sort === 'newest'
                ? 'library.sortNewest'
                : sort === 'oldest'
                  ? 'library.sortOldest'
                  : 'library.sortTitle',
            )}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'sort'}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ kind: 'sort', anchor: { x: rect.left, y: rect.bottom } });
            }}
          >
            <LibraryIcon name="sort" />
          </button>
          <button
            type="button"
            className={
              iconControl +
              (selecting ? ' bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400' : '')
            }
            aria-label={t(selecting ? 'library.done' : 'library.select')}
            title={t(selecting ? 'library.done' : 'library.select')}
            aria-pressed={selecting}
            disabled={busy}
            onClick={() => {
              setSelecting(!selecting);
              resetSelection();
            }}
          >
            <LibraryIcon name={selecting ? 'close' : 'select'} />
          </button>
        </div>
      </div>
      {menu && (
        <ActionMenu
          title={
            menu.kind === 'sort'
              ? t('library.sort')
              : (menuFolder?.name ?? t('library.folderActions'))
          }
          anchor={menu.anchor}
          onClose={closeMenu}
          items={
            menu.kind === 'sort'
              ? (['newest', 'oldest', 'title'] as const).map((value) => ({
                  key: value,
                  label:
                    (sort === value ? '✓ ' : '') +
                    t(
                      value === 'newest'
                        ? 'library.sortNewest'
                        : value === 'oldest'
                          ? 'library.sortOldest'
                          : 'library.sortTitle',
                    ),
                  action: () => {
                    setSort(value);
                    setMenu(null);
                  },
                }))
              : menuFolder
                ? [
                    {
                      key: 'rename',
                      label: t('library.collectionRename'),
                      action: () => beginEditor('rename', menuFolder.id),
                    },
                    {
                      key: 'move',
                      label: t('library.folderMove'),
                      action: () => beginEditor('move', menuFolder.id),
                    },
                    {
                      key: 'delete',
                      label: t('library.collectionDelete'),
                      destructive: true,
                      action: () => beginEditor('delete', menuFolder.id),
                    },
                  ]
                : []
          }
        />
      )}
      {editor && editor.mode !== 'delete' && (
        <ActionMenu
          title={t(
            editor.mode === 'create'
              ? 'library.collectionNew'
              : editor.mode === 'rename'
                ? 'library.collectionRename'
                : 'library.folderMove',
          )}
          dialog
          busy={busy}
          error={error}
          onClose={closeEditor}
          items={[]}
        >
          <form
            className="px-3 pb-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitEditor();
            }}
          >
            {editor.mode === 'move' ? (
              <div className="mb-3 space-y-1">
                <p className="mb-2 text-xs text-zinc-500">{t('library.folderDestination')}</p>
                <button
                  type="button"
                  className={control + ' w-full text-left'}
                  aria-pressed={editor.parentId === null}
                  onClick={() => setEditor({ ...editor, parentId: null })}
                  disabled={busy}
                >
                  {editor.parentId === null ? '✓ ' : ''}
                  {t('nav.library')}
                </button>
                {collections
                  .filter(
                    (item) =>
                      item.id !== editor.id &&
                      !getCollectionPath(collections, item.id).some(
                        (ancestor) => ancestor.id === editor.id,
                      ),
                  )
                  .map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={control + ' w-full break-words text-left'}
                      aria-pressed={editor.parentId === item.id}
                      onClick={() => setEditor({ ...editor, parentId: item.id })}
                      disabled={busy}
                    >
                      {editor.parentId === item.id ? '✓ ' : ''}
                      {folderLabels.get(item.id)}
                    </button>
                  ))}
              </div>
            ) : (
              <input
                autoFocus
                aria-label={t('library.collectionName')}
                placeholder={t('library.collectionName')}
                className={control + ' mb-3 w-full'}
                value={editor.name}
                readOnly={editor.mode === 'create' && editor.id !== undefined}
                disabled={busy}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={control} onClick={closeEditor} disabled={busy}>
                {t('actions.cancel')}
              </button>
              <button
                type="submit"
                className="min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-40"
                disabled={busy || (editor.mode !== 'move' && !editor.name.trim())}
              >
                {t('actions.saveChanges')}
              </button>
            </div>
          </form>
        </ActionMenu>
      )}
      {editor?.mode === 'delete' && (
        <ConfirmActionDialog
          title={editor.name}
          message={t('library.collectionDeleteConfirm')}
          busy={busy}
          error={error}
          onCancel={closeEditor}
          onConfirm={submitEditor}
        />
      )}
      {(error || queryError) && !editor && (
        <p
          role="alert"
          className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300"
        >
          {error || (queryError instanceof Error ? queryError.message : String(queryError))}
        </p>
      )}
      {loading ? (
        <DbStageSpinner />
      ) : (
        <>
          {(children.length > 0 || location.kind === 'root') && (
            <section className="mb-6">
              <h2 className="mb-3 text-xs font-semibold text-zinc-500">{t('library.folders')}</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {location.kind === 'root' && (
                  <button
                    type="button"
                    aria-label={t('library.all')}
                    className="flex min-h-28 flex-col items-start rounded-2xl border border-blue-100 bg-blue-50/50 p-4 text-left transition-colors hover:bg-blue-50 dark:border-blue-900/60 dark:bg-blue-950/20 dark:hover:bg-blue-950/40"
                    onClick={() => navigate({ kind: 'all' })}
                  >
                    <LibraryIcon
                      name="all"
                      className="mb-3 h-6 w-6 text-blue-600 dark:text-blue-400"
                    />
                    <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {t('library.all')}
                    </span>
                    <span className="mt-1 text-xs text-zinc-500">
                      {t('library.workCount').replace('{count}', String(allIds.length))}
                    </span>
                  </button>
                )}
                {children.map((folder) => (
                  <GalleryActionTarget
                    key={folder.id}
                    gallery={{ id: folder.id, title: folder.name }}
                    onOpen={(anchor) => setMenu({ kind: 'folder', id: folder.id, anchor })}
                  >
                    <button
                      type="button"
                      aria-label={folder.name}
                      className="flex min-h-28 w-full flex-col items-start rounded-2xl border border-zinc-200 bg-white p-4 text-left transition-colors hover:border-amber-300 hover:bg-amber-50/30 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-amber-700"
                      onClick={() => navigate({ kind: 'folder', id: folder.id })}
                    >
                      <LibraryIcon
                        name="folder"
                        className="mb-3 h-7 w-7 fill-amber-100 text-amber-500 dark:fill-amber-950/50 dark:text-amber-400"
                      />
                      <span className="break-words text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {folder.name}
                      </span>
                      <span className="mt-1 text-xs text-zinc-500">
                        {t('library.workCount').replace('{count}', String(folder.count))}
                        {collections.some((item) => item.parentId === folder.id)
                          ? ' · ' +
                            t('library.folderCount').replace(
                              '{count}',
                              String(
                                collections.filter((item) => item.parentId === folder.id).length,
                              ),
                            )
                          : ''}
                      </span>
                    </button>
                  </GalleryActionTarget>
                ))}
              </div>
            </section>
          )}
          {visibleIds.length > 0 ? (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold text-zinc-500">
                  {t('library.works')} <span className="ml-1 font-normal">{visibleIds.length}</span>
                </h2>
                <span className="text-xs text-zinc-400">
                  {t(
                    sort === 'newest'
                      ? 'library.sortNewest'
                      : sort === 'oldest'
                        ? 'library.sortOldest'
                        : 'library.sortTitle',
                  )}
                </span>
              </div>
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
            </section>
          ) : (
            (hasFilters || !children.length) && (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-zinc-200 px-6 py-8 text-center dark:border-zinc-800">
                <LibraryIcon name="folder" className="h-9 w-9 text-zinc-300 dark:text-zinc-600" />
                <p className="max-w-sm text-sm text-zinc-500">
                  {location.kind === 'root' && allIds.length > 0 && !hasFilters
                    ? t('library.unclassified') + ' · 0'
                    : emptyText}
                </p>
                {((location.kind === 'root' && !allIds.length) ||
                  (location.kind === 'all' && !allIds.length)) && (
                  <Link
                    href="/"
                    className="min-h-11 rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {t('empty.browseGalleries')}
                  </Link>
                )}
              </div>
            )
          )}
        </>
      )}
      {selecting && (
        <div
          className="fixed inset-x-3 bottom-[calc(var(--bottom-nav-h)+0.75rem)] z-40 mx-auto max-w-4xl rounded-2xl border border-zinc-200 bg-white/95 p-3 shadow-xl backdrop-blur-md md:bottom-4 dark:border-zinc-700 dark:bg-zinc-900/95"
          aria-label={t('library.select')}
        >
          <div className="mb-2 flex flex-wrap items-center gap-2 border-b border-zinc-100 pb-2 dark:border-zinc-800">
            <span className="mr-auto text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {t('library.selectedCount').replace('{count}', String(visibleSelected.length))}
            </span>
            <button
              type="button"
              className="min-h-11 px-2 text-xs font-medium text-zinc-500"
              disabled={busy || loading}
              onClick={() => setSelected(new Set(visibleIds))}
            >
              {t('library.selectAll')}
            </button>
            <button
              type="button"
              className="min-h-11 px-2 text-xs font-medium text-zinc-500"
              disabled={busy}
              onClick={resetSelection}
            >
              {t('library.selectNone')}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={control + ' min-w-0 max-w-full flex-1'}
              aria-label={t('library.collectionTarget')}
              value={collectionTarget}
              disabled={busy || loading}
              onChange={(event) => setCollectionTarget(event.target.value)}
            >
              <option value="">{t('library.collectionTarget')}</option>
              {collections.map((item) => (
                <option value={item.id} key={item.id}>
                  {folderLabels.get(item.id)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={control}
              disabled={busy || loading || !visibleSelected.length || !collectionTarget}
              onClick={() =>
                void mutate(() => addToCollection(visibleSelected, Number(collectionTarget)), true)
              }
            >
              {t('library.collectionAdd')}
            </button>
            <button
              type="button"
              className={control}
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
              type="button"
              className={control}
              disabled={busy || loading || !visibleSelected.length}
              onClick={() => void mutate(() => actions.deleteFiles(targets()), true)}
            >
              {t('actions.deleteFiles')}
            </button>
            <button
              type="button"
              className={control + ' text-red-600 dark:text-red-400'}
              disabled={busy || loading || !visibleSelected.length}
              onClick={() => void mutate(() => actions.remove(targets()), true)}
            >
              {t('actions.remove')}
            </button>
          </div>
        </div>
      )}
      {!selecting && (
        <FloatingPageNav
          totalItems={visibleIds.length}
          loadedItems={visibleIds.length}
          pageSize={25}
          onJumpToPage={(page) => gridRef.current?.scrollToItem((page - 1) * 25)}
        />
      )}
    </div>
  );
}
