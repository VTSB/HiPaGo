// @vitest-environment jsdom
import React from 'react';
import { describe, it, vi, expect, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getDownloadedImage, hasCompleteDownloadedGallery } from '@/lib/utils/download-zip';
const platform = vi.hoisted(() => ({ native: true }));
import { GalleryCardById } from '../GalleryCard';
import { useGalleryBlock } from '../../hooks/useGalleryBlock';
vi.mock('../../hooks/useGalleryBlock', () => ({ useGalleryBlock: vi.fn() }));
vi.mock('@/shared/hooks/useGalleryActions', () => ({
  useGalleryActions: () => ({ open: vi.fn() }),
}));
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/lib/i18n/useTagI18n', () => ({ useTagI18n: () => new Map() }));
vi.mock('@/lib/storage/download-store', () => ({
  createDownloadStore: async () => ({
    coverUrl: platform.native ? async () => 'blob:local-cover' : undefined,
  }),
}));
vi.mock('@/lib/utils/download-zip', () => ({
  getDownloadedImage: vi.fn(async () => new Uint8Array([1, 2, 3])),
  hasCompleteDownloadedGallery: vi.fn(async () => true),
}));
vi.mock('@/shared/components/AbortableImage', () => ({
  AbortableImage: ({ src, alt }: { src: string; alt: string }) => React.createElement('img', { src, alt }),
}));

beforeEach(() => {
  platform.native = true;
  vi.mocked(getDownloadedImage).mockClear();
  vi.mocked(hasCompleteDownloadedGallery).mockResolvedValue(true);
});

describe('offline downloaded card', () => {
  it('omits completion and checking badges in a library card while keeping the local cover', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveIntegrity!: (complete: boolean) => void;
    vi.mocked(hasCompleteDownloadedGallery).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { resolveIntegrity = resolve; }),
    );
    render(
      <QueryClientProvider client={client}>
        <GalleryCardById id={12} hideDownloadedBadge download={{ galleryId: 12,
          title: 'Library offline work', thumbnail: '', tags: '{}', pageCount: 5,
          totalBytes: 100, downloadedAt: '2025-01-01', status: 'complete' }} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('img', { name: 'Library offline work' })).toHaveAttribute('src', 'blob:local-cover');
    expect(screen.queryByText('actions.loading')).not.toBeInTheDocument();
    await act(async () => { resolveIntegrity(true); });
    await waitFor(() => expect(client.isFetching({ queryKey: ['download-integrity', 12] })).toBe(0));
    expect(screen.queryByText('detail.downloaded')).not.toBeInTheDocument();
  });

  it.each(['complete', 'failed', 'paused'] as const)(
    'retains actionable feedback for a %s download when completion badges are hidden', async (status) => {
      vi.mocked(hasCompleteDownloadedGallery).mockResolvedValue(false);
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <GalleryCardById id={12} hideDownloadedBadge download={{ galleryId: 12,
            title: 'Needs attention', thumbnail: '', tags: '{}', pageCount: 5,
            totalBytes: 100, downloadedAt: '2025-01-01', status }} />
        </QueryClientProvider>,
      );
      await screen.findByText(status === 'complete' ? 'library.filesMissing' : status === 'failed' ? 'library.failed' : 'library.pending');
      expect(screen.queryByText('detail.downloaded')).not.toBeInTheDocument();
    },
  );

  it('loads a browser cover from local page bytes and revokes its blob URL when unmounted', async () => {
    platform.native = false;
    const create = vi.fn(() => 'blob:web-local-cover');
    const revoke = vi.fn();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    try {
      const { unmount } = render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <GalleryCardById
            id={12}
            download={{
              galleryId: 12,
              title: 'Web offline work',
              thumbnail: '',
              tags: '{}',
              pageCount: 5,
              totalBytes: 100,
              downloadedAt: '2025-01-01',
              status: 'complete',
            }}
          />
        </QueryClientProvider>,
      );
      expect(await screen.findByRole('img', { name: 'Web offline work' })).toHaveAttribute(
        'src',
        'blob:web-local-cover',
      );
      expect(getDownloadedImage).toHaveBeenCalledWith(12, 0, undefined);
      expect(create).toHaveBeenCalledOnce();
      unmount();
      expect(revoke).toHaveBeenCalledWith('blob:web-local-cover');
    } finally {
      if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });
  it('shows a missing-files state instead of claiming a complete DB row is offline-ready', async () => {
    vi.mocked(hasCompleteDownloadedGallery).mockResolvedValue(false);
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <GalleryCardById
          id={12}
          download={{
            galleryId: 12,
            title: 'Missing work',
            thumbnail: '',
            tags: '{}',
            pageCount: 5,
            totalBytes: 100,
            downloadedAt: '2025-01-01',
            status: 'complete',
          }}
        />
      </QueryClientProvider>,
    );
    await screen.findByText('library.filesMissing');
    expect(screen.queryByText('detail.downloaded')).not.toBeInTheDocument();
  });

  it('renders a local cover and download metadata without querying missing gallery cache/network', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <GalleryCardById
          id={12}
          download={{
            galleryId: 12,
            title: 'Offline work',
            thumbnail: '',
            tags: '{}',
            pageCount: 5,
            totalBytes: 100,
            downloadedAt: '2025-01-01',
            status: 'complete',
          }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Offline work')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Offline work' })).toHaveAttribute(
      'src',
      'blob:local-cover',
    );
    await screen.findByText('detail.downloaded');
    expect(useGalleryBlock).not.toHaveBeenCalled();
  });
});
