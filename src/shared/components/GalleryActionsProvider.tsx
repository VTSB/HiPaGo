'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GalleryActionsContext,
  type GalleryActions,
  type GalleryActionGallery,
  type GalleryActionAnchor,
} from '@/shared/hooks/useGalleryActions';
import {
  addToLibrary,
  removeFromLibrary,
  getCollections,
  getGalleryCollectionIds,
  addToCollection,
  removeFromCollection,
} from '@/lib/db/library';
import {
  isFavorite,
  getReadingProgress,
  getGalleryBlock,
  saveGalleryBlock,
  saveGalleryImages,
} from '@/lib/db/gallery';
import { getDownload, deleteDownload, deserializeTags } from '@/lib/db/download';
import { createDownloadStore } from '@/lib/storage/download-store';
import {
  useDownloadProgressStore,
  DOWNLOAD_LIBRARY_CHANGED_EVENT,
  notifyDownloadLibraryChanged,
} from '@/lib/store/download-progress';
import { fetchGalleryInfo } from '@/lib/api/gallery';
import { galleryInfoToBlock } from '@/lib/api/parser';
import { GalleryBlockType, type GalleryBlock } from '@/lib/utils/types';
import { hasCompleteDownloadedGallery, exportGalleryZip } from '@/lib/utils/download-zip';
import { readerHref } from '@/lib/utils/routes';
import { useT } from '@/lib/i18n/useT';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import type { DBDownload } from '@/lib/db/schema';
import { ensureDb } from '@/lib/db/adapter';

interface OpenMenu {
  gallery: GalleryActionGallery;
  anchor?: GalleryActionAnchor;
  selecting?: () => void;
  collections: boolean;
}

interface Confirmation {
  title: string;
  message: string;
  resolve: (accepted: boolean) => void;
}

const INVALIDATION_KEYS = [
  'favorites',
  'favorites-pages',
  'favorites-filtered',
  'library',
  'library-ids',
  'library-downloads',
  'library-collections',
  'library-filtered',
  'library-titles',
  'library-membership',
  'library-list',
  'library-search',
  'gallery-actions',
  'download-integrity',
  'download-covers',
  'history-grouped',
  'history-filtered',
  'reading-progress',
  'continue-reading',
];

