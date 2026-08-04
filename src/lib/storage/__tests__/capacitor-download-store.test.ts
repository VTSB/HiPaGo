import { beforeEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({
  readdir: vi.fn(),
  rmdir: vi.fn(),
}));

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: filesystem,
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
}));

import { CapacitorDownloadStore } from '../adapters/capacitor';

describe('CapacitorDownloadStore destructive error handling', () => {
  beforeEach(() => {
    filesystem.readdir.mockReset();
    filesystem.rmdir.mockReset();
  });

  it('treats an absent legacy root as an empty gallery list', async () => {
    filesystem.readdir.mockRejectedValue(new Error('Directory does not exist'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.listGalleries()).resolves.toEqual([]);
  });

  it('does not turn an indeterminate legacy-root read failure into an empty list', async () => {
    filesystem.readdir.mockRejectedValue(new Error('provider temporarily unavailable'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.listGalleries()).rejects.toThrow('provider temporarily unavailable');
  });

  it('keeps delete idempotent when the legacy gallery is already absent', async () => {
    filesystem.rmdir.mockRejectedValue(new Error('Directory does not exist'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.deleteGallery(42)).resolves.toBeUndefined();
  });

  it('propagates an indeterminate legacy delete failure', async () => {
    filesystem.rmdir.mockRejectedValue(new Error('legacy storage is read-only'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.deleteGallery(42)).rejects.toThrow('legacy storage is read-only');
  });
});
