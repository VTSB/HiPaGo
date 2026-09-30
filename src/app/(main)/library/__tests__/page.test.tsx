// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DBDownload } from '@/lib/db/schema';
import { LibraryCollectionError } from '@/lib/db/library';
import { t, type TranslationKey } from '@/lib/i18n/translations';
import LibraryPage from '../page';

const state = vi.hoisted(() => ({
  locale: null as 'ko' | 'en' | null,
  persist: vi.fn(),
  ids: [3, 2, 1],
  beginSelection: new Map<number, () => void>(),
  downloads: [] as DBDownload[],
  titles: [
    { galleryId: 1, title: 'Able' },
    { galleryId: 2, title: 'Beta' },
    { galleryId: 3, title: 'Gamma' },
  ],
  collections: [{ id: 10, name: 'Reading', count: 2, parentId: null as number | null }],
  classified: [2, 1],
  matches: [] as number[],
  replace: vi.fn(),
  refreshQueue: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  deleteFiles: vi.fn(async () => {}),
  getLibraryIds: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  move: vi.fn(),
  deleteCollection: vi.fn(),
  addToCollection: vi.fn(async () => {}),
  removeFromCollection: vi.fn(async () => {}),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: state.replace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: TranslationKey) => (state.locale ? t(key, state.locale) : key),
}));
vi.mock('@/shared/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/shared/hooks/useGalleryActions', () => ({
  useGalleryActions: () => ({ remove: state.remove, deleteFiles: state.deleteFiles }),
}));
vi.mock('@/lib/db/adapter', () => ({
  ensureDb: async () => ({ query: async () => state.titles }),
  persistDb: () => state.persist(),
}));
vi.mock('@/lib/db/download', () => ({
  listDownloads: async () => state.downloads,
  deserializeTags: (raw: string) => JSON.parse(raw),
}));
vi.mock('@/lib/db/library', async (importOriginal) => ({
  LibraryCollectionError: (await importOriginal<typeof import('@/lib/db/library')>())
    .LibraryCollectionError,
  getLibraryIds: (options: { collectionId?: number; unclassified?: boolean } = {}) =>
    state.getLibraryIds(options),
  getCollections: async () => state.collections,
  createCollection: (name: string, parentId: number | null = null) => state.create(name, parentId),
  renameCollection: (id: number, name: string) => state.rename(id, name),
  moveCollection: (id: number, parentId: number | null) => state.move(id, parentId),
  deleteCollection: (id: number) => state.deleteCollection(id),
  addToCollection: state.addToCollection,
  removeFromCollection: state.removeFromCollection,
}));
vi.mock('@/lib/db/search-local', () => ({ filterFavoritesByTags: async () => state.matches }));
vi.mock('@/lib/store/download-progress', () => ({
  DOWNLOAD_LIBRARY_CHANGED_EVENT: 'download-library-changed',
  useDownloadProgressStore: (selector: (data: unknown) => unknown) =>
    selector({ queue: [], refreshQueue: state.refreshQueue }),
}));
vi.mock('@/features/gallery-list/components/GalleryCard', () => ({
  GalleryCardById: ({
    id,
    download,
    selected,
    onSelect,
    onBeginSelection,
  }: {
    id: number;
    download?: DBDownload;
    selected?: boolean;
    onSelect?: () => void;
    onBeginSelection?: () => void;
  }) => {
    if (onBeginSelection) state.beginSelection.set(id, onBeginSelection);
    return (
      <button data-testid="work" aria-pressed={selected} onClick={onSelect}>
        {download?.title ?? `Saved ${id}`}
      </button>
    );
  },
}));
vi.mock('@/features/gallery-list/components/SavedGalleryGrid', () => ({
  SavedGalleryGrid: React.forwardRef(function Grid(
    {
      groups,
      renderItem,
    }: {
      groups: Array<{ key: string; items: number[] }>;
      renderItem: (id: number) => React.ReactNode;
    },
    _ref,
  ) {
    void _ref;
    return (
      <div>
        {groups.flatMap((group) =>
          group.items.map((id) => <React.Fragment key={id}>{renderItem(id)}</React.Fragment>),
        )}
      </div>
    );
  }),
}));
vi.mock('@/shared/components/FilterBar', () => ({
  FilterBar: ({
    onFilterChange,
  }: {
    onFilterChange: (filters: { tags: []; titleQuery: string }) => void;
  }) => (
    <input
      aria-label="Filter"
      onChange={(event) => onFilterChange({ tags: [], titleQuery: event.target.value })}
    />
  ),
}));
vi.mock('@/shared/components/DbErrorBanner', () => ({ DbErrorBanner: () => null }));
vi.mock('@/shared/components/DbStageSpinner', () => ({
  DbStageSpinner: () => <div role="status">Loading</div>,
}));
vi.mock('@/shared/components/FloatingPageNav', () => ({ FloatingPageNav: () => null }));