/** The single action authority coordinates metadata, worker state, files and membership. */
export function GalleryActionsProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const confirmationRef = useRef<Confirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyError, setBusyError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingIds = useRef(new Set<number>());

  const invalidate = useCallback(() => {
    for (const key of INVALIDATION_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
  }, [queryClient]);

  useEffect(() => {
    window.addEventListener(DOWNLOAD_LIBRARY_CHANGED_EVENT, invalidate);
    return () => window.removeEventListener(DOWNLOAD_LIBRARY_CHANGED_EVENT, invalidate);
  }, [invalidate]);

  useEffect(
    () => () => {
      confirmationRef.current?.resolve(false);
    },
    [],
  );

  const close = useCallback(() => {
    setMenu(null);
  }, []);
  const open = useCallback(
    (gallery: GalleryActionGallery, anchor?: GalleryActionAnchor, selecting?: () => void) => {
      setError(null);
      setNotice(null);
      setBusyError(false);
      setMenu({ gallery, anchor, selecting, collections: false });
    },
    [],
  );

  const {
    data: state,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['gallery-actions', menu?.gallery.id],
    enabled: !!menu,
    staleTime: 0,
    queryFn: async () => {
      const id = menu!.gallery.id;
      await ensureDb();
      const [saved, download, progress, collections, collectionIds] = await Promise.all([
        isFavorite(id),
        getDownload(id),
        getReadingProgress(id),
        getCollections(),
        getGalleryCollectionIds(id),
      ]);
      const complete =
        download?.status === 'complete' &&
        (await hasCompleteDownloadedGallery(id, download.pageCount, {
          folderName: download.folderName,
        }).catch(() => false));
      return { saved, download, progress, collections, collectionIds, complete };
    },
  });

  const run = useCallback(
    async (galleries: GalleryActionGallery[], operation: () => Promise<void>) => {
      if (galleries.some((gallery) => pendingIds.current.has(gallery.id)))
        throw new Error(t('actions.busy'));
      for (const gallery of galleries) pendingIds.current.add(gallery.id);
      setPending(true);
      setError(null);
      setNotice(null);
      setBusyError(false);
      try {
        await operation();
      } catch (cause) {
        if (!(cause instanceof Error && cause.name === 'AbortError')) {
          const blocked = cause instanceof Error && cause.name === 'DownloadBusyError';
          setBusyError(blocked);
          setError(blocked ? t('actions.busy') : t('actions.failed'));
          console.warn('[gallery-actions] Action failed:', cause);
        }
        throw cause;
      } finally {
        for (const gallery of galleries) pendingIds.current.delete(gallery.id);
        setPending(pendingIds.current.size > 0);
        invalidate();
        notifyDownloadLibraryChanged(true);
      }
    },
    [invalidate, t],
  );

  const save = useCallback(
    (gallery: GalleryActionGallery) =>
      run([gallery], async () => {
        if (gallery.title && !(await getGalleryBlock(gallery.id))) {
          await saveGalleryBlock({
            id: gallery.id,
            title: gallery.title,
            thumbnail: gallery.thumbnail ?? '',
            tags: (gallery.tags ?? {}) as GalleryBlock['tags'],
            related: [],
            date: new Date(),
            type: GalleryBlockType.NOT_DETAILED,
          });
          void queryClient.invalidateQueries({ queryKey: ['gallery-block', gallery.id] });
        }
        await addToLibrary(gallery.id);
        setNotice(t('actions.saved'));
      }),
    [run, t, queryClient],
  );

  const download = useCallback(
    (gallery: GalleryActionGallery) =>
      run([gallery], async () => {
        const row = await getDownload(gallery.id);
        const live = useDownloadProgressStore.getState().entries[gallery.id];
        if (
          live?.progress ||
          live?.queued ||
          row?.status === 'queued' ||
          row?.status === 'paused' ||
          row?.status === 'downloading'
        ) {
          router.push('/downloads');
          close();
          return;
        }
        const info = await queryClient.fetchQuery({
          queryKey: ['gallery-info', gallery.id],
          queryFn: () => fetchGalleryInfo(gallery.id),
          staleTime: 5 * 60_000,
        });
        if (info.files.length === 0) throw new Error('No pages are available to download');
        const block = galleryInfoToBlock(info);
        await saveGalleryBlock(block);
        await saveGalleryImages(gallery.id, info.files);
        void queryClient.invalidateQueries({ queryKey: ['gallery-block', gallery.id] });
        await useDownloadProgressStore.getState().start({
          id: gallery.id,
          title: gallery.title ?? info.title,
          thumbnail: gallery.thumbnail ?? row?.thumbnail ?? block.thumbnail,
          files: info.files,
          tags: gallery.tags ?? block.tags,
        });
        const next = await getDownload(gallery.id);
        const failure = useDownloadProgressStore.getState().entries[gallery.id]?.error;
        if (!next || failure) throw new Error(failure ?? 'Failed to queue download');
        setNotice(t('actions.saved'));
      }),
    [run, queryClient, router, close, t],
  );

  const confirm = useCallback(
    (title: string, message: string) =>
      new Promise<void>((resolve, reject) => {
        const request: Confirmation = {
          title,
          message,
          resolve: (accepted) => {
            confirmationRef.current = null;
            setConfirmation(null);
            if (accepted) resolve();
            else reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
          },
        };
        confirmationRef.current?.resolve(false);
        confirmationRef.current = request;
        setConfirmation(request);
      }),
    [],
  );

  const ensureIdle = useCallback(
    async (id: number): Promise<DBDownload | null> => {
      const row = await getDownload(id);
      const live = useDownloadProgressStore.getState().entries[id];
      if (
        row?.status === 'queued' ||
        row?.status === 'paused' ||
        row?.status === 'downloading' ||
        row?.nextRetryAt ||
        live?.progress ||
        live?.queued ||
        live?.retryAt
      ) {
        throw Object.assign(new Error(t('actions.busy')), { name: 'DownloadBusyError' });
      }
      return row;
    },
    [t],
  );

  const deleteStoredFiles = useCallback(
    async (gallery: GalleryActionGallery) => {
      const row = await ensureIdle(gallery.id);
      if (!row) return;
      if (!(await getGalleryBlock(gallery.id))) {
        // File-only deletion retains a useful saved card even for legacy downloads
        // whose only metadata was stored on the download index.
        await saveGalleryBlock({
          id: row.galleryId,
          title: row.title,
          thumbnail: row.thumbnail,
          tags: deserializeTags(row.tags) as GalleryBlock['tags'],
          related: [],
          date: new Date(row.downloadedAt),
          type: GalleryBlockType.NOT_DETAILED,
        });
        void queryClient.invalidateQueries({ queryKey: ['gallery-block', gallery.id] });
      }
      const store = await createDownloadStore();
      // Read the latest state again after creating the storage adapter, before the destructive call.
      await ensureIdle(gallery.id);
      await store.deleteGallery(
        gallery.id,
        row.folderName ? { folderName: row.folderName } : undefined,
      );
      await deleteDownload(gallery.id);
      await useDownloadProgressStore.getState().refreshDownloaded(gallery.id);
    },
    [ensureIdle, queryClient],
  );

  const deleteFiles = useCallback(
    (input: GalleryActionGallery | GalleryActionGallery[]) => {
      const galleries = Array.isArray(input) ? input : [input];
      return run(galleries, async () => {
        for (const gallery of galleries) await ensureIdle(gallery.id);
        await confirm(t('actions.deleteFiles'), t('actions.confirmFiles'));
        for (const gallery of galleries) await deleteStoredFiles(gallery);
        close();
      });
    },
    [run, ensureIdle, confirm, t, deleteStoredFiles, close],
  );

  const remove = useCallback(
    (input: GalleryActionGallery | GalleryActionGallery[]) => {
      const galleries = Array.isArray(input) ? input : [input];
      return run(galleries, async () => {
        const rows = await Promise.all(galleries.map((gallery) => ensureIdle(gallery.id)));
        await confirm(
          t('actions.remove'),
          t(rows.some(Boolean) ? 'actions.confirmRemoveFiles' : 'actions.confirmRemove'),
        );
        for (const gallery of galleries) {
          await deleteStoredFiles(gallery);
          await removeFromLibrary(gallery.id);
        }
        close();
      });
    },
    [run, ensureIdle, confirm, t, deleteStoredFiles, close],
  );

  const collections = useCallback((gallery: GalleryActionGallery) => {
    setError(null);
    setNotice(null);
    setBusyError(false);
    setMenu({ gallery, collections: true });
  }, []);

  const actions = useMemo<GalleryActions>(
    () => ({ open, close, save, download, remove, deleteFiles, collections }),
    [open, close, save, download, remove, deleteFiles, collections],
  );
  const swallow = (promise: Promise<void>) => {
    void promise.catch(() => {});
  };

  const items: ActionMenuItem[] = [];
  if (menu && state && !menu.collections) {
    const gallery = menu.gallery;
    const resume =
      state.progress &&
      state.progress.totalPages > 0 &&
      state.progress.lastPage > 0 &&
      state.progress.lastPage < state.progress.totalPages - 1;
    items.push({
      key: 'read',
      label: t(resume ? 'actions.continue' : 'actions.read'),
      action: () => {
        router.push(readerHref(gallery.id, resume ? state.progress!.lastPage + 1 : undefined));
        close();
      },
    });
    if (!state.saved)
      items.push({ key: 'save', label: t('actions.save'), action: () => swallow(save(gallery)) });
    items.push({
      key: 'collections',
      label: t('actions.manageCollections'),
      action: () => setMenu({ ...menu, collections: true }),
    });
    const downloading =
      state.download?.status === 'downloading' ||
      state.download?.status === 'queued' ||
      state.download?.status === 'paused';
    if (downloading)
      items.push({
        key: 'manager',
        label: t('library.queue.title'),
        action: () => {
          close();
          router.push('/downloads');
        },
      });
    else if (!state.complete)
      items.push({
        key: 'download',
        label: t(state.download ? 'actions.retry' : 'actions.download'),
        action: () => swallow(download(gallery)),
      });
    if (state.complete)
      items.push({
        key: 'export',
        label: t('actions.export'),
        action: () =>
          swallow(
            run([gallery], () =>
              exportGalleryZip(gallery.id, gallery.title ?? state.download!.title),
            ),
          ),
      });
    items.push({
      key: 'share',
      label: t('actions.share'),
      action: () =>
        swallow(
          run([gallery], async () => {
            const url = `https://hitomi.la/galleries/${gallery.id}.html`;
            if (navigator.share) await navigator.share({ title: gallery.title, url });
            else {
              await navigator.clipboard.writeText(url);
              setNotice(t('actions.copied'));
            }
          }),
        ),
    });
    if (menu.selecting)
      items.push({
        key: 'select',
        label: t('actions.select'),
        action: () => {
          menu.selecting!();
          close();
        },
      });
    if (state.download)
      items.push({
        key: 'files',
        label: t('actions.deleteFiles'),
        destructive: true,
        action: () => swallow(deleteFiles(gallery)),
      });
    if (state.saved)
      items.push({
        key: 'remove',
        label: t('actions.remove'),
        destructive: true,
        action: () => swallow(remove(gallery)),
      });
  }

  return (
    <GalleryActionsContext.Provider value={actions}>
      {children}
      {(error || notice) && !menu && (
        <div className="fixed inset-x-4 bottom-24 z-[90] mx-auto flex max-w-md items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <p className="flex-1 text-zinc-800 dark:text-zinc-100" role={error ? 'alert' : 'status'}>
            {error ?? notice}
          </p>
          {busyError && (
            <button
              onClick={() => {
                setError(null);
                router.push('/downloads');
              }}
              className="font-semibold text-blue-600 dark:text-blue-400"
            >
              {t('library.queue.title')}
            </button>
          )}
          <button
            aria-label={t('actions.cancel')}
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
            className="h-8 w-8 text-zinc-500"
          >
            ×
          </button>
        </div>
      )}
      {menu && (
        <ActionMenu
          title={menu.gallery.title ?? `#${menu.gallery.id}`}
          anchor={menu.anchor}
          items={items}
          busy={pending}
          error={error ?? (isError ? t('actions.failed') : null)}
          onClose={close}
          active={!confirmation}
          dialog={menu.collections}
        >
          {isLoading && (
            <p role="status" className="px-3 py-3 text-sm text-zinc-500">
              {t('actions.loading')}
            </p>
          )}
          {isError && (
            <button className="min-h-11 px-3 text-sm text-blue-600" onClick={() => void refetch()}>
              {t('actions.retry')}
            </button>
          )}
          {notice && (
            <p role="status" className="px-3 py-2 text-sm text-zinc-500">
              {notice}
            </p>
          )}
          {busyError && (
            <button
              className="min-h-11 px-3 text-sm text-blue-600"
              onClick={() => {
                close();
                router.push('/downloads');
              }}
            >
              {t('library.queue.title')}
            </button>
          )}
          {menu.collections && state && (
            <div className="px-3 pb-2">
              <p className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                {t('actions.manageCollections')}
              </p>
              {state.collections.length === 0 && (
                <p className="py-2 text-sm text-zinc-500">{t('actions.emptyCollections')}</p>
              )}
              {state.collections.map((collection) => (
                <label
                  key={collection.id}
                  className="flex min-h-11 items-center gap-3 text-sm text-zinc-800 dark:text-zinc-100"
                >
                  <input
                    type="checkbox"
                    checked={state.collectionIds.includes(collection.id)}
                    disabled={pending}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      swallow(
                        run([menu.gallery], async () => {
                          if (checked) await addToCollection([menu.gallery.id], collection.id);
                          else await removeFromCollection([menu.gallery.id], collection.id);
                        }),
                      );
                    }}
                    className="h-4 w-4 accent-zinc-900"
                  />
                  <span className="flex-1">{collection.name}</span>
                  <span className="text-zinc-400">{collection.count}</span>
                </label>
              ))}
              <button
                className="mt-2 min-h-11 w-full rounded-lg bg-zinc-100 text-sm font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                onClick={close}
                disabled={pending}
              >
                {t('actions.done')}
              </button>
            </div>
          )}
        </ActionMenu>
      )}
      {confirmation && (
        <ConfirmActionDialog
          title={confirmation.title}
          message={confirmation.message}
          onConfirm={() => confirmation.resolve(true)}
          onCancel={() => confirmation.resolve(false)}
        />
      )}
    </GalleryActionsContext.Provider>
  );
}
