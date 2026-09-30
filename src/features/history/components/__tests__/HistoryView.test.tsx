// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { removeHistoryBatch, clearHistory } from '@/lib/db/library';
import { HistoryView } from '../HistoryView';

const mockEntries = vi.hoisted(() => ({
  rows: [] as Array<{ galleryId: number; viewedAt: string }>,
  filtered: [] as number[],
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ back: vi.fn(), replace: vi.fn() }) }));

vi.mock('@/lib/db/library', () => ({
  removeHistoryBatch: vi.fn(async (ids: number[]) => {
    mockEntries.rows = mockEntries.rows.filter((entry) => !ids.includes(entry.galleryId));
  }),
  clearHistory: vi.fn(async () => {
    mockEntries.rows = [];
  }),
}));

vi.mock('@/lib/db/gallery', () => ({
  getRecentlyViewedWithDates: vi.fn(async () => mockEntries.rows),
}));

vi.mock('@/lib/db/search-local', () => ({
  filterHistoryByTags: vi.fn(async () => mockEntries.filtered),
}));

vi.mock('@/features/gallery-list/components/GalleryCard', () => ({
  GalleryCardById: ({
    id,
    onSelect,
    selected,
  }: {
    id: number;
    onSelect?: () => void;
    selected?: boolean;
  }) => (
    <button data-testid="gallery-id" aria-pressed={selected} onClick={onSelect}>
      {id}
    </button>
  ),
}));

vi.mock('@/features/gallery-list/components/SavedGalleryGrid', () => ({
  SavedGalleryGrid: ({
    groups,
    renderItem,
  }: {
    groups: Array<{ key: string; label?: string; items: number[] }>;
    renderItem: (id: number, index: number) => React.ReactNode;
  }) => (
    <div>
      {groups.map((group) => (
        <section key={group.key}>
          {group.label && <h2>{group.label}</h2>}
          {group.items.map((id, index) => (
            <React.Fragment key={id}>{renderItem(id, index)}</React.Fragment>
          ))}
        </section>
      ))}
    </div>
  ),
}));

vi.mock('@/shared/components/FloatingPageNav', () => ({
  FloatingPageNav: () => null,
}));

vi.mock('@/shared/components/DbErrorBanner', () => ({
  DbErrorBanner: () => null,
}));

vi.mock('@/shared/components/DbStageSpinner', () => ({
  DbStageSpinner: () => <div data-testid="spinner" />,
}));

vi.mock('@/shared/components/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

vi.mock('@/shared/components/FilterBar', () => ({
  FilterBar: ({
    onFilterChange,
  }: {
    onFilterChange: (filters: { tags: []; titleQuery: string }) => void;
  }) => (
    <input
      aria-label="filter"
      onChange={(event) => onFilterChange({ tags: [], titleQuery: event.target.value })}
    />
  ),
}));

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (state: { locale: 'en' }) => unknown) => selector({ locale: 'en' }),
}));

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HistoryView />
    </QueryClientProvider>,
  );
}

describe('HistoryView performance rendering', () => {
  beforeEach(() => {
    vi.mocked(removeHistoryBatch).mockClear();
    vi.mocked(clearHistory).mockClear();
    mockEntries.rows = Array.from({ length: 30 }, (_, i) => ({
      galleryId: i + 1,
      viewedAt: '2026-06-20T12:00:00.000Z',
    }));
    mockEntries.filtered = [4, 7];
  });

  it('passes all ordered history groups to the single bounded grid', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getAllByTestId('gallery-id')).toHaveLength(30));
    expect(screen.getByRole('heading', { name: 'June 20, 2026' })).toBeInTheDocument();
    expect(screen.getAllByTestId('gallery-id').map((element) => element.textContent)).toEqual(
      mockEntries.rows.map((row) => String(row.galleryId)),
    );
  });

  it('switches between date groups and filtered IDs without retaining previous results', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getAllByTestId('gallery-id')).toHaveLength(30));
    fireEvent.change(screen.getByLabelText('filter'), { target: { value: 'saved' } });
    await waitFor(() =>
      expect(screen.getAllByTestId('gallery-id').map((element) => element.textContent)).toEqual([
        '4',
        '7',
      ]),
    );
    expect(screen.queryByRole('heading', { name: 'June 20, 2026' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('filter'), { target: { value: '' } });
    await waitFor(() => expect(screen.getAllByTestId('gallery-id')).toHaveLength(30));
    expect(screen.getByRole('heading', { name: 'June 20, 2026' })).toBeInTheDocument();
  });
});

