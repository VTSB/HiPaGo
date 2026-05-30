// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const setReaderZoom = vi.fn();
vi.mock('@/lib/plugins/readerZoom', () => ({
  setReaderZoom: (enabled: boolean) => setReaderZoom(enabled),
}));

import { useReaderZoom } from '../useReaderZoom';

describe('useReaderZoom', () => {
  beforeEach(() => setReaderZoom.mockClear());

  it('enables zoom on mount and disables it on unmount (reader-scoped)', () => {
    const { unmount } = renderHook(() => useReaderZoom());
    expect(setReaderZoom).toHaveBeenNthCalledWith(1, true);
    unmount();
    expect(setReaderZoom).toHaveBeenNthCalledWith(2, false);
  });
});
