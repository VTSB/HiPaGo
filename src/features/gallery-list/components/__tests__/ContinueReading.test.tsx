// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, it, describe, vi, expect } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContinueReading } from '../ContinueReading';
const data = vi.hoisted(() => ({
  entries: [] as Array<{ galleryId: number; lastPage: number; totalPages: number }>,
  get: vi.fn(),
}));
vi.mock('@/lib/db/library', () => ({ getContinueReading: (limit: number) => data.get(limit) }));
vi.mock('@/lib/db/download', () => ({ listDownloads: async () => [] }));
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('../GalleryCard', () => ({
  GalleryCardById: ({ id }: { id: number }) => <div>Work {id}</div>,
}));
function renderContinue() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ContinueReading />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  data.entries = [];
  data.get.mockImplementation(async () => data.entries);
});
afterEach(cleanup);
describe('continue reading', () => {
  it('hides empty progress instead of presenting a visited-work list', async () => {
    const { container } = renderContinue();
    await waitFor(() => expect(data.get).toHaveBeenCalledWith(6));
    expect(container).toBeEmptyDOMElement();
  });
  it('resumes zero-based progress using the one-based reader URL and displays compact progress', async () => {
    data.entries = [{ galleryId: 12, lastPage: 4, totalPages: 20 }];
    renderContinue();
    const resume = await screen.findByRole('link', { name: 'actions.continue · 5/20' });
    expect(resume).toHaveAttribute('href', '/reader?id=12&page=5');
    expect(screen.getByRole('link', { name: /history.title/ })).toHaveAttribute('href', '/history');
  });
});
