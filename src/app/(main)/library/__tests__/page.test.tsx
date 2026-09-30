// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DBDownload } from '@/lib/db/schema';
import LibraryPage from '../page';

const state = vi.hoisted(() => ({
  ids: [3, 2, 1],
  beginSelection: new Map<number, () => void>(),
  downloads: [] as DBDownload[],
  titles: [
    { galleryId: 1, title: 'Able' },
    { galleryId: 2, title: 'Beta' },
    { galleryId: 3, title: 'Gamma' },
  ],
  collections: [{ id: 10, name: 'Reading', count: 2 }],
  classified: [2, 1],
  matches: [] as number[],
  replace: vi.fn(),
  refreshQueue: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  deleteFiles: vi.fn(async () => {}),
  getLibraryIds: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  deleteCollection: vi.fn(),
  addToCollection: vi.fn(async () => {}),
  removeFromCollection: vi.fn(async () => {}),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: state.replace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/shared/hooks/useGalleryActions', () => ({
  useGalleryActions: () => ({ remove: state.remove, deleteFiles: state.deleteFiles }),
}));
vi.mock('@/lib/db/adapter', () => ({
  ensureDb: async () => ({ query: async () => state.titles }),
}));
vi.mock('@/lib/db/download', () => ({
  listDownloads: async () => state.downloads,
  deserializeTags: (raw: string) => JSON.parse(raw),
}));
vi.mock('@/lib/db/library', () => ({
  getLibraryIds: (options: { collectionId?: number; unclassified?: boolean }) =>
    state.getLibraryIds(options),
  getCollections: async () => state.collections,
  createCollection: (name: string) => state.create(name),
  renameCollection: (id: number, name: string) => state.rename(id, name),
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
  return render(
    <QueryClientProvider client={client}>
      <LibraryPage />
    </QueryClientProvider>,
  );
}
const workNames = () => screen.getAllByTestId('work').map((element) => element.textContent);
beforeEach(() => {
  vi.clearAllMocks();
  state.beginSelection.clear();
  window.history.replaceState({}, '', '/library');
  state.ids = [3, 2, 1];
  state.downloads = [download(2)];
  state.matches = [];
  state.collections = [{ id: 10, name: 'Reading', count: 2 }];
  state.classified = [2, 1];
  state.getLibraryIds.mockImplementation(async (options) =>
    options.collectionId
      ? state.classified
      : options.unclassified
        ? state.ids.filter((id) => !state.classified.includes(id))
        : state.ids,
  );
  state.create.mockImplementation(async (name) => {
    state.collections.push({ id: 11, name, count: 0 });
    return 11;
  });
  state.rename.mockResolvedValue(undefined);
  state.deleteCollection.mockImplementation(async (id) => {
    state.collections = state.collections.filter((collection) => collection.id !== id);
  });
  state.remove.mockResolvedValue();
  state.deleteFiles.mockResolvedValue();
});
afterEach(cleanup);

async function ready() {
  await waitFor(() => expect(screen.getAllByTestId('work')).toHaveLength(3));
}

describe('unified saved library', () => {
  it('shows saved and downloaded works in one grid and passes offline metadata to common cards', async () => {
    renderPage();
    await ready();
    expect(workNames()).toEqual(['Saved 3', 'Downloaded Beta', 'Saved 1']);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'library.more' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'library.manager' })).toHaveAttribute(
      'href',
      '/downloads',
    );
  });

  it('keeps manager access and filters mounted for an empty library', async () => {
    state.ids = [];
    state.downloads = [];
    renderPage();
    await screen.findByText('library.savedEmpty');
    expect(screen.getByRole('link', { name: 'library.manager' })).toBeInTheDocument();
    expect(screen.getByLabelText('Filter')).toBeInTheDocument();
    expect(
      screen.getAllByRole('link').filter((link) => link.getAttribute('href') === '/downloads'),
    ).toHaveLength(1);
  });

  it('shows failed-download summary only when actionable work exists', async () => {
    state.downloads.push(download(3, 'failed'));
    renderPage();
    await ready();
    expect(screen.getByRole('link', { name: 'library.status.failed 1' })).toHaveAttribute(
      'href',
      '/downloads',
    );
    expect(workNames()).toContain('Failed Gamma');
  });

  it('filters downloaded state without creating a second library', async () => {
    renderPage();
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: 'library.downloadedOnly' }));
    expect(workNames()).toEqual(['Downloaded Beta']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'library.downloadedOnly' }));
    expect(workNames()).toHaveLength(3);
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
    fireEvent.change(screen.getByRole('combobox', { name: 'library.sort' }), {
      target: { value: 'oldest' },
    });
    expect(workNames()).toEqual(['Saved 1', 'Downloaded Beta', 'Saved 3']);
    fireEvent.change(screen.getByRole('combobox', { name: 'library.sort' }), {
      target: { value: 'title' },
    });
    await waitFor(() => expect(workNames()).toEqual(['Saved 1', 'Downloaded Beta', 'Saved 3']));
  });

  it('queries a collection or unclassified membership and preserves All', async () => {
    renderPage();
    await ready();
    fireEvent.change(screen.getByRole('combobox', { name: 'actions.manageCollections' }), {
      target: { value: '10' },
    });
    await waitFor(() => expect(workNames()).toHaveLength(2));
    expect(state.getLibraryIds).toHaveBeenLastCalledWith({ collectionId: 10 });
    fireEvent.change(screen.getByRole('combobox', { name: 'actions.manageCollections' }), {
      target: { value: 'unclassified' },
    });
    await waitFor(() => expect(workNames()).toEqual(['Saved 3']));
    fireEvent.change(screen.getByRole('combobox', { name: 'actions.manageCollections' }), {
      target: { value: 'all' },
    });
    await ready();
  });

  it('creates an optional collection without moving saved works or downloading', async () => {
    renderPage();
    await ready();
    expect(screen.queryByRole('button', { name: 'library.collectionNew' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'actions.manageCollections' }));
    fireEvent.click(screen.getByRole('button', { name: 'library.collectionNew' }));
    expect(screen.getByRole('button', { name: /actions.save/ })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'library.collectionName' }), {
      target: { value: 'Later' },
    });
    fireEvent.click(screen.getByRole('button', { name: /actions.save/ }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith('Later'));
    await screen.findByRole('option', { name: 'Later (0)' });
    expect(workNames()).toHaveLength(3);
  });

  it('deletes a collection only after its keep-works message and preserves library membership', async () => {
    renderPage();
    await ready();
    fireEvent.change(screen.getByRole('combobox', { name: 'actions.manageCollections' }), {
      target: { value: '10' },
    });
    await waitFor(() => expect(workNames()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'actions.manageCollections' }));
    fireEvent.click(screen.getByRole('button', { name: 'library.collectionDelete' }));
    expect(
      screen.getByText('library.collectionDeleteConfirm', { exact: false }),
    ).toBeInTheDocument();
    expect(state.deleteCollection).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button', { name: 'library.collectionDelete' });
    fireEvent.click(buttons[buttons.length - 1]);
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
    fireEvent.click(screen.getByRole('checkbox', { name: 'library.downloadedOnly' }));
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
