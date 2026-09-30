// @vitest-environment jsdom
import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DBDownload } from '@/lib/db/schema';
import { GalleryActionsProvider } from '../GalleryActionsProvider';
import { useGalleryActions } from '@/shared/hooks/useGalleryActions';

const mocks = vi.hoisted(() => ({
  row: null as DBDownload | null,
  saved: true,
  live: {} as Record<number, unknown>,
  deleteGallery: vi.fn(async () => {}),
  deleteDownload: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  fetch: vi.fn(),
  start: vi.fn(async () => {}),
  downloadRejected: vi.fn(),
  exportZip: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/shared/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/db/library', () => ({
  addToLibrary: vi.fn(async () => {
    mocks.saved = true;
  }),
  removeFromLibrary: mocks.remove,
  getCollections: vi.fn(async () => []),
  getGalleryCollectionIds: vi.fn(async () => []),
  addToCollection: vi.fn(),
  removeFromCollection: vi.fn(),
}));
vi.mock('@/lib/db/adapter', () => ({ ensureDb: vi.fn(async () => ({})) }));
vi.mock('@/lib/db/gallery', () => ({
  getGalleryBlock: vi.fn(async () => null),
  saveGalleryBlock: vi.fn(async () => {}),
  saveGalleryImages: vi.fn(async () => {}),
  isFavorite: vi.fn(async () => mocks.saved),
  getReadingProgress: vi.fn(async () => null),
}));
vi.mock('@/lib/db/download', () => ({
  getDownload: vi.fn(async () => mocks.row),
  deleteDownload: mocks.deleteDownload,
  deserializeTags: (raw: string) => JSON.parse(raw),
}));
vi.mock('@/lib/storage/download-store', () => ({
  createDownloadStore: vi.fn(async () => ({ deleteGallery: mocks.deleteGallery })),
}));
vi.mock('@/lib/store/download-progress', () => ({
  useDownloadProgressStore: {
    getState: () => ({ entries: mocks.live, refreshDownloaded: mocks.refresh, start: mocks.start }),
  },
  DOWNLOAD_LIBRARY_CHANGED_EVENT: 'download-library-changed',
  notifyDownloadLibraryChanged: vi.fn(),
}));
vi.mock('@/lib/api/parser', () => ({
  galleryInfoToBlock: () => ({
    id: 12,
    title: 'Work',
    thumbnail: '',
    tags: {},
    related: [],
    date: new Date(),
    type: 1,
  }),
}));
vi.mock('@/lib/api/gallery', () => ({
  fetchGalleryInfo: mocks.fetch,
}));
vi.mock('@/lib/utils/download-zip', () => ({
  hasCompleteDownloadedGallery: vi.fn(async () => true),
  exportGalleryZip: mocks.exportZip,
}));

