// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { OfflineImage } from '../components/OfflineImage';
import type { OfflineImageSource } from '../hooks/useOfflineImages';

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
});