describe('HistoryView deletion scope', () => {
  beforeEach(() => {
    vi.mocked(removeHistoryBatch).mockClear();
    vi.mocked(clearHistory).mockClear();
    mockEntries.rows = [
      { galleryId: 1, viewedAt: '2026-06-20T12:00:00.000Z' },
      { galleryId: 2, viewedAt: '2026-06-20T12:00:00.000Z' },
    ];
  });

  it('requires a reading-position reset warning before clearing history', async () => {
    renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'history.clear' }));
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('history.clear');
    expect(clearHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'actions.cancel' }));
    expect(clearHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'history.clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await waitFor(() => expect(clearHistory).toHaveBeenCalledOnce());
    await screen.findByText('history.empty');
  });

  it('removes only selected records after confirmation', async () => {
    renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'actions.select' }));
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    fireEvent.click(screen.getByRole('button', { name: 'history.remove (1)' }));
    expect(removeHistoryBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await waitFor(() => expect(removeHistoryBatch).toHaveBeenCalledWith([1]));
    expect(clearHistory).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByTestId('gallery-id')).toHaveLength(1));
    expect(screen.getByTestId('gallery-id')).toHaveTextContent('2');
  });

  it('clears hidden selections when filtering changes', async () => {
    mockEntries.filtered = [2];
    renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'actions.select' }));
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    fireEvent.change(screen.getByLabelText('filter'), { target: { value: 'other' } });
    await waitFor(() => expect(screen.getAllByTestId('gallery-id')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'history.remove (0)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    fireEvent.click(screen.getByRole('button', { name: 'history.remove (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await waitFor(() => expect(removeHistoryBatch).toHaveBeenCalledWith([2]));
  });

  it('keeps a failed batch visible with selected records available for retry', async () => {
    vi.mocked(removeHistoryBatch).mockRejectedValueOnce(new Error('DB failure'));
    renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'actions.select' }));
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    fireEvent.click(screen.getByRole('button', { name: 'history.remove (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await screen.findByText('actions.failed');
    expect(screen.getAllByTestId('gallery-id')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await screen.findByText('history.empty');
    expect(removeHistoryBatch).toHaveBeenLastCalledWith([1, 2]);
  });

  it('refreshes committed removals even when browser persistence reports failure', async () => {
    vi.mocked(removeHistoryBatch).mockImplementationOnce(async (ids) => {
      mockEntries.rows = mockEntries.rows.filter((entry) => !ids.includes(entry.galleryId));
      throw new Error('Persistence failed after commit');
    });
    renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'actions.select' }));
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    fireEvent.click(screen.getByRole('button', { name: 'history.remove (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await screen.findByText('actions.failed');
    await waitFor(() => expect(screen.getAllByTestId('gallery-id')).toHaveLength(1));
    expect(screen.getByTestId('gallery-id')).toHaveTextContent('2');
    fireEvent.click(screen.getByRole('button', { name: 'actions.cancel' }));
    expect(screen.getByRole('button', { name: 'history.remove (0)' })).toBeDisabled();
  });

  it('uses the confirmed target snapshot even if filters change before confirmation', async () => {
    mockEntries.filtered = [2];
    renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'actions.select' }));
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    fireEvent.click(screen.getByRole('button', { name: 'history.remove (1)' }));
    fireEvent.change(screen.getByLabelText('filter'), { target: { value: 'other' } });
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await waitFor(() => expect(removeHistoryBatch).toHaveBeenCalledWith([1]));
  });
});