function download(galleryId: number, status: DBDownload['status'] = 'complete'): DBDownload {
  return {
    galleryId,
    title: galleryId === 2 ? 'Downloaded Beta' : 'Failed Gamma',
    thumbnail: '/local-cover',
    tags: '{}',
    status,
    pageCount: 5,
    totalBytes: 100,
    downloadedAt: '2025-01-01',
  };
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <LibraryPage />
    </QueryClientProvider>,
  );
  return { ...result, client };
}
const workNames = () => screen.getAllByTestId('work').map((element) => element.textContent);
beforeEach(() => {
  vi.clearAllMocks();
  state.locale = null;
  state.persist.mockReset().mockResolvedValue(undefined);
  state.beginSelection.clear();
  window.history.replaceState({}, '', '/library');
  state.ids = [3, 2, 1];
  state.downloads = [download(2)];
  state.matches = [];
  state.collections = [{ id: 10, name: 'Reading', count: 2, parentId: null }];
  state.classified = [2, 1];
  state.getLibraryIds.mockImplementation(async (options) =>
    options.collectionId
      ? state.classified
      : options.unclassified
        ? state.ids.filter((id) => !state.classified.includes(id))
        : state.ids,
  );
  state.create.mockImplementation(async (name, parentId) => {
    state.collections.push({ id: 11, name, count: 0, parentId });
    return 11;
  });
  state.rename.mockResolvedValue(undefined);
  state.move.mockResolvedValue(undefined);
  state.deleteCollection.mockImplementation(async (id) => {
    state.collections = state.collections.filter((collection) => collection.id !== id);
  });
  state.remove.mockResolvedValue();
  state.deleteFiles.mockResolvedValue();
});
afterEach(cleanup);

async function ready() {
  fireEvent.click(await screen.findByRole('button', { name: 'library.all' }));
  await waitFor(() => expect(screen.getAllByTestId('work')).toHaveLength(3));
}

async function openFolder(name = 'Reading') {
  fireEvent.click(await screen.findByRole('button', { name }));
}

