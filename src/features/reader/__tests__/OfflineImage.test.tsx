// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OfflineImage } from '../components/OfflineImage';
import type { OfflineImageSource } from '../hooks/useOfflineImages';

vi.mock('@/lib/i18n/useT', () => ({
  useT: () => (key: string) =>
    ({
      'reader.retry': 'Retry',
      'reader.imageLoadFailed': 'Could not load this page',
    })[key] ?? key,
}));

const mockRevokeObjectURL = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', {
    revokeObjectURL: mockRevokeObjectURL,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OfflineImage', () => {
  it('loads a lazy blob source and revokes the blob URL on unmount', async () => {
    const source: OfflineImageSource = {
      index: 0,
      ext: 'webp',
      loadUrl: vi.fn(async () => 'blob:page-0'),
    };

    const { unmount } = render(<OfflineImage source={source} alt="Page 1" loading="eager" />);

    const img = screen.getByRole('img', { name: 'Page 1' });
    await waitFor(() => expect(img).toHaveAttribute('src', 'blob:page-0'));

    expect(source.loadUrl).toHaveBeenCalledTimes(1);
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();

    unmount();

    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:page-0');
  });

  it('does not create an img src when a lazy source returns null', async () => {
    const source: OfflineImageSource = {
      index: 0,
      ext: 'webp',
      loadUrl: vi.fn(async () => null),
    };

    const { container } = render(<OfflineImage source={source} alt="Page 1" loading="eager" />);

    await waitFor(() => expect(source.loadUrl).toHaveBeenCalledTimes(1));
    expect(container.querySelector('img')).toBeNull();
  });

  it('releases the failed blob and invokes the source again when retry is clicked', async () => {
    const loadUrl = vi
      .fn<NonNullable<OfflineImageSource['loadUrl']>>()
      .mockResolvedValueOnce('blob:page-0-failed')
      .mockResolvedValueOnce('blob:page-0-retry');
    const source: OfflineImageSource = {
      index: 0,
      ext: 'webp',
      loadUrl,
    };

    render(<OfflineImage source={source} alt="Page 1" loading="eager" />);

    const firstImage = screen.getByRole('img', { name: 'Page 1' });
    await waitFor(() => expect(firstImage).toHaveAttribute('src', 'blob:page-0-failed'));
    fireEvent.error(firstImage);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry: Page 1' }));

    await waitFor(() => expect(loadUrl).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Page 1' })).toHaveAttribute(
        'src',
        'blob:page-0-retry',
      ),
    );
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:page-0-failed');
  });
});
