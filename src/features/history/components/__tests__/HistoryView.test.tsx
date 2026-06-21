// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { HistoryView } from '../HistoryView';

const mockEntries = vi.hoisted(() => ({
  rows: [] as Array<{ galleryId: number; viewedAt: string }>,
}));

vi.mock('@/lib/db/gallery', () => ({
  getRecentlyViewedWithDates: vi.fn(async () => mockEntries.rows),
}));

vi.mock('@/lib/db/search-local', () => ({
  filterHistoryByTags: vi.fn(async () => []),
}));

vi.mock('@/features/gallery-list/components/GalleryGrid', () => ({
  GalleryGridById: ({ ids }: { ids: number[] }) => (
    <div>
      {ids.map((id) => (
        <span key={id} data-testid="gallery-id">
          {id}
        </span>
      ))}
    </div>
  ),
}));

vi.mock('@/shared/components/InfiniteScrollTrigger', () => ({
  InfiniteScrollTrigger: ({ hasMore, onLoadMore }: { hasMore: boolean; onLoadMore: () => void }) =>
    hasMore ? (
      <button type="button" onClick={onLoadMore}>
        load more
      </button>
    ) : null,
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
  FilterBar: () => <input aria-label="filter" />,
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
    mockEntries.rows = Array.from({ length: 30 }, (_, i) => ({
      galleryId: i + 1,
      viewedAt: '2026-06-20T12:00:00.000Z',
    }));
  });

  it('renders history in batches instead of mounting every saved card at once', async () => {
    renderHistory();

    await waitFor(() => expect(screen.getAllByTestId('gallery-id')).toHaveLength(25));

    fireEvent.click(screen.getByRole('button', { name: 'load more' }));

    await waitFor(() => expect(screen.getAllByTestId('gallery-id')).toHaveLength(30));
  });
});