async function folderMenu(item: string) {
  fireEvent.click(screen.getByRole('button', { name: 'library.folderActions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

describe('unified saved library', () => {
  it.each(['ko', 'en'] as const)(
    'retries a committed nested current-folder deletion in %s and returns to its former parent',
    async (locale) => {
      state.locale = locale;
      const label = (key: TranslationKey) => t(key, locale);
      state.collections = [
        { id: 10, name: 'Reading', count: 1, parentId: null },
        { id: 11, name: 'Branch', count: 1, parentId: 10 },
        { id: 12, name: 'Child', count: 1, parentId: 11 },
      ];
      state.getLibraryIds.mockImplementation(async (options) =>
        options.collectionId === 10
          ? [2]
          : options.collectionId === 11
            ? [3]
            : options.collectionId === 12
              ? [1]
              : options.unclassified
                ? state.collections.some((folder) => folder.id === 11) ? [] : [3]
                : state.ids,
      );
      state.deleteCollection.mockImplementation(async (id) => {
        const source = state.collections.find((folder) => folder.id === id);
        if (!source) throw new LibraryCollectionError('missing', 'Source no longer exists');
        state.collections = state.collections
          .filter((folder) => folder.id !== id)
          .map((folder) =>
            folder.parentId === id ? { ...folder, parentId: source.parentId } : folder,
          );
        throw new LibraryCollectionError('deleted-unsaved', 'Disk full');
      });
      state.persist.mockRejectedValueOnce(new Error('Disk full again'));
      renderPage();
      await openFolder();
      await openFolder('Branch');
      await waitFor(() => expect(workNames()).toEqual(['Saved 3']));
      fireEvent.click(screen.getByRole('button', { name: label('library.folderActions') }));
      fireEvent.click(
        await screen.findByRole('menuitem', { name: label('library.collectionDelete') }),
      );
      expect(screen.getByRole('alertdialog')).toHaveTextContent(
        label('library.collectionDeleteConfirm'),
      );
      fireEvent.click(screen.getByRole('button', { name: label('actions.confirm') }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        label('library.folderError.deleted-unsaved'),
      );
      await screen.findByRole('button', { name: label('library.all') });
      expect(screen.getByRole('heading', { name: label('nav.library'), level: 1 })).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: label('library.location') })).not.toBeInTheDocument();
      expect(screen.getByRole('alertdialog')).toHaveTextContent(
        label('library.folderDeletePersistConfirm'),
      );
      expect(screen.getByRole('alertdialog')).not.toHaveTextContent(
        label('library.collectionDeleteConfirm'),
      );
      expect(state.deleteCollection).toHaveBeenCalledExactlyOnceWith(11);
      expect(state.persist).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: label('actions.confirm') }));
      await waitFor(() => expect(state.persist).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: label('actions.confirm') })).toBeEnabled(),
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        label('library.folderError.deleted-unsaved'),
      );
      expect(state.deleteCollection).toHaveBeenCalledTimes(1);
      expect(state.collections.find((folder) => folder.id === 12)?.parentId).toBe(10);

      fireEvent.click(screen.getByRole('button', { name: label('actions.confirm') }));
      await waitFor(() => expect(state.persist).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { level: 1, name: 'Reading' })).toBeInTheDocument();
      expect(
        within(screen.getByRole('navigation', { name: label('library.location') }))
          .getByRole('button', { name: 'Reading' }),
      ).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('button', { name: 'Child' })).toBeInTheDocument();
      await waitFor(() => expect(workNames()).toEqual(['Downloaded Beta']));
      expect(state.deleteCollection).toHaveBeenCalledTimes(1);
      expect(state.ids).toEqual([3, 2, 1]);
      expect(state.downloads).toEqual([download(2)]);
      expect(state.remove).not.toHaveBeenCalled();
      expect(state.deleteFiles).not.toHaveBeenCalled();
      await openFolder('Child');
      await waitFor(() => expect(workNames()).toEqual(['Saved 1']));
    },
  );

  it.each(['ko', 'en'] as const)(
    'retries a committed creation in %s without creating or renaming another folder',
    async (locale) => {
      state.locale = locale;
      state.create.mockImplementationOnce(async (name, parentId) => {
        state.collections.push({ id: 47, name, parentId, count: 0 });
        throw new LibraryCollectionError('created-unsaved', 'Disk full', 47);
      });
      state.persist.mockRejectedValueOnce(new Error('Disk full again'));
      const label = (key: TranslationKey) => t(key, locale);
      renderPage();
      await screen.findByRole('button', { name: label('library.all') });
      fireEvent.click(screen.getByRole('button', { name: label('library.collectionNew') }));
      fireEvent.change(screen.getByRole('textbox', { name: label('library.collectionName') }), {
        target: { value: 'Committed folder' },
      });
      fireEvent.click(screen.getByRole('button', { name: label('actions.saveChanges') }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        label('library.folderError.created-unsaved'),
      );
      expect(
        screen.getByRole('textbox', { name: label('library.collectionName') }),
      ).toHaveAttribute('readonly');
      expect(state.create).toHaveBeenCalledExactlyOnceWith('Committed folder', null);
      expect(state.persist).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: label('actions.saveChanges') }));
      await waitFor(() => expect(state.persist).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: label('actions.saveChanges') })).toBeEnabled(),
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        label('library.folderError.created-unsaved'),
      );
      expect(screen.getByRole('textbox', { name: label('library.collectionName') })).toHaveValue(
        'Committed folder',
      );
      expect(
        screen.getByRole('textbox', { name: label('library.collectionName') }),
      ).toHaveAttribute('readonly');
      expect(state.collections.filter((folder) => folder.name === 'Committed folder')).toEqual([
        { id: 47, name: 'Committed folder', parentId: null, count: 0 },
      ]);

      fireEvent.click(screen.getByRole('button', { name: label('actions.saveChanges') }));
      await waitFor(() => expect(state.persist).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          screen.queryByRole('textbox', { name: label('library.collectionName') }),
        ).not.toBeInTheDocument(),
      );
      expect(screen.getAllByRole('button', { name: 'Committed folder' })).toHaveLength(1);
      expect(state.create).toHaveBeenCalledTimes(1);
      expect(state.rename).not.toHaveBeenCalled();
    },
  );

  describe.each(['ko', 'en'] as const)('%s folder failure alerts', (locale) => {
    it.each(['stale source', 'stale parent', 'cycle', 'persistence'] as const)(
      'localizes a %s failure and retains the editor for retry',
      async (scenario) => {
        state.locale = locale;
        const label = (key: TranslationKey) => t(key, locale);
        const rawMessage = 'Internal database failure: untranslated detail';
        renderPage();
        await openFolder();
        if (scenario === 'stale parent') {
          state.create.mockRejectedValueOnce(new LibraryCollectionError('missing', rawMessage));
          fireEvent.click(screen.getByRole('button', { name: label('library.collectionNew') }));
          fireEvent.change(screen.getByRole('textbox', { name: label('library.collectionName') }), {
            target: { value: 'Child' },
          });
        } else if (scenario === 'cycle') {
          state.move.mockRejectedValueOnce(new LibraryCollectionError('cycle', rawMessage));
          fireEvent.click(screen.getByRole('button', { name: label('library.folderActions') }));
          fireEvent.click(
            await screen.findByRole('menuitem', { name: label('library.folderMove') }),
          );
        } else {
          state.rename.mockRejectedValueOnce(
            scenario === 'stale source'
              ? new LibraryCollectionError('missing', rawMessage)
              : new Error(rawMessage),
          );
          fireEvent.click(screen.getByRole('button', { name: label('library.folderActions') }));
          fireEvent.click(
            await screen.findByRole('menuitem', { name: label('library.collectionRename') }),
          );
          fireEvent.change(screen.getByRole('textbox', { name: label('library.collectionName') }), {
            target: { value: 'Revised' },
          });
        }
        fireEvent.click(screen.getByRole('button', { name: label('actions.saveChanges') }));
        const key =
          scenario === 'cycle'
            ? 'library.folderError.cycle'
            : scenario === 'persistence'
              ? 'library.folderError.failed'
              : 'library.folderError.missing';
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(label(key));
        expect(alert).not.toHaveTextContent(rawMessage);
        expect(screen.getByRole('button', { name: label('actions.saveChanges') })).toBeEnabled();
      },
    );
  });

  it('shows folder tiles without declaring a folder-only root empty', async () => {
    state.ids = [];
    state.downloads = [];
    renderPage();
    await screen.findByRole('button', { name: 'Reading' });
    expect(screen.getByRole('button', { name: 'library.all' })).toBeInTheDocument();
    expect(screen.queryByText('library.savedEmpty')).not.toBeInTheDocument();
  });

  it('creates a subfolder beneath the current location', async () => {
    renderPage();
    await openFolder();
    fireEvent.click(screen.getByRole('button', { name: 'library.collectionNew' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'library.collectionName' }), {
      target: { value: 'Child' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith('Child', 10));
    await screen.findByRole('button', { name: 'Child' });
  });

  it('keeps sort selection and exposes the icon toggle pressed state', async () => {
    renderPage();
    await ready();
    expect(screen.getByRole('button', { name: 'library.select' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'library.select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Downloaded Beta' }));
    fireEvent.click(screen.getByRole('button', { name: /^library.sort:/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /library.sortOldest/ }));
    expect(screen.getByRole('button', { name: 'library.sort: library.sortOldest' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Downloaded Beta' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'library.done' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('clears selection when navigating to a folder', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'library.select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Downloaded Beta' }));
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'library.location' })).getByRole('button', {
        name: 'nav.library',
      }),
    );
    await openFolder();
    await waitFor(() => expect(workNames()).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Downloaded Beta' })).not.toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('refreshes folder truth and falls back to root after a postcommit deletion error', async () => {
    state.deleteCollection.mockImplementation(async (id) => {
      state.collections = state.collections.filter((folder) => folder.id !== id);
      throw new Error('Persistence failed after commit');
    });
    renderPage();
    await openFolder();
    await folderMenu('library.collectionDelete');
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await screen.findByRole('alert');
    await screen.findByRole('button', { name: 'library.all' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reading' })).not.toBeInTheDocument(),
    );
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.deleteFiles).not.toHaveBeenCalled();
  });

  it('renames the active folder and refreshes its breadcrumb', async () => {
    state.rename.mockImplementation(async (id, name) => {
      state.collections = state.collections.map((folder) =>
        folder.id === id ? { ...folder, name } : folder,
      );
    });
    renderPage();
    await openFolder();
    await folderMenu('library.collectionRename');
    fireEvent.change(screen.getByRole('textbox', { name: 'library.collectionName' }), {
      target: { value: 'Revised' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
    await waitFor(() => expect(state.rename).toHaveBeenCalledWith(10, 'Revised'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'library.location' })).getByText('Revised'),
      ).toBeInTheDocument(),
    );
  });

  it('offers full paths when moving a folder', async () => {
    state.collections.push(
      { id: 20, name: 'Archive', count: 0, parentId: null },
      { id: 21, name: 'Later', count: 0, parentId: 20 },
    );
    renderPage();
    await openFolder();
    await folderMenu('library.folderMove');
    fireEvent.click(await screen.findByRole('button', { name: 'Archive / Later' }));
    fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
    await waitFor(() => expect(state.move).toHaveBeenCalledWith(10, 21));
  });

  it('uses full paths for batch destinations without losing the selected work', async () => {
    state.collections.push(
      { id: 20, name: 'Archive', count: 0, parentId: null },
      { id: 21, name: 'Reading', count: 0, parentId: 20 },
    );
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'library.select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Downloaded Beta' }));
    const destinations = screen.getByRole('combobox', { name: 'library.collectionTarget' });
    expect(within(destinations).getByRole('option', { name: 'Archive / Reading' })).toHaveValue(
      '21',
    );
    fireEvent.change(destinations, { target: { value: '21' } });
    fireEvent.click(screen.getByRole('button', { name: 'library.collectionAdd' }));
    await waitFor(() => expect(state.addToCollection).toHaveBeenCalledWith([2], 21));
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.deleteFiles).not.toHaveBeenCalled();
  });

  it('returns to root when the active folder disappears after a hierarchy refresh', async () => {
    const { client } = renderPage();
    await openFolder();
    await waitFor(() => expect(workNames()).toHaveLength(2));
    state.collections = [];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['library-collections'] });
    });
    await screen.findByRole('button', { name: 'library.all' });
    await waitFor(() => expect(workNames()).toEqual(['Saved 3']));
  });
  it('shows saved and downloaded works in one grid and passes offline metadata to common cards', async () => {
    renderPage();
    await ready();
    expect(workNames()).toEqual(['Saved 3', 'Downloaded Beta', 'Saved 1']);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'library.more' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /library.manager/ })).toHaveAttribute(
      'href',
      '/downloads',
    );
  });

  it('keeps manager access and filters mounted for an empty library', async () => {
    state.ids = [];
    state.downloads = [];
    state.collections = [];
    renderPage();
    await screen.findByText('library.savedEmpty');
    expect(screen.getByRole('link', { name: /library.manager/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Filter')).toBeInTheDocument();
    expect(
      screen.getAllByRole('link').filter((link) => link.getAttribute('href') === '/downloads'),
    ).toHaveLength(1);
  });

  it('shows failed-download summary only when actionable work exists', async () => {
    state.downloads.push(download(3, 'failed'));
    renderPage();
    await ready();
    expect(screen.getByText('library.status.failed 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /library.manager/ })).toHaveAttribute(
      'href',
      '/downloads',
    );
    expect(workNames()).toContain('Failed Gamma');
  });

  it('offers All works as a tile and removes obsolete toolbar filters', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'library.all' });
    await waitFor(() => expect(workNames()).toEqual(['Saved 3']));
    expect(
      screen.queryByRole('checkbox', { name: 'library.downloadedOnly' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'actions.manageCollections' }),
    ).not.toBeInTheDocument();
    expect(state.getLibraryIds).toHaveBeenCalledWith({ unclassified: true });
    await waitFor(() => expect(state.getLibraryIds).toHaveBeenCalledWith({}));
    await ready();
    expect(new Set(workNames()).size).toBe(3);
  });

  it('searches download metadata when remote/gallery cache metadata is absent', async () => {
    renderPage();
    await ready();
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'Beta' } });
    await waitFor(() => expect(workNames()).toEqual(['Downloaded Beta']));
    expect(screen.getByLabelText('Filter')).toBeInTheDocument();
  });

  it('sorts saved works by oldest and title', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /^library.sort:/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /library.sortOldest/ }));
    expect(workNames()).toEqual(['Saved 1', 'Downloaded Beta', 'Saved 3']);
    fireEvent.click(screen.getByRole('button', { name: /^library.sort:/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /library.sortTitle/ }));
    await waitFor(() => expect(workNames()).toEqual(['Saved 1', 'Downloaded Beta', 'Saved 3']));
  });

  it('navigates direct folders and members through ancestor breadcrumbs', async () => {
    state.collections.push({ id: 11, name: 'Later', count: 1, parentId: 10 });
    state.getLibraryIds.mockImplementation(async (options) =>
      options.collectionId === 11
        ? [1]
        : options.collectionId === 10
          ? [2]
          : options.unclassified
            ? [3]
            : state.ids,
    );
    renderPage();
    await screen.findByRole('button', { name: 'Reading' });
    expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
    await openFolder();
    await waitFor(() => expect(workNames()).toEqual(['Downloaded Beta']));
    expect(state.getLibraryIds).toHaveBeenCalledWith({ collectionId: 10 });
    await openFolder('Later');
    await waitFor(() => expect(workNames()).toEqual(['Saved 1']));
    const breadcrumbs = screen.getByRole('navigation', { name: 'library.location' });
    fireEvent.click(within(breadcrumbs).getByRole('button', { name: 'Reading' }));
    await waitFor(() => expect(workNames()).toEqual(['Downloaded Beta']));
    fireEvent.click(within(breadcrumbs).getByRole('button', { name: 'nav.library' }));
    await waitFor(() => expect(workNames()).toEqual(['Saved 3']));
    await ready();
  });

  it('creates an optional collection without moving saved works or downloading', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'library.all' });
    fireEvent.click(screen.getByRole('button', { name: 'library.collectionNew' }));
    expect(screen.getByRole('button', { name: 'actions.saveChanges' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'library.collectionName' }), {
      target: { value: 'Later' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'actions.saveChanges' }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith('Later', null));
    await screen.findByRole('button', { name: 'Later' });
    expect(workNames()).toEqual(['Saved 3']);
  });

  it('deletes a collection only after its keep-works message and preserves library membership', async () => {
    renderPage();
    await openFolder();
    await waitFor(() => expect(workNames()).toHaveLength(2));
    await folderMenu('library.collectionDelete');
    expect(
      screen.getByText('library.collectionDeleteConfirm', { exact: false }),
    ).toBeInTheDocument();
    expect(state.deleteCollection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await waitFor(() => expect(state.deleteCollection).toHaveBeenCalledWith(10));
    await ready();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.deleteFiles).not.toHaveBeenCalled();
  });

  it('enters selection with the single work chosen by the common menu', async () => {
    renderPage();
    await ready();
    expect(state.beginSelection.has(2)).toBe(true);
    act(() => {
      state.beginSelection.get(2)!();
    });
    expect(screen.getByRole('button', { name: 'Downloaded Beta' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getAllByTestId('work').filter((work) => work.getAttribute('aria-pressed') === 'true'),
    ).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'actions.remove' })).toBeEnabled();
  });

  it('keeps selection on failed batch operations for retry', async () => {
    state.remove.mockRejectedValue(new Error('Storage unavailable'));
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'library.select' }));
    fireEvent.click(screen.getByRole('button', { name: 'Downloaded Beta' }));
    fireEvent.click(screen.getByRole('button', { name: 'actions.remove' }));
    await screen.findByRole('alert');
    expect(state.remove).toHaveBeenCalledWith([expect.objectContaining({ id: 2 })]);
    expect(screen.getByRole('button', { name: 'Downloaded Beta' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'actions.remove' })).toBeEnabled();
  });

  it('clears selection on filters so batch operations cannot target hidden works', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'library.select' }));
    fireEvent.click(screen.getByRole('button', { name: 'library.selectAll' }));
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'Beta' } });
    await waitFor(() => expect(workNames()).toEqual(['Downloaded Beta']));
    expect(screen.getByRole('button', { name: 'actions.remove' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Downloaded Beta' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('routes legacy history tab bookmarks to standalone history', async () => {
    window.history.replaceState({}, '', '/library?tab=history');
    renderPage();
    await waitFor(() => expect(state.replace).toHaveBeenCalledWith('/history'));
  });
});
