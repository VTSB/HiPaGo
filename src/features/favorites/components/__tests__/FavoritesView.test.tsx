// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FavoritesView } from '../FavoritesView';

vi.mock('@/lib/db/gallery', () => ({ getFavoriteIds: vi.fn() }));
vi.mock('@/lib/db/search-local', () => ({ filterFavoritesByTags: vi.fn() }));
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/shared/components/DbErrorBanner', () => ({ DbErrorBanner: () => null }));
vi.mock('@/shared/components/DbStageSpinner', () => ({ DbStageSpinner: () => <div data-testid="loading" /> }));
vi.mock('@/shared/components/FloatingPageNav', () => ({ FloatingPageNav: () => null }));
vi.mock('@/features/gallery-list/components/GalleryCard', () => ({
  GalleryCardById: ({ id }: { id: number }) => <span data-testid="gallery">{id}</span>,
}));
vi.mock('@/features/gallery-list/components/SavedGalleryGrid', () => ({
  SavedGalleryGrid: ({ groups, renderItem }: {
    groups: Array<{ items: number[] }>;
    renderItem: (id: number) => React.ReactNode;
  }) => <div>{groups.flatMap((group) => group.items).map((id) => <React.Fragment key={id}>{renderItem(id)}</React.Fragment>)}</div>,
}));
vi.mock('@/shared/components/FilterBar', () => ({
  // The real FilterBar owns its input state and notifies its parent on mount
  // and value changes. An unmount/remount therefore loses the typed query.
  FilterBar: function StatefulFilterBar({ onFilterChange }: {
    onFilterChange: (filters: { tags: []; titleQuery: string }) => void;
  }) {
    const [value, setValue] = React.useState('');
    React.useEffect(() => onFilterChange({ tags: [], titleQuery: value }), [value, onFilterChange]);
    return <input aria-label="Favorites filter" value={value} onChange={(event) => setValue(event.target.value)} />;
  },
}));

import { getFavoriteIds } from '@/lib/db/gallery';
import { filterFavoritesByTags } from '@/lib/db/search-local';

function renderFavorites() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><FavoritesView /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFavoriteIds).mockResolvedValue([10, 20, 30]);
});
afterEach(cleanup);

describe('FavoritesView filtering', () => {
  it('keeps input mounted through pending and empty filters, then restores all favorites on clear', async () => {
    const pending = new Map<string, (ids: number[]) => void>();
    vi.mocked(filterFavoritesByTags).mockImplementation((_tags, title) => new Promise((resolve) => {
      pending.set(title ?? '', resolve);
    }));
    renderFavorites();
    await waitFor(() => expect(screen.getAllByTestId('gallery')).toHaveLength(3));
    const input = screen.getByRole('textbox', { name: 'Favorites filter' });

    fireEvent.change(input, { target: { value: 'one' } });
    await waitFor(() => expect(pending.has('one')).toBe(true));
    expect(screen.getByRole('textbox', { name: 'Favorites filter' })).toBe(input);
    expect(input).toHaveValue('one');
    expect(screen.getByTestId('loading')).toBeInTheDocument();
    await act(async () => pending.get('one')!([20]));
    await waitFor(() => expect(screen.getAllByTestId('gallery').map((item) => item.textContent)).toEqual(['20']));
    expect(input).toHaveValue('one');

    fireEvent.change(input, { target: { value: 'missing' } });
    await waitFor(() => expect(pending.has('missing')).toBe(true));
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('missing');
    await act(async () => pending.get('missing')!([]));
    await waitFor(() => expect(screen.getByText('search.noResults')).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Favorites filter' })).toBe(input);
    expect(input).toHaveValue('missing');

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(screen.getAllByTestId('gallery').map((item) => item.textContent)).toEqual(['10', '20', '30']));
    expect(input).toHaveValue('');
    expect(filterFavoritesByTags).toHaveBeenCalledTimes(2);
  });

  it('keeps the filter hidden for an initially empty favorites list', async () => {
    vi.mocked(getFavoriteIds).mockResolvedValue([]);
    renderFavorites();
    await waitFor(() => expect(screen.getByText('favorites.empty')).toBeInTheDocument());
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