function Commands() {
  const actions = useGalleryActions();
  const gallery = { id: 12, title: 'Work' };
  return (
    <>
      <button
        onClick={() => {
          void actions.deleteFiles(gallery).catch(() => {});
        }}
      >
        Files
      </button>
      <button
        onClick={() => {
          void actions.remove(gallery).catch(() => {});
        }}
      >
        Remove
      </button>
      <button
        onClick={() => {
          void actions.download(gallery).catch(mocks.downloadRejected);
        }}
      >
        Download
      </button>
      <button onClick={() => actions.open(gallery, { x: 10, y: 20 })}>Menu</button>
      <button onClick={() => actions.open({ id: 13, title: 'Another work' }, { x: 10, y: 20 })}>
        Another menu
      </button>
      <button onClick={() => actions.collections({ id: 13, title: 'Another work' })}>
        Another collections
      </button>
    </>
  );
}
function renderActions() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GalleryActionsProvider>
        <Commands />
      </GalleryActionsProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockImplementation(async () => {});
  mocks.fetch.mockResolvedValue({
    id: 12,
    title: 'Work',
    files: [
      {
        name: '0001.jpg',
        hash: 'hash',
        width: 800,
        height: 1200,
        haswebp: 1,
        hasavif: 1,
        hasavifsmalltn: 1,
      },
    ],
  });
  mocks.saved = true;
  mocks.live = {};
  mocks.row = {
    galleryId: 12,
    title: 'Work',
    thumbnail: '',
    tags: '{}',
    status: 'complete',
    pageCount: 5,
    totalBytes: 100,
    downloadedAt: '2025-01-01',
    folderName: '12 - Work',
  };
  mocks.deleteGallery.mockResolvedValue();
  mocks.deleteDownload.mockImplementation(async () => {
    mocks.row = null;
  });
  mocks.remove.mockImplementation(async () => {
    mocks.saved = false;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function confirm() {
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
}

describe('download file and saved membership lifetimes', () => {
  it('deletes files before their database index and keeps saved membership', async () => {
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(mocks.deleteGallery).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith(12));
    expect(mocks.deleteGallery).toHaveBeenCalledWith(12, { folderName: '12 - Work' });
    expect(mocks.deleteGallery.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteDownload.mock.invocationCallOrder[0],
    );
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.saved).toBe(true);
  });

  it('preserves the download index and membership when storage deletion fails', async () => {
    mocks.deleteGallery.mockRejectedValue(new Error('Permission denied'));
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText('actions.confirmRemoveFiles');
    await confirm();
    await screen.findByRole('alert');
    expect(mocks.deleteDownload).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.row).not.toBeNull();
    expect(mocks.saved).toBe(true);
  });

  it('removes membership only after confirmed files/index deletion', async () => {
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText('actions.confirmRemoveFiles');
    await confirm();
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(12));
    expect(mocks.deleteDownload.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.remove.mock.invocationCallOrder[0],
    );
    expect(mocks.saved).toBe(false);
  });

  it('cancelling confirmation preserves files and membership', async () => {
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'actions.cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mocks.deleteGallery).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.saved).toBe(true);
  });

  it.each(['queued', 'paused', 'downloading'] as const)(
    'refuses deleting a %s work and offers the manager',
    async (status) => {
      mocks.row!.status = status;
      renderActions();
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
      await screen.findByText('actions.busy');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(mocks.deleteGallery).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'library.queue.title' }));
      expect(mocks.push).toHaveBeenCalledWith('/downloads');
    },
  );

  it.each(['Another menu', 'Another collections'])(
    'clears busy guidance when opening %s',
    async (command) => {
      mocks.row!.status = 'queued';
      renderActions();
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
      await screen.findByText('actions.busy');
      expect(screen.getByRole('button', { name: 'library.queue.title' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: command }));
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'library.queue.title' }),
        ).not.toBeInTheDocument(),
      );
      expect(screen.queryByText('actions.busy')).not.toBeInTheDocument();
    },
  );

  it('refuses deleting a failed work that has a scheduled automatic retry', async () => {
    mocks.row!.status = 'failed';
    mocks.row!.nextRetryAt = '2030-01-01';
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await screen.findByText('actions.busy');
    expect(mocks.deleteGallery).not.toHaveBeenCalled();
  });

  it('rechecks writer state after confirmation before deleting', async () => {
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await screen.findByRole('alertdialog');
    mocks.live = { 12: { progress: { percent: 5 } } };
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await screen.findByText('actions.busy');
    expect(mocks.deleteGallery).not.toHaveBeenCalled();
    expect(mocks.deleteDownload).not.toHaveBeenCalled();
  });

  it('rejects empty upstream pages without reporting an existing completed row as a new download', async () => {
    mocks.fetch.mockResolvedValueOnce({ id: 12, title: 'Work', files: [] });
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await screen.findByRole('alert');
    expect(mocks.downloadRejected).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(screen.queryByText('actions.saved')).not.toBeInTheDocument();
    expect(mocks.row?.status).toBe('complete');
  });

  it.each(['complete', 'queued'] as const)(
    'surfaces a resolved start failure even if a %s index row remains',
    async (status) => {
      mocks.start.mockImplementation(async () => {
        mocks.live = { 12: { error: 'Queue start failed' } };
        mocks.row!.status = status;
      });
      renderActions();
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
      await screen.findByRole('alert');
      expect(mocks.start).toHaveBeenCalledOnce();
      expect(mocks.downloadRejected).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Queue start failed' }),
      );
      expect(screen.queryByText('actions.saved')).not.toBeInTheDocument();
    },
  );

  it('keeps ZIP export available and prevents a duplicate in-flight export', async () => {
    let finish!: () => void;
    mocks.exportZip.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const exportButton = await screen.findByRole('menuitem', { name: 'actions.export' });
    fireEvent.click(exportButton);
    await waitFor(() => expect(mocks.exportZip).toHaveBeenCalledWith(12, 'Work'));
    expect(exportButton).toBeDisabled();
    fireEvent.click(exportButton);
    expect(mocks.exportZip).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
    });
  });

  it('presents a single desktop menu and Android Back dismisses it', async () => {
    renderActions();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveAccessibleName('Work');
    expect(
      await screen.findByRole('menuitem', { name: 'actions.deleteFiles' }),
    ).toBeInTheDocument();
    const event = new Event('hipago:overlay-back', { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(event.defaultPrevented).toBe(true);
  });
});
