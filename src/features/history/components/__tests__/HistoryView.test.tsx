// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { removeHistory, clearHistory } from '@/lib/db/library';
import { HistoryView } from '../HistoryView';

const mockEntries = vi.hoisted(() => ({
  rows: [] as Array<{ galleryId: number; viewedAt: string }>,
  filtered: [] as number[],
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ back: vi.fn(), replace: vi.fn() }) }));

vi.mock('@/lib/db/library', () => ({
  removeHistory: vi.fn(async (id: number) => {
    mockEntries.rows = mockEntries.rows.filter((entry) => entry.galleryId !== id);
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
    vi.mocked(removeHistory).mockClear();
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
    vi.mocked(removeHistory).mockClear();
    vi.mocked(clearHistory).mockClear();
    mockEntries.rows = [
      { galleryId: 1, viewedAt: '2026-06-20T12:00:00.000Z' },
      { galleryId: 2, viewedAt: '2026-06-20T12:00:00.000Z' },
    ];
  });

  it('requires a reading-position reset warning before clearing history', async () => {
    renderHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'history.clear' }));
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('history.confirmDelete');
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
    expect(removeHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'actions.confirm' }));
    await waitFor(() => expect(removeHistory).toHaveBeenCalledWith(1));
    expect(clearHistory).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByTestId('gallery-id')).toHaveLength(1));
    expect(screen.getByTestId('gallery-id')).toHaveTextContent('2');
  });
});
