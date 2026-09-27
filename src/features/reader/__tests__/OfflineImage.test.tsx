// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OfflineImage } from '../components/OfflineImage';
import type { OfflineImageSource } from '../hooks/useOfflineImages';

const mockRevokeObjectURL = vi.fn();

vi.mock('@/shared/components/AbortableImage', () => ({
  AbortableImage: ({ src, alt, onPermanentError }: { src: string; alt: string; onPermanentError?: () => void }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img data-testid="abortable-image" src={src} alt={alt} onError={onPermanentError} />
  ),
}));

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
      loadFallbackUrl: vi.fn(async () => 'https://cdn.example/0.webp'),
    };

    const { unmount } = render(<OfflineImage source={source} alt="Page 1" loading="eager" />);

    const img = screen.getByRole('img', { name: 'Page 1' });
    await waitFor(() => expect(img).toHaveAttribute('src', 'blob:page-0'));

    expect(source.loadUrl).toHaveBeenCalledTimes(1);
    expect(source.loadFallbackUrl).not.toHaveBeenCalled();
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

  it('renders a missing page through AbortableImage after requesting its fallback', async () => {
    const source: OfflineImageSource = {
      index: 0, ext: 'webp',
      loadUrl: vi.fn(async () => null),
      loadFallbackUrl: vi.fn(async () => 'https://cdn.example/0.webp'),
    };
    render(<OfflineImage source={source} alt="Recovered page" loading="eager" />);

    await waitFor(() => expect(screen.getByTestId('abortable-image'))
      .toHaveAttribute('src', 'https://cdn.example/0.webp'));
    expect(source.loadFallbackUrl).toHaveBeenCalledTimes(1);
  });

  it('recovers a file that resolves but fails to decode without touching healthy pages', async () => {
    const healthy: OfflineImageSource = {
      index: 0, ext: 'webp', loadUrl: vi.fn(async () => 'content://healthy'),
      loadFallbackUrl: vi.fn(async () => 'https://cdn.example/0.webp'),
    };
    const damaged: OfflineImageSource = {
      index: 1, ext: 'webp', loadUrl: vi.fn(async () => 'content://damaged'),
      loadFallbackUrl: vi.fn(async () => 'https://cdn.example/1.webp'),
    };
    render(<><OfflineImage source={healthy} alt="Healthy" loading="eager" />
      <OfflineImage source={damaged} alt="Damaged" loading="eager" /></>);
    await waitFor(() => expect(screen.getByAltText('Damaged')).toHaveAttribute('src', 'content://damaged'));
    fireEvent.error(screen.getByAltText('Damaged'));

    await waitFor(() => expect(screen.getByTestId('abortable-image'))
      .toHaveAttribute('src', 'https://cdn.example/1.webp'));
    expect(screen.getByAltText('Healthy')).toHaveAttribute('src', 'content://healthy');
    expect(healthy.loadFallbackUrl).not.toHaveBeenCalled();
    expect(healthy.loadUrl).toHaveBeenCalledTimes(1);
    expect(damaged.loadFallbackUrl).toHaveBeenCalledTimes(1);
  });

  it('recovers immediate URL sources only after permanent local-image failure', async () => {
    const source: OfflineImageSource = {
      index: 0, ext: 'webp', url: 'file:///saved/0.webp',
      loadFallbackUrl: vi.fn(async () => 'https://cdn.example/0.webp'),
    };
    render(<OfflineImage source={source} alt="Immediate" loading="eager" />);
    expect(source.loadFallbackUrl).not.toHaveBeenCalled();
    fireEvent.error(screen.getByAltText('Immediate'));

    await waitFor(() => expect(screen.getByTestId('abortable-image'))
      .toHaveAttribute('src', 'https://cdn.example/0.webp'));
    expect(source.loadFallbackUrl).toHaveBeenCalledTimes(1);
  });

  it('settles to the failed placeholder if local and network lookup both fail', async () => {
    const source: OfflineImageSource = {
      index: 0, ext: 'webp', loadUrl: vi.fn(async () => null),
      loadFallbackUrl: vi.fn(async () => { throw new Error('offline'); }),
    };
    const { container } = render(<OfflineImage source={source} alt="Unavailable" loading="eager" />);
    await waitFor(() => expect(source.loadFallbackUrl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('svg path')).not.toBeNull());
    expect(container.querySelector('img')).toBeNull();
  });
});
