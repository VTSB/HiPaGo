// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DownloadQueueView } from '../DownloadQueueView';
import type { QueueItem } from '@/lib/store/download-progress';

const state = {
  queue: [] as QueueItem[],
  globalPaused: false,
  refreshQueue: vi.fn(async () => {}),
  reorder: vi.fn(async () => {}),
  pauseAll: vi.fn(async () => {}),
  resumeAll: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  cancel: vi.fn(),
};

vi.mock('@/lib/store/download-progress', () => ({
  useDownloadProgressStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('@/shared/components/Spinner', () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock('@/shared/components/AbortableImage', () => ({
  AbortableImage: ({ alt }: { alt: string }) => <div role="img" aria-label={alt} />,
}));

describe('DownloadQueueView', () => {
  it('renders every active downloading row in the status panel', () => {
    state.queue = [
      {
        id: 1,
        title: 'First download',
        thumbnail: '',
        status: 'downloading',
        position: null,
        progress: { current: 2, total: 10 },
      },
      {
        id: 2,
        title: 'Second download',
        thumbnail: '',
        status: 'downloading',
        position: null,
        progress: { current: 1, total: 4 },
      },
    ];

    render(<DownloadQueueView />);

    expect(screen.getByText('First download')).toBeTruthy();
    expect(screen.getByText('Second download')).toBeTruthy();
    expect(screen.getByText('2/10 · 20%')).toBeTruthy();
    expect(screen.getByText('1/4 · 25%')).toBeTruthy();
    expect(screen.getByText('(2)')).toBeTruthy();
  });
});
